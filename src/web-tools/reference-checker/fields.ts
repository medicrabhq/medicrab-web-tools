// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 TIKMOON LTD
/**
 * The website reference checker: compares the entry field by field with the record found.
 *
 * Recognizing "this paper" does not mean every field is written correctly: `judgeCitation` only
 * decides identity, so wrong authors or volume/issue/pages must be found here. Fields are parsed from
 * the entry text, and fields that cannot be parsed are not compared:
 * **a missing side means "no such field", not "you wrote it wrong"** (same as the desktop app).
 * All comparison rules come from `reference-field-compare`, shared with the desktop app.
 */
import type { ParsedEntry } from '../../main/citation-match'
import { compareReferenceField, type FieldCompareKind } from '../../shared/reference-field-compare'
import { GROUP_AUTHOR, recordHasOneFewerInitial, samePerson, splitPersons } from '../../shared/person-name'

export type CheckedField = 'authors' | 'title' | 'journal' | 'year' | 'volume' | 'issue' | 'pages'

export interface FieldRow {
  field: CheckedField
  /**
   * same: identical; convention: written differently but refers to the same thing (abbreviation, et al.,
   * online year vs print year one apart); differs: not identical; unverified: record incomplete, cannot
   * compare.
   */
  status: FieldCompareKind
  declared: string
  found: string
}

export interface FoundRecord {
  title?: string | null
  authors?: string | null
  journal?: string | null
  pubdate?: string | null
  volume?: string | null
  issue?: string | null
  pages?: string | null
}

const LEADING_MARKER = /^\s*(?:[[［]\s*\d{1,3}\s*[\]］]|\(\s*\d{1,3}\s*\)|\d{1,3}\s*[.．)）、](?!\d))\s*/

/**
 * The author segment of the entry: the part before the title; when no title can be parsed, accept the
 * APA "Authors (Year)." form.
 * Reject segments that are too long or contain numbers of 3+ digits: those most likely swallowed the
 * journal and volume/issue, and comparing them only produces false alarms.
 */
