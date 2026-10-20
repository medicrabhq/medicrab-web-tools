// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 TIKMOON LTD
const DOI_PREFIX = /\b10\s*\.\s*\d{4,9}\s*\/\s*/gi
const DOI_SHAPE = /^10\.\d{4,9}\/.+/i
const URL_PREFIX = /^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi\s*[:：]\s*)/i
/**
 * Publisher footer / button text glued right after the extracted DOI.
 * Words like `Get` often stick directly to digits (`004Get`), so word boundaries do not help; but a
 * trailing `get` cannot be matched unconditionally either, or valid suffixes like `.../idget` break.
 */
const GLUED_JUNK = /(?:https?:\/\/|\bwww\.|(?<=[\d./)(])(?:https?|www|Get|Download|FullText|HTML|PDF|Rights|Reprinted|CrossRef)).*$/i
const TRAILING_PUNCT = /[.,;:。，；、]+$/u
const HEADER_CHARS = 8_000
const REFERENCE_SPLIT = /\n\s*(?:#{1,6}\s*)?(?:参考文献|References|Bibliography)\b/i
/**
 * Characters allowed in a DOI suffix (no whitespace; whitespace is skipped only when bridging OCR
 * breaks).
 */
const DOI_CHAR = /[A-Za-z0-9\-._;()/:]/
/**
 * When OCR inserts a space after `.` / `/` / `-` / `_` and the next segment is one of these English
 * words, stop, so `test. abstract` is not collected as a fake DOI. `cnki` / `issn` / numeric segments
 * are not in this list.
 */
const OCR_BRIDGE_BLOCK = new Set([
  'abstract', 'and', 'article', 'available', 'copyright', 'doi', 'download',
  'for', 'from', 'fulltext', 'get', 'html', 'http', 'https', 'issue', 'journal',
  'pages', 'pdf', 'reprinted', 'retrieved', 'rights', 'see', 'that', 'the',
  'this', 'volume', 'with', 'www',
])

export function sanitizeDoi(value: string | null | undefined): string | null {
  if (!value) return null
  let doi = value.trim().replace(URL_PREFIX, '')
  const start = doi.search(/10\s*\.\s*\d{4,9}\s*\//i)
  if (start < 0) return null
  doi = isolateDoiBody(doi.slice(start)).replace(GLUED_JUNK, '')
  doi = stripUnbalancedTrail(doi.replace(TRAILING_PUNCT, ''))
  if (!DOI_SHAPE.test(doi) || doi.length > 200) return null
  // Single-letter suffixes are almost always OCR / truncation junk (`10.20039/j`), not a real
  // identifier.
  const suffix = doi.slice(doi.indexOf('/') + 1)
  if (/^[a-z]$/i.test(suffix)) return null
  return doi.toLowerCase()
}

export function extractDoi(text: string): string | null {
  if (!text) return null
  const header = text.length > HEADER_CHARS ? text.slice(0, HEADER_CHARS) : text
  const front = text.split(REFERENCE_SPLIT)[0] ?? text
  return firstCleanDoi(header) ?? firstCleanDoi(front) ?? firstCleanDoi(text)
}

function firstCleanDoi(text: string): string | null {
  for (const match of text.matchAll(DOI_PREFIX)) {
    const at = match.index ?? 0
    const raw = isolateDoiBody(text.slice(at), text)
    const cleaned = sanitizeDoi(raw)
    if (cleaned) return cleaned
  }
  return null
}

/**
 * Collect the suffix starting from `10.xxxx/`; skip spaces OCR inserted after punctuation, and stop
 * at other whitespace, Han characters or a capitalized sentence start. The caller then passes it to
 * sanitize to strip trailing junk and validate.
 */
function isolateDoiBody(value: string, context?: string): string {
  const prefix = /^10\s*\.\s*\d{4,9}\s*\/\s*/i.exec(value)
  if (!prefix) return ''
  let out = prefix[0]!.replace(/\s/g, '')
  let i = prefix[0]!.length
  while (i < value.length) {
    // Reject over-long candidates instead of cutting them to a plausible-looking 200-character prefix.
    if (out.length > 200) return ''
    const ch = value[i]!
    if (DOI_CHAR.test(ch)) {
      out += ch
      i += 1
      continue
    }
    if (/\s/.test(ch)) {
      let j = i
      while (j < value.length && /\s/.test(value[j]!)) j += 1
      if (j - i <= 8 && !/\n\s*\n/.test(value.slice(i, j))) {
        if (canBridgeOcrSpace(out, value, j) || (context && joinedElsewhere(out, value, j, context))) {
          i = j
          continue
        }
        // `pone.028978 2`: broken after digits with only one or two digits left. They may be the DOI's last
        // digits or a page number; if nothing elsewhere confirms it, drop the candidate.
        if (/\d$/.test(out) && /^\d{1,3}(?:\s|$)/.test(value.slice(j))) return ''
      }
    }
    break
  }
  return out
}

/**
 * Are the characters on both sides of this space written together elsewhere in the same text?
 * Search for the collected `out` allowing whitespace between characters, immediately followed by
 * the first character of the next segment. PDF footers repeat the same DOI on every page, broken in
 * a different place each time; this is the only evidence that does not rely on guessing.
 */
function joinedElsewhere(out: string, value: string, nextIndex: number, context: string): boolean {
  const next = value[nextIndex]
  if (!next || !DOI_CHAR.test(next)) return false
  const rest = value.slice(nextIndex)
  if (/^10\s*\.\s*\d{4,9}\s*\//i.test(rest)) return false
  // What is glued on elsewhere may also be a footer word (`16698Copyright`): capitalized words and
  // common footer words are not joined by this rule.
  if (/^[A-Z][a-z]/.test(rest)) return false
  const word = /^[a-z]+/i.exec(rest)?.[0]?.toLowerCase()
  if (word && OCR_BRIDGE_BLOCK.has(word)) return false
  const flexible = [...out].map((char) => char.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('\\s*')
  const escapedNext = next.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
  return new RegExp(`${flexible}${escapedNext}`, 'i').test(context)
}

function canBridgeOcrSpace(out: string, text: string, nextIndex: number): boolean {
  const rest = text.slice(nextIndex, nextIndex + 210)
  // The next DOI is a separate candidate and must not be appended to the previous one.
  if (/^10\s*\.\s*\d{4,9}\s*\//i.test(rest)) return false
  const suffix = out.slice(out.indexOf('/') + 1)
  const prev = out.at(-1)!
  const token = /^[A-Za-z0-9._/()-]+/.exec(rest)?.[0] ?? ''
  if (!token) return false
  // PDFs from the Chinese Medical Association put each character in its own text item:
  // `/cma . j . cn 112148 - 20230119 - 00038`. Join across spaces only if, with whitespace removed, the
  // following segments have an identifier structure; a sentence-final `. 2020 Elsevier` is not joined.
  const collapsed = rest.slice(0, 40).replace(/\s+/g, '')
  // Fix an OCR space before a period only when the next segment has an identifier structure.
  if (/^[._-]/.test(token)) {
    if (!/[A-Za-z0-9]/.test(prev)) return false
    return /\d/.test(token)
      || /^[-_]\d/.test(collapsed)
      || /^\.[a-z]{1,8}(?:\.[a-z]{0,8})?\d/i.test(collapsed)
      || /^\.\d+[-_]\d/.test(collapsed)
  }
  // `.cn 112148-...`: a short letter segment immediately followed by a long number.
  if (/[._][a-z]{1,4}$/i.test(out) && /^\d{4,}$/.test(token) && /^\d{4,}[-._]\d/.test(collapsed)) return true
  if (!/[./\-_]/.test(prev)) return false
  const word = /^[a-z]+/i.exec(token)?.[0]?.toLowerCase()
  if (word && OCR_BRIDGE_BLOCK.has(word)) return false
  if (/^[A-Za-z]/.test(token)) {
    // Lowercase body text and capitalized sentence starts cannot be joined on letter shape alone; a
    // following numeric identifier segment is required.
    return /^[A-Za-z]{1,16}\.[A-Za-z0-9]/.test(rest)
      || /^[A-Za-z]{1,16}\.\s+[A-Za-z0-9]/.test(rest)
      || /^[A-Za-z]{1,8}\.[A-Za-z]{0,8}\d/.test(collapsed)
      || /^[A-Za-z]{1,8}\d{4,}[-._]\d/.test(collapsed)
  }
  // A standalone year / page number right after a period is not joined. Only structured numeric
  // segments or long article numbers are.
  return /^\d{5,}/.test(token) || /^\d+[-._/()]\w/.test(token)
    || (/(?:\.\d+){2}\.$/.test(suffix) && /^\d+$/.test(token))
}

function stripUnbalancedTrail(value: string): string {
  let doi = value
  for (;;) {
    const next = doi.replace(TRAILING_PUNCT, '')
    const opens = countChar(next, '(')
    const closes = countChar(next, ')')
    if (next.endsWith(')') && closes > opens) {
      doi = next.slice(0, -1)
      continue
    }
    if (next.endsWith('(') && opens > closes) {
      doi = next.slice(0, -1)
      continue
    }
    const openBrackets = countChar(next, '[')
    const closeBrackets = countChar(next, ']')
    if (next.endsWith(']') && closeBrackets > openBrackets) {
      doi = next.slice(0, -1)
      continue
    }
    return next
  }
}

function countChar(value: string, char: string): number {
  let count = 0
  for (const current of value) if (current === char) count += 1
  return count
}
