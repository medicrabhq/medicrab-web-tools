// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 TIKMOON LTD
/**
 * Fetch a PubMed record by exact ID.
 *
 * Verification must not go through semantic search: a semantic search for a PMID returns the
 * article "semantically closest to that string of digits", and a citation would then be judged
 * wrong against a completely unrelated paper.
 *
 * This uses NCBI E-utilities esummary: **free, no key needed, deterministic results**.
 * Given an ID, we either get the real title, authors, journal and year of that record, or a clear
 * "this ID does not exist". No judgment here: we only fetch the facts; whether it is the same
 * article is for the model and the user to compare.
 *
 * **The most common and most dangerous case is not "ID does not exist" but "ID exists but is a
 * completely different article"**: the manuscript cites "Smith et al., 2019; PMID <n>", but that
 * ID belongs to an unrelated letter from another year. Checking only whether the ID exists lets it
 * through; fetching the record and comparing exposes it.
 */

import { plainLiteratureText } from '../shared/literature-plain-text'
import type {
  CitationPublicationState, CitationPublicationStatus, CitationPublicationUpdate,
  CitationPublicationUpdateType, CitationRecord, CitationVerification,
} from '../shared/contracts'
import { requestLiterature } from './literature-http'

/**
 * Lookups fire dozens of requests in a row, so they **must rate-limit and retry**: without
 * spacing, Crossref answers a burst with 429s, and those references would be reported as "could
 * not be checked" only because we sent requests too fast.
 *
 * Separate queues + a minimum interval; 429/5xx are retried per Retry-After or with exponential
 * backoff. NCBI and Crossref do not block each other.
 */
async function fetchWithRetry(url: string | URL, init: RequestInit): Promise<Response> {
  return requestLiterature(() => fetch(url, init), { signal: init.signal ?? undefined, url })
}
const CROSSREF = 'https://api.crossref.org/works'
const ESUMMARY = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi'
const ESEARCH = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi'
const TIMEOUT_MS = 15_000

/**
 * Request profile. The browser build cannot send contact details in a request header (a custom
 * User-Agent adds a CORS preflight, and browsers may not send it anyway), so for
 * Crossref it uses the `mailto` parameter to join the polite pool (response header
 * `x-api-pool: polite-single`). CNKI's CHNDOI does not allow CORS, so the browser profile skips it;
 * doi.org content negotiation does allow CORS.
 */
export interface LiteratureProfile {
  crossrefHeaders: Record<string, string>
  crossrefParams: Record<string, string>
  registryHeaders: Record<string, string>
}

export const BROWSER_LITERATURE_PROFILE: LiteratureProfile = {
  crossrefHeaders: {},
  crossrefParams: { mailto: 'contact@medicrab.com' },
  registryHeaders: {},
}

let profile: LiteratureProfile = BROWSER_LITERATURE_PROFILE

/** Switch the request profile. The browser build calls this at startup. */
export function useLiteratureProfile(next: LiteratureProfile): void {
  profile = next
}

