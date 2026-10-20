// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 TIKMOON LTD
/**
 * The website reference checker: the verdict for one reference.
 *
 * Identity is decided by the desktop app's `verifyEntry` (same rules: exact lookup by identifier first,
 * bibliographic search only when there is none; a wrong DOI is recovered by title).
 * On top of it, the web version adds three things:
 *
 * 1. **The verdict has three layers**: is it this paper (identity) + which fields are written differently
 *    (fields) + publication status (publication). One entry can be "this paper", "authors wrong" and
 *    "retracted" at the same time; these must not be collapsed into one status.
 * 2. **When both DOI and PMID are given, check both**: `verifyEntry` only takes the DOI, so a wrong
 *    PMID would be hidden behind a correct DOI.
 * 3. **Publication status is attached only to the paper the user means to cite**: when the identifier
 *    points to another article, whether that article was retracted is irrelevant to the user and not shown.
 */
import { judgeCitation, verifyEntry, bibliographicIdentityConfirmed, type CitationResult, type EntryHints } from '../../main/citation-verify'
import { parseEntry, similarity, type ParsedEntry } from '../../main/citation-match'
import { extractDoi } from '../../main/doi'
import { compareJournals, compareTitles } from '../../shared/reference-field-compare'
import type { CitationPublicationStatus, CitationVerification } from '../../shared/contracts'
import { declaredAuthors, fieldRows, uncheckedFields, type CheckedField, type FieldRow, type FoundRecord } from './fields'
import { journalLike, parseLocatorLoose, parseStyledEntry } from './formats'

export type Identity =
  /**
   * Recognized as this paper (fetched by identifier and the title etc. match, or found uniquely by
   * bibliographic search and confirmed by fetching its identifier).
   */
  | 'verified'
  /** Wrong DOI: the paper was found by title, and its registered DOI differs from the one in the entry. */
  | 'wrong-doi'
  /** The identifier is real but points to another article. */
  | 'points-elsewhere'
  /** A very similar record was found but could not be confirmed as the same paper; needs a human look. */
  | 'needs-review'
  /**
   * The identifier in the entry cannot be found (PMID not in PubMed; DOI not in PubMed, Crossref or
   * the DOI registration agency).
   */
  | 'id-not-found'
  /**
   * No identifier given, and no confirmable record found by bibliographic search. Not found does not
   * mean the reference is fake.
   */
  | 'no-match'
  /** The lookup did not complete this time (network, database busy); can be retried. */
  | 'failed'

export interface CheckRecord {
  title: string
  authors: string
  journal: string
  pubdate: string
  volume: string | null
  issue: string | null
  pages: string | null
  doi: string | null
  pmid: string | null
  url: string | null
  source: string
}

export interface IdProblem {
  /**
   * `*-unchecked`: this identifier could not be looked up this time (network, database busy); not
   * counted as wrong.
   */
  kind: 'pmid-not-found' | 'pmid-elsewhere' | 'pmid-unchecked' | 'doi-not-found' | 'doi-elsewhere' | 'doi-unchecked'
  id: string
  /** Title of the article this identifier actually points to (when it points elsewhere). */
  otherTitle: string | null
}

export interface EntryCheck {
  identity: Identity
  identifiers: { doi: string | null; pmid: string | null }
  /**
   * The record found: for verified / wrong-doi it is the paper the user means to cite; for
   * points-elsewhere it is the paper the identifier actually points to; for needs-review it is the close
   * candidate.
   */
  record: CheckRecord | null
  /** When the DOI is wrong, the correct DOI found by title. */
  suggestedDoi: string | null
  fields: FieldRow[]
  /**
   * Fields present in the record that could not be parsed from the entry and so were not compared
   * (volume, pages, year). Only given for verified / wrong-doi.
   */
  unchecked: CheckedField[]
  /** Only given for verified / wrong-doi; null otherwise. */
  publication: CitationPublicationStatus | null
  /** When both identifiers are given and one of them has a problem. */
  idProblems: IdProblem[]
  /**
   * The database failed during the title fallback search: "not found" only means the identifier was not
   * found; the title step did not finish and can be retried.
   */
  titleSearchFailed: boolean
}

