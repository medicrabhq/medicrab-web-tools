// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 TIKMOON LTD
/**
 * Verify one reference: extract identifiers from the entry, look it up by identifier or by
 * bibliographic search, and turn the lookup result into a verdict.
 *
 * Only judgment and lookup orchestration live here; nothing is stored. The desktop app
 * and the website reference checker (browser version) share this file, so the rules are identical on
 * both. Lookup functions are injected by the caller (both use pubmed-service; the browser uses its
 * browser build). **Do not introduce Node / Electron dependencies here**: the website build bundles
 * this file into a browser script and would fail.
 */
import type { CitationPublicationStatus, CitationVerification as PubmedLookup } from '../shared/contracts'
import { locatorFieldsAlign, parseEntry, pickMatch, toCandidate, verifyCandidate, type Candidate, type ParsedEntry } from './citation-match'
import { journalAnchorHits, resolveJournal } from './journal-registry'
import { extractDoi } from './doi'
import { compareJournals, compareReferenceField, compareTitles, type FieldCompareKind } from '../shared/reference-field-compare'
import { GROUP_AUTHOR } from '../shared/person-name'

/**
 * Identifiers that may appear in a reference entry. **DOI before PMID**: when an entry has both, the
 * DOI is more precise.
 */
const PMID_IN_TEXT = /\bPMID[:：\s]*(\d{1,9})\b/i

/**
 * Extract identifiers from a reference that can be looked up exactly.
 *
 * **Return null if none is found; do not guess.** A semantic search on the title for something that
 * "looks like" it would let a model assert "this citation is wrong" when no exact match was ever made.
 * No identifier means honestly saying there is none.
 */
export function extractIdentifier(entry: string): string | null {
  const doi = extractDoi(entry)
  if (doi) return doi
  const pmid = entry.match(PMID_IN_TEXT)
  if (pmid) return pmid[1]
  return null
}

export type CitationVerdict =
  /**
   * For an entry without an identifier, bibliographic matching **found a candidate that passed the
   * deterministic check**.
   * This is **not** "verified"; it means "we found a very similar record, please compare".
   */
  | 'candidate'
  /**
   * An entry without an identifier was searched and no candidate passed the check. **This does not mean
   * the citation is wrong.**
   */
  | 'no-match'
  /**
   * The identifier exists and the real record was retrieved, **but it still has to be compared with the
   * authors / year / topic written in the manuscript**.
   */
  | 'found'
  /**
   * The identifier exists, but the full reference's title or year definitely does not match the real
   * record it points to.
   */
  | 'mismatch'
  /** Exact lookup by identifier definitely found nothing. */
  | 'not-found'
  /** The entry has no PMID / DOI at all, so lookup by identifier is not possible. */
  | 'no-identifier'
  /** Network or API failure. **Must be kept separate from "does not exist".** */
  | 'unavailable'

export interface CitationResult {
  verdict: CitationVerdict
  /** One-sentence summary of the result. **No full record**: the structured fields carry that. */
  note: string
  /** The real record retrieved, written into the results table for the user to compare item by item. */
  record: {
    title: string
    authors: string
    journal: string
    pubdate: string
    source: string
    url?: string
    doi?: string
    pmid?: string
    isbn?: string
    publicationStatus?: CitationPublicationStatus
    abstract?: string
    aminerId?: string
    volume?: string
    issue?: string
    pages?: string
    /**
     * Other publication dates registered for the record (electronic / online / print); see
     * `CitationRecord.otherDates`.
     */
    otherDates?: string[]
  } | null
  /**
   * Work identity is stored separately from the verdict: `candidate` does not mean "not found", nor
   * does it automatically mean verified.
   */
  identityMatch?: CitationIdentityMatch
}

export interface CitationIdentityMatch {
  matchedBy: 'id' | 'metadata'
  title: FieldCompareKind | 'unverified'
  year: 'same' | 'differs' | 'unverified'
  journal: FieldCompareKind | 'unverified'
  uniqueMatch: boolean
  sourceRecord: boolean
  /** Whether the language-neutral anchor of year + volume/issue/pages closes. */
  locatorClosed?: boolean
  /** Whether the candidate hits the journal registry row of the cited journal. */
  journalAnchored?: boolean
  /**
   * A preprint revision changed its title: preprint DOI + same year + same first author counts as the
   * same work (the title is still recorded as differs for field comparison).
   */
  preprintRetitled?: boolean
}

