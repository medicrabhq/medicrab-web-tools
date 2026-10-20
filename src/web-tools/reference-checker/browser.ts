// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 TIKMOON LTD
/**
 * Browser entry point of the website reference checker. Bundled by `scripts/build.mjs` into
 * `dist/reference-checker-engine.js`; page scripts call it via `window.MCRefCheck`.
 *
 * All lookups go straight from the user's browser to PubMed / Crossref / doi.org, never through
 * MediCrab servers.
 */
import {
  BROWSER_LITERATURE_PROFILE, lookupCitation, searchBibliographic, searchBibliographicNearYear, useLiteratureProfile,
} from '../../main/pubmed-service'
import { checkEntry, type EntryCheck } from './check'
import { splitReferenceList, type SplitResult } from './split'

/**
 * Query orchestration uses `AbortSignal.any` / `AbortSignal.timeout` (`any` is missing before
 * Safari 17.4 and Firefox 124). If missing, install a minimal polyfill so older browsers don't
 * report every entry as "lookup failed".
 */
function ensureAbortSignalHelpers(): void {
  const signals = AbortSignal as typeof AbortSignal & Partial<Pick<typeof AbortSignal, 'any' | 'timeout'>>
  if (typeof signals.timeout !== 'function') {
    signals.timeout = (ms: number) => {
      const controller = new AbortController()
      setTimeout(() => controller.abort(new DOMException('The operation timed out.', 'TimeoutError')), ms)
      return controller.signal
    }
  }
  if (typeof signals.any !== 'function') {
    signals.any = (list: Iterable<AbortSignal>) => {
      const controller = new AbortController()
      for (const signal of list) {
        if (signal.aborted) { controller.abort(signal.reason); break }
        signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
      }
      return controller.signal
    }
  }
}

ensureAbortSignalHelpers()
useLiteratureProfile(BROWSER_LITERATURE_PROFILE)

const api = {
  split(text: string): SplitResult {
    return splitReferenceList(text)
  },
  check(entry: string, signal?: AbortSignal): Promise<EntryCheck> {
    return checkEntry(entry, { lookup: lookupCitation, search: searchBibliographic, searchNearYear: searchBibliographicNearYear }, signal)
  },
}

declare global {
  interface Window { MCRefCheck: typeof api }
}

window.MCRefCheck = api