export interface CheckDeps {
  lookup: (identifier: string, signal?: AbortSignal) => Promise<CitationVerification>
  search: (entry: string, rows?: number, signal?: AbortSignal) => Promise<unknown[]>
  searchNearYear?: (entry: string, year: number, rows?: number, signal?: AbortSignal) => Promise<unknown[]>
}

const PMID_IN_TEXT = /\bPMID[:：\s]*(\d{1,9})\b/i
/** A percent-encoded DOI in a URL (`doi.org/10.1016/S0140-6736%2820%2932381-3`). */
const ENCODED_DOI = /\b10\.\d{4,9}(?:\/|%2F)\S*/gi
/**
 * Old-style SICI DOIs contain `<` `>`
 * (`10.1002/(SICI)1097-0258(19960615)15:11<1231::AID-SIM245>3.0.CO;2-Q`); extraction truncates at `<`.
 */
const SICI_DOI = /\b10\.\d{4,9}\/\S*\(SICI\)\S*/gi

/**
 * Before looking up, normalize the DOI in the entry so it can be extracted reliably: decode percent
 * encoding; SICI-style DOIs cannot be extracted in full, so drop them and use bibliographic search
 * rather than judging "wrong DOI" from a truncated prefix.
 */
function normalizeEntry(entry: string): string {
  return entry
    .replace(ENCODED_DOI, (doi) => {
      if (!/%[0-9A-Fa-f]{2}/.test(doi)) return doi
      try { return decodeURIComponent(doi) } catch { return doi }
    })
    .replace(SICI_DOI, '')
}

function identifiersOf(entry: string): { doi: string | null; pmid: string | null } {
  return { doi: extractDoi(entry), pmid: PMID_IN_TEXT.exec(entry)?.[1] ?? null }
}

function recordOf(result: CitationResult): CheckRecord | null {
  const record = result.record as (CitationResult['record'] & Partial<Pick<CheckRecord, 'volume' | 'issue' | 'pages'>>) | null
  if (!record) return null
  return {
    title: record.title,
    authors: record.authors,
    journal: record.journal,
    pubdate: record.pubdate,
    volume: record.volume ?? null,
    issue: record.issue ?? null,
    pages: record.pages ?? null,
    doi: record.doi ?? null,
    pmid: record.pmid ?? null,
    url: record.url ?? null,
    source: record.source,
  }
}

function identityOf(result: CitationResult, entryDoi: string | null): Identity {
  switch (result.verdict) {
    case 'unavailable': return 'failed'
    case 'not-found': return 'id-not-found'
    case 'no-identifier': return 'id-not-found'
    case 'no-match': return 'no-match'
    case 'mismatch': {
      const found = result.record?.doi?.trim().toLowerCase()
      if (result.identityMatch?.matchedBy === 'metadata' && found && found !== entryDoi?.toLowerCase()) return 'wrong-doi'
      // The paper fetched by identifier has a title matching the entry, only the year (or volume/issue/pages)
      // differs: this paper has one field wrong; the identifier does not point elsewhere.
      // Identity and fields are reported separately.
      const title = result.identityMatch?.title
      return result.identityMatch?.matchedBy === 'id' && (title === 'same' || title === 'convention') ? 'verified' : 'points-elsewhere'
    }
    case 'candidate': return 'needs-review'
    case 'found': return bibliographicIdentityConfirmed(result) ? 'verified' : 'needs-review'
  }
}

