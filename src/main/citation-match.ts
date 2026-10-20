// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 TIKMOON LTD
/**
 * Bibliographic matching for references without an ID.
 *
 * **Background**: Chinese manuscripts often cite in GB/T 7714 format with no PMID or DOI at all, so
 * exact lookup by ID does not work for them, and citation authenticity is a core requirement.
 *
 * **Why Crossref search results cannot be trusted directly**: `query.bibliographic` returns
 * results for **any** query, and for a Chinese reference the top results can all score high while
 * being entirely unrelated articles from other years. The score is a TF-IDF-like relative value,
 * not comparable across queries, and **cannot be used as confidence**. Showing such results
 * directly produces a confident, specific, entirely plausible wrong conclusion.
 *
 * **So we run our own deterministic check, rejecting by default**: the year must match and the
 * title must really be similar. Failing the check means "not found", not "this citation has a
 * problem".
 */

import { compareReferenceField, compareTitles } from '../shared/reference-field-compare'
import { plainLiteratureText } from '../shared/literature-plain-text'
import { personParts, samePerson, splitPersons } from '../shared/person-name'

export interface ParsedEntry {
  title: string | null
  year: number | null
  journal: string | null
  volume: string | null
  issue: string | null
  pages: string | null
}

/**
 * Split title, journal and year out of a GB/T 7714 or Vancouver entry.
 *
 * Only well-structured parts are recognized; anything that cannot be split stays null. A wrong
 * split makes the later check compare the wrong things, which is worse than not comparing.
 */
export function parseEntry(entry: string): ParsedEntry {
  // Remove the leading number: [12], full-width [12], 12. or 12 with a full-width period
  const body = entry.replace(/^\s*([[［]\d+[\]］]|\d+[.、．])\s*/, '')

  /*
   * GB/T 7714: Author. Title[J]. Journal, year, volume(issue): pages
   * Chinese references often use full-width `。`, `．` and `［J］`; both full-width and half-width
   * forms are recognized, so `作者，等。题名[J]。刊，2021` still yields a title.
   */
  const gb = body.match(/^(.+?)[.．。]\s*(.+?)\s*[[［][A-Z][\]］]\s*[.．。]\s*([^,，]+)[,，]\s*(\d{4})/)
  if (gb) {
    return { title: gb[2].trim(), year: Number(gb[4]), journal: gb[3].trim(), ...parseLocator(body) }
  }

  // Common English format: Authors (2009) Title. Journal, volume, pages.
  // Author initials contain many periods, so the `. ` split taking the second segment (below) cannot
  // be reused.
  const parenthetical = body.match(/^.+?\s+\((19\d{2}|20\d{2})\)\s+(.+?)\.\s+([^,，]+)[,，]/)
  if (parenthetical) {
    return { title: parenthetical[2].trim(), year: Number(parenthetical[1]), journal: parenthetical[3].trim(), ...parseLocator(body) }
  }

  /*
   * Vancouver format (PubMed's citation style, the most common in English medical manuscripts):
   *   Authors. Title. Journal abbreviation. 2021;36(5):1159-1163.
   * Also handles a month (`2021 May;36(5):1159-63.`), no issue (`2022;71:1724-1762`), electronic
   * pages (`2021;36(5):e123.`), and trailing doi / PMID.
   *
   * **The journal is the segment after the title's period and before the year**. Journal / volume /
   * issue / pages are needed for the rule "tolerate a one-year difference only when volume, issue
   * and pages all match".
   */
  const vancouver = body.match(
    /^(.+?[.．])\s*([^.．]+?)[.．]\s*(?:19\d{2}|20\d{2})(?:\s+[A-Za-z]{3,9})?(?:\s+\d{1,2})?\s*[;；]/,
  )
  if (vancouver) {
    const head = vancouver[1]
    // The title is the segment after the authors and before the journal: split on periods, and the
    // last segment is the title.
    const headParts = head.replace(/[.．]\s*$/, '').split(/[.．]\s+/).map((part) => part.trim()).filter(Boolean)
    const title = headParts.length >= 2 ? headParts[headParts.length - 1]! : null
    const yearInTail = /(?:19\d{2}|20\d{2})/.exec(body.slice(head.length))
    if (title && looksLikeTitle(title) && yearInTail) {
      return {
        title,
        year: Number(yearInTail[0]),
        journal: vancouver[2].trim() || null,
        ...parseLocator(body),
      }
    }
  }

  /*
   * Year: four digits, limited to 1900-2099. Nature/Cell style (`Journal 74, 229-263 (2024).`) puts the
   * year in trailing parentheses; titles often contain other years ("Global cancer statistics 2022"),
   * and pages can be four digits (2086-2092, 1985-1998): if there is a parenthesized year take the
   * last one; otherwise take the first four-digit number not inside a page range.
   * When a title can be split out, search only after it: the year of
   * "CONSORT 2010 statement: ... Pilot Feasibility Stud. 2016." is 2016.
   */
  // Fallback case: Author. Title. Rest...  take the second segment as the title
  const parts = body.split(/\.\s+/).map((part) => part.trim()).filter(Boolean)
  const candidate = parts.length >= 2 ? parts[1] : null
  const title = candidate && looksLikeTitle(candidate) ? candidate : null
  const YEAR_OUTSIDE_PAGES = /(?<![\d–—-]\s*)\b(19\d{2}|20\d{2})\b(?!\s*[–—-]\s*\d)/
  const parenYears = [...body.matchAll(/\((19\d{2}|20\d{2})[a-z]?\)/g)]
  const afterTitle = title ? body.slice(body.indexOf(title) + title.length).match(YEAR_OUTSIDE_PAGES) : null
  const yearMatch = parenYears.length
    ? parenYears[parenYears.length - 1]
    : afterTitle ?? body.match(YEAR_OUTSIDE_PAGES)
  const year = yearMatch ? Number(yearMatch[1]) : null

  return { title, year, journal: null, ...parseLocator(body) }
}

