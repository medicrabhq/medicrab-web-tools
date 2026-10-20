// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 TIKMOON LTD
/**
 * Citation field comparison.
 *
 * A bare string check (strip punctuation, lowercase, test equality or mutual containment) is not
 * enough: names and journal names are exactly the two fields that are **meant to be abbreviated**,
 * and valid citation styles would be reported as conflicts:
 *
 *   manuscript `Smith J A.`                     <- GB/T 7714: surname + initials
 *   record     `John A. Smith`                  <- database: given name, surname
 *   manuscript `Smith JA, Doe B, Lee C, et al.`  <- et al. after three authors
 *   record     `John A. Smith; Bob Doe; Carol Lee; Dan Wu`
 *   manuscript `J Clin Med`                     <- ISO abbreviation
 *   record     `Journal of Clinical Medicine`   <- full name
 *
 * These are **correct citations**; reporting them as conflicts asks the user to "fix" what is right.
 * So results have four levels, with `convention` on its own: a difference but not an error, not
 * highlighted in red and not counted as a to-do.
 *
 * The title is the identity anchor and **must not be matched by containment**: only punctuation,
 * case and whitespace are normalized; a missing subtitle, a translated title or an edition
 * difference all count as `differs` and are left to the caller.
 */

import type { FieldCompareResult } from './person-name'
export type { FieldCompareKind, FieldCompareResult } from './person-name'

/**
 * Remove differences in punctuation, whitespace and case. Unicode spaces and full-width punctuation
 * are handled too.
 */
function plain(value: string): string {
  return value
    // Trademark symbols are not a title difference (e.g. "Acapella® device"); Crossref's <sup> tags
    // are already cleaned in toCandidate.
    .replace(/[®™©℠]/g, '')
    .replace(/[  -​　]/g, ' ')
    .replace(/[\s\p{P}]/gu, '')
    .toLowerCase()
}

import { comparePersons } from './person-name'
export {
  joinSurnameInitials, personParts, samePerson, splitPersons, comparePersons,
} from './person-name'

const JOURNAL_NOISE = /\b(the|of|and|for|in|on|journal|zeitschrift)\b/gi
/**
 * Expansions of common abbreviations in journal names; only **certain** mappings go here, nothing
 * uncertain.
 */
const JOURNAL_ALIAS: Array<[RegExp, string]> = [
  [/\bj\b/gi, 'journal'], [/\bandrol\b/gi, 'andrology'], [/\burol\b/gi, 'urology'],
  [/\bendocrinol\b/gi, 'endocrinology'], [/\bclin\b/gi, 'clinical'], [/\banat\b/gi, 'anatomy'],
  [/\beur\b/gi, 'european'], [/\bam\b/gi, 'american'], [/\bint\b/gi, 'international'],
  [/\bres\b/gi, 'research'], [/\brev\b/gi, 'review'], [/\bsci\b/gi, 'science'],
  [/\bmed\b/gi, 'medicine'], [/\bbiol\b/gi, 'biology'], [/\bgenet\b/gi, 'genetics'],
  [/\breprod\b/gi, 'reproduction'], [/\bnatl\b/gi, 'national'], [/\bacad\b/gi, 'academy'],
  [/\bproc\b/gi, 'proceedings'], [/\bsurg\b/gi, 'surgery'], [/\bpathol\b/gi, 'pathology'],
]

/** Journal-name normalization: expand known abbreviations, drop function words and punctuation. */
export function normalizeJournalName(value: string): string {
  let text = value.replace(/[《》]/g, ' ').trim()
  for (const [pattern, full] of JOURNAL_ALIAS) text = text.replace(pattern, full)
  return plain(text.replace(JOURNAL_NOISE, ' '))
}

import { journalAbbreviationMatches } from './journal-name'
export { journalAbbreviationMatches }

/**
 * NLM journal abbreviations sometimes start with the journal's acronym: `AJR Am J Roentgenol`.
 * A manuscript writing `Am J Roentgenol` is a valid form of the same journal, not a wrong name.
 * Strip only **the single leading all-caps word**; it must be exactly the initials of the following
 * words, and the rest must equal the other side after normalization.
 */