/** Crossref URL with the profile's extra parameters. */
function crossrefUrl(path = ''): URL {
  const url = new URL(`${CROSSREF}${path}`)
  for (const [key, value] of Object.entries(profile.crossrefParams)) url.searchParams.set(key, value)
  return url
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(TIMEOUT_MS)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

/**
 * The type definitions live in `shared/contracts.ts` so every caller shares the same shape. The
 * aliases stay here so existing references do not all need changing.
 */
export type PubmedRecord = CitationRecord
export type PubmedLookup = CitationVerification

const PMID = /^\d{1,9}$/
const DOI = /^10\.\d{4,9}\/\S+$/

interface EsummaryEntry {
  error?: string
  title?: string
  source?: string
  pubdate?: string
  /** Electronic publication date (ArticleDate). The print year is often one year later. */
  epubdate?: string
  elocationid?: string
  volume?: string
  issue?: string
  pages?: string
  authors?: Array<{ name?: string }>
  pubtype?: string[]
}

interface CrossrefUpdateEntry {
  DOI?: string
  type?: string
  label?: string
  source?: string
  updated?: { 'date-parts'?: number[][]; 'date-time'?: string }
}

interface CrossrefMessage {
  title?: string[]
  subtitle?: string[]
  author?: Array<{ family?: string; given?: string }>
  editor?: Array<{ family?: string; given?: string }>
  'container-title'?: string[]
  issued?: { 'date-parts'?: number[][] }
  'published-online'?: { 'date-parts'?: number[][] }
  'published-print'?: { 'date-parts'?: number[][] }
  volume?: string
  issue?: string
  page?: string
  publisher?: string
  ISBN?: string[]
  'updated-by'?: CrossrefUpdateEntry[]
}

function crossrefName(item: { family?: string; given?: string }): string {
  return [item.family, item.given].filter(Boolean).join(' ')
}

/**
 * Crossref returns a monograph's main title and subtitle in separate fields; dropping `subtitle`
 * truncates the identity anchor to a generic word.
 */
export function crossrefBookFields(message: Pick<CrossrefMessage, 'title' | 'subtitle' | 'author' | 'editor' | 'ISBN'>, doi: string): {
  title: string
  authors: string[]
  isbn: string | null
} {
  // Crossref titles often contain tags such as <i> and <sub> (`<i>Helicobacter pylori</i>`);
  // convert to plain text before comparing, consistent with candidates from bibliographic search.
  const title = plainLiteratureText(message.title?.[0])
  const subtitle = plainLiteratureText(message.subtitle?.[0])
  const fullTitle = subtitle && !title.toLowerCase().includes(subtitle.toLowerCase())
    ? `${title}: ${subtitle}` : title
  const contributors = message.author?.length ? message.author : message.editor ?? []
  const isbnList = (message.ISBN ?? []).map((value) => value.replace(/[^0-9Xx]/g, '').toUpperCase())
  const doiSuffix = /^10\.1007\/(97[89][0-9-]+)$/i.exec(doi)?.[1]?.replace(/-/g, '').toUpperCase()
  return {
    title: fullTitle,
    authors: contributors.map(crossrefName).filter(Boolean),
    isbn: (doiSuffix && isbnList.includes(doiSuffix) ? doiSuffix : isbnList[0]) ?? null,
  }
}

function publicationStateOf(updates: CitationPublicationUpdate[]): CitationPublicationState {
  if (!updates.length) return 'no-update-found'
  // A reinstatement notice overrides an earlier retraction status; when Crossref has dates, the
  // latest update wins.
  const latest = [...updates].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))[0]
  if (latest?.type === 'reinstated') return 'reinstated'
  if (updates.some((item) => item.type === 'retracted')) return 'retracted'
  if (updates.some((item) => item.type === 'withdrawn')) return 'withdrawn'
  if (updates.some((item) => item.type === 'expression-of-concern')) return 'expression-of-concern'
  if (updates.some((item) => item.type === 'corrected')) return 'corrected'
  if (updates.some((item) => item.type === 'notice')) return 'notice'
  return 'unknown'
}

function normalizedUpdateType(value: string): CitationPublicationUpdateType {
  const normalized = value.toLowerCase().replace(/[_\s]+/g, '-')
  if (normalized.includes('reinstat')) return 'reinstated'
  if (normalized.includes('expression') && normalized.includes('concern')) return 'expression-of-concern'
  if (normalized.includes('withdraw')) return 'withdrawn'
  if (normalized.includes('retract')) return 'retracted'
  if (normalized.includes('correct') || normalized.includes('errat')) return 'corrected'
  if (normalized.includes('notice')) return 'notice'
  return 'other'
}

function dateOf(update: CrossrefUpdateEntry): string | null {
  const parts = update.updated?.['date-parts']?.[0]
  if (parts?.length) return parts.map((part, index) => index ? String(part).padStart(2, '0') : String(part)).join('-')
  return update.updated?.['date-time']?.slice(0, 10) ?? null
}