function normalizePages(value: string): string {
  const pages = value.replace(/\s+/g, '').replace(/[\u2010-\u2015~]/g, '-')
  /*
   * Vancouver abbreviates the end page: `1159-63` means 1159-1163. Without expanding it, the
   * reference and the database record of the same article would be judged a page mismatch.
   */
  const abbreviated = /^(\d+)-(\d+)$/.exec(pages)
  if (abbreviated) {
    const start = abbreviated[1]!
    const end = abbreviated[2]!
    if (end.length < start.length) return `${start}-${start.slice(0, start.length - end.length)}${end}`
  }
  return pages
}

/**
 * Split volume, issue and pages from the end of the reference. The numbers are the same in
 * Chinese and English registrations and serve as cross-language anchors.
 * If they cannot be split, leave null; do not guess.
 */
function parseLocator(body: string): { volume: string | null; issue: string | null; pages: string | null } {
  const gb = /[,，;；]\s*(?:19\d{2}|20\d{2})\s*[,，;；]\s*(\d+)\s*[(（]\s*([^)）]+?)\s*[)）]\s*[:：]\s*(\d+(?:\s*[-–—~]\s*\d+)?)/.exec(body)
  if (gb) {
    return { volume: gb[1], issue: gb[2].replace(/\s+/g, ''), pages: normalizePages(gb[3]) }
  }
  /*
   * Vancouver: `2021;36(5):1159-1163`, `2021 May;36(5):1159-63`, `2021;36(5):e123`.
   * The year may be followed by a month (sometimes a day); the issue is optional; pages may be
   * electronic, with letters before or after (`e93S-e120S`).
   */
  const vancouver = /(?:19\d{2}|20\d{2})(?:\s+[A-Za-z]{3,9})?(?:\s+\d{1,2})?\s*[;；]\s*(\d+)\s*(?:[(（]\s*([^)）]+?)\s*[)）])?\s*[:：]\s*([A-Za-z]?\d+[A-Za-z]?(?:\s*[-\u2010-\u2015~]\s*[A-Za-z]?\d+[A-Za-z]?)?)/
    .exec(body)
  if (vancouver) {
    return {
      volume: vancouver[1]!,
      issue: vancouver[2]?.replace(/\s+/g, '') ?? null,
      pages: normalizePages(vancouver[3]!),
    }
  }
  return { volume: null, issue: null, pages: null }
}

