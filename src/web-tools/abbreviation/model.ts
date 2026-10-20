// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 TIKMOON LTD
/**
 * "Find missing full terms with a model provided by MediCrab" for the abbreviation list (off by default; sends
 * only when the user ticks it and clicks the button). Pure functions plus one fetch wrapper, shared by
 * the page and unit tests.
 *
 * - Sentence selection: only for abbreviations without a locally found full form ("no full form found"
 *   and "possibly not an abbreviation"), take the sentence of each one's first occurrence;
 *   abbreviations whose full form was found in the text locally are not sent. Truncate to the
 *   server's per-request limits (items, sentences, characters per sentence, total characters, request
 *   body bytes) without batching (batching would use up more of the daily quota); count what was left
 *   out and tell the user.
 * - Merge: the model may only supply a full form or mark "not an abbreviation" for these entries. The
 *   full form must appear verbatim in the sentence it points to (checked again locally), otherwise it
 *   is dropped; it cannot add abbreviations or change the abbreviation or first occurrence; entries
 *   that already have a local full form are never touched.
 * - Endpoint: POST /v1/tools/abbreviations; request, response and error codes are defined server-side.
 */
import { contextOf, scopeParagraphs, type ListEntry, type Loc, type Scope } from './detect'

/**
 * Matches the server's per-request limits; request body bytes keep a margin (a CJK character takes 3
 * bytes).
 */
export interface ModelLimits { items: number; sentences: number; sentenceChars: number; totalChars: number; bodyBytes: number; longChars: number }
export const MODEL_LIMITS: Readonly<ModelLimits> = Object.freeze({ items: 120, sentences: 200, sentenceChars: 600, totalChars: 40_000, bodyBytes: 60_000, longChars: 300 })
export const MODEL_ENDPOINT = 'https://api-crab.medicrab.com/v1/tools/abbreviations'

export interface ModelItem { id: string; abbr: string; sentenceIds: string[] }
export interface ModelSentence { id: string; text: string }
export interface ModelRequest { page: string; lang: string; items: ModelItem[]; sentences: ModelSentence[] }

interface SentenceInfo { para: number; scope: Scope; start: number; text: string }

export interface ModelPlan {
  request: ModelRequest
  /** item id -> abbreviation in the list (`ListEntry.abbr`). */
  itemAbbr: Map<string, string>
  sentenceInfo: Map<string, SentenceInfo>
  /** Pre-send preview: the original sentence and the abbreviations in it being asked about. */
  preview: { text: string; hits: { at: number; len: number }[] }[]
  /** Total characters of the sentences. */
  chars: number
  /** Number of abbreviations that need tidy-up but exceed the per-request limit and are not sent this time. */
  omitted: number
}

// ---------------------------------------------------------------- Sentence splitting

const OPENERS = '（(\\[［【'
const CLOSERS = '）)\\]］】'
const LOCAL_END = /[。！？；]/
/**
 * A period after these (e.g., et al., Fig., a single capital letter as a name initial) does not end
 * a sentence.
 */
const NOT_END = /(?:\b(?:e\.g|i\.e|et al|etc|al|Fig|Figs|fig|figs|vs|No|Nos|no|approx|ca|cf|Dr|Mr|Mrs|Ms|Prof|St|Ref|Refs|Eq|Eqs|Vol|vol|pp|ed|eds|Inc|Ltd|Co|Jr|Sr|resp|incl|min|max|Suppl|Dept|Univ)\.|(?<![A-Za-z])[A-Z]\.)$/
const NEXT_START = new RegExp(`^\\s+["“‘'${OPENERS}]?[A-Z0-9぀-ヿ㐀-鿿가-힯]`)

/**
 * [start, end) of each sentence in a paragraph. No splits inside parentheses (if a sentence ends on
 * an open parenthesis, join it with the next one).
 */