function stripLeadingAcronym(value: string): string {
  const match = /^([A-Z]{2,6})\s+(\S+(?:\s+\S+)+)$/.exec(value.trim())
  if (!match) return value
  // The all-caps word must be exactly the initials of the following words (AJR = Am J Roentgenol);
  // the JAMA in JAMA Netw Open is not.
  const initials = match[2].split(/\s+/).map((word) => word[0]?.toUpperCase() ?? '').join('')
  return initials === match[1] ? match[2] : value
}

function sameJournalBehindAcronym(declared: string, found: string): boolean {
  const pairs: Array<[string, string]> = [[stripLeadingAcronym(declared), found], [declared, stripLeadingAcronym(found)]]
  return pairs.some(([left, right]) => (left !== declared || right !== found)
    && normalizeJournalName(left) === normalizeJournalName(right))
}

export function compareJournals(declared: string, found: string): FieldCompareResult {
  if (plain(declared) === plain(found)) return { kind: 'same', why: '刊名一致' }
  if (normalizeJournalName(declared) === normalizeJournalName(found)
    || journalAbbreviationMatches(declared, found)
    || sameJournalBehindAcronym(declared, found)) {
    return { kind: 'convention', why: `刊名缩写与全称对应（${declared.trim()} / ${found.trim()}）` }
  }
  return { kind: 'differs', why: `刊名与记录不一致（稿件 ${declared.trim()}，记录 ${found.trim()}）` }
}

/**
 * Pages: omitting the shared prefix of the last page is standard.
 *
 * GB/T 7714 and Vancouver both allow `137-148` written as `137-48` (even `137-8`), so expand first,
 * then compare.
 */
export function expandPageRange(value: string): string {
  const match = /^\s*(\d+)\s*[-–—~]\s*(\d+)\s*$/.exec(value)
  if (!match) return expandLetteredPageRange(value) ?? plain(value)
  const [, start, end] = match
  if (end.length >= start.length) return `${Number(start)}-${Number(end)}`
  const full = start.slice(0, start.length - end.length) + end
  return `${Number(start)}-${Number(full)}`
}

/**
 * Supplement and electronic pages carry letters: `x320-x327` / `x320-7`, `S181-S206` / `S181-206`,
 * `e278S-e313S` / `e278S-313S`. A letter omitted from the last page is taken from the first page, and
 * both ends must have the same letters; after that the last page is expanded by the numeric rule.
 * Anything not of this shape returns null and is compared verbatim.
 */
function expandLetteredPageRange(value: string): string | null {
  const match = /^\s*([a-z]*)(\d+)([a-z]*)\s*[-–—~]\s*([a-z]*)(\d+)([a-z]*)\s*$/i.exec(value)
  if (!match) return null
  const [, prefix, start, suffix, endPrefixRaw, end, endSuffixRaw] = match
  if (!prefix && !suffix) return null
  const endPrefix = endPrefixRaw || prefix
  const endSuffix = endSuffixRaw || suffix
  if (endPrefix.toLowerCase() !== prefix.toLowerCase() || endSuffix.toLowerCase() !== suffix.toLowerCase()) return null
  const full = end.length >= start.length ? end : start.slice(0, start.length - end.length) + end
  const tag = (number: string) => `${prefix.toLowerCase()}${Number(number)}${suffix.toLowerCase()}`
  return `${tag(start)}-${tag(full)}`
}

function articleNumberConvention(declared: string, found: string): boolean {
  const article = declared.trim().match(/^(\d+)$/)
  if (!article) return false
  const number = article[1]
  const normalized = found.replace(/[–—]/g, '-').replace(/\s+/g, '')
  return new RegExp(`^${number}(?:,|:|-|e)`).test(normalized)
}

/**
 * PubMed's page field may carry attached pages: `651-5; quiz 801`, `1802-13; discussion 1813-4`.
 * Those are the quiz / discussion / author reply pages, not the article's page range; remove them
 * before comparing.
 */
function mainPageRange(value: string): string {
  return value.replace(/\s*[;,]\s*(?:quiz|discussion|author reply|passim)\b.*$/i, '')
    // PubMed records trailing plates as `329-47 3p following 347`.
    .replace(/\s+\d+\s*p\s+following\s+\d+\s*$/i, '')
    .trim()
}