export interface IssueLocator {
  year: number
  volume: string
  issue: string
  pages: string
}

/**
 * Whether the second segment from the fallback split is really a title.
 *
 * This gate is required. Compact Vancouver (`Smith J, et al. BMJ 2023. PMID: <n>`) and a
 * Chinese GB variant (author. Chinese journal name, 2012, 40(3): 210-214.) **have no title at all**;
 * the second `. ` segment is the journal and volume/issue/pages. Passing it to `verifyCandidate` as
 * a title gives very low similarity, so a perfectly correct citation would be judged "ID does not
 * match bibliographic data, high priority": the most severe conclusion the checker gives.
 *
 * **False positives hurt trust more than misses.** So we would rather not recognize a title. The
 * cost of missing one is only falling back to "ID exists, needs comparison", leaving the
 * judgment to the researcher; the cost of a wrong one is the user deleting a fine citation.
 */
function looksLikeTitle(text: string): boolean {
  // Something with no letter or Han character at all is certainly not a title (pure numbers,
  // pure pages).
  if (!/[A-Za-z一-鿿]/.test(text)) return false

  // volume(issue) or page range: `40(3)`, `210-214`, `15(3):200-210`.
  // Titles never have this layout; if present, the segment is the bibliographic tail, not a title.
  if (/\d+\s*\(\s*\d+\s*\)/.test(text)) return false
  if (/\d+\s*[:：]\s*\d+\s*[-–—]\s*\d+/.test(text)) return false
  if (/\d+\s*[-–—]\s*\d+\s*\.?\s*$/.test(text)) return false

  const hasCjk = /[一-鿿]/.test(text)

  // A bare single Latin-script word: Circulation / BMJ / Lancet is a journal, not a title.
  // This applies only to Latin script: Chinese titles have no spaces, so applying it would reject
  // every real Chinese title.
  if (!hasCjk && !/\s/.test(text.replace(/\.$/, ''))) return false

  // "Journal + year": BMJ 2023 / Lancet 2019 / a Chinese journal name 2012.
  // The part before the year must be short enough to only be a journal (abbreviations or Chinese
  // journal names are usually <= 12 characters), otherwise long real titles ending in a year get hit.
  if (/^[^\d]{1,12}\s*[,，;；]?\s*(19|20)\d{2}\.?$/.test(text)) return false

  return true
}

/** Chinese has no word boundaries, so use character bigrams; English is lowercased as well. */
function bigrams(text: string): Set<string> {
  const cleaned = text.toLowerCase().replace(/[\s\p{P}]/gu, '')
  const grams = new Set<string>()
  for (let i = 0; i < cleaned.length - 1; i += 1) grams.add(cleaned.slice(i, i + 2))
  return grams
}

/** Dice coefficient: 2|A∩B| / (|A|+|B|). From 0 to 1; higher means more similar. */
export function similarity(a: string, b: string): number {
  const left = bigrams(a)
  const right = bigrams(b)
  if (!left.size || !right.size) return 0
  let shared = 0
  for (const gram of left) if (right.has(gram)) shared += 1
  return (2 * shared) / (left.size + right.size)
}

export interface Candidate {
  title: string
  authors: string[]
  journal: string
  year: number | null
  doi: string
  volume?: string | null
  issue?: string | null
  pages?: string | null
  issn?: string | null
  /** Crossref's own score. **Display only, never used for judgment**. */
  score: number
  /**
   * Which data source the candidate came from ('aminer' etc.); defaults to Crossref. Lets the
   * results table's source column be traced.
   */
  source?: string
  aminerId?: string
  abstract?: string
  url?: string
}

export interface MatchVerdict {
  ok: boolean
  /**
   * On failure, say which gate failed: the user must be able to tell whether we are too strict
   * or the entry is really wrong.
   */
  why: string
  similarity: number
  /**
   * What the pass relied on: a title match (same language) or only a cross-language
   * volume/issue/page closure. Only the `locator` path must also pass the journal-registry anchor;
   * same-language entries whose title already matches should not be blocked by it.
   */
  via: 'title' | 'locator' | 'none'
}

