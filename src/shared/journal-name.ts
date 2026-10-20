// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 TIKMOON LTD
/**
 * Function words in journal names that are ignored in matching. Cover every language: `di`, `de`,
 * `der` are common in Italian/Spanish/German journal names.
 */
const JOURNAL_STOPWORDS = new Set([
  'the', 'of', 'and', 'for', 'in', 'on', 'a', 'an',
  'di', 'de', 'del', 'della', 'e', 'y', 'der', 'die', 'das', 'und', 'et', 'la', 'le', 'les',
])

function journalWords(value: string): string[] {
  return value
    .replace(/[《》]/g, ' ')
    .split(/[\s,，.。;；:：\-—–/()]+/)
    .map((word) => word.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase())
    .filter((word) => word && !JOURNAL_STOPWORDS.has(word))
}

/**
 * Journal abbreviations are matched **word by word**, not with a hard-coded alias table.
 *
 * ISO 4 / NLM abbreviation truncates each word and **keeps the word count**:
 * `Cardiology in Review` <-> `Cardiol Rev`, `JAMA Network Open` <-> `JAMA Netw Open`,
 * `Giornale Italiano di Cardiologia` <-> `G Ital Cardiol`.
 *
 * Abbreviation and full name have the same word count, so word count cannot tell which side is the
 * abbreviation (`cardiol` startsWith `cardiology` never holds). Compare position by position and
 * accept a prefix in either direction.
 *
 * Word counts must be equal: that is the ISO rule itself, and it prevents false matches like
 * `Medicine` against `Med Sci Monit`, where one matching word would count as the same journal.
 */
export function journalAbbreviationMatches(declared: string, found: string): boolean {
  return wordsAbbreviate(journalWords(declared), journalWords(found))
    // The place qualifier NLM adds to same-named journals (`Medicine (Baltimore)`) is not part of the
    // name; strip it and compare again.
    || wordsAbbreviate(journalWords(stripQualifier(declared)), journalWords(stripQualifier(found)))
    // A hyphenated compound is one word in NLM abbreviations:
    // `Neuro-Psychopharmacology` <-> `Neuropsychopharmacol`.
    || wordsAbbreviate(journalWords(joinHyphenated(declared)), journalWords(joinHyphenated(found)))
}

function joinHyphenated(value: string): string {
  return value.replace(/(\p{L})[-\u2010\u2011](\p{L})/gu, '$1$2')
}

/** Remove a trailing parenthesized qualifier from a journal name: `Medicine (Baltimore)` -> `Medicine`. */
function stripQualifier(value: string): string {
  return value.replace(/[(（][^)）]*[)）]\s*$/, '').trim() || value
}

function wordsAbbreviate(left: string[], right: string[]): boolean {
  if (!left.length || left.length !== right.length) return false
  return left.every((word, index) => wordAbbreviates(word, right[index]!))
}

function wordAbbreviates(left: string, right: string): boolean {
  if (left === right) return true
  const [short, long] = left.length <= right.length ? [left, right] : [right, left]
  if (long.startsWith(short)) return true
  /*
   * Besides truncation, ISO 4 also allows **contraction**: `Deutsche`->`Dtsch`,
   * `Wochenschrift`->`Wochenschr`. A contracted word is a subsequence of the original. Require the
   * same first letter and at least 4 letters so short words do not match at random.
   */
  return short.length >= 4 && short[0] === long[0] && isSubsequence(short, long)
}

function isSubsequence(short: string, long: string): boolean {
  let cursor = 0
  for (const letter of short) {
    const hit = long.indexOf(letter, cursor)
    if (hit < 0) return false
    cursor = hit + 1
  }
  return true
}