export function comparePages(declaredRaw: string, foundRaw: string): FieldCompareResult {
  if (plain(declaredRaw) === plain(foundRaw)) return { kind: 'same', why: '页码一致' }
  const declared = mainPageRange(declaredRaw)
  const found = mainPageRange(foundRaw)
  if (expandPageRange(declared) === expandPageRange(found)) {
    return { kind: 'convention', why: `页码写法不同，区间相同（${declared.trim()} / ${found.trim()}）` }
  }
  if (articleNumberConvention(declared, found) || articleNumberConvention(found, declared)) {
    return { kind: 'convention', why: `文章号与内部分页是同一篇的两种著录（${declared.trim()} / ${found.trim()}）` }
  }
  return { kind: 'differs', why: `页码与记录不一致（稿件 ${declared.trim()}，记录 ${found.trim()}）` }
}

/** Volume / issue: `07` and `7` are the same issue; zero padding is only a typesetting habit. */
export function compareSerialNumber(field: string, declared: string, found: string): FieldCompareResult {
  const strip = (value: string) => value.replace(/[^\d]/g, '').replace(/^0+(?=\d)/, '')
  const left = strip(declared)
  const right = strip(found)
  const label = field === 'volume' ? '卷号' : '期号'
  /*
   * Supplements: PubMed puts `8 Suppl 4` entirely in the volume field, while manuscripts by convention
   * write `8(Suppl 4)`: volume 8, with the supplement number in the issue slot. Extracting digits
   * would compare 8 with 84. When a supplement marker is present, compare only the leading volume.
   */
  const supplement = /\s*\(?\s*(?:suppl(?:ement)?\.?|增刊)/i
  if (field === 'volume' && (supplement.test(declared) || supplement.test(found))) {
    const head = (value: string) => strip(value.split(supplement)[0] ?? '')
    if (head(declared) && head(declared) === head(found)) {
      return { kind: 'convention', why: `${label}一致，增刊号的写法不同（${declared.trim()} / ${found.trim()}）` }
    }
  }
  /*
   * Supplement in the issue field: PubMed records `1 Suppl 1` (issue 1, supplement 1), while
   * manuscripts by convention write only `Suppl 1`. Extracting digits would give 1 vs 11. They count
   * as two forms of the same issue only if the supplement numbers match and any issue number written
   * on both sides also matches.
   */
  if (field === 'issue' && supplement.test(declared) && supplement.test(found)) {
    const parts = (value: string) => {
      const [head = '', tail = ''] = value.split(supplement)
      return { issue: strip(head), suppl: strip(tail) }
    }
    const a = parts(declared)
    const b = parts(found)
    if (a.suppl === b.suppl && (!a.issue || !b.issue || a.issue === b.issue)) {
      return plain(declared) === plain(found)
        ? { kind: 'same', why: `${label}一致` }
        : { kind: 'convention', why: `${label}一致，增刊号的写法不同（${declared.trim()} / ${found.trim()}）` }
    }
  }
  if (!left || !right) return { kind: 'differs', why: `${label}与记录不一致` }
  if (left !== right) return { kind: 'differs', why: `${label}与记录不一致（稿件 ${declared.trim()}，记录 ${found.trim()}）` }
  return plain(declared) === plain(found)
    ? { kind: 'same', why: `${label}一致` }
    : { kind: 'convention', why: `${label}一致，只是补零写法不同（${declared.trim()} / ${found.trim()}）` }
}

const PUBLISHER_IMPRINT: Record<string, string> = {
  academicpress: 'elsevier',
  saunders: 'elsevier',
  wbsaunders: 'elsevier',
  churchilllivingstone: 'elsevier',
  mosby: 'elsevier',
  pergamon: 'elsevier',
  sinauerassociates: 'oup',
  sinauer: 'oup',
}

function publisherKey(value: string): string {
  const key = plain(value)
  if (key.includes('oxforduniversitypress') || key.includes('sinauer')) return 'oup'
  if (key.includes('elsevier')) return 'elsevier'
  if (key.includes('springer')) return 'springer'
  if (key.includes('wolterskluwer')) return 'wolterskluwer'
  return PUBLISHER_IMPRINT[key] ?? key
}

export function comparePublishers(declared: string, found: string): FieldCompareResult {
  const journal = compareJournals(declared, found)
  if (journal.kind !== 'differs') {
    return journal.kind === 'same' ? { kind: 'same', why: '出版者一致' } : { kind: 'convention', why: '出版者写法不同，指向同一机构' }
  }
  if (publisherKey(declared) === publisherKey(found) && publisherKey(declared)) {
    return { kind: 'convention', why: '出版社与其出版印记指向同一机构' }
  }
  /**
   * Short and full publisher names: `McGraw-Hill` <-> `McGraw-Hill Education`, a Chinese publisher name
   * <-> its full name with the city. Accept only names that **still contain one another after removing
   * generic suffix words**, so that sharing one word does not make two publishers the same.
   */
  const trimSuffix = (value: string) => plain(value)
    .replace(/(education|press|publishing|publishers?|group|inc|ltd|llc|company|co|出版社|出版集团|有限公司)$/g, '')
  const left = trimSuffix(declared)
  const right = trimSuffix(found)
  if (left && right && (left === right || (left.length >= 4 && right.length >= 4
    && (left.startsWith(right) || right.startsWith(left))))) {
    return { kind: 'convention', why: `出版者简称与全称对应（${declared.trim()} / ${found.trim()}）` }
  }
  return { kind: 'differs', why: `出版者与记录不一致（稿件 ${declared.trim()}，记录 ${found.trim()}）` }
}

export function normalizeEdition(value: string): string | null {
  const text = value.trim().toLowerCase().replace(/[第版次]/g, ' ')
  const match = /(?:^|[^\d])(\d{1,2})(?:st|nd|rd|th)?(?:\s*ed(?:ition)?)?\b/.exec(` ${text} `)
    ?? /(\d{1,2})/.exec(text)
  return match?.[1] ?? null
}

export function compareEditions(declared: string, found: string): FieldCompareResult {
  if (plain(declared) === plain(found)) {
    return declared.trim() === found.trim()
      ? { kind: 'same', why: '版次一致' }
      : { kind: 'convention', why: '版次写法不同' }
  }
  const left = normalizeEdition(declared)
  const right = normalizeEdition(found)
  if (left && right && left === right) {
    return { kind: 'convention', why: `版次一致（${declared.trim()} / ${found.trim()}）` }
  }
  return { kind: 'differs', why: '版次与记录不一致' }
}

/**
 * Markers databases add to titles after a retraction or withdrawal: Crossref / PubMed record the
 * 2020 Lancet Surgisphere paper as "RETRACTED: Hydroxychloroquine or chloroquine ...", and there are
 * also "Retracted article: ..." and "... [Retracted]". The marker is not part of the title; if it is
 * not removed, a retracted paper cited under its original title is judged "the identifier points to
 * a different article" and the retraction itself goes unreported.
 */
const RETRACTION_PREFIX = /^\s*(?:\[\s*)?(?:retracted|withdrawn)(?:\s+(?:article|paper|publication))?(?:\s*\])?\s*[:：.\-–—]\s*/i
const RETRACTION_SUFFIX = /\s*[[(]\s*(?:retracted|withdrawn)(?:\s+(?:article|paper|publication))?\s*[\])]\s*[.。]?\s*$/i

function withoutRetractionMark(title: string): string {
  return title.replace(RETRACTION_PREFIX, '').replace(RETRACTION_SUFFIX, '').trim()
}

export function compareTitles(declared: string, found: string): FieldCompareResult {
  if (declared.trim() === found.trim()) return { kind: 'same', why: '题名逐字一致' }
  if (plain(declared) === plain(found)) {
    return { kind: 'convention', why: '题名仅大小写或标点不同' }
  }
  const left = withoutRetractionMark(declared)
  const right = withoutRetractionMark(found)
  if ((left !== declared.trim() || right !== found.trim()) && plain(left) === plain(right)) {
    return { kind: 'convention', why: '题名一致，记录在题名前后加了撤稿或撤回标记' }
  }
  return { kind: 'differs', why: '题名与记录不一致' }
}

/**
 * A citation may contain several four-digit years (start year and update date, access year and
 * publication year). Taking only the first would flag living documents as year conflicts.
 */
export function extractYears(value: string): string[] {
  const years: string[] = []
  const seen = new Set<string>()
  for (const match of value.matchAll(/(?:19|20)\d{2}/g)) {
    if (seen.has(match[0])) continue
    seen.add(match[0])
    years.push(match[0])
  }
  return years
}

function validIsbn10(value: string): boolean {
  if (!/^\d{9}[\dX]$/.test(value)) return false
  const sum = [...value].reduce((total, digit, index) =>
    total + (digit === 'X' ? 10 : Number(digit)) * (10 - index), 0)
  return sum % 11 === 0
}

function isbn13From10(value: string): string | null {
  if (!validIsbn10(value)) return null
  const stem = `978${value.slice(0, 9)}`
  const sum = [...stem].reduce((total, digit, index) =>
    total + Number(digit) * (index % 2 === 0 ? 1 : 3), 0)
  return `${stem}${(10 - (sum % 10)) % 10}`
}

export function normalizedIsbn(value: string): string {
  const compact = value.replace(/[^0-9Xx]/g, '').toUpperCase()
  return compact.length === 10 ? isbn13From10(compact) ?? compact : compact
}

export function isbnEquivalent(left: string, right: string): boolean {
  const normalizedLeft = normalizedIsbn(left)
  const normalizedRight = normalizedIsbn(right)
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight)
}