export function bibliographicIdentityConfirmed(result: CitationResult): boolean {
  const match = result.identityMatch
  if (!match || !match.uniqueMatch || !match.sourceRecord) return false
  if (match.preprintRetitled && match.year === 'same') return true
  if (match.title !== 'same' && match.title !== 'convention') return false
  if (match.year === 'same' || match.journal === 'same' || match.journal === 'convention') return true
  /*
   * A record retrieved by identifier whose title matches verbatim, with no conflict in year or journal,
   * also counts as settled. The CHNDOI registration page often leaves the source and publication year
   * fields empty, so year and journal can only be unverified; without this rule a confirmed identifier
   * would not be written into the result. A verbatim title match is stronger than the year.
   */
  return match.matchedBy === 'id' && result.verdict === 'found' && match.title === 'same'
    && match.year !== 'differs' && match.journal !== 'differs'
}

/** DOI prefixes of preprint platforms: medRxiv / bioRxiv, Research Square, SSRN, arXiv, Preprints.org. */
const PREPRINT_DOI = /^10\.(?:1101|21203|2139|48550|20944)\//i

function surname(value: string): string | null {
  return /^\s*(?:[[［]\d+[\]］]|\d+[.、．])?\s*([A-Za-zÀ-ÿ'’-]{2,})/.exec(value)?.[1]?.toLowerCase() ?? null
}

const TITLE_FILLER = new Set(('with from that this into among after before between during within without their which '
  + 'study trial analysis results using based patients').split(' '))

/**
 * Content words of a title (four letters or more, common function words and study boilerplate
 * removed, crude plural stripping).
 */
function titleWords(title: string): Set<string> {
  return new Set((title.toLowerCase().match(/[a-z0-9][a-z0-9-]{3,}/g) ?? [])
    .filter((word) => !TITLE_FILLER.has(word))
    .map((word) => word.replace(/(?:ies|es|s)$/, '')))
}

/**
 * Surnames listed in the part of the entry before the title (the author list):
 * "Smith J, Doe A, Lee K, ..." -> smith, doe, lee.
 */
function entrySurnames(entry: string, title: string): string[] {
  const at = entry.indexOf(title)
  const head = at > 0 ? entry.slice(0, at) : ''
  return (head.match(/[A-Za-zÀ-ÿ'’-]{2,}/g) ?? [])
    .filter((token) => !/^(?:et|al|and|[A-Z]{1,3})$/.test(token))
    .map((token) => token.toLowerCase())
}

/**
 * A preprint revision changed its title (the entry cites the original title of a medRxiv DOI, while
 * Crossref now holds the revised one). The identifier is from a preprint platform, the year matches,
 * the first author's surname is the same, **and** at least two other authors in the entry are among
 * the registered authors and the old and new titles share at least two content words: only then is it
 * the same work with a changed title. Checking only surname and year would accept a wrong DOI pointing
 * to another preprint by an author with the same surname as "found". Preprints only: journal articles
 * rarely change titles, so there the title still distinguishes two papers.
 */
function preprintRetitled(entry: string, parsed: ReturnType<typeof parseWithHints>, candidate: Candidate): boolean {
  if (!PREPRINT_DOI.test(candidate.doi ?? '')) return false
  if (!parsed.year || !candidate.year || parsed.year !== candidate.year) return false
  if (!parsed.title || compareTitles(parsed.title, candidate.title).kind !== 'differs') return false
  const declared = surname(entry)
  const recorded = surname(candidate.authors[0] ?? '')
  if (!declared || !recorded || declared !== recorded) return false
  const registered = new Set(candidate.authors.map((author) => surname(author)).filter(Boolean))
  const coauthors = entrySurnames(entry, parsed.title).slice(1).filter((name) => registered.has(name))
  if (new Set(coauthors).size < 2) return false
  const recordWords = titleWords(candidate.title)
  return [...titleWords(parsed.title)].filter((word) => recordWords.has(word)).length >= 2
}

function authorsForNote(authors: string[]): string {
  return authors.slice(0, 3).join(', ') + (authors.length > 3 ? ' 等' : '')
}

/**
 * Authoritative authors must be written into the record complete and in order; truncation is only for
 * the note. Otherwise author-order checks would lose middle positions.
 */
function authorsForRecord(authors: string[]): string {
  return authors.join('; ')
}

/**
 * Reference fields already parsed by the caller (the desktop app may supply title / year / journal).
 * Priority differs by field:
 * - title: a supplied title overrides the regex-parsed one; the regex title is only a fallback.
 * - year, journal: the regex result wins; the hint is used only when the regex finds nothing
 *   (full-width punctuation, unusual formats). A year hint is reduced to its first 19xx/20xx.
 */
export interface EntryHints {
  title?: string | null
  year?: number | string | null
  journal?: string | null
}

function parseWithHints(entry: string, hints?: EntryHints): ParsedEntry {
  const parsed = parseEntry(entry)
  if (!hints) return parsed
  const year = typeof hints.year === 'number' ? hints.year : Number(/\b(19\d{2}|20\d{2})\b/.exec(String(hints.year ?? ''))?.[1] ?? '') || null
  return {
    ...parsed,
    /*
     * The supplied title takes precedence; the regex-parsed title is only a fallback: for an entry with no
     * authors (Chinese title, then journal name, then `2025(5):184-187`), the regex takes the journal name
     * as the title, and a DOI match with a verbatim matching title would be judged "title does not match
     * the record".
     */
    title: hints.title?.trim() || parsed.title,
    year: parsed.year ?? year,
    journal: parsed.journal ?? (hints.journal?.trim() || null),
  }
}

/**
 * The title of the record retrieved by identifier = the manuscript title + a subtitle. Journal
 * citations often omit the subtitle (cited "X", registered "X (ACRONYM): a national, multicentre,
 * observational cohort study"); the DOI is that paper and must not be judged "identifier attached to a
 * different article".
 * Used only for retrieval by identifier (the identifier itself is the identity anchor); title search
 * is not relaxed, since "X" and "X: the Berlin Definition" in the same year may be two papers.
 */
function subtitleOmitted(parsed: ParsedEntry, recordTitle: string, pubdate: string): boolean {
  const declared = parsed.title?.trim().replace(/[.。]+$/, '') ?? ''
  const found = recordTitle.trim()
  if (declared.length < 20 || found.length <= declared.length) return false
  const head = found.slice(0, declared.length)
  if (head.toLowerCase() !== declared.toLowerCase()) return false
  if (!/^\s*[:：(（—–-]/.test(found.slice(declared.length))) return false
  const year = Number(/\b(19\d{2}|20\d{2})\b/.exec(pubdate)?.[1] ?? '') || null
  return !parsed.year || !year || Math.abs(parsed.year - year) <= 1
}

/** For comparison: lowercase, letters and digits only. */
function comparable(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

/**
 * For older papers with a group author, PubMed appends the group name to the title (e.g. UKPDS 33,
 * PMID 9742976): the registered title is "Intensive blood-glucose control ... (UKPDS 33). UK
 * Prospective Diabetes Study (UKPDS) Group." and the author field is empty. Compared verbatim with the
 * cited title, the same paper becomes "title mismatch, needs comparison". Strip the appended part only
 * when it looks like a group name **and the citation itself names that group**; the returned title is
 * only for comparison, and the displayed record stays as registered.
 */
export function withoutGroupAuthorSuffix(recordTitle: string, entry: string, declaredTitle?: string | null): string {
  const title = recordTitle.trim()
  const match = /^(.{8,}?[.?!])\s+([^.?!]{6,})\.?$/.exec(title)
  if (!match) return title
  const suffix = match[2]!.trim()
  if (!GROUP_AUTHOR.test(suffix)) return title
  const key = comparable(suffix)
  // The cited title itself contains this sentence (the title has two sentences); it is part of the
  // title, so keep it.
  if (declaredTitle && comparable(declaredTitle).includes(key)) return title
  return key.length >= 6 && comparable(entry).includes(key) ? match[1]!.trim() : title
}

export function judgeCitation(entry: string, lookup: PubmedLookup | null, hints?: EntryHints): CitationResult {
  if (!lookup) {
    return {
      verdict: 'no-identifier',
      note: '条目里没有 PMID / DOI，无法按号精确核实',
      record: null,
    }
  }
  if (lookup.found) {
    const r = lookup.record
    const shortAuthors = authorsForNote(r.authors)
    const record = {
      title: r.title, authors: authorsForRecord(r.authors), journal: r.journal, pubdate: r.pubdate,
      ...(r.otherDates?.length ? { otherDates: r.otherDates } : {}),
      source: r.source, url: r.url, doi: r.doi ?? undefined,
      pmid: r.pmid || undefined,
      volume: r.volume ?? undefined,
      issue: r.issue ?? undefined,
      pages: r.pages ?? undefined,
      publisher: r.publisher ?? undefined,
      isbn: r.isbn ?? undefined,
      publicationStatus: r.publicationStatus,
    }
    const parsed = parseWithHints(entry, hints)
    // Registered title for comparison: strip the group author PubMed appends (UKPDS 33). The displayed
    // `record.title` is unchanged.
    const comparedTitle = withoutGroupAuthorSuffix(r.title, entry, parsed.title)
    const candidate: Candidate = {
      title: comparedTitle,
      authors: r.authors,
      journal: r.journal,
      year: Number(/\b(19\d{2}|20\d{2})\b/.exec(r.pubdate)?.[1] ?? '') || null,
      doi: r.doi ?? '',
      volume: r.volume ?? null,
      issue: r.issue ?? null,
      pages: r.pages ?? null,
      score: 0,
    }
    // Only flag an error automatically when a reasonable title was parsed; entries with just a DOI/PMID
    // stay "to be compared".
    const subtitleOnly = subtitleOmitted(parsed, comparedTitle, r.pubdate)
    if (parsed.title && parsed.title.length >= 8 && !subtitleOnly) {
      const compared = verifyCandidate(parsed, candidate, entry)
      if (!compared.ok && preprintRetitled(entry, parsed, candidate)) {
        return {
          verdict: 'found',
          note: `号存在（${r.source}），与登记记录为同一篇：${shortAuthors} ${r.pubdate}；预印本改版换过题名，登记的是现在的题名「${r.title}」`,
          record,
          identityMatch: {
            matchedBy: 'id', title: 'differs', year: 'same', journal: 'unverified',
            uniqueMatch: true, sourceRecord: true, preprintRetitled: true,
          },
        }
      }
      if (!compared.ok) {
        const titleKind = parsed.title && r.title ? compareTitles(parsed.title, comparedTitle).kind : 'unverified'
        return {
          verdict: 'mismatch',
          note: `编号存在（${r.source}），但${compared.why}；实际记录与稿件书目不符`,
          record,
          identityMatch: {
            matchedBy: 'id', title: titleKind,
            year: parsed.year && /\b(19\d{2}|20\d{2})\b/.test(r.pubdate)
              ? (parsed.year === Number(/\b(19\d{2}|20\d{2})\b/.exec(r.pubdate)?.[1]) ? 'same' : 'differs')
              : 'unverified',
            journal: 'unverified', uniqueMatch: true, sourceRecord: true,
          },
        }
      }
    }
    const titleKind: FieldCompareKind | 'unverified' = subtitleOnly ? 'convention'
      : parsed.title && r.title ? compareTitles(parsed.title, comparedTitle).kind : 'unverified'
    const journalKind = parsed.journal && r.journal ? compareJournals(parsed.journal, r.journal).kind : 'unverified'
    const yearKind = parsed.year && /\b(19\d{2}|20\d{2})\b/.test(r.pubdate)
      ? (parsed.year === Number(/\b(19\d{2}|20\d{2})\b/.exec(r.pubdate)?.[1]) ? 'same' : 'differs')
      : 'unverified'
    const locatorClosed = locatorFieldsAlign(parsed, candidate)
    const journalAnchored = journalAnchorHits({
      declaredJournal: parsed.journal,
      candidateJournal: r.journal,
      candidateDoi: r.doi,
    })
    /*
     * MEDLINE writes titles of non-English papers as a bracketed English translation
     * "[Translated title (2023)].", which itself registers "the original is in another language". When
     * retrieved by the manuscript's own identifier and volume/issue/pages and year all match, it is the
     * same paper even if the journal is not in the registry.
     * The journal anchor guards against same-position articles from other journals brought back by
     * volume/issue/page search, so only the identifier chain counts: the record's DOI is the very
     * identifier the manuscript wrote. If the journal is in the registry the anchor applies as usual (a
     * mismatch is counter-evidence and is not accepted); this only covers "journal not in the registry".
     */
    const entryOwnDoi = Boolean(r.doi && entry.toLowerCase().includes(r.doi.trim().toLowerCase()))
    const medlineTranslatedTitle = /^\[.+\]\.?$/.test(r.title.trim()) && yearKind === 'same'
      && entryOwnDoi && !resolveJournal(parsed.journal)
    const languageSurface = titleKind === 'differs' && locatorClosed && (journalAnchored || medlineTranslatedTitle)
      && Boolean(parsed.title && r.title && /[\u3400-\u9fff]/.test(parsed.title) !== /[\u3400-\u9fff]/.test(r.title))
    const identityClosed = titleKind === 'same' || titleKind === 'convention' || languageSurface
    if (!identityClosed && titleKind === 'differs') {
      return {
        verdict: 'candidate',
        note: `号存在（${r.source}），实际是：${r.journal} ${r.pubdate} ${shortAuthors}，需比对`,
        record,
        identityMatch: {
          matchedBy: 'id',
          title: titleKind,
          year: yearKind,
          journal: journalKind,
          uniqueMatch: true,
          sourceRecord: true,
        },
      }
    }
    return {
      verdict: 'found',
      // Once identity is closed by identifier chain + volume/issue/pages (or title), do not write "needs
      // comparison"; that phrasing implies the comparison is unfinished.
      // Only when the identifier exists but fields do not match is the judgment handed back to the researcher.
      note: identityClosed
        ? `号存在（${r.source}），与登记记录为同一篇：${r.journal} ${r.pubdate} ${shortAuthors}`
        : `号存在（${r.source}），实际是：${r.journal} ${r.pubdate} ${shortAuthors}，需比对`,
      record,
      identityMatch: {
        matchedBy: 'id',
        // **Both sides need a value before match or mismatch makes sense.** When the record lacks this field
        // the comparison yields `differs` with a reason like "record " (followed by nothing); that means "the
        // record has no such field", not "you wrote it wrong", and must not be used to tell the user their
        // citation is incorrect.
        title: languageSurface ? 'convention' : titleKind,
        year: yearKind,
        journal: languageSurface && journalKind === 'differs' ? 'convention' : journalKind,
        uniqueMatch: true,
        sourceRecord: true,
        // Identifier + volume/issue/pages + journal anchor closing together is not the same tier as
        // "identifier only"; the evidence cap is tiered accordingly.
        locatorClosed,
        journalAnchored,
      },
    }
  }
  if (lookup.reason === 'not-found') {
    /*
     * **A DOI that cannot be found does not mean the identifier does not exist.**
     * The DOI namespace has no single authority: registration agencies such as CHNDOI, JaLC and DataCite
     * are not queried, so absence from all three sources only shows our databases do not hold it. PMID is
     * different: PubMed is authoritative for PMIDs.
     * Saying "no such identifier" would make users delete real Chinese papers.
     */
    const isDoi = /^10\.\d{4,9}\//.test((lookup.identifier ?? '').trim())
    return {
      verdict: 'not-found',
      note: isDoi
        ? `PubMed、Crossref、CHNDOI 都没有这条记录：${lookup.identifier}（不代表这篇文献不存在）`
        : `查无此号：${lookup.identifier}（按号精确查询）`,
      record: null,
    }
  }
  if (lookup.reason === 'bad-identifier') {
    return { verdict: 'no-identifier', note: `${lookup.identifier} 不是合法的 PMID / DOI 格式`, record: null }
  }
  return {
    verdict: 'unavailable',
    note: `这次没查成（${lookup.detail}）—— 不代表引用有问题`,
    record: null,
  }
}

/** Structured result for each reference. */
export interface CitationItemData {
  entry: string
  identifier: string | null
  result: CitationResult
}

/**
 * Verify one reference. **With an identifier, look it up exactly (most deterministic); only without
 * one fall back to bibliographic matching. The order must not be reversed.**
 */
export async function verifyEntry(entry: string, deps: {
  lookup: (identifier: string, signal?: AbortSignal) => Promise<PubmedLookup>
  search: (entry: string, rows?: number, signal?: AbortSignal) => Promise<unknown[]>
  /**
   * Search again with the cited year plus or minus one, used only when "DOI not found and not found by
   * title either". Not searched if not provided.
   * E.g. a guideline chapter that keeps the same title every year: without the year, Crossref's top 5
   * results can all be other editions, so the cited edition never ranks and a one-character DOI typo
   * would be reported as "not indexed" instead of corrected.
   */
  searchNearYear?: (entry: string, year: number, rows?: number, signal?: AbortSignal) => Promise<unknown[]>
}, signal?: AbortSignal, hints?: EntryHints): Promise<CitationItemData> {
  const identifier = extractIdentifier(entry)
  let result = identifier
    ? judgeCitation(entry, await deps.lookup(identifier, signal), hints)
    : await judgeUnidentifiedEntry(entry, deps, signal, hints)
  /*
   * When the DOI is not found, or it points to another real article (the identifier exists but the
   * title does not match), search once more by title. If the title uniquely finds the same paper and its
   * registered DOI differs, the DOI is wrong (e.g. transposed digits); give the correction from the
   * record. A PMID that is not found does not take this path (PubMed is authoritative for PMIDs).
   */
  const pointsElsewhere = (result.verdict === 'mismatch' || result.verdict === 'candidate')
    && result.identityMatch?.matchedBy === 'id' && result.identityMatch.title === 'differs'
  if (identifier && (result.verdict === 'not-found' || pointsElsewhere) && /^10\.\d{4,9}\//.test(identifier)) {
    try {
      let byTitle = await judgeUnidentifiedEntry(entry, deps, signal, hints)
      const year = parseWithHints(entry, hints).year
      if (byTitle.verdict !== 'found' && deps.searchNearYear && year) {
        const nearYear = await deps.searchNearYear(entry, year, 5, signal)
        byTitle = await judgeUnidentifiedEntry(entry, { lookup: deps.lookup, search: async () => nearYear }, signal, hints)
        /*
         * Crossref often records the online-first date: an edition cited as 2025 may be registered as
         * 2024-12, so the year gate fails. General matching is not relaxed here (two real papers with the
         * same title a year apart exist); only on this DOI fallback path: when exactly one candidate is the
         * same work by title and differs by just one year, fetch the authoritative record by its identifier
         * and run the full citation judgment again; year and journal must still match to count as "found".
         */
        const neighbor = byTitle.verdict === 'found' ? null : soleSameTitleNeighbor(parseWithHints(entry, hints), nearYear)
        if (neighbor?.doi) {
          const lookup = await deps.lookup(neighbor.doi, signal)
          // A re-fetched identifier does not by itself prove it is this paper: if the journal does not match,
          // volume or pages conflict, or pages do not match, keep not found and do not suggest another paper's
          // identifier.
          // Issue is not compared: supplement notation varies (manuscript "Suppl 1", PubMed "1 Suppl 1").
          const judged = lookup.found
            ? judgeCitation(entry, withLookupDoi(lookup, neighbor.doi), hints)
            : null
          if (judged && lookup.found && judged.identityMatch?.journal !== 'differs'
            && neighborLocatorAgrees(entry, parseWithHints(entry, hints), lookup.record)) byTitle = judged
        }
      }
      const found = byTitle.record?.doi?.trim()
      if (byTitle.verdict === 'found' && found && found.toLowerCase() !== identifier.toLowerCase()
        && byTitle.identityMatch?.title !== 'differs') {
        // Write the identifier in the hint exactly as in the manuscript: it was lowercased for lookup, and
        // seeing NEJMoa as nejmoa would make the author think they miscited the original.
        const start = entry.toLowerCase().indexOf(identifier.toLowerCase())
        const written = start >= 0 ? entry.slice(start, start + identifier.length) : identifier
        result = {
          ...byTitle,
          verdict: 'mismatch',
          note: `DOI 写错：稿件写 ${written}${pointsElsewhere ? `（这个号登记的是另一篇：${result.record?.title ?? ''}）` : ''}，按题名找到的这篇登记的是 ${found}`,
          identityMatch: { ...byTitle.identityMatch!, matchedBy: 'metadata' },
        }
      }
    } catch (error) {
      if (signal?.aborted) throw error
    }
  }
  const resolvedId = identifier ?? (
    result.verdict === 'found' && bibliographicIdentityConfirmed(result)
      ? (result.record?.doi ?? result.record?.pmid ?? result.record?.isbn ?? null)
      : null
  )
  return {
    entry, identifier: resolvedId, result,
  }
}

/**
 * A PubMed record retrieved by DOI sometimes lacks the DOI (ESummary often omits it for older papers).
 * The record was fetched with this identifier, so it belongs to it; fill it in, otherwise "DOI is
 * wrong" cannot give the correct identifier.
 */
function withLookupDoi(lookup: PubmedLookup, doi: string): PubmedLookup {
  if (!lookup.found || lookup.record.doi) return lookup
  return { ...lookup, record: { ...lookup.record, doi } }
}

/**
 * Volume does not conflict, and pages exist on both sides and match. A supplement such as
 * `12(Suppl 1): S10-S25` does not parse into volume/pages, so pages are taken from the last page range
 * in the entry (after removing DOI and URLs).
 */
function neighborLocatorAgrees(entry: string, parsed: ParsedEntry, record: { volume?: string | null; pages?: string | null }): boolean {
  if (parsed.volume && record.volume && compareReferenceField('volume', parsed.volume, record.volume).kind === 'differs') return false
  const pages = parsed.pages ?? [...entry
    .replace(/\b(?:doi|https?):\s*\S+/gi, ' ')
    .matchAll(/(?:^|[\s:：,，])([A-Za-z]{0,2}\d+[A-Za-z]?\s*[-–—]\s*[A-Za-z]{0,2}\d+[A-Za-z]?)(?=[\s.。;；,，]|$)/g)]
    .map((match) => match[1]!).pop()
  return Boolean(pages && record.pages) && compareReferenceField('pages', pages!, record.pages!).kind !== 'differs'
}

/**
 * Return the candidate when exactly one candidate with a DOI is the same work as the citation and
 * differs by only one year; otherwise null (do not guess among two or more).
 */
function soleSameTitleNeighbor(parsed: ParsedEntry, items: unknown[]): Candidate | null {
  if (!parsed.title || !parsed.year) return null
  const neighbors = items
    .map((item) => toCandidate(item as Record<string, unknown>))
    .filter((candidate): candidate is Candidate => candidate !== null)
    .filter((candidate) => Boolean(candidate.doi) && candidate.year !== null
      && Math.abs(candidate.year - parsed.year!) <= 1
      && compareTitles(parsed.title!, candidate.title).kind !== 'differs')
  return neighbors.length === 1 ? neighbors[0]! : null
}

async function judgeUnidentifiedEntry(
  entry: string,
  deps: {
    lookup: (identifier: string, signal?: AbortSignal) => Promise<PubmedLookup>
    search: (entry: string, rows?: number, signal?: AbortSignal) => Promise<unknown[]>
  },
  signal?: AbortSignal,
  hints?: EntryHints,
): Promise<CitationResult> {
  const candidates = (await deps.search(entry, 5, signal))
    .map((item) => toCandidate(item as Record<string, unknown>))
    .filter((candidate): candidate is Candidate => candidate !== null)
  const parsed = parseWithHints(entry, hints)
  const { matched, matchedVia } = pickMatch(parsed, candidates, entry)
  /**
   * Entries without an identifier: when bibliographic search finds a unique, anchored hit with a DOI,
   * fetch it by identifier first, then judge. For a Chinese citation registered in English, locating by
   * volume/issue/pages and taking the DOI is more direct than querying with the Chinese title.
   *
   * The journal anchor only governs cross-language acceptance. A title match (same language) is itself
   * an identity anchor, so it is accepted even when the journal is not in the registry; only a
   * cross-language match closed by volume/issue/pages needs the journal anchor, otherwise
   * same-position articles from other journals would slip back in.
   */
  const anchored = matchedVia === 'title' || (matchedVia === 'locator' && journalAnchorHits({
    declaredJournal: parsed.journal,
    candidateJournal: matched?.journal,
    candidateDoi: matched?.doi,
    candidateIssn: matched?.issn,
  }))
  if (matched?.doi && anchored) {
    try {
      const lookup = await deps.lookup(matched.doi, signal)
      if (lookup.found) return judgeCitation(entry, withLookupDoi(lookup, matched.doi), hints)
    } catch (error) {
      if (signal?.aborted) throw error
    }
  }
  return judgeByBibliographic(entry, candidates, hints)
}

/** One Hanyu Pinyin syllable (initial + final; u-umlaut written as v or u). */
const PINYIN_SYLLABLE = '(?:zh|ch|sh|[bpmfdtnlgkhjqxrzcsyw])?(?:iang|iong|uang|ueng|ang|eng|ing|ong|uan|ian|iao|uai|van|ai|ei|ao|ou|an|en|in|un|vn|ui|ue|ve|ie|iu|ia|ua|uo|er|a|o|e|i|u|v)'
const PINYIN_SURNAME = new RegExp(`^${PINYIN_SYLLABLE}(?:${PINYIN_SYLLABLE})?$`)

/**
 * When the first author in the entry has a Chinese name, the candidate's authors must include a
 * Chinese name, or someone whose surname (first word in the record) spells one or two Pinyin syllables.
 * If the cited author is not Chinese or the candidate lists no authors, this check does not apply
 * (returns true).
 */
export function romanizedAuthorsCouldMatch(entry: string, candidateAuthors: readonly string[]): boolean {
  const lead = entry.replace(/^\s*(?:[[［]\s*\d{1,3}\s*[\]］]|\d{1,3}\s*[.、．])\s*/, '').split(/[.．]\s/)[0] ?? ''
  if (!/[\u3400-\u9fff]/.test(lead)) return true
  const names = candidateAuthors.map((name) => name.trim()).filter(Boolean)
  if (!names.length) return true
  if (names.some((name) => /[\u3400-\u9fff]/.test(name))) return true
  // Candidate authors are built by `toCandidate` as "surname given-name"; only the surname is checked,
  // since given names often spell as Pinyin (Anna = an + na) and would let foreign names through.
  return names.some((name) => PINYIN_SURNAME.test(
    name.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().split(/[\s,.]+/).filter(Boolean)[0] ?? '',
  ))
}

/**
 * Bibliographic matching for entries without an identifier.
 *
 * **A match is only ever a "candidate", never written as verified.** What we deliver is
 * "found a record with the same year and a highly similar title, please compare"; the judgment stays
 * with the researcher.
 * When no candidate passes the check, the verdict is "no similar record found", **not** "this citation
 * is wrong": Crossref coverage of Chinese journals is incomplete, so not finding one is normal.
 */
export function judgeByBibliographic(entry: string, candidates: Candidate[], hints?: EntryHints): CitationResult {
  const parsed = parseWithHints(entry, hints)
  const { matched, matchedVia } = pickMatch(parsed, candidates, entry)
  if (!matched) {
    return {
      verdict: 'no-match',
      note: '按参考文献信息检索后，没有找到能确认的记录——没找到不等于这条文献有问题',
      record: null,
    }
  }
  /**
   * The cited journal is in the registry, but the candidate does not anchor to that row and the title
   * does not match: this is a same-position article from another journal, not a "similar record".
   * Asking the user to "compare" is just noise; close it as not found, with a note saying which journal
   * did not match.
   */
  const declaredRow = resolveJournal(parsed.journal)
  if (declaredRow && matchedVia === 'locator' && !journalAnchorHits({
    declaredJournal: parsed.journal,
    candidateJournal: matched.journal,
    candidateDoi: matched.doi,
    candidateIssn: matched.issn,
  })) {
    return {
      verdict: 'no-match',
      note: `按卷期页只查到别的期刊（${matched.journal}）的同位记录，不是《${declaredRow.zh}》的——没找到不等于这条文献有问题`,
      record: null,
    }
  }
  // When chosen only by volume/issue/pages and the title does not match, the authors must plausibly be
  // the same people: if the entry has Chinese authors but the candidate lists foreign names that do not
  // spell as Pinyin (a Chinese journal article colliding with a foreign journal's article at the same
  // volume, issue and pages), it is a same-position article from another journal, not a "similar record".
  if (matchedVia === 'locator' && !romanizedAuthorsCouldMatch(entry, matched.authors)) {
    return {
      verdict: 'no-match',
      note: `按卷期页只查到别的期刊（${matched.journal}）的同位记录，作者对不上——没找到不等于这条文献有问题`,
      record: null,
    }
  }
  const shortAuthors = authorsForNote(matched.authors)
  return {
    verdict: 'candidate',
    note: `找到相近记录：${matched.journal} ${matched.year ?? ''} ${shortAuthors}，需比对`,
    record: {
      title: matched.title, authors: authorsForRecord(matched.authors),
      journal: matched.journal, pubdate: String(matched.year ?? ''),
      // The source follows the candidate: AMiner hits are labeled `aminer-书目匹配`, the rest are Crossref.
      source: matched.source ? `${matched.source}-书目匹配` : 'crossref-书目匹配',
      doi: matched.doi || undefined,
      url: matched.url,
      abstract: matched.abstract,
      aminerId: matched.aminerId,
      publicationStatus: {
        state: 'unknown', checkedSources: [], updates: [],
        note: '这只是信息相近的记录，尚未按 DOI/PMID 精确确认，不能可靠判断发表状态',
      },
    },
    identityMatch: {
      matchedBy: 'metadata',
      title: parsed.title && matched.title ? compareTitles(parsed.title, matched.title).kind : 'unverified',
      year: parsed.year && matched.year ? (parsed.year === matched.year ? 'same' : 'differs') : 'unverified',
      journal: parsed.journal && matched.journal ? compareJournals(parsed.journal, matched.journal).kind : 'unverified',
      uniqueMatch: true,
      sourceRecord: true,
    },
  }
}
