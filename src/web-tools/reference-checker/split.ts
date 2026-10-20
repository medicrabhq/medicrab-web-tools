// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 TIKMOON LTD
/**
 * Website reference checker: split a pasted reference list into individual entries.
 *
 * In a list copied from Word / PDF **the line breaks are the separators**; collapsing them would
 * make an unnumbered list impossible to split. So the list is split by line:
 *
 * - With numbers (`[1]`, `1.`, `1)`, `(1)`), each number starts an entry and unnumbered lines are
 *   appended to the previous entry (PDF line wraps); a line holding several `[n]` is split by number.
 * - Without numbers, split into paragraphs on blank lines if there are any; otherwise one line per
 *   entry, but lines that are clearly wrapped continuations are joined back to the previous entry.
 *
 * **Never silently drop anything**: uncertain spots (an overly long entry, skipped or repeated
 * numbers, leading text that is not an entry) go into `warnings`, and the page tells the user
 * "found N entries" before querying so a bad split can be corrected. `confident` is false when
 * the split was guessed or any of these were found.
 */

export interface SplitEntry {
  /** The number written in the list; null for unnumbered lists. */
  number: number | null
  /**
   * Text of this entry with line breaks joined by spaces (no space inserted at breaks inside a DOI
   * or URL).
   */
  text: string
}

export type SplitWarning =
  | { kind: 'long-entry'; index: number }
  | { kind: 'short-entry'; index: number }
  | { kind: 'numbering-gap'; missing: number[] }
  | { kind: 'numbering-duplicate'; numbers: number[] }
  | { kind: 'leading-text'; text: string }
  | { kind: 'too-many'; limit: number; total: number }

export interface SplitResult {
  entries: SplitEntry[]
  warnings: SplitWarning[]
  /**
   * True when numbering is consecutive or entries are split on blank lines; false when relying on
   * line-wrap guesses or when an entry is overly long.
   */
  confident: boolean
  mode: 'numbered' | 'paragraphs' | 'lines' | 'empty'
}

/**
 * Maximum entries per check: NCBI without an API key allows 3 requests per second, so 200 entries
 * already take a few minutes.
 */
export const MAX_ENTRIES = 200
const LONG_ENTRY = 700
const SHORT_ENTRY = 25

const HEADING = /^\s*(?:references?|bibliography|reference list|literature cited|works cited|参考文献|參考文獻|参考文献一覧|引用文献|참고\s*문헌)\s*[:：]?\s*$/i
/**
 * Leading number: `[12]`, `［12］`, `12.`, `12．`, `12)`, `(12)`, `12、`; must not be followed
 * directly by a digit (excludes things like `2021;36`).
 */
const LINE_MARKER = /^\s*(?:\[\s*(\d{1,3})\s*\]|［\s*(\d{1,3})\s*］|\(\s*(\d{1,3})\s*\)|(\d{1,3})\s*[.．)）、](?!\d))\s*/

function cleanText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[   ]/g, ' ')
    .replace(/[​-‍﻿]/g, '')
}

function markerOf(line: string): { number: number; rest: string; style: string } | null {
  const match = LINE_MARKER.exec(line)
  if (!match) return null
  const number = Number(match[1] ?? match[2] ?? match[3] ?? match[4])
  const rest = line.slice(match[0].length)
  // A line with only a number and nothing after it (Word auto-numbering sometimes pastes this way)
  // also starts an entry; the text is on the next line.
  if (!Number.isFinite(number) || number < 1) return null
  const style = match[1] || match[2] ? '[]' : match[3] ? '()' : match[0].trim().slice(-1).replace('．', '.').replace('）', ')')
  return { number, rest, style }
}

/**
 * After the first entry, a leading number starts a new entry only if it uses the same style as the
 * first one and is not smaller than the current number; otherwise it is a line wrap (a PDF wrapping
 * `16(4)` into `4):R151`). Skipped numbers still start entries and trigger a gap warning; a
 * same-style number that goes backwards is not silently absorbed but flagged as a doubtful split.
 */
