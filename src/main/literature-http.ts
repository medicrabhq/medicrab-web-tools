// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 TIKMOON LTD
/**
 * Rate limiter for public literature APIs.
 *
 * NCBI without an API key allows about 3 requests per second and needs its own queue.
 * Crossref returns 429 when hit too fast, but it does not need to share NCBI's queue.
 * CHNDOI / Europe PMC and others use a third queue.
 */
const MAX_RETRIES = 3

const QUEUE_INTERVAL_MS = {
  ncbi: 350,
  crossref: 150,
  other: 200,
} as const

type LiteratureQueue = keyof typeof QUEUE_INTERVAL_MS

interface QueueState {
  chain: Promise<unknown>
  lastCallAt: number
}

const queues: Record<LiteratureQueue, QueueState> = {
  ncbi: { chain: Promise.resolve(), lastCallAt: 0 },
  crossref: { chain: Promise.resolve(), lastCallAt: 0 },
  other: { chain: Promise.resolve(), lastCallAt: 0 },
}

export function literatureQueueFor(url?: string | URL | null): LiteratureQueue {
  const parsed = parseUrl(url)
  if (!parsed) return 'other'
  const host = parsed.host
  if (host === 'eutils.ncbi.nlm.nih.gov' || host.endsWith('.ncbi.nlm.nih.gov')) return 'ncbi'
  if (host === 'api.crossref.org' || host.endsWith('.crossref.org')) return 'crossref'
  return 'other'
}

function parseUrl(url?: string | URL | null): { host: string; pathname: string } | null {
  if (!url) return null
  try {
    const parsed = typeof url === 'string' ? new URL(url) : url
    return { host: parsed.host.toLowerCase(), pathname: parsed.pathname }
  } catch {
    return null
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function schedule<T>(
  queue: LiteratureQueue, run: () => Promise<T>, signal?: AbortSignal,
): Promise<T> {
  const state = queues[queue]
  const interval = QUEUE_INTERVAL_MS[queue]
  const mine = state.chain.then(async () => {
    throwIfAborted(signal)
    const wait = interval - (Date.now() - state.lastCallAt)
    if (wait > 0) await sleep(wait, signal)
    throwIfAborted(signal)
    state.lastCallAt = Date.now()
    return run()
  })
  state.chain = mine.catch(() => undefined)
  return mine as Promise<T>
}

export interface LiteratureRequestOptions {
  signal?: AbortSignal
  url?: string | URL | null
  /**
   * Do not retry 5xx. The Europe PMC full-text endpoint always returns 500 for articles that are in PMC
   * but have no open XML; retrying three times just wastes time on every such article. 429 still backs
   * off as usual.
   */
  noServerErrorRetry?: boolean
}

/** Retry 429 and 5xx with Retry-After / exponential backoff; pass other statuses to the caller as-is. */
export async function requestLiterature(
  run: () => Promise<Response>,
  signalOrOptions?: AbortSignal | LiteratureRequestOptions,
  maybeOptions?: LiteratureRequestOptions,
): Promise<Response> {
  const options: LiteratureRequestOptions = signalOrOptions instanceof AbortSignal
    || signalOrOptions == null
    ? { signal: signalOrOptions ?? undefined, ...maybeOptions }
    : signalOrOptions
  const queue = literatureQueueFor(options.url)
  for (let attempt = 0; ; attempt += 1) {
    throwIfAborted(options.signal)
    const response = await schedule(queue, run, options.signal)
    if (response.status !== 429 && response.status < 500) return response
    if (options.noServerErrorRetry && response.status >= 500) return response
    if (attempt >= MAX_RETRIES) {
      return response
    }
    const retryAfter = Number(response.headers.get('retry-after'))
    await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1_000 : 2 ** attempt * 1_000, options.signal)
  }
}