/**
 * ISBN accepts valid 10/13-digit conversion; years are compared as sets of four-digit numbers that
 * must intersect, without guessing the citation style.
 */
function compareIdentifierish(field: string, declared: string, found: string): FieldCompareResult | null {
  if (field === 'isbn') {
    const left = declared.replace(/[^0-9Xx]/g, '').toUpperCase()
    const right = found.replace(/[^0-9Xx]/g, '').toUpperCase()
    if (!left || !right) return null
    return isbnEquivalent(left, right)
      ? { kind: declared === found ? 'same' : 'convention', why: 'ISBN 一致（10/13 位或分隔符写法不同）' }
      : { kind: 'differs', why: 'ISBN 与记录不一致' }
  }
  if (field === 'standard-number') {
    const left = declared.replace(/[^0-9Xx]/g, '').toUpperCase()
    const right = found.replace(/[^0-9Xx]/g, '').toUpperCase()
    if (!left || !right) return null
    return left === right
      ? { kind: left === right && declared !== found ? 'convention' : 'same', why: '编号一致' }
      : { kind: 'differs', why: '编号与记录不一致' }
  }
  if (field === 'year') {
    const left = extractYears(declared)
    const right = extractYears(found)
    if (!left.length || !right.length) return null
    if (!left.some((year) => right.includes(year))) {
      return { kind: 'differs', why: `出版年不一致（稿件 ${left.join('、')}，记录 ${right.join('、')}）` }
    }
    if (left.length === 1 && right.length === 1 && left[0] === right[0]) {
      return { kind: 'same', why: '出版年一致' }
    }
    return { kind: 'convention', why: `稿件著录含记录年份（${left.join('、')} / ${right.join('、')}）` }
  }
  return null
}

/**
 * The comparison result for one field. The caller sorts fields into same / convention / differs;
 * `unverified` is mostly set by the caller when a field is missing; an incomplete author list (the
 * record is a strict positional prefix of the manuscript list) is returned directly by
 * `comparePersons`. A gap in the middle is still `differs`.
 */
export function compareReferenceField(field: string, declared: string, found: string): FieldCompareResult {
  const special = compareIdentifierish(field, declared, found)
  if (special) return special
  if (field === 'authors' || field === 'organization') return comparePersons(declared, found)
  if (field === 'journal') return compareJournals(declared, found)
  if (field === 'publisher') return comparePublishers(declared, found)
  if (field === 'edition') return compareEditions(declared, found)
  if (field === 'pages') return comparePages(declared, found)
  if (field === 'volume' || field === 'issue') return compareSerialNumber(field, declared, found)
  if (field === 'title') return compareTitles(declared, found)
  if (plain(declared) === plain(found)) {
    return declared.trim() === found.trim()
      ? { kind: 'same', why: '一致' }
      : { kind: 'convention', why: '仅标点或大小写不同' }
  }
  return { kind: 'differs', why: '与记录不一致' }
}