/**
 * Year + volume + issue + pages: a language-neutral identity anchor.
 *
 * Titles do not match character-for-character across Chinese and English registrations, but
 * volume/issue/pages are the same digits. The year must match; at least two of volume/issue/pages
 * must match, with no conflict. Same journal, year, volume, issue and pages can only be one article.
 */
export function locatorFieldsAlign(
  parsed: Pick<ParsedEntry, 'year' | 'volume' | 'issue' | 'pages'>,
  candidate: Pick<Candidate, 'year' | 'volume' | 'issue' | 'pages'>,
): boolean {
  if (!parsed.year || !candidate.year || parsed.year !== candidate.year) return false
  const pairs: Array<['volume' | 'issue' | 'pages', string | null | undefined, string | null | undefined]> = [
    ['volume', parsed.volume, candidate.volume],
    ['issue', parsed.issue, candidate.issue],
    ['pages', parsed.pages, candidate.pages],
  ]
  let agreed = 0
  let pagesAgreed = false
  for (const [field, left, right] of pairs) {
    if (!left || !right) continue
    const kind = compareReferenceField(field, String(left), String(right)).kind
    if (kind === 'differs') return false
    agreed += 1
    if (field === 'pages') pagesAgreed = true
  }
  /*
   * **Pages must be among the two matched fields.** This rule does not compare journal names (a
   * Chinese reference against an English registration never matches by characters), so "year +
   * volume + issue" distinguishes nothing: any journal has a volume 32 issue 2 in 2023, and an
   * unrelated article in another journal would be reported as "similar record found". Pages are what
   * pins an article down.
   */
  return agreed >= 2 && pagesAgreed
}

/**
 * Volume, issue and pages **all present and all matching**. Year is not considered.
 *
 * A stricter tier than `locatorFieldsAlign` (two fields suffice), used only for the "one-year
 * difference" exception: two different articles with the same journal, volume, issue and pages
 * do not exist.
 */
function locatorAllThreeAgree(
  parsed: Pick<ParsedEntry, 'volume' | 'issue' | 'pages'>,
  candidate: Pick<Candidate, 'volume' | 'issue' | 'pages'>,
): boolean {
  const pairs: Array<['volume' | 'issue' | 'pages', string | null | undefined, string | null | undefined]> = [
    ['volume', parsed.volume, candidate.volume],
    ['issue', parsed.issue, candidate.issue],
    ['pages', parsed.pages, candidate.pages],
  ]
  return pairs.every(([field, left, right]) => Boolean(left) && Boolean(right)
    && compareReferenceField(field, String(left), String(right)).kind !== 'differs')
}

/**
 * A second gap for the one-year difference: Crossref records the online date 2020-10-30, the
 * reference cites the issue year 2021, and the entry has no issue number, so volume/issue/pages
 * are incomplete. Allowed only if all hold: the title is the same work; both sides have a journal
 * and it matches; **volume and pages are present on both sides and match**, and an issue, if
 * given, must not conflict; when the entry's raw text is given, the first author must also be the
 * same person. Only a start page with no volume (highly repetitive items like a "Letter to the
 * Editor" p.1) is not allowed. Two same-title articles a year apart necessarily differ in journal
 * or volume/pages, so this gate stays closed for them.
 */
function sameWorkOneYearApart(parsed: ParsedEntry, candidate: Candidate, sameWork: boolean, entry?: string): boolean {
  if (!sameWork || !parsed.journal || !candidate.journal) return false
  if (compareReferenceField('journal', parsed.journal, candidate.journal).kind === 'differs') return false
  if (!parsed.volume || !candidate.volume || !parsed.pages || !candidate.pages) return false
  for (const [field, left, right] of [
    ['volume', parsed.volume, candidate.volume], ['issue', parsed.issue, candidate.issue], ['pages', parsed.pages, candidate.pages],
  ] as const) {
    if (left && right && compareReferenceField(field, String(left), String(right)).kind === 'differs') return false
  }
  return !entry || leadAuthorAgrees(entry, parsed, candidate.authors)
}