export function sentenceSpans(text: string): [number, number][] {
  const spans: [number, number][] = []
  let start = 0
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (OPENERS.includes(c)) depth++
    else if (CLOSERS.includes(c)) depth = Math.max(0, depth - 1)
    if (depth > 0) continue
    let end = -1
    if (LOCAL_END.test(c)) end = i + 1
    else if ((c === '.' || c === '!' || c === '?') && NEXT_START.test(text.slice(i + 1, i + 4)) && !(c === '.' && NOT_END.test(text.slice(Math.max(0, i - 12), i + 1)))) end = i + 1
    if (end > 0) {
      spans.push([start, end])
      start = end
    }
  }
  if (start < text.length) spans.push([start, text.length])
  return spans.map(([s, e]) => {
    while (s < e && /\s/.test(text[s]!)) s++
    while (e > s && /\s/.test(text[e - 1]!)) e--
    return [s, e] as [number, number]
  }).filter(([s, e]) => e > s)
}

/**
 * The sentence containing index `at`; if longer than `max` characters, cut a window centred on this
 * occurrence (breaking at whitespace where possible).
 */
export function sentenceAt(text: string, at: number, len: number, max: number = MODEL_LIMITS.sentenceChars): { start: number; text: string } {
  const span = sentenceSpans(text).find(([s, e]) => at >= s && at < e) ?? [0, text.length]
  let [s, e] = span
  if (e - s > max) {
    s = Math.max(s, Math.min(at - Math.floor((max - len) / 2), e - max))
    e = Math.min(e, s + max)
    const space = text.slice(s, Math.min(at, s + 40)).search(/\s/)
    if (s > span[0] && space >= 0) s += space + 1
    const tail = text.slice(Math.max(at + len, e - 40), e)
    const back = tail.search(/\s\S*$/)
    if (e < span[1] && back >= 0) e = Math.max(at + len, e - 40) + back
  }
  const raw = text.slice(s, e)
  const lead = raw.length - raw.trimStart().length
  return { start: s + lead, text: raw.trim() }
}

// ---------------------------------------------------------------- Sentence selection

const norm = (s: string): string => s.normalize('NFKC').toLowerCase().replace(/[\s­‐-―−\-_/]+/g, '')
const byteLength = (s: string): number => new TextEncoder().encode(s).length

/**
 * Build the request for abbreviations without a full form. Returns null when there is nothing to ask.
 * Order: list entries first, "possibly not an abbreviation" after, each by first-occurrence paragraph;
 * entries beyond the limit are not sent and are counted in `omitted`.
 */