/** Read the "who updated this work" relations from Crossref's current production API. */
export function publicationStatusFromCrossref(message: Pick<CrossrefMessage, 'updated-by'>): CitationPublicationStatus {
  const updates = (message['updated-by'] ?? []).map((item): CitationPublicationUpdate => {
    const noticeDoi = item.DOI?.trim() || null
    const raw = item.type || item.label || 'update'
    const source = item.source === 'publisher' || item.source === 'retraction-watch' ? item.source : 'crossref'
    return {
      type: normalizedUpdateType(raw),
      label: item.label?.trim() || item.type?.trim() || 'Update',
      source,
      date: dateOf(item),
      noticeDoi,
      url: noticeDoi ? `https://doi.org/${noticeDoi}` : null,
    }
  })
  return { state: publicationStateOf(updates), checkedSources: ['crossref'], updates, note: null }
}

function publicationStatusFromPubmed(pubtypes: string[] | undefined): CitationPublicationStatus {
  const updates: CitationPublicationUpdate[] = []
  for (const label of pubtypes ?? []) {
    const lower = label.toLowerCase()
    const type: CitationPublicationUpdateType | null = lower === 'retracted publication'
      ? 'retracted'
      : lower.includes('retraction notice')
        ? 'notice'
        : lower.includes('expression of concern')
          ? 'expression-of-concern'
          : null
    if (type) updates.push({ type, label, source: 'pubmed', date: null, noticeDoi: null, url: null })
  }
  return { state: publicationStateOf(updates), checkedSources: ['pubmed'], updates, note: null }
}

