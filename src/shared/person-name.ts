// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 TIKMOON LTD
/**
 * Splitting and comparing person-name lists. **Lives in shared so every caller uses one copy of the
 * rules**: field comparison (`reference-field-compare`), citation format checks, and candidate scoring.
 *
 * In a Western citation such as `Smith, A.B., Doe, C., Lee, D.J., et al.`, the comma in
 * "Surname, Initials" is **not** an author separator. Splitting on every comma would produce 6
 * "authors" and report spurious order differences or missing authors.
 */

export type FieldCompareKind = 'same' | 'convention' | 'differs' | 'unverified'

export interface FieldCompareResult {
  kind: FieldCompareKind
  /** A one-sentence explanation in Chinese, shown to the user as is. */
  why: string
}

function plain(value: string): string {
  return value
    // Diacritics are not a name difference: manuscripts often write `Müller` as `Muller` and `José`
    // as `Jose`.
    .normalize('NFD').replace(/\p{M}/gu, '')
    .replace(/[\u00a0\u2000-\u200b\u3000]/g, ' ')
    .replace(/[\s\p{P}]/gu, '')
    .toLowerCase()
}

function gbSurnameThenInitials(block: string, before: string): boolean {
  if (/[A-Z]{3,}/.test(block)) return true
  const tokens = block.trim().split(/\s+/)
  if (tokens.length < 2 || !/^[A-Z]{2,}$/.test(tokens[0]!)) return false
  // For a two-letter surname, check whether the author before the comma already has initials:
  // `LAI Y, SU J` is the next author; `Smith, AB C` is Smith's initials.
  const previous = before.split(/[,，;；、]/).pop()?.trim() ?? ''
  return /\s[A-Z]{1,3}\.?$/.test(previous)
}

/**
 * Join "Surname, Initials" back into one segment so the comma can serve as the author separator.
 * In Chinese citations like `李娜, 王强` a full name follows the comma, so the pattern does not match
 * and they are unaffected.
 */
export function joinSurnameInitials(value: string): string {
  return value.replace(
    // Initials of hyphenated given names (`Herbold, A.-K.`, `Lee, Y.‐W.`) are also one initials block.
    /,\s*((?:[A-Z]\.?[\s\-\u2010\u2011]*){1,4})(?=\s*(?:[,，;；、&]|\bet al\b|\band\b|等|$))/g,
    // In `CHO Y J, RYU H`, `RYU H` is the next author (GB/T 7714 all-caps surname), not initials of the
    // previous one: a segment with no periods and three or more consecutive capitals is kept as is.
    // Same for two-letter surnames: joining `LAI Y, SU J, QIU P` into `LAI Y SU J` would shift every
    // author from the second on and report a spurious order difference.
    // Rule: no periods, the first block is two capitals followed by an initials block, and the author
    // before the comma already has initials.
    (all, initials: string, offset: number) => (
      !initials.includes('.') && gbSurnameThenInitials(initials, value.slice(0, offset)) ? all : ` ${initials.trim()} `
    ),
  ).replace(/\s+([,，;；、])/g, '$1').replace(/\s{2,}/g, ' ').trim()
}

/**
 * `\b` is an ASCII word boundary and never holds when `等` is preceded by a space or comma, so a
 * `\b`-based pattern would miss the `等` ("et al.") truncation in Chinese citations. `等` gets its own
 * branch, without `\b`.
 */
const ET_AL = /(?:\bet\.?\s*al\.?|等)\s*[.,;，。；]?\s*$/i

/**
 * Role statements are not names. English `(editor-in-chief)` could be stripped with ASCII parentheses
 * plus `\b`; but in Chinese `张三（主编）` / `张三主编` neither side is a word boundary and full-width
 * parentheses are not `()`, so `plain()` would glue `主编` ("editor-in-chief") onto the name and
 * match it as a different person.
 */
const LATIN_ROLE = /\b(?:editor(?:-in-chief)?s?|eds?\.?|edited by)\b/gi
const CJK_ROLE = /名誉主编|总主编|副主编|主编|主审|编著|编译|译著|译者/g
const CJK_TRAILING_ROLE = /(?:编|著|校)$/
const ROLE_PARENS = /[（(]([^）)]{1,24})[）)]/g
const ROLE_LABEL = /^(?:editor(?:-in-chief)?s?|eds?|editedby|名誉主编|总主编|副主编|主编|主审|编著|编译|译著|译者)$/i
/**
 * Some bibliographic records put a whole "illustrations by ..." phrase in the author field; those
 * people are not co-authors.
 */
const CONTRIBUTOR_BY_CLAUSE = /(?:^|[;；,，])\s*(?:computer\s+)?(?:illustrations?|illustrated|scanning\s+electron\s+micrographs?|ultrasound\s+images?|photographs?|drawings?|figures?)\s+by\b[^;；]*/gi

function isRoleLabel(value: string): boolean {
  return ROLE_LABEL.test(value.replace(/[\s.。]/g, ''))
}

