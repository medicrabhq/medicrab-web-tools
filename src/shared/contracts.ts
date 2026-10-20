// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 TIKMOON LTD
/**
 * Shared contract types used by the web tools (types only).
 */

/**
 * Result of exact lookup by identifier.
 *
 * These records are **facts retrieved by identifier**, not "the closest candidates" from a search.
 * The four kinds of "not found" are kept strictly apart: reporting a network failure as "no such
 * identifier" would make the user delete a reference that is actually fine.
 */
export interface CitationRecord {
  /** Records from Crossref have no PMID; empty string in that case */
  pmid: string
  title: string
  authors: string[]
  journal: string
  pubdate: string
  doi: string | null
  url: string
  /**
   * Volume, issue, pages, publisher, ISBN.
   *
   * Field-by-field verification depends on them: entries checked by identifier compare authors and
   * volume/issue/pages, not only title, year and journal. null when the source omits the field; `null`
   * means "the record has no such field", not "mismatch".
   */
  volume?: string | null
  issue?: string | null
  pages?: string | null
  publisher?: string | null
  isbn?: string | null
  /**
   * Abstract supplied by the registration agency along with the bibliographic data. Currently only
   * filled by doi.org content negotiation: Chinese DOIs from ISTIC / Wanfang mostly carry full
   * abstracts, free and verifiable word for word.
   */
  abstract?: string | null
  /**
   * Publication dates in the record other than `pubdate`: PubMed's electronic date (ArticleDate;
   * the entry date EDAT does not count), Crossref's online / print dates. If the cited year equals
   * any of them, it is just the online vs. print year, and no change is needed.
   * Older records lack this field.
   */
  otherDates?: string[]
  /** Who says it exists. Users need to know where this fact comes from. */
  source: 'pubmed' | 'crossref' | 'doi-registry'
  /**
   * Post-publication status check. When this field is absent, the UI must prompt for a recheck and must
   * not treat its absence as "not retracted".
   * "no-update-found" only means the sources checked this time returned no update; it is not a
   * permanent guarantee.
   */
  publicationStatus?: CitationPublicationStatus
}

export type CitationPublicationState =
  | 'no-update-found'
  | 'retracted'
  | 'expression-of-concern'
  | 'corrected'
  | 'withdrawn'
  | 'reinstated'
  | 'notice'
  | 'unknown'

export type CitationPublicationUpdateType = Exclude<CitationPublicationState, 'no-update-found' | 'unknown'> | 'other'

export interface CitationPublicationUpdate {
  type: CitationPublicationUpdateType
  label: string
  source: 'pubmed' | 'publisher' | 'retraction-watch' | 'crossref'
  /** ISO date; null when the source gives no explicit date. */
  date: string | null
  /** DOI of the retraction/correction notice itself. */
  noticeDoi: string | null
  url: string | null
}

export interface CitationPublicationStatus {
  state: CitationPublicationState
  /**
   * Sources actually checked successfully. An empty array means nothing was checked and must not be
   * shown as normal.
   */
  checkedSources: Array<'pubmed' | 'crossref'>
  updates: CitationPublicationUpdate[]
  /** Honest limits when some sources failed or status coverage is limited. */
  note: string | null
}

export type CitationVerification =
  /**
   * `pubmedUnavailable`: a DOI lookup where PubMed failed this time and a later source found the
   * record. Don't say "not indexed in PubMed" here; PubMed was not actually checked.
   */
  | { found: true; record: CitationRecord; pubmedUnavailable?: boolean }
  /** Identifier is well-formed but the database has no such record: a definite conclusion */
  | { found: false; reason: 'not-found'; identifier: string }
  /** The input is not a PMID / DOI at all */
  | { found: false; reason: 'bad-identifier'; identifier: string }
  /** Network or API problem. **Must be kept separate from "does not exist"** */
  | { found: false; reason: 'unavailable'; identifier: string; detail: string }