function sameWork(left: CheckRecord | null, right: CheckRecord | null): boolean {
  if (!left || !right) return false
  const doiL = left.doi?.toLowerCase()
  const doiR = right.doi?.toLowerCase()
  if (doiL && doiR) return doiL === doiR
  if (left.pmid && right.pmid) return left.pmid === right.pmid
  // Only look at the title when neither side has a comparable identifier (different papers with the same
  // title are not the same paper once their identifiers conflict).
  return Boolean(left.title && right.title && compareTitles(left.title, right.title).kind !== 'differs')
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Only authors, year and number should come before the title: a lowercase word of 4+ letters means
 * part of the title is still in front.
 */
const TITLE_BEFORE = /(?<![\p{L}\p{N}'’\-])\p{Ll}{4,}/u
/**
 * The segment after the title and before volume/issue/pages, DOI or URL should be the journal name (or
 * empty).
 */
const AFTER_JOURNAL_END = /\d|\b(?:doi|https?|available|retrieved|published|epub)\b/i

/**
 * When these words precede the title, the entry cites a correction, retraction notice, comment or
 * reply, not the original article itself.
 */
const NOTICE_BEFORE = /\b(?:erratum|correction|corrigendum|retraction|comment|reply)\b/i
/**
 * DOI prefixes of preprint servers (same list as the desktop app); when the entry does not show it is
 * a preprint, a preprint fetched by identifier is not accepted as the paper directly.
 */
const PREPRINT_DOI = /^10\.(?:1101|21203|2139|48550|20944)\//i
const PREPRINT_VENUE = /\b(?:medrxiv|biorxiv|research\s*square|ssrn|arxiv|preprints?)\b/i

export interface TitleSpan {
  /** The title segment exactly as written in the entry. */
  text: string
  /** The segment after the title and before volume/issue/pages (journal name; empty string if none). */
  journal: string
}

/**
 * The segment of the entry where the record title appears verbatim (word by word, ignoring punctuation
 * and case); titles that are too short are not searched.
 *
 * `recordTitleSpan` uses it to accept this paper when the record title fetched by identifier is
 * **the whole title** in the entry, even if the citation format was not split correctly (`U.S.` in the
 * title, missing period after the title). All three must hold:
 * - Only authors, year and number come before it (otherwise the entry contains another paper's title);
 *   a Correction / Erratum / Reply prefix means the entry cites that notice and does not count either;
 * - It is not directly followed by an alphanumeric character (not the first half of a longer title);
 * - Only the journal name follows before volume/issue/pages; an irregularly written journal name
 *   ("Clinical neurophysiology", "eLife") also counts when it matches the record's journal.
 * Returns the original title segment from the entry and the journal segment after it, or null.
 */
function titleMatch(recordTitle: string | null | undefined, entry: string): RegExpExecArray | null {
  const title = recordTitle?.replace(/^\s*(?:\[\s*)?(?:retracted|withdrawn)[^:]*:\s*/i, '').trim()
  const words = title?.match(/[\p{L}\p{N}]+/gu)
  if (!words || words.join(' ').length < 20) return null
  const body = words.map(escapeRegExp).join('[^\\p{L}\\p{N}]+')
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'iu').exec(entry.normalize('NFC'))
}

export function recordTitleSpan(record: CheckRecord | null, entry: string): TitleSpan | null {
  const text = entry.normalize('NFC')
  const match = titleMatch(record?.title, entry)
  if (!match) return null
  const before = text.slice(0, match.index)
  if (NOTICE_BEFORE.test(before)) return null
  if (TITLE_BEFORE.test(before.replace(/\b(?:van|von|der|den|del|della|dos|et al)\b/gi, ''))) return null
  const after = text.slice(match.index + match[0].length)
  const journal = after.slice(0, after.search(AFTER_JOURNAL_END) >= 0 ? after.search(AFTER_JOURNAL_END) : after.length)
    .replace(/[^\p{L}\p{N}.'’\-&:\s]/gu, ' ').replace(/^[\s.:]+|[\s.:]+$/g, '')
  const journalFits = journal === '' || journalLike(journal)
    || Boolean(record?.journal && compareJournals(journal, record.journal).kind !== 'differs')
  return journalFits ? { text: match[0], journal } : null
}

function recordTitleInEntry(record: CheckRecord | null, entry: string): boolean {
  return recordTitleSpan(record, entry) !== null
}

/** Four-digit years in the entry (excluding digits inside DOIs and URLs). */
function entryYears(entry: string): number[] {
  const text = entry.replace(/\b(?:https?:\/\/|doi:?\s*|10\.\d{4,9}\/)\S*/gi, ' ')
  return [...text.matchAll(/(?<!\d)(1[6-9]\d{2}|20\d{2})(?!\d)/g)].map((m) => Number(m[1]))
}

/**
 * Fetched by the entry's own identifier, the record title is written in full in the entry, and the
 * year does not conflict: it is this paper, even if the title could not be parsed from the citation
 * format (Chicago quoted titles, titles ending in a year range, journal names starting lowercase).
 * If the entry gives a year, at least one must be within one year of the record;
 * when a preprint is fetched but the entry does not show it is a preprint, do not accept directly (the
 * journal version and the preprint are separate registrations).
 */
function confirmedByOwnId(result: CitationResult, entry: string): boolean {
  if (result.identityMatch?.matchedBy !== 'id' || result.identityMatch.year === 'differs') return false
  const record = recordOf(result)
  if (!record || !recordTitleInEntry(record, entry)) return false
  if (record.doi && PREPRINT_DOI.test(record.doi) && !PREPRINT_VENUE.test(entry)) return false
  const found = /\b(1[6-9]\d{2}|20\d{2})\b/.exec(record.pubdate ?? '')?.[1]
  const years = entryYears(entry)
  if (!years.length || !found) return true
  return years.some((year) => Math.abs(year - Number(found)) <= 1)
}

/**
 * Content words of a title (4+ letters, common function words removed), for checking whether the
 * record title and the entry share words.
 */
const TITLE_FILLER = new Set('with from that this into among after before between during within without their which study trial analysis results using based patients'.split(' '))
function contentWords(text: string): string[] {
  return (text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().match(/[a-z0-9][a-z0-9-]{3,}/g) ?? [])
    .filter((word) => !TITLE_FILLER.has(word)).map((word) => word.replace(/(?:ies|es|s)$/, ''))
}

/**
 * Fraction of the record title's content words that appear in the entry (works even if the entry's
 * title was not parsed correctly).
 */
function recordTitleOverlap(recordTitle: string, entry: string): number {
  const words = [...new Set(contentWords(recordTitle))]
  if (!words.length) return 1
  const present = new Set(contentWords(entry))
  return words.filter((word) => present.has(word)).length / words.length
}

const agrees = (row: FieldRow | undefined) => row?.status === 'same' || row?.status === 'convention'

/**
 * When fetched by identifier but the title does not match, there are tiers:
 * - The title was parsed cleanly, pages (or volume plus authors) match, and year, volume/issue/pages and
 *   authors do not conflict: the identifier is this paper, **the title is wrong** (verified, with the
 *   title row reported as differing). A one-word typo also falls into this tier.
 * - The whole record title is in the entry but the entry's title is another segment (an abstract in a
 *   supplement): needs a human look.
 * - Volume, pages or authors are wrong, neither pages nor authors match, and almost none of the record
 *   title's content words are in the entry: the identifier points to another paper.
 * - Everything else still needs a human look. Chinese entries skip the second tier (the record may be
 *   registered under an English translated title).
 */
function reviewTier(result: CitationResult, entry: string, parsed: ParsedEntry, authors: string | null): Identity {
  const record = recordOf(result)
  if (!record) return 'needs-review'
  const rows = fieldRows(parsed, authors, record as FoundRecord)
  const row = (field: FieldRow['field']) => rows.find((item) => item.field === field)
  const conflict = rows.some((item) => item.status === 'differs' && ['year', 'volume', 'issue', 'pages'].includes(item.field))
  const titleTrusted = Boolean(parsed.title && parsed.title.length >= 20 && /\s\S+\s/.test(parsed.title)) && row('title')?.status === 'differs'
  const overlap = recordTitleOverlap(record.title, entry)
  // The whole record title is written in the entry but the entry's title is another segment (an abstract in
  // a conference supplement, a chapter in a book): the identifier registers the whole volume; needs a
  // human look.
  const flat = (text: string) => text.normalize('NFKD').replace(/[\s\p{P}\p{M}]/gu, '').toLowerCase()
  const partOfLarger = Boolean(parsed.title) && ((overlap >= 0.6 && similarity(parsed.title!, record.title) < 0.5)
    || (flat(parsed.title!).includes(flat(record.title)) && flat(parsed.title!).length - flat(record.title).length >= 15))
  if (result.verdict === 'candidate' && titleTrusted && !partOfLarger && !conflict && result.identityMatch?.year !== 'differs'
    && row('authors')?.status !== 'differs' && (agrees(row('pages')) || (agrees(row('volume')) && agrees(row('authors'))))) return 'verified'
  // Papers in the same journal and year share the volume anyway, so a matching volume is not evidence;
  // only matching pages or authors count.
  // The record's first author surname appearing at the start of the entry also counts as an author match
  // (the author segment is often mis-split, and a mis-split row cannot be evidence of "wrong authors").
  const firstSurname = record.authors.split(/[;,]/)[0]?.trim().split(/\s+/)[0]
  const leadAuthor = Boolean(firstSurname && firstSurname.length >= 2
    && new RegExp(`(?<![\\p{L}])${escapeRegExp(firstSurname)}(?![\\p{L}])`, 'iu').test(entry.slice(0, 60)))
  const anyAgree = agrees(row('pages')) || agrees(row('authors')) || leadAuthor
  const anyDiffers = rows.some((item) => item.status === 'differs' && item.field !== 'title')
  if (!anyAgree && anyDiffers && !/[\u3400-\u9fff]/.test(entry) && overlap < 0.34) return 'points-elsewhere'
  return 'needs-review'
}

/**
 * Identity after fetching by identifier: adds "record title appears verbatim in the entry" and the
 * tiers for a title mismatch on top of the verdict.
 */
function ownIdentity(result: CitationResult, entryDoi: string | null, entry: string, parsed: ParsedEntry, authors: string | null): Identity {
  const identity = identityOf(result, entryDoi)
  if (identity === 'points-elsewhere' && recordTitleInEntry(recordOf(result), entry)) return 'verified'
  // Title differs by only a word or two (typo, singular/plural), year does not conflict, and there are no
  // volume/issue/pages to compare: cannot tell whether the identifier or the title is wrong; leave it to a
  // human.
  if (identity === 'points-elsewhere' && result.verdict === 'mismatch' && result.identityMatch?.matchedBy === 'id'
    && result.identityMatch.title === 'differs' && result.identityMatch.year !== 'differs'
    && parsed.title && result.record && similarity(parsed.title, result.record.title) >= 0.75) return 'needs-review'
  if (identity !== 'needs-review' || result.identityMatch?.matchedBy !== 'id') return identity
  if (confirmedByOwnId(result, entry)) return 'verified'
  return reviewTier(result, entry, parsed, authors)
}

/**
 * When Vancouver / GB/T parsing cannot extract volume/issue/pages, fill them in with the web version's
 * loose parser (`parseLocatorLoose`), only for empty fields.
 * The loose parser only accepts the segment at the end of the entry, right after the journal name,
 * followed only by a DOI or the end of the sentence (by position and structure); extracted values are
 * compared and reported as wrong as usual.
 */
function withLooseLocator(parsed: ParsedEntry, entry: string): ParsedEntry {
  if (parsed.volume !== null) return parsed
  const loose = parseLocatorLoose(entry)
  if (!loose) return parsed
  return {
    ...parsed,
    volume: loose.volume,
    issue: parsed.issue ?? loose.issue,
    pages: parsed.pages ?? loose.pages,
    year: parsed.year ?? loose.year,
  }
}

/**
 * The entry explicitly cites a notice ("Correction to: <title>", "Erratum for <title>", "Comment on:
 * <title>") but the record is the original article. Decided by position:
 * the notice prefix sits directly before the record title; when the record title is not found in the
 * entry, check whether the parsed title starts with a notice prefix.
 * Not blocked when the record title itself starts with these words (the record is that notice).
 */
const NOTICE_WORDS = String.raw`(?:correction|erratum|corrigendum|retraction(?:\s+note)?|expression\s+of\s+concern|comment|commentary|reply|response|author(?:s['’]?)?\s+reply)(?:\s*[:：]|\s+(?:to|on|of|for|regarding)\s*[:：]|\s+(?:to|on|for)\b)`
const NOTICE_TAIL = new RegExp(String.raw`(?:^|[\s.,;“"‘(])${NOTICE_WORDS}[\s“"‘]*$`, 'i')
const NOTICE_HEAD = new RegExp(String.raw`^[\s“"‘[]*${NOTICE_WORDS}`, 'i')
const NOTICE_TITLE = /^\s*(?:\[\s*)?(?:correction|erratum|corrigendum|retraction|expression\s+of\s+concern|comment|commentary|reply|response|author(?:s['’]?)?\s+reply)\b/i
function citesNotice(entry: string, recordTitle: string, parsedTitle: string | null): boolean {
  if (NOTICE_TITLE.test(recordTitle)) return false
  const match = titleMatch(recordTitle, entry)
  if (match) return NOTICE_TAIL.test(entry.normalize('NFC').slice(0, match.index))
  return Boolean(parsedTitle && NOTICE_HEAD.test(parsedTitle))
}

function journalAfterSpan(entry: string, spanText: string, journal: string | null): string | null {
  if (!journal?.trim()) return null
  const text = entry.normalize('NFC')
  const end = text.indexOf(spanText) + spanText.length
  if (end < spanText.length || spanText.toLowerCase().includes(journal.toLowerCase())) return null
  return text.slice(end).toLowerCase().includes(journal.toLowerCase()) ? journal : null
}

/** Judge once more by PMID alone. */
async function judgeByPmid(entry: string, pmid: string, deps: CheckDeps, hints: EntryHints | undefined, signal?: AbortSignal): Promise<CitationResult> {
  return judgeCitation(entry, await deps.lookup(pmid, signal), hints)
}

export async function checkEntry(rawEntry: string, deps: CheckDeps, signal?: AbortSignal): Promise<EntryCheck> {
  const entry = normalizeEntry(rawEntry)
  const identifiers = identifiersOf(entry)
  // If any step of the title path (search, then fetching the candidate by its identifier) did not
  // complete, we cannot say "not found by title either".
  let titleSearchFailed = false
  const tracked = <A extends unknown[], R>(fn: (...args: A) => Promise<R>) => async (...args: A): Promise<R> => {
    try { return await fn(...args) } catch (error) { if (!signal?.aborted) titleSearchFailed = true; throw error }
  }
  const ownIds = new Set([identifiers.doi?.toLowerCase(), identifiers.pmid].filter(Boolean))
  const lookup = deps.lookup
  deps = {
    search: tracked(deps.search),
    searchNearYear: deps.searchNearYear && tracked(deps.searchNearYear),
    lookup: async (identifier, lookupSignal) => {
      const own = ownIds.has(identifier.trim().toLowerCase())
      const result = await (own ? lookup : tracked(lookup))(identifier, lookupSignal)
      if (!own && !result.found && result.reason === 'unavailable' && !signal?.aborted) titleSearchFailed = true
      return result
    },
  }
  // Nature / APA style entries are parsed by format first, with the title passed to the verdict as a hint;
  // Vancouver and GB/T are still parsed by parseEntry.
  const styled = parseStyledEntry(entry)
  const hints: EntryHints | undefined = styled ? { title: styled.title, year: styled.year, journal: styled.journal } : undefined
  const parsedEntry = withLooseLocator(styled ?? parseEntry(entry), entry)
  const parsedAuthors = styled?.authors ?? declaredAuthors(entry, parsedEntry.title)
  const primary = (await verifyEntry(entry, deps, signal, hints)).result
  let main = primary
  let identity = ownIdentity(primary, identifiers.doi, entry, parsedEntry, parsedAuthors)
  const idProblems: IdProblem[] = []

  if (identifiers.doi && identifiers.pmid) {
    const byPmid = await judgeByPmid(entry, identifiers.pmid, deps, hints, signal)
    const pmidIdentity = ownIdentity(byPmid, null, entry, parsedEntry, parsedAuthors)
    const pmidRecord = recordOf(byPmid)
    if (identity === 'verified' || identity === 'wrong-doi') {
      // The DOI side was recognized (or recovered by title): the PMID must point to the same paper.
      if (pmidIdentity === 'id-not-found') idProblems.push({ kind: 'pmid-not-found', id: identifiers.pmid, otherTitle: null })
      else if (pmidIdentity === 'failed') idProblems.push({ kind: 'pmid-unchecked', id: identifiers.pmid, otherTitle: null })
      else if (!sameWork(recordOf(main), pmidRecord)) {
        idProblems.push({ kind: 'pmid-elsewhere', id: identifiers.pmid, otherTitle: pmidRecord?.title ?? null })
      }
    } else if (pmidIdentity === 'verified') {
      // The DOI was not recognized but the PMID was: go by the PMID and report the DOI problem separately. A
      // lookup that did not complete is not counted as wrong.
      const doiRecord = recordOf(primary)
      if (identity === 'failed') idProblems.push({ kind: 'doi-unchecked', id: identifiers.doi, otherTitle: null })
      else if (identity === 'id-not-found') idProblems.push({ kind: 'doi-not-found', id: identifiers.doi, otherTitle: null })
      else if (!sameWork(doiRecord, pmidRecord)) {
        idProblems.push({ kind: 'doi-elsewhere', id: identifiers.doi, otherTitle: doiRecord?.title ?? null })
      }
      main = byPmid
      identity = 'verified'
    }
  }

  // The entry cites a correction, comment or reply ("Correction to: <title>") but the record is the
  // original: whichever path recognized it, it does not count as this paper.
  if ((identity === 'verified' || identity === 'wrong-doi') && citesNotice(entry, recordOf(main)?.title ?? '', parsedEntry.title)) identity = 'needs-review'
  const record = recordOf(main)
  const ownsRecord = identity === 'verified' || identity === 'wrong-doi'
  // When the record title appears verbatim in the entry, use that title segment from the entry as the
  // basis for comparing the other fields (when the format was mis-parsed the title is split wrongly or
  // not at all).
  const span = record && ownsRecord && (!parsedEntry.title || compareTitles(parsedEntry.title, record.title).kind === 'differs')
    ? recordTitleSpan(record, entry) : null
  const parsed: ParsedEntry = span ? { ...parsedEntry, title: span.text } : { ...parsedEntry }
  // The title was recovered from the entry text: recompute the author segment and journal name from this
  // title's position instead of reusing the boundaries from the mis-parsed format.
  const authors = span ? declaredAuthors(entry, span.text) : styled?.authors ?? declaredAuthors(entry, parsed.title)
  // The journal name from the format parse is after the recovered title, not inside it: the boundary is
  // reliable, compare as usual. Otherwise it was cut along with the wrong title; do not compare, record
  // as "not checked".
  if (span) parsed.journal = journalAfterSpan(entry, span.text, parsedEntry.journal)
  const fields = record && (ownsRecord || identity === 'needs-review') ? fieldRows(parsed, authors, record as FoundRecord) : []
  const unchecked = record && ownsRecord ? uncheckedFields(parsed, record as FoundRecord, fields) : []
  if (span && !parsed.journal && record?.journal?.trim() && ownsRecord) unchecked.push('journal')
  return {
    identity,
    identifiers,
    record,
    suggestedDoi: identity === 'wrong-doi' ? record?.doi ?? null : null,
    fields,
    unchecked,
    publication: ownsRecord ? main.record?.publicationStatus ?? null : null,
    idProblems,
    titleSearchFailed: identity === 'id-not-found' && titleSearchFailed,
  }
}
