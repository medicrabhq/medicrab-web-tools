// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 TIKMOON LTD
/**
 * Titles and abstracts returned by bibliographic databases often contain HTML: `<i>Helicobacter pylori</i>`,
 * sometimes escaped once as `&lt;i&gt;`. Shown as-is, that is a string of angle brackets.
 * Convert to plain text for matching and display.
 *
 * **It is also the input cleaner for citation matching**: Crossref titles carry
 * `<i>Helicobacter pylori</i>` and line breaks; compared as-is, even a well-known consensus such as
 * Maastricht VI is judged "not found". Every reference whose title has a Latin species name, in vitro,
 * or sub/superscripts is affected.
 */
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, code: string) => {
    if (code[0] === '#') {
      const value = code[1]?.toLowerCase() === 'x' ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1))
      return Number.isFinite(value) && value > 0 ? String.fromCodePoint(value) : all
    }
    return ENTITIES[code.toLowerCase()] ?? all
  })
}

export function plainLiteratureText(value: string | null | undefined): string {
  let text = value ?? ''
  // Unescape once-escaped tags first, then strip them together with raw tags; at most two passes, to
  // handle nested escaping.
  for (let round = 0; round < 2; round += 1) {
    const decoded = decodeEntities(text)
    // Tag names may carry a namespace prefix and hyphens: <mml:math>, <scp>, <alt-title> must all go.
    // **Replace with a space, then collapse whitespace**: Crossref's
    // `Vonoprazan‐containing<i>H. pylori</i>triple therapies` has no spaces around the tags; deleting them
    // would glue the words into "containingHelicobacter pyloritriple", an unreadable run of text.
    const stripped = decoded.replace(/<\/?[a-z][a-z0-9]*(?::[a-z][a-z0-9-]*)?(?:-[a-z0-9]+)*(?:\s[^<>]*)?\/?>/gi, ' ')
    if (stripped === text) break
    text = stripped
  }
  return text.replace(/\s+/g, ' ').trim()
}