export function declaredAuthors(entry: string, title: string | null): string | null {
  const body = entry.replace(LEADING_MARKER, '')
  let segment: string | null = null
  if (title) {
    const at = body.indexOf(title)
    if (at > 0) segment = body.slice(0, at)
  }
  if (segment === null) {
    const apa = /^(.+?)\s*\((?:19|20)\d{2}[a-z]?(?:,\s*[A-Za-z]+\.?\s*\d{0,2})?\)/.exec(body)
    if (apa) segment = apa[1]!
  }
  if (segment === null) return null
  // Chicago style "..., and J. Yan, “Title,”": strip the opening quote at the end of the author segment too.
  segment = segment.replace(/[\s“”"‘'«„]+$/, '').replace(/\(\s*(?:19|20)\d{2}[a-z]?\s*\)\s*[.:]?\s*$/, '').replace(/[\s.,;:“”"‘'«„]+$/, '').trim()
  // American Society for Microbiology style "..., Zhang Y. 2025. Title": the year is at the end of the
  // author segment.
  segment = segment.replace(/[.,]?\s*\(?(?:19|20)\d{2}[a-z]?\)?$/, '').replace(/[\s.,;:]+$/, '').trim()
  if (!segment || segment.length > 600 || /\d{3,}/.test(segment)) return null
  return comparableAuthors(segment) !== null ? segment : null
}

/** Lowercase particles in names (`van der Berg`, `de la Cruz`); not counted as "long lowercase words". */
const NAME_PARTICLE = /^(?:van|von|der|den|de|da|di|du|le|la|del|della|dos|das|ter|ten|op|y|e|et|al|and)$/

/**
 * Add separators to the author segment before comparing:
 * - No commas, "Rogers P Wang D Lu Z": each "surname + uppercase initials" directly followed by the next
 *   capitalized surname gets a comma;
 * - Period-separated "Harhouri K. Navarro C. Mattei M. G.": each "surname + dotted initials" directly
 *   followed by the next author gets a comma.
 * Only these two shapes are touched; "Smith AB, Jones C" and "Hosking, J. G., Lam, F. C." are unaffected.
 */
export function separatedAuthors(segment: string): string {
  return segment
    .replace(/(\p{Lu}[\p{L}'’\-]+ [A-Z]{1,4})\s+(?=(?:(?:van|von|de|der|den|da|di|du|le|la|del|dos)\s)*\p{Lu}[\p{L}'’\-]+ [A-Z]{1,4}(?![\p{L}]))/gu, '$1, ')
    .replace(/(\p{Lu}[\p{L}'’\-]+(?: [A-Z]\.(?:[\-\u2010][A-Z]\.)?)+)\s+(?=(?:(?:van|von|de|der|den|da|di|du|le|la|del|dos)\s)*\p{Lu}[\p{L}'’\-]+ [A-Z](?![\p{L}]))/gu, '$1, ')
}

/**
 * Whether one author looks like a person's name: not if it contains digits, a lowercase non-particle
 * word of 4+ letters (a title word), or 4+ full words (probably swallowed the title). Single-letter
 * initials are not full words.
 */
function looksLikeName(name: string): boolean {
  if (/\d/.test(name)) return false
  if (GROUP_AUTHOR.test(name)) return true
  const tokens = name.replace(/[.,]/g, ' ').split(/\s+/).filter(Boolean)
  const words = tokens.filter((token) => /^\p{Lu}/u.test(token) && !/^[A-Z]{1,3}$/.test(token.replace(/[-\u2010\u2011]/g, '')))
  if (words.length >= 4) return false
  return !tokens.some((token) => /^\p{Ll}{4,}$/u.test(token) && !NAME_PARTICLE.test(token))
}

/**
 * The author list used for comparison (with separators added). `complete=false`: some author does not
 * look like a name, so the list only goes up to before it; an incomplete parse does not mean the authors
 * are wrong, nor that the entry used et al.; this field is recorded as "not checked". If the first one
 * already does not look like a name, or the whole segment is a single initial (`H`, `T.-Y`; the author
 * segment was chopped up), returns null.
 */
export function comparableAuthors(segment: string): { text: string; complete: boolean } | null {
  const { names, truncated } = splitPersons(separatedAuthors(segment))
  if (!names.length) return null
  if (names.length === 1 && !/\p{L}{2,}/u.test(names[0]!.replace(/\b[A-Z]\b/g, ''))) return null
  const bad = names.findIndex((name) => !looksLikeName(name))
  if (bad === 0) return null
  if (bad < 0) return { text: names.join('; ') + (truncated ? '; et al.' : ''), complete: true }
  return { text: names.slice(0, bad).join('; '), complete: false }
}

type PersonMatch = 'same' | 'fewer-initials' | null

/**
 * Whether two names at the same position match. When the record has one initial fewer than the entry
 * (`Lam FC` vs `Lam F. C. W.`), we cannot tell whether the database dropped it or the entry added
 * one, so record `fewer-initials`: neither reported as wrong nor as identical (left as "not checked").
 * The shared `samePerson` is not loosened.
 */
function matchPerson(declared: string, found: string): PersonMatch {
  if (samePerson(declared, found)) return 'same'
  return recordHasOneFewerInitial(declared, found) ? 'fewer-initials' : null
}

/**
 * Author comparison: three additions to the shared rules (web version):
 * - The entry has no et al. and lists only the first few authors (3 or more, each matching): record
 *   "written differently". Many journals require listing only the first 3 to 6.
 * - APA "first few, ... & last": each author before the ellipsis matches and the last is the record's
 *   last author: record "written differently".
 * - Someone merely has one initial fewer in the record and everything else matches: record
 *   `unverified` (not checked), neither wrong nor identical.
 */
function compareAuthors(declared: string, found: string, raw: string): FieldCompareKind {
  const kind = compareReferenceField('authors', declared, found).kind
  if (kind !== 'differs') return kind
  const right = splitPersons(found).names
  const verdict = (matches: PersonMatch[], ok: boolean): FieldCompareKind => {
    if (!ok || matches.some((m) => m === null)) return kind
    return matches.includes('fewer-initials') ? 'unverified' : 'convention'
  }
  // The ellipsis is gone after adding separators and splitting, so look for it in the original text.
  const ellipsis = /\s*(?:…|\.\.\.)\s*,?\s*&?\s*/.exec(raw)
  if (ellipsis) {
    const head = splitPersons(separatedAuthors(raw.slice(0, ellipsis.index))).names
    const tail = splitPersons(separatedAuthors(raw.slice(ellipsis.index + ellipsis[0].length))).names
    const last = right[right.length - 1]
    const ok = head.length >= 1 && tail.length === 1 && right.length > head.length + 1 && Boolean(last)
    return verdict(ok ? [...head.map((name, index) => matchPerson(name, right[index]!)), matchPerson(tail[0]!, last!)] : [], ok)
  }
  const { names: left, truncated } = splitPersons(declared)
  const ok = left.length <= right.length && (left.length === right.length || truncated || left.length >= 3)
  return verdict(ok ? left.map((name, index) => matchPerson(name, right[index]!)) : [], ok)
}

function yearOf(value: string | null | undefined): number | null {
  const match = /\b(1[6-9]\d{2}|20\d{2})\b/.exec(value ?? '')
  return match ? Number(match[1]) : null
}

/**
 * Compare field by field. Only compare when both sides have a value; a one-year year difference is
 * "written differently": a journal's online-first year and issue year often differ by one.
 */
export function fieldRows(parsed: ParsedEntry, authors: string | null, record: FoundRecord): FieldRow[] {
  const rows: FieldRow[] = []
  const push = (field: CheckedField, declared: string | null | undefined, found: string | null | undefined) => {
    const left = declared?.trim()
    const right = found?.trim()
    if (!left || !right) return
    const kind = compareReferenceField(field, left, right).kind
    rows.push({ field, status: kind, declared: left, found: right })
  }
  if (authors?.trim() && record.authors?.trim()) {
    const comparable = comparableAuthors(authors.trim())
    if (comparable) {
      const status = comparable.complete ? compareAuthors(comparable.text, record.authors.trim(), authors.trim()) : 'unverified'
      rows.push({ field: 'authors', status, declared: authors.trim(), found: record.authors.trim() })
    }
  }
  push('title', parsed.title, record.title)
  // The parsed "journal name" is a DOI, URL or contains volume/issue numbers: wrong position, do not
  // compare.
  if (!/\bdoi\b|https?:|\b10\.\d{4,9}\/|\d/i.test(parsed.journal ?? '')) push('journal', parsed.journal, record.journal)
  const declaredYear = parsed.year
  const foundYear = yearOf(record.pubdate)
  if (declaredYear && foundYear) {
    const gap = Math.abs(declaredYear - foundYear)
    rows.push({
      field: 'year',
      status: gap === 0 ? 'same' : gap === 1 ? 'convention' : 'differs',
      declared: String(declaredYear),
      found: String(foundYear),
    })
  }
  push('volume', parsed.volume, record.volume)
  push('issue', parsed.issue, record.issue)
  push('pages', parsed.pages, record.pages)
  return rows
}

/**
 * Fields present in the record but not parseable from the entry and therefore not compared (authors,
 * year, volume, pages). Journal name is not listed: Vancouver entries mostly cannot be parsed for the
 * journal, so listing it would make almost every entry "partially not checked". Recognizing the paper
 * does not mean these fields were checked,
 * so the page does not say "citation matches" based on this.
 */
export function uncheckedFields(parsed: ParsedEntry, record: FoundRecord, rows: FieldRow[]): CheckedField[] {
  const missing: CheckedField[] = []
  // Authors: no author segment read from the entry, the list was not fully parsed, or the record merely
  // has one initial fewer (all recorded as unverified).
  const authorRow = rows.find((row) => row.field === 'authors')
  if (record.authors?.trim() && (!authorRow || authorRow.status === 'unverified')) missing.push('authors')
  if (!parsed.year && yearOf(record.pubdate)) missing.push('year')
  if (!parsed.volume?.trim() && record.volume?.trim()) missing.push('volume')
  if (!parsed.pages?.trim() && record.pages?.trim()) missing.push('pages')
  return missing
}