/**
 * Whether the entry's first author and the candidate's first author are the same person (shared
 * `samePerson`). The first author is the first name in the segment before the title; this
 * counter-check is skipped when no title is found in the entry, no name can be parsed, or the name
 * is Chinese.
 */
function leadAuthorAgrees(entry: string, parsed: ParsedEntry, authors: readonly string[]): boolean {
  if (!parsed.title || !authors.length) return true
  const at = entry.toLowerCase().indexOf(parsed.title.toLowerCase())
  if (at <= 0) return true
  const segment = entry.slice(0, at).replace(/^\s*(?:[[［]\s*\d{1,3}\s*[\]］]|\d{1,3}\s*[.、．)])\s*/, '')
  const lead = splitPersons(segment).names[0]
  if (!lead || personParts(lead).cjk) return true
  return samePerson(lead, authors[0]!)
}

/**
 * Deterministically check one candidate.
 *
 * Both gates must pass:
 * 1. **The year must match.** Reference years are almost never wrong, and the year is the
 *    strongest exclusion signal: unrelated candidates usually have a different year.
 * 2. **The title must be the same work, or volume/issue/pages must close the match.** A Chinese
 *    reference against an English registration does not match by title characters, but year +
 *    volume + issue + pages are the same digits. Without a title, volume/issue/pages alone can pass.
 */
export function verifyCandidate(parsed: ParsedEntry, candidate: Candidate, entry?: string): MatchVerdict {
  const score = parsed.title && candidate.title ? similarity(parsed.title, candidate.title) : 0
  const sameWork = Boolean(parsed.title) && compareTitles(parsed.title ?? '', candidate.title).kind !== 'differs'
  /*
   * A one-year difference is usually **online first, in print the next year**, not two different
   * articles: Crossref records the online date (e.g. 2020-09-21), the reference cites the print year
   * 2021, and volume/issue/pages match exactly; the year gate alone would reject it as "not found".
   *
   * The gap is narrow: **only one year off**, and either the title is the same work or all three of
   * volume/issue/pages match. Two or more years off, or different titles without volume/issue/pages,
   * are still rejected; the year remains the strongest exclusion signal.
   */
  if (parsed.year && candidate.year && parsed.year !== candidate.year) {
    /*
     * The gap is **very narrow**: only one year off, and **volume, issue and pages all present and
     * matching**.
     *
     * A matching title alone is not enough: same-title articles a year apart really exist (e.g. a
     * 2021 article in one Chinese journal and a 2022 article in another with the same title), and
     * then the year is the only thing that separates them. Two different articles with the same
     * journal, volume, issue and pages do not exist.
     */
    const oneYear = Math.abs(parsed.year - candidate.year) === 1
    const onlineAheadOfPrint = oneYear && (locatorAllThreeAgree(parsed, candidate) || sameWorkOneYearApart(parsed, candidate, sameWork, entry))
    if (!onlineAheadOfPrint) {
      return { ok: false, why: `年份不符（条目 ${parsed.year}，候选 ${candidate.year}）`, similarity: score, via: 'none' }
    }
    return {
      ok: true,
      why: `${locatorAllThreeAgree(parsed, candidate) ? '卷期页逐项一致' : '题名、刊名与卷页一致'}，年份差一年（著录 ${parsed.year}，记录 ${candidate.year}；在线发表与印刷年常差一年）`,
      similarity: score,
      via: sameWork ? 'title' : 'locator',
    }
  }
  if (parsed.title) {
    const title = compareTitles(parsed.title, candidate.title)
    if (title.kind !== 'differs') {
      return { ok: true, why: `年份一致，${title.why}`, similarity: score, via: 'title' }
    }
    if (locatorFieldsAlign(parsed, candidate)) {
      return { ok: true, why: '年份与卷期页一致，题名登记语言不同', similarity: score, via: 'locator' }
    }
    return { ok: false, why: title.why, similarity: score, via: 'none' }
  }
  if (locatorFieldsAlign(parsed, candidate)) {
    return { ok: true, why: '年份与卷期页一致', similarity: 0, via: 'locator' }
  }
  return { ok: false, why: '没能从条目里拆出题名，无法复核', similarity: 0, via: 'none' }
}