const YEAR = /\b(?:19|20)\d{2}\b/

const LINK_TOKEN = /(?:10\.\d{4,9}\/|https?:\/\/|doi\.org\/)\S*$/i
const AFTER_LINK_WORD = /^(?:pmid|pmcid|epub|available|accessed|doi|https?|published|retrieved)\b/i

/**
 * Whether a DOI or URL was broken at the end of a line. Ending in `-` `/` `_` is always a break;
 * ending in `.` may be a break (`10.1016/j.` + `ijcard…`) or a sentence period
 * (`10.1186/cc11466.` + `(PubMed…`, `PMID: …`), so join only if the next line looks like a DOI
 * continuation.
 */
function continuesLink(lastToken: string, next: string): boolean {
  if (!LINK_TOKEN.test(lastToken)) return false
  if (/[-/_]$/.test(lastToken)) return /^[A-Za-z0-9]/.test(next)
  if (/\.$/.test(lastToken)) return /^[a-z0-9]/.test(next) && !AFTER_LINK_WORD.test(next)
  return false
}

/**
 * Join the lines of one entry into one. No space where a DOI or URL broke at the line end; one
 * space elsewhere.
 */
function joinLines(lines: string[]): string {
  let out = ''
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (!out) { out = line; continue }
    const lastToken = out.slice(out.lastIndexOf(' ') + 1)
    out += continuesLink(lastToken, line) ? line : ` ${line}`
  }
  return out.replace(/\s+/g, ' ').trim()
}

/**
 * When one line holds several entries (`[1] … [2] … [3] …`), split on consecutive numbers only;
 * in-text citations like `[12]` are left alone.
 */
function splitInlineBrackets(entry: SplitEntry): SplitEntry[] {
  if (entry.number === null) return [entry]
  const pieces: SplitEntry[] = []
  let current = entry.number
  let rest = entry.text
  for (;;) {
    const next = new RegExp(`(?:^|\\s)[\\[［]\\s*${current + 1}\\s*[\\]］]\\s*`).exec(rest)
    if (!next || next.index < 15) break
    pieces.push({ number: current, text: rest.slice(0, next.index).trim() })
    rest = rest.slice(next.index + next[0].length)
    current += 1
  }
  pieces.push({ number: current, text: rest.trim() })
  return pieces
}

/**
 * Without numbers or blank lines: is this line a wrapped continuation of the previous entry?
 * Check both ends: this line starts with a lowercase letter, a digit, "doi" or a page number; or
 * the previous line is unfinished, i.e. no year yet (only authors or title so far), or it does not
 * end with a period, parenthesis, numeric page, DOI or URL.
 */
function continuesPrevious(previous: string, line: string): boolean {
  const next = line.trim()
  if (/^[a-z(&\d]/.test(next) || /^(?:doi\b|https?:\/\/|pmid\b|pmcid\b|available from\b|accessed\b)/i.test(next)) return true
  const prev = previous.trim()
  if (/(?:https?:\/\/|10\.\d{4,9}\/)\S+$/i.test(prev)) return false
  // Journal references always have a year: if the previous entry has no year yet, it only got as
  // far as authors or title, and this line continues it.
  if (!YEAR.test(prev)) return true
  return !/[.)\]\d]$/.test(prev)
}

function numberingWarnings(entries: SplitEntry[]): SplitWarning[] {
  const numbers = entries.map((entry) => entry.number).filter((value): value is number => value !== null)
  if (numbers.length < 2) return []
  const warnings: SplitWarning[] = []
  const seen = new Set<number>()
  const duplicates = new Set<number>()
  for (const value of numbers) {
    if (seen.has(value)) duplicates.add(value)
    seen.add(value)
  }
  if (duplicates.size) warnings.push({ kind: 'numbering-duplicate', numbers: [...duplicates].sort((a, b) => a - b) })
  const first = Math.min(...numbers)
  const last = Math.max(...numbers)
  const missing: number[] = []
  for (let value = first; value <= last && missing.length < 50; value++) if (!seen.has(value)) missing.push(value)
  if (missing.length) warnings.push({ kind: 'numbering-gap', missing })
  return warnings
}