function mergePublicationStatuses(...statuses: CitationPublicationStatus[]): CitationPublicationStatus {
  const checkedSources = [...new Set(statuses.flatMap((item) => item.checkedSources))]
  const seen = new Set<string>()
  const updates = statuses.flatMap((item) => item.updates).filter((item) => {
    const key = [item.type, item.noticeDoi ?? '', item.source].join('|')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return {
    state: publicationStateOf(updates),
    checkedSources,
    updates,
    note: statuses.map((item) => item.note).filter(Boolean).join('；') || null,
  }
}

async function crossrefPublicationStatusOf(doi: string, signal?: AbortSignal): Promise<CitationPublicationStatus> {
  const response = await fetchWithRetry(crossrefUrl(`/${encodeURIComponent(doi)}`), {
    headers: profile.crossrefHeaders,
    signal: requestSignal(signal),
  })
  if (response.status === 404) {
    return { state: 'no-update-found', checkedSources: ['crossref'], updates: [], note: 'Crossref 未收录该 DOI，发表状态覆盖有限' }
  }
  if (!response.ok) throw new Error(`Crossref 返回 ${response.status}`)
  const payload = await response.json() as { message?: CrossrefMessage }
  if (!payload.message) throw new Error('Crossref 未返回作品记录')
  return publicationStatusFromCrossref(payload.message)
}

async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetchWithRetry(url, { signal: requestSignal(signal) })
  if (!response.ok) throw new Error(`PubMed 返回 ${response.status}`)
  return response.json()
}

/** `elocationid` looks like "doi: 10.1055/s-0043-118218", or possibly "pii: xxx". */
function doiFrom(elocationid: string | undefined): string | null {
  const match = /10\.\d{4,9}\/\S+/.exec(elocationid ?? '')
  return match ? match[0].replace(/[.,;]$/, '') : null
}

async function summaryOf(pmid: string, signal?: AbortSignal): Promise<PubmedLookup> {
  const payload = await getJson(`${ESUMMARY}?db=pubmed&id=${encodeURIComponent(pmid)}&retmode=json`, signal) as {
    error?: string
    result?: Record<string, EsummaryEntry | string[]>
    esummaryresult?: unknown
  }
  // When busy, NCBI returns HTTP 200 + `{"error":"API rate limit exceeded"}` with no `result`.
  // That means the lookup failed, not that the ID does not exist.
  if (payload.error || payload.result == null) {
    return {
      found: false,
      reason: 'unavailable',
      identifier: pmid,
      detail: String(payload.error ?? 'PubMed 未返回记录详情'),
    }
  }
  const entry = payload.result[pmid] as EsummaryEntry | undefined
  if (!entry || entry.error) return { found: false, reason: 'not-found', identifier: pmid }
  const doi = doiFrom(entry.elocationid)
  let publicationStatus = publicationStatusFromPubmed(entry.pubtype)
  if (doi) {
    try {
      publicationStatus = mergePublicationStatuses(publicationStatus, await crossrefPublicationStatusOf(doi, signal))
    } catch (error) {
      if (signal?.aborted) throw error
      publicationStatus = {
        ...publicationStatus,
        note: `Crossref 发表状态本次未查成（${error instanceof Error ? error.message : '网络错误'}）`,
      }
    }
  }
  return {
    found: true,
    record: {
      pmid,
      // Delivered as-is, without stripping the trailing period: PubMed titles include it, and
      // stripping would turn "et al." into "et al". This is a verification tool; fidelity beats looks.
      title: plainLiteratureText(entry.title),
      authors: (entry.authors ?? []).map((author) => author.name ?? '').filter(Boolean),
      journal: plainLiteratureText(entry.source),
      pubdate: entry.pubdate ?? '',
      // Only the electronic publication date (ArticleDate) counts; the entry date (EDAT) is when
      // PubMed indexed it, not a publication date.
      otherDates: [entry.epubdate].filter((value): value is string => Boolean(value?.trim())),
      volume: entry.volume || null,
      issue: entry.issue || null,
      // esummary's `pages` is often an empty string; `elocationid` (e12345 / doi:...) is not a page
      // number and must not be used in its place.
      pages: entry.pages || null,
      doi,
      url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
      source: 'pubmed',
      publicationStatus,
    },
  }
}

/**
 * Crossref fallback.
 *
 * **Many journals are not in PubMed**: Chinese journals and most engineering and social-science
 * journals are missing. Concluding "no such ID" from PubMed alone would make the user delete a
 * perfectly fine reference. Crossref covers almost every publication with a registered DOI,
 * which fills this gap.
 */
async function crossrefOf(doi: string, signal?: AbortSignal): Promise<PubmedLookup> {
  const response = await fetchWithRetry(crossrefUrl(`/${encodeURIComponent(doi)}`), {
    // Crossref requires contact details, otherwise requests are demoted to the slow pool
    headers: profile.crossrefHeaders,
    signal: requestSignal(signal),
  })
  if (response.status === 404) return { found: false, reason: 'not-found', identifier: doi }
  if (!response.ok) throw new Error(`Crossref 返回 ${response.status}`)

  // A 200 without `message` (or non-JSON) means the lookup failed, not "no such ID": only 404
  // means that.
  const payload = await response.json().catch(() => null) as { message?: CrossrefMessage } | null
  const message = payload?.message
  if (!message) throw new Error('Crossref 返回缺字段')

  const parts = message.issued?.['date-parts']?.[0] ?? []
  const bookFields = crossrefBookFields(message, doi)
  return {
    found: true,
    record: {
      pmid: '',
      title: bookFields.title,
      authors: bookFields.authors,
      journal: plainLiteratureText(message['container-title']?.[0]),
      pubdate: parts.join('-'),
      // `issued` is the earliest date (often online-first); the print date is recorded separately
      // and used when the reference cites the print year.
      otherDates: [message['published-online'], message['published-print']]
        .map((date) => (date?.['date-parts']?.[0] ?? []).join('-'))
        .filter(Boolean),
      volume: message.volume ?? null,
      issue: message.issue ?? null,
      pages: message.page ?? null,
      publisher: message.publisher ?? null,
      isbn: bookFields.isbn,
      doi,
      url: `https://doi.org/${doi}`,
      source: 'crossref',
      publicationStatus: publicationStatusFromCrossref(message),
    },
  }
}

interface CslName { family?: string; given?: string; literal?: string }

function cslText(value: unknown): string {
  const first = Array.isArray(value) ? value[0] : value
  return typeof first === 'string' ? first.replace(/\s+/g, ' ').trim() : ''
}

/**
 * CSL-JSON from DOI content negotiation. ISTIC "Chinese DOI" records only register the first
 * author and the start page, so the author list is passed through as-is (`comparePersons` treats
 * a true prefix as "source incomplete", not "author mismatch"), and pages are omitted when only
 * the start page is given, since `68` vs `68-73` would be treated as a page mismatch.
 */
export function parseCslRecord(value: unknown, doi: string): CitationRecord | null {
  if (!value || typeof value !== 'object') return null
  const csl = value as Record<string, unknown>
  const title = cslText(csl.title)
  /*
   * Some JaLC (Japan) records have a title consisting of a single space, but the DOI, journal, year,
   * volume and pages are all present. The DOI is real, so a missing title must not count as "no such
   * ID"; leave the title empty and record "not provided by source" when comparing. Reject only when
   * even the journal and year are missing.
   */
  if (!title && !cslText(csl['container-title']) && !(csl.issued as { 'date-parts'?: unknown[][] } | undefined)?.['date-parts']?.[0]?.length) return null
  const authors = (Array.isArray(csl.author) ? csl.author as CslName[] : [])
    .map((name) => name.literal?.trim() || [name.family, name.given]
      .map((part) => part?.trim()).filter(Boolean)
      .join(/[一-鿿]/.test(`${name.family ?? ''}${name.given ?? ''}`) ? '' : ' '))
    .filter(Boolean)
  const issued = (csl.issued as { 'date-parts'?: unknown[][] } | undefined)?.['date-parts']?.[0] ?? []
  const page = cslText(csl.page)
  const landing = cslText(csl.URL)
  /*
   * Abstracts converted by Crossref carry JATS tags; ISTIC ones are plain text. Only strip tags
   * that start with a letter: abstracts are full of `P<0.05` and `(P>0.05)`, and a loose
   * `<[^>]+>` would delete everything between two comparison signs.
   */
  const abstract = cslText(csl.abstract)
    // Block-level tags become a space; inline tags (`<i>P</i>`, `<b>...</b>`) are just removed, so
    // the text does not read as "( P <0.05)".
    .replace(/<\/?(?:jats:)?(?:p|sec|title|br|div)\b(?:\s[^<>]*)?\/?>/gi, ' ')
    .replace(/<\/?[A-Za-z][\w:.-]*(?:\s[^<>]*)?\/?>/g, '')
    .replace(/\s+/g, ' ').trim()
  return {
    pmid: '',
    title,
    authors,
    journal: cslText(csl['container-title']),
    pubdate: issued.filter((part) => typeof part === 'number' || typeof part === 'string').join('-'),
    volume: cslText(csl.volume) || null,
    // JaLC puts the issue number in `number`.
    issue: cslText(csl.issue) || cslText(csl.number) || null,
    pages: /\d\s*[-–—~]\s*\d/.test(page) ? page : null,
    publisher: cslText(csl.publisher) || null,
    doi,
    url: /^https?:\/\//i.test(landing) ? landing : `https://doi.org/${doi}`,
    abstract: abstract || null,
    source: 'doi-registry',
    publicationStatus: {
      state: 'unknown', checkedSources: [], updates: [],
      note: 'DOI 登记机构提供了书目记录，但没有撤稿状态来源',
    },
  }
}

async function registeredDoiOf(doi: string, signal?: AbortSignal): Promise<PubmedLookup> {
  const path = encodeURIComponent(doi).replace(/%2F/gi, '/')
  const response = await fetchWithRetry(`https://doi.org/${path}`, {
    signal: requestSignal(signal),
    headers: { accept: 'application/vnd.citationstyles.csl+json', ...profile.registryHeaders },
  })
  if (response.status === 404) return { found: false, reason: 'not-found', identifier: doi }
  if (!response.ok) throw new Error(`DOI 登记机构返回 ${response.status}`)
  if (!/json/i.test(response.headers.get('content-type') ?? '')) {
    return { found: false, reason: 'not-found', identifier: doi }
  }
  // A CSL JSON response means the DOI is registered; if it cannot be parsed or no record can be
  // read, the lookup failed, and we must not say "no such ID".
  const record = parseCslRecord(await response.json().catch(() => null), doi)
  if (!record) throw new Error('DOI 登记机构返回的记录读不出')
  return { found: true, record }
}

/**
 * Fetch a record by PMID or DOI, retrying once after a timeout.
 *
 * Three kinds of "not found" are kept strictly apart: invalid ID / not in the database / API
 * unavailable. **The last must never be reported as one of the first two**: reporting a network
 * failure as "this citation does not exist" would make the user delete a perfectly fine reference.
 *
 * `requestLiterature` only retries 429 and 5xx; **timeouts are thrown** and end after one try, so
 * a single network hiccup would otherwise leave the reference "could not be checked".
 *
 * Only one extra chance: lookups run over dozens of references, and the retry count multiplies
 * straight into the total run time.
 */
const TRANSIENT_RETRY_DELAY_MS = 1_000

export async function lookupCitation(identifier: string, signal?: AbortSignal): Promise<PubmedLookup> {
  const first = await lookupCitationOnce(identifier, signal)
  if (first.found || first.reason !== 'unavailable') return first
  // No retry when the caller cancels on purpose (the user paused the task): that is not a hiccup.
  if (signal?.aborted) return first
  await new Promise((resolve) => setTimeout(resolve, TRANSIENT_RETRY_DELAY_MS))
  if (signal?.aborted) return first
  return lookupCitationOnce(identifier, signal)
}

async function lookupCitationOnce(identifier: string, signal?: AbortSignal): Promise<PubmedLookup> {
  const cleaned = identifier.trim().replace(/^(?:PMID|doi)[：:\s]*/i, '').replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
  if (!cleaned) return { found: false, reason: 'bad-identifier', identifier }

  try {
    if (PMID.test(cleaned)) return await summaryOf(cleaned, signal)

    if (DOI.test(cleaned)) {
      /*
       * A PubMed search error must not block the sources after it: NCBI esearch can return
       * "Search Backend failed ... Cannot connect to SOLR" for a whole day while Crossref works fine.
       * Returning "temporarily unavailable" right away would leave every reference identified by DOI
       * stuck.
       */
      /*
       * Per-source fault tolerance: each source has only three outcomes: found / definitely not found
       * / lookup failed. Use the first one that finds it; only when every source definitely finds
       * nothing is it "no such ID"; if any source failed (timeout, 5xx, 200 with missing fields), we
       * can only say "temporarily unavailable". If one source failed, we cannot declare all not found.
       */
      const failures: string[] = []
      let pubmedFailed = false
      const ask = async (source: () => Promise<PubmedLookup>): Promise<PubmedLookup> => {
        try {
          return await source()
        } catch (error) {
          if (signal?.aborted) throw error
          return { found: false, reason: 'unavailable', identifier: cleaned, detail: error instanceof Error ? error.message : '网络错误' }
        }
      }
      let pmid: string | undefined
      try {
        const search = await getJson(
          `${ESEARCH}?db=pubmed&term=${encodeURIComponent(`${cleaned}[DOI]`)}&retmode=json`,
          signal,
        ) as { error?: string; esearchresult?: { idlist?: string[]; ERROR?: string } }
        // HTTP 200 without `esearchresult` / `idlist` is, like an ERROR, a failed lookup, not "not
        // indexed in PubMed".
        if (search.error || search.esearchresult?.ERROR || !Array.isArray(search.esearchresult?.idlist)) {
          failures.push(String(search.esearchresult?.ERROR ?? search.error ?? 'PubMed 检索返回缺字段'))
          pubmedFailed = true
        } else pmid = search.esearchresult.idlist[0]
      } catch (error) {
        if (signal?.aborted) throw error
        failures.push(error instanceof Error ? error.message : '网络错误')
        pubmedFailed = true
      }
      const settled = (lookup: PubmedLookup & { found: true }): PubmedLookup => (
        pubmedFailed ? { ...lookup, pubmedUnavailable: true } : lookup
      )
      if (pmid) {
        const summary = await ask(() => summaryOf(pmid!, signal))
        if (summary.found) return summary
        // Found a PMID but could not fetch its details: count PubMed as failed and keep querying the
        // remaining sources.
        if (summary.reason === 'unavailable') failures.push(summary.detail)
        pubmedFailed = true
      }
      // A DOI with no PMID **does not mean the DOI is fake**: many journals are not in PubMed
      // (Chinese journals, most engineering and social-science journals). So Crossref must confirm it,
      // otherwise the user would delete a perfectly fine reference.
      // Many Chinese DOIs are registered only with China DOI/CHNDOI; DOIs registered elsewhere are not
      // found by CHNDOI, so ask doi.org next.
      for (const source of [crossrefOf, registeredDoiOf]) {
        const lookup = await ask(() => source(cleaned, signal))
        if (lookup.found) return settled(lookup)
        if (lookup.reason === 'unavailable') failures.push(lookup.detail)
      }
      return failures.length
        ? { found: false, reason: 'unavailable', identifier: cleaned, detail: failures.join('；') }
        : { found: false, reason: 'not-found', identifier: cleaned }
    }

    return { found: false, reason: 'bad-identifier', identifier: cleaned }
  } catch (error) {
    if (signal?.aborted) throw error
    return {
      found: false,
      reason: 'unavailable',
      identifier: cleaned,
      detail: error instanceof Error ? error.message : '网络错误',
    }
  }
}

/**
 * Bibliographic search for entries without an ID.
 *
 * **Only fetches candidates, makes no judgment**: judgment happens in `citation-match.ts`, as a
 * deterministic check. Crossref returns results for any query, and its score cannot be used as
 * confidence (entirely wrong candidates can score high).
 */
const CROSSREF_SEARCH_SELECT = 'title,author,container-title,issued,DOI,score,volume,issue,page'

export async function searchBibliographic(entry: string, rows = 5, signal?: AbortSignal): Promise<unknown[]> {
  const url = crossrefUrl()
  url.searchParams.set('query.bibliographic', entry.slice(0, 400))
  url.searchParams.set('rows', String(rows))
  url.searchParams.set('select', CROSSREF_SEARCH_SELECT)
  const response = await fetchWithRetry(url, {
    headers: profile.crossrefHeaders,
    signal: requestSignal(signal),
  })
  if (!response.ok) throw new Error(`Crossref 返回 ${response.status}`)
  const payload = await response.json() as { message?: { items?: unknown[] } }
  return payload.message?.items ?? []
}

/**
 * The same bibliographic search, keeping only records within one year of the cited year. Only
 * used as a fallback after "DOI not found and no match by title": for guideline chapters with
 * the same title every year (ADA Standards of Care, chapter 9), without a year that year's
 * edition does not make the top results. The window is one year wide because Crossref's `issued`
 * is often the online-first date.
 */
export async function searchBibliographicNearYear(entry: string, year: number, rows = 5, signal?: AbortSignal): Promise<unknown[]> {
  const url = crossrefUrl()
  url.searchParams.set('query.bibliographic', entry.slice(0, 400))
  url.searchParams.set('rows', String(rows))
  url.searchParams.set('select', CROSSREF_SEARCH_SELECT)
  url.searchParams.set('filter', `from-pub-date:${year - 1},until-pub-date:${year + 1}`)
  const response = await fetchWithRetry(url, {
    headers: profile.crossrefHeaders,
    signal: requestSignal(signal),
  })
  if (!response.ok) throw new Error(`Crossref 返回 ${response.status}`)
  const payload = await response.json() as { message?: { items?: unknown[] } }
  return payload.message?.items ?? []
}