export function planModelRequest(raw: string, split: boolean, entries: ListEntry[], meta: { lang: string; page: string }, limits: Readonly<ModelLimits> = MODEL_LIMITS): ModelPlan | null {
  const firstRow = new Map<string, ListEntry>()
  for (const e of entries) {
    if (e.long !== null || e.longSource) continue
    const prev = firstRow.get(e.abbr)
    if (!prev || e.firstUse.para < prev.firstUse.para || (e.firstUse.para === prev.firstUse.para && e.firstUse.at < prev.firstUse.at)) firstRow.set(e.abbr, e)
  }
  // If any row of the same abbreviation is in the list, treat it as a list entry
  const inList = new Set(entries.filter((e) => e.section === 'list').map((e) => e.abbr))
  const wanted = [...firstRow.values()].sort((a, b) => Number(!inList.has(a.abbr)) - Number(!inList.has(b.abbr))
    || a.firstUse.para - b.firstUse.para || a.firstUse.at - b.firstUse.at)
  if (!wanted.length) return null

  const paras = new Map(scopeParagraphs(raw, split).paragraphs.map((p) => [p.index, p]))
  const items: ModelItem[] = []
  const sentences: ModelSentence[] = []
  const sentenceKey = new Map<string, string>()
  const sentenceInfo = new Map<string, SentenceInfo>()
  const itemAbbr = new Map<string, string>()
  const preview = new Map<string, { text: string; hits: { at: number; len: number }[] }>()
  let chars = 0
  let bytes = byteLength(JSON.stringify({ page: meta.page, lang: meta.lang, items: [], sentences: [] }))
  let omitted = 0
  for (const e of wanted) {
    const para = paras.get(e.firstUse.para)
    if (!para) { omitted++; continue }
    const hit = e.firstUse.ctx.hit
    const { start, text } = sentenceAt(para.text, e.firstUse.at, hit.length, limits.sentenceChars)
    const key = `${para.index}:${start}`
    let sid = sentenceKey.get(key)
    const isNew = !sid
    const newSid = sid ?? `s${sentenceKey.size + 1}`
    const abbr = norm(text).includes(norm(e.abbr)) ? e.abbr : hit
    const id = `a${items.length + 1}`
    const item: ModelItem = { id, abbr, sentenceIds: [newSid] }
    const addBytes = byteLength(JSON.stringify(item)) + 1 + (isNew ? byteLength(JSON.stringify({ id: newSid, text })) + 1 : 0)
    if (items.length + 1 > limits.items || (isNew && (sentences.length + 1 > limits.sentences || chars + text.length > limits.totalChars))
      || bytes + addBytes > limits.bodyBytes || abbr.length > 40) { omitted++; continue }
    if (isNew) {
      sid = newSid
      sentenceKey.set(key, sid)
      sentences.push({ id: sid, text })
      sentenceInfo.set(sid, { para: para.index, scope: para.scope, start, text })
      preview.set(sid, { text, hits: [] })
      chars += text.length
    }
    bytes += addBytes
    items.push(item)
    itemAbbr.set(id, e.abbr)
    preview.get(sid!)!.hits.push({ at: e.firstUse.at - sentenceInfo.get(sid!)!.start, len: hit.length })
  }
  if (!items.length) return null
  return { request: { page: meta.page, lang: meta.lang, items, sentences }, itemAbbr, sentenceInfo, preview: [...preview.values()], chars, omitted }
}

// ---------------------------------------------------------------- Merge

export interface MergeResult {
  /**
   * One-to-one with the passed-in entries (same order, same length); unchanged entries are the original
   * objects.
   */
  entries: ListEntry[]
  /** Number of abbreviations that gained a full form. */
  filled: number
  /** Number of abbreviations moved from the list to "possibly not an abbreviation". */
  movedOut: number
  /** Number of abbreviations moved from "possibly not an abbreviation" back to the list. */
  movedIn: number
  /**
   * Number of full forms the model gave that were dropped because they could not be matched in the
   * original sentence locally.
   */
  dropped: number
}

/**
 * A usable full form appears verbatim in the indicated original sentence, is not the abbreviation
 * itself, contains letters and is not too long.
 */
function acceptedLong(plan: ModelPlan, item: ModelItem, abbr: string, long: unknown, definedIn: unknown): { long: string; sid: string } | null {
  if (typeof long !== 'string' || typeof definedIn !== 'string' || !item.sentenceIds.includes(definedIn)) return null
  const value = long.trim()
  const sentence = plan.sentenceInfo.get(definedIn)
  if (!value || !sentence || value.length > MODEL_LIMITS.longChars || !/\p{L}/u.test(value)) return null
  if (norm(value) === norm(abbr) || norm(value) === norm(item.abbr)) return null
  if (!sentence.text.includes(value)) return null
  return { long: value, sid: definedIn }
}