export function splitReferenceList(input: string): SplitResult {
  const lines = cleanText(input).split('\n')
  const trimEdges = () => {
    while (lines.length && !lines[0]!.trim()) lines.shift()
    while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop()
  }
  // Leading and trailing blank lines are not paragraph separators: only blank lines between content
  // split paragraphs.
  trimEdges()
  if (lines.length && HEADING.test(lines[0]!)) { lines.shift(); trimEdges() }
  const nonEmpty = lines.filter((line) => line.trim())
  if (!nonEmpty.length) return { entries: [], warnings: [], confident: true, mode: 'empty' }

  const warnings: SplitWarning[] = []
  let entries: SplitEntry[]
  let mode: SplitResult['mode']
  let guessed = false

  const numberedLines = nonEmpty.filter((line) => markerOf(line)).length
  if (numberedLines >= 2 || (numberedLines === 1 && nonEmpty.length === 1)) {
    mode = 'numbered'
    entries = []
    const leading: string[] = []
    let current: { number: number; lines: string[] } | null = null
    let style: string | null = null
    for (const line of lines) {
      const candidate = markerOf(line)
      const marker: ReturnType<typeof markerOf> = candidate && (!current || (candidate.style === style
        && candidate.number >= current.number)) ? candidate : null
      // A rejected number may really start a new entry if it uses the first entry's style or is followed
      // by capitalized text (`2) Jones B. …`): flag it as doubtful.
      if (candidate && !marker && current && (candidate.style === style || /^[\p{Lu}]/u.test(candidate.rest))) guessed = true
      if (marker) {
        style ??= marker.style
        if (current) entries.push({ number: current.number, text: joinLines(current.lines) })
        current = { number: marker.number, lines: [marker.rest] }
      } else if (current) {
        current.lines.push(line)
      } else if (line.trim()) {
        leading.push(line)
      }
    }
    if (current) entries.push({ number: current.number, text: joinLines(current.lines) })
    entries = entries.flatMap(splitInlineBrackets)
    if (leading.length) warnings.push({ kind: 'leading-text', text: joinLines(leading).slice(0, 200) })
    warnings.push(...numberingWarnings(entries))
  } else if (lines.some((line, index) => !line.trim() && index > 0 && index < lines.length - 1)) {
    mode = 'paragraphs'
    entries = []
    let block: string[] = []
    for (const line of [...lines, '']) {
      if (line.trim()) { block.push(line); continue }
      if (block.length) entries.push({ number: null, text: joinLines(block) })
      block = []
    }
  } else {
    mode = 'lines'
    entries = []
    for (const line of nonEmpty) {
      const last = entries[entries.length - 1]
      if (last && continuesPrevious(last.text, line)) {
        last.text = joinLines([last.text, line])
        guessed = true
      } else {
        entries.push({ number: null, text: joinLines([line]) })
      }
    }
  }

  entries = entries.filter((entry) => entry.text)
  entries.forEach((entry, index) => {
    if (entry.text.length > LONG_ENTRY) warnings.push({ kind: 'long-entry', index })
    else if (entry.text.length < SHORT_ENTRY) warnings.push({ kind: 'short-entry', index })
  })
  if (entries.length > MAX_ENTRIES) {
    warnings.push({ kind: 'too-many', limit: MAX_ENTRIES, total: entries.length })
    entries = entries.slice(0, MAX_ENTRIES)
  }
  const confident = !guessed && !warnings.some((warning) => warning.kind === 'long-entry'
    || warning.kind === 'numbering-gap' || warning.kind === 'numbering-duplicate' || warning.kind === 'leading-text')
  return { entries, warnings, confident, mode }
}