function stripPersonRoles(value: string): string {
  return value
    .replace(CONTRIBUTOR_BY_CLAUSE, ' ')
    .replace(ROLE_PARENS, (all, inner: string) => (isRoleLabel(inner) ? ' ' : all))
    .replace(LATIN_ROLE, ' ')
    .replace(CJK_ROLE, ' ')
    .replace(CJK_TRAILING_ROLE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Split out an author list; `et al.` only means "the manuscript truncates here" and is not compared. */
export function splitPersons(value: string): { names: string[]; truncated: boolean } {
  const raw = stripPersonRoles(joinSurnameInitials(value.trim()))
  const truncated = ET_AL.test(raw)
  const body = raw.replace(ET_AL, '')
  const names = body
    // `，` must also be a separator: Chinese citations such as `郭应禄，夏术阶` use a full-width comma.
    // Only the ASCII `,` needs joinSurnameInitials to rejoin "Surname, Initials" first.
    // APA's "..., & Last Author": `&` is a separator just like `and`.
    .split(/[;；，]|,(?![^(（]*[)）])|、| and |\s&\s/i)
    .map((part) => stripPersonRoles(part.replace(/^[\s&]+/, '')))
    .filter((part) => part && /[\p{L}]/u.test(part))
  return { names, truncated }
}

const CJK = /[一-鿿]/

interface PersonParts {
  /** A Chinese name as a whole is the fingerprint: fixed order, never abbreviated. */
  cjk: string | null
  /** Full words (surnames, spelled-out given names) */
  words: Set<string>
  /** Initials, including each letter split out of an initials block */
  initials: Set<string>
}

/**
 * Split one person name into comparable parts.
 *
 * You cannot "take the longest segment as the surname": in a name like `Maria Ruiz-de la Vega` the
 * longest segment need not be the surname, and picking the wrong one turns one person into two.
 * Instead keep two sets: full words and initials. All-caps blocks of at most three letters (`AJ`,
 * `AW`, `T`) are initials and are split into single letters, not treated as a word; otherwise `AJ`
 * in `Smith AJ` would never match `Alan J. Smith`.
 */
export function personParts(name: string): PersonParts {
  const cleaned = name.replace(/[.,]/g, ' ').replace(/[-\u2010\u2011–—]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!cleaned) return { cjk: null, words: new Set(), initials: new Set() }
  if (CJK.test(cleaned)) return { cjk: plain(cleaned), words: new Set(), initials: new Set() }
  const words = new Set<string>()
  const initials = new Set<string>()
  const tokens = cleaned.split(' ').filter(Boolean)
  /*
   * GB/T 7714 writes Western surnames in all caps: `CHO Y J`, `RYU H`, `LEE J`. When every block is an
   * all-caps block of at most three letters, the first block is the surname, not initials. Otherwise
   * the person is reduced to initials and matches nobody, and a correct "first 3 + et al." would be
   * reported as differing from the full author list.
   */
  const surnameFirst = tokens.length >= 2 && tokens.every((token) => /^[A-Z]{1,3}$/.test(token)) && tokens[0]!.length >= 2
  for (const [index, token] of tokens.entries()) {
    if (surnameFirst && index === 0) {
      words.add(token.toLowerCase())
      initials.add(token[0]!.toLowerCase())
      continue
    }
    if (/^[A-Z]{1,3}$/.test(token)) {
      for (const letter of token.toLowerCase()) initials.add(letter)
      continue
    }
    const word = plain(token)
    if (!word) continue
    words.add(word)
    initials.add(word[0])
  }
  return { cjk: null, words, initials }
}

/** Is the person written in the manuscript the same person as the one in the record? */
export function samePerson(declared: string, found: string): boolean {
  const left = personParts(declared)
  const right = personParts(found)
  if (left.cjk || right.cjk) return Boolean(left.cjk) && left.cjk === right.cjk
  if (!left.words.size || !right.words.size) return false
  // The side that writes less must be fully contained in the other: abbreviated in the manuscript and
  // expanded in the record, or the reverse.
  const [small, big] = left.words.size <= right.words.size ? [left, right] : [right, left]
  for (const word of small.words) if (!big.words.has(word)) return false
  for (const initial of small.initials) if (!big.initials.has(initial)) return false
  return true
}

/**
 * Group authors (collaborative groups, committees, investigator consortia).
 *
 * `comparePersons` below decides whether two author lists are the same group of people. Rule: **the
 * authors the manuscript lists** must all be in the record, in the same order. When the manuscript
 * truncates with `et al.`, only the authors it actually wrote are compared; truncation is an
 * accepted style. But if the listed authors are out of order or misspelled, the result is still
 * `differs`: `et al.` does not hide errors in the listed part.
 * If the record is a strict positional prefix of the manuscript list (the first N match, the rest is
 * cut off), the source list is incomplete: `unverified`. A gap in the middle (A,B,C vs A,C) is still
 * `differs`.
 */
export const GROUP_AUTHOR = /investigators|collaborat|consortium|\bgroup\b|\bteam\b|\bnetwork\b|\bcommittee\b|\btrial(?:ists)?\b|协作组|研究组|专家组|委员会|学会|分会/i

export function comparePersons(declared: string, found: string): FieldCompareResult {
  const left = splitPersons(declared)
  const right = splitPersons(found)
  if (!left.names.length || !right.names.length) {
    return { kind: 'same', why: '作者信息不足以比对' }
  }
  if (plain(declared) === plain(found)) return { kind: 'same', why: '作者完全一致' }
  const orderedSame = left.names.every((name, index) => right.names[index] && samePerson(name, right.names[index]))
  if (orderedSame) {
    // Extra authors in the record are an accepted truncation only when the manuscript explicitly uses
    // et al. Otherwise "the manuscript lists 3, the source has 4" is an incomplete citation and must
    // not be absorbed as `convention`.
    /*
     * The manuscript names only the group and the record also lists writing-group members after it:
     * citing by group name is correct, not missing authors (PubMed often lists individuals after a
     * collaboration's name). If the extra names include another group, a second group author was left
     * out; report it.
     */
    if (right.names.length > left.names.length && left.names.length === 1 && GROUP_AUTHOR.test(left.names[0]!)
      && right.names.slice(1).every((name) => !GROUP_AUTHOR.test(name))) {
      return { kind: 'convention', why: '稿件按团体署名，记录另列了写作组成员' }
    }
    if (right.names.length > left.names.length && !left.truncated) {
      return { kind: 'differs', why: `记录多出 ${right.names.length - left.names.length} 位作者，稿件未使用 et al. 截断` }
    }
    const reasons: string[] = []
    if (left.truncated && right.names.length > left.names.length) {
      reasons.push(`稿件用 et al. 截断，记录列出全部 ${right.names.length} 位`)
    }
    reasons.push('姓名顺序或缩写写法不同，指向同一批人')
    return { kind: 'convention', why: reasons.join('；') }
  }
  const missing = left.names.filter((name) => !right.names.some((other) => samePerson(name, other)))
  if (!missing.length) return { kind: 'differs', why: '作者相同但顺序与记录不一致' }
  const recordIsPrefix = right.names.length < left.names.length
    && right.names.every((name, index) => samePerson(left.names[index]!, name))
  if (recordIsPrefix) {
    return {
      kind: 'unverified',
      why: `来源作者列表不完整，无法核对其余 ${left.names.length - right.names.length} 位作者`,
    }
  }
  return {
    kind: 'differs',
    why: missing.length === left.names.length ? `记录里没有 ${missing.length} 位稿件所列作者` : `记录里没有其中 ${missing.length} 位稿件所列作者`,
  }
}

/**
 * Same person, but the record lists one fewer given-name initial than the manuscript (`Hartgerink CH` vs
 * `Hartgerink CHJ`, `Lam FC` vs `Lam F. C. W.`). We cannot tell whether the database dropped it or the
 * manuscript added one, so this is neither reported as wrong nor as matching (it is recorded as not checked).
 * The shared `samePerson` is not relaxed: an extra initial must not be swallowed as a record omission.
 */
export function recordHasOneFewerInitial(declared: string, found: string): boolean {
  const left = personParts(declared)
  const right = personParts(found)
  if (left.cjk || right.cjk || !left.words.size || left.words.size !== right.words.size) return false
  for (const word of left.words) if (!right.words.has(word)) return false
  // Compare the initials in order: the record's string is the manuscript's minus its last letter. `CH` vs `CHJ`
  // qualifies, `CH` vs `CK` does not (a set of initials would mix in the surname's H and make `CK` look like one fewer).
  const declaredInitials = givenInitials(declared)
  const foundInitials = givenInitials(found)
  return declaredInitials.length === foundInitials.length + 1 && declaredInitials.startsWith(foundInitials)
}

/**
 * The given-name initials of a name, in order: `Lam F. C. W.` → `fcw`, `Hartgerink CHJ` → `chj`.
 * An all-caps surname (GB/T style) does not count.
 */
function givenInitials(name: string): string {
  const tokens = name.replace(/[.,]/g, ' ').replace(/[-\u2010\u2011–—]/g, ' ').trim().split(/\s+/).filter(Boolean)
  const surnameFirst = tokens.length >= 2 && tokens.every((token) => /^[A-Z]{1,3}$/.test(token)) && tokens[0]!.length >= 2
  return tokens.filter((token, index) => /^[A-Z]{1,3}$/.test(token) && !(surnameFirst && index === 0)).join('').toLowerCase()
}

/**
 * Every author lines up position by position, and the only differences are records that list one fewer
 * initial (`recordHasOneFewerInitial`). The lists must be the same length; when the manuscript truncates with
 * et al., only the authors it writes out are compared.
 */
export function authorsDifferOnlyByRecordInitials(declared: string, found: string): boolean {
  const left = splitPersons(declared)
  const right = splitPersons(found)
  if (!left.names.length || left.names.length > right.names.length) return false
  if (left.names.length < right.names.length && !left.truncated) return false
  let fewer = 0
  for (const [index, name] of left.names.entries()) {
    const other = right.names[index]!
    if (samePerson(name, other)) continue
    if (!recordHasOneFewerInitial(name, other)) return false
    fewer += 1
  }
  return fewer > 0
}