export function mergeModelResult(entries: ListEntry[], plan: ModelPlan, response: unknown): MergeResult {
  const out = [...entries]
  const result: MergeResult = { entries: out, filled: 0, movedOut: 0, movedIn: 0, dropped: 0 }
  const answers = (response && typeof response === 'object' && Array.isArray((response as { items?: unknown }).items)) ? (response as { items: unknown[] }).items : []
  const itemById = new Map(plan.request.items.map((it) => [it.id, it]))
  const seen = new Set<string>()
  for (const answer of answers) {
    if (!answer || typeof answer !== 'object') continue
    const a = answer as { id?: unknown; isAbbreviation?: unknown; long?: unknown; definedIn?: unknown }
    if (typeof a.id !== 'string' || seen.has(a.id)) continue
    const item = itemById.get(a.id)
    const abbr = plan.itemAbbr.get(a.id)
    if (!item || !abbr) continue // Not in the request: cannot add abbreviations
    seen.add(a.id)
    const ok = acceptedLong(plan, item, abbr, a.long, a.definedIn)
    if (!ok && typeof a.long === 'string' && a.long.trim()) result.dropped++
    const rows = out.map((e, i) => [e, i] as const).filter(([e]) => e.abbr === abbr && e.long === null && !e.longSource)
    if (!rows.length) continue
    if (ok) {
      const s = plan.sentenceInfo.get(ok.sid)!
      const at = s.start + s.text.indexOf(ok.long)
      const def: Loc = { para: s.para, at, ctx: contextOf(s.text, s.text.indexOf(ok.long), ok.long.length) }
      for (const [e, i] of rows) {
        const marks = e.marks.filter((m) => m !== 'no_long')
        const elsewhere = e.scope !== s.scope && (e.scope === 'abstract' || e.scope === 'body') ? ['defined_elsewhere' as const] : []
        const { why: _why, ...rest } = e
        out[i] = { ...rest, long: ok.long, longSource: 'model', firstDef: def, marks: [...elsewhere, 'model', ...marks], section: 'list' }
      }
      result.filled++
      if (rows.some(([e]) => e.section === 'maybe_not')) result.movedIn++
    } else if (a.isAbbreviation === false && rows.some(([e]) => e.section === 'list')) {
      for (const [e, i] of rows) out[i] = { ...e, section: 'maybe_not', why: 'model' }
      result.movedOut++
    } else if (a.isAbbreviation === true && rows.some(([e]) => e.section === 'maybe_not')) {
      for (const [e, i] of rows) {
        const { why: _why, ...rest } = e
        out[i] = { ...rest, section: 'list' }
      }
      result.movedIn++
    }
  }
  return result
}

// ---------------------------------------------------------------- Request

export type ModelErrorCode = 'ip_daily' | 'site_daily' | 'ip_minute' | 'disabled' | 'unavailable' | 'upstream_failed' | 'too_large' | 'origin_not_allowed' | 'invalid_request' | 'network'
export type ModelOutcome = { ok: true; data: { items: unknown[] } } | { ok: false; code: ModelErrorCode; retryAfter?: number }

const KNOWN: ModelErrorCode[] = ['ip_daily', 'site_daily', 'ip_minute', 'disabled', 'unavailable', 'upstream_failed', 'too_large', 'origin_not_allowed', 'invalid_request']

/**
 * Send one request; every failure is folded into a single `code` (the page shows text based on it and
 * keeps the local result); never throws.
 */
export async function callModel(request: ModelRequest, options: { endpoint?: string; fetchImpl?: typeof fetch; timeoutMs?: number } = {}): Promise<ModelOutcome> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), options.timeoutMs ?? 75_000) : null
  try {
    const res = await fetchImpl(options.endpoint ?? MODEL_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      credentials: 'omit',
      signal: controller?.signal,
    })
    const body = await res.json().catch(() => null) as { items?: unknown; error?: { code?: unknown; retryAfter?: unknown } } | null
    if (res.ok) return body && Array.isArray(body.items) ? { ok: true, data: { items: body.items } } : { ok: false, code: 'upstream_failed' }
    const code = body?.error?.code
    const retryAfter = typeof body?.error?.retryAfter === 'number' ? body.error.retryAfter : undefined
    if (typeof code === 'string' && (KNOWN as string[]).includes(code)) return { ok: false, code: code as ModelErrorCode, ...(retryAfter !== undefined ? { retryAfter } : {}) }
    return { ok: false, code: res.status === 413 ? 'too_large' : res.status === 403 ? 'origin_not_allowed' : 'upstream_failed' }
  } catch {
    return { ok: false, code: 'network' }
  } finally {
    if (timer) clearTimeout(timer)
  }
}