/**
 * One Crossref / AMiner record (AMiner is converted to the Crossref shape) -> candidate.
 *
 * **Title and journal are cleaned to plain text right here**: Crossref returns
 * `"Management of\n    <i>Helicobacter pylori</i>\n    infection: the Maastricht VI/..."`,
 * which never matches in `pickMatch` as-is.
 *
 * Cleaning in one place means matching and display use the same clean title, so one never matches
 * while the other shows angle brackets.
 */
export function toCandidate(item: Record<string, unknown>): Candidate | null {
  const title = Array.isArray(item.title) ? plainLiteratureText(String(item.title[0] ?? '')) : ''
  if (!title) return null
  const issued = item.issued as { 'date-parts'?: number[][] } | undefined
  const authors = Array.isArray(item.author)
    ? (item.author as Array<{ family?: string; given?: string }>)
      .map((a) => [a.family, a.given].filter(Boolean).join(' '))
      .filter(Boolean)
    : []
  return {
    title,
    authors,
    journal: Array.isArray(item['container-title']) ? plainLiteratureText(String(item['container-title'][0] ?? '')) : '',
    year: issued?.['date-parts']?.[0]?.[0] ?? null,
    doi: String(item.DOI ?? ''),
    volume: typeof item.volume === 'string' && item.volume ? item.volume : null,
    issue: typeof item.issue === 'string' && item.issue ? item.issue : null,
    pages: typeof item.page === 'string' && item.page
      ? item.page
      : (typeof item.pages === 'string' && item.pages ? item.pages : null),
    issn: Array.isArray(item.ISSN) ? String(item.ISSN[0] ?? '') || null
      : (typeof item.ISSN === 'string' && item.ISSN ? item.ISSN : null),
    score: typeof item.score === 'number' ? item.score : 0,
    source: typeof item.source === 'string' && item.source ? item.source : undefined,
    aminerId: typeof item.aminer_id === 'string' && item.aminer_id ? item.aminer_id : undefined,
    abstract: typeof item.abstract === 'string' && item.abstract ? item.abstract : undefined,
    url: typeof item.url === 'string' && item.url ? item.url : undefined,
  }
}

/**
 * Pick the single candidate that passes the check from a batch.
 *
 * **Also returns null when more than one passes**: two that both "look right" means we cannot
 * tell them apart, and giving the user one that may be wrong is worse than "not found".
 */
export function pickMatch(parsed: ParsedEntry, candidates: Candidate[], entry?: string): {
  matched: Candidate | null
  /**
   * Whether the unique pass relied on the title or only on volume/issue/pages; `none` when there is
   * no unique match.
   */
  matchedVia: MatchVerdict['via']
  verdicts: MatchVerdict[]
} {
  const verdicts = candidates.map((candidate) => verifyCandidate(parsed, candidate, entry))
  const passedIndexes = verdicts.flatMap((verdict, index) => (verdict.ok ? [index] : []))
  /*
   * When exactly one candidate matches by title, accept it; candidates matching only by
   * volume/issue/pages are not competitors.
   * The Crossref volume/issue/page locator also brings back articles from other journals with the same
   * volume, issue and pages and completely different titles. They pass as "year and volume/issue/pages
   * match, title registered in another language", and counting them as competitors would make a
   * correct record with an exactly matching title no longer unique, so the entry would be "not found".
   * With two or more title matches we still do not guess.
   */
  const titleIndexes = passedIndexes.filter((index) => verdicts[index]!.via === 'title')
  const index = passedIndexes.length === 1 ? passedIndexes[0] : titleIndexes.length === 1 ? titleIndexes[0] : undefined
  if (index === undefined) return { matched: null, matchedVia: 'none', verdicts }
  return { matched: candidates[index]!, matchedVia: verdicts[index]!.via, verdicts }
}
