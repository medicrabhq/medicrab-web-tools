// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 TIKMOON LTD
/**
 * Website reference checker: parse Nature-style and APA-style references.
 *
 * The desktop `parseEntry` handles GB/T 7714 and Vancouver. Splitting a Nature-style entry
 * ("Smith, J. et al. Title. Journal 74, 229–263 (2024).") on periods treats an author fragment such
 * as "Doe, A" as the title, so an entry with a correct identifier would be reported as "points to
 * a different article". The title, year and journal extracted here are passed as hints to the same
 * matching logic (`verifyEntry` prefers the title from hints), and volume/issue/pages are compared
 * field by field.
 *
 * Only structurally complete entries are recognized; anything else returns null and falls back to
 * `parseEntry`.
 */
import type { ParsedEntry } from '../../main/citation-match'
import { comparableAuthors } from './fields'

export interface StyledEntry extends ParsedEntry {
  authors: string
  style: 'nature' | 'apa' | 'science' | 'frontiers' | 'chicago'
}

const LEADING_MARKER = /^\s*(?:[[［]\s*\d{1,3}\s*[\]］]|\(\s*\d{1,3}\s*\)|\d{1,3}\s*[.．)）、](?!\d))\s*/

/** One author as "Surname, Initials": Smith, J. / Doe, A. B. / van Dijk, M. E. / O’Brien, Á. */
const PERSON = String.raw`(?:(?:van|von|de|der|den|da|di|du|le|la|del|dos)\s)*[\p{Lu}][\p{L}'’\-]+(?:\s[\p{Lu}][\p{L}'’\-]+)*,\s(?:[\p{Lu}]\.(?:\s?-?[\p{Lu}]\.)*)`
const AUTHOR_LIST = String.raw`${PERSON}(?:,\s${PERSON})*(?:,?\s(?:&|and)\s${PERSON})?(?:,?\set\sal\.)?`
const PAGES = String.raw`[A-Za-z]?\d+[A-Za-z]?(?:\s*[-–—]\s*[A-Za-z]?\d+[A-Za-z]?)?`

// Take title and journal together first (`rest`), then let splitTitleJournal find the boundary:
// the title itself may contain periods (`the U.S. population`).
const NATURE = new RegExp(String.raw`^(?<authors>${AUTHOR_LIST})\s+(?<rest>.+?)\s+(?<volume>\d+)(?:\s*\((?<issue>[^)]+)\))?,\s*(?<pages>\S+?)\s*\((?<year>(?:19|20)\d{2})\)`, 'u')

/** One author as "Initials Surname": J. A. Smith / T.-Y. Lee / M. A. J. van Dijk. */
const PERSON_INITIALS_FIRST = String.raw`[\p{Lu}]\.(?:\s?-?[\p{Lu}]\.)*\s(?:(?:van|von|de|der|den|da|di|du|le|la|del|dos)\s)*[\p{Lu}][\p{L}'’\-]+(?:\s[\p{Lu}][\p{L}'’\-]+)?`
/**
 * Science style: "J. A. Smith, C. J. Doe, S. D. Lee, Title. Journal 97, 197–210 (2021)."
 * Authors are followed by a comma, not a period.
 */
const SCIENCE = new RegExp(String.raw`^(?<authors>${PERSON_INITIALS_FIRST}(?:,\s${PERSON_INITIALS_FIRST})*(?:,\set\sal\.)?),\s(?<rest>.+?)\s+(?<volume>\d+)(?:\s*\((?<issue>[^)]+)\))?,\s*(?<pages>\S+?)\s*\((?<year>(?:19|20)\d{2})\)`, 'u')

/** One author as "Surname Initials.": Smith L. / Doe M. G. / Lee X.-F. */
const PERSON_SURNAME_DOTTED = String.raw`(?:(?:van|von|de|der|den|da|di|du|le|la|del|dos)\s)*[\p{Lu}][\p{L}'’\-]+(?:\s[\p{Lu}][\p{L}'’\-]+)?(?:\s[\p{Lu}]\.(?:-?[\p{Lu}]\.)?)+`
/**
 * Frontiers style: "Smith L. Doe B. Lee J.. (2022). Title. Journal 13:1590."
 * Authors are separated by spaces only.
 */
const FRONTIERS = new RegExp(String.raw`^(?<authors>${PERSON_SURNAME_DOTTED}(?:,?\s${PERSON_SURNAME_DOTTED})*(?:,?\set\sal\.)?)\.?\s*\((?<year>(?:19|20)\d{2})[a-z]?\)\.\s+(?<rest>.+?)\s+(?<volume>\d+)(?:\s*\((?<issue>[^)]+)\))?\s*[,:]\s*(?<pages>${PAGES})`, 'u')

/**
 * Chicago style: the title is in quotes ("..., and J. Lee, “Title,” Journal 114 (2006): 100–109",
 * "... 2022. “Title.” Journal 104: 97–109").
 */
const CHICAGO = /^(?<authors>[^“”"]{2,400}?)(?<sep>[\s,.]*)[“"](?<title>[^“”"]{20,400}?)[,.]?[”"]\s*(?<rest>.*)$/u

const APA = new RegExp(String.raw`^(?<authors>${AUTHOR_LIST})\s\((?<year>(?:19|20)\d{2})[a-z]?(?:,[^)]*)?\)\.\s+(?<rest>[^,]+?(?:,[^,\d][^,]*?)*?),\s*(?<volume>\d+)(?:\s*\((?<issue>[^)]+)\))?(?:,\s*(?<pages>${PAGES}))?`, 'u')

/**
 * A word in a journal name: capitalized or abbreviated (`N.`, `Engl.`, "PLoS"), or one of a few
 * lowercase function words.
 */
const JOURNAL_WORD = /^(?:[\p{Lu}\d][\p{L}\d'’\-.:]*|of|and|the|in|for|on|&|de|des|du|la|le|und|der|y|e)$/u

export function journalLike(text: string): boolean {
  const words = text.trim().split(/\s+/)
  return words.length > 0 && words.length <= 12 && !/\d/.test(text) && words.every((word) => JOURNAL_WORD.test(word))
}

/**
 * Title/journal boundary (`splitTitleJournal`): try each "sentence-ending punctuation + space" from
 * left to right and take the first position where the right side looks like a journal name. In
 * `Outcomes in the U.S. population. Nature`, cutting after `U.S.` leaves `population. Nature`, which
 * has a lowercase word and is not a journal; cutting after `population.` leaves `Nature`, which is.
 * If nothing fits, return null rather than guess.
 * Periods after an abbreviation (`U.S.`, `St.`, `N.`, `vs.`) are skipped: they most likely do not end
 * the title.
 */
const ABBREVIATION_END = /(?:^|\s)(?:[A-Z][A-Za-z]{0,2}|(?:[A-Za-z]\.){1,}[A-Za-z]|vs|e\.g|i\.e|al)\.$/

function splitTitleJournal(rest: string): { title: string; journal: string } | null {
  for (const match of rest.matchAll(/[.?!]\s+/g)) {
    const at = match.index!
    const title = rest.slice(0, at + 1).trim()
    if (ABBREVIATION_END.test(title)) continue
    const journal = rest.slice(at + match[0].length).trim().replace(/,$/, '')
    if (title.length >= 8 && journalLike(journal)) return { title, journal }
  }
  return null
}

function clean(value: string | undefined): string | null {
  const text = value?.trim().replace(/\s+/g, ' ')
  return text || null
}

/**
 * A DOI (`127, 10.1016/J.JOUR.2020.100001 (2020)`) or URL in the page position is not a page
 * number.
 */
function pagesOf(value: string | undefined): string | null {
  const text = clean(value)?.replace(/[.,;]$/, '') ?? null
  if (!text || /^10\.\d{4,9}\//.test(text) || /^https?:/i.test(text)) return null
  return new RegExp(`^${PAGES}$`).test(text) ? text : null
}

export function parseStyledEntry(entry: string): StyledEntry | null {
  const body = entry.replace(LEADING_MARKER, '').trim()
  const apa = APA.exec(body)
  const apaParts = apa?.groups && splitTitleJournal(apa.groups.rest!)
  if (apa?.groups && apaParts) {
    const g = apa.groups
    return {
      style: 'apa',
      authors: clean(g.authors)!,
      title: clean(apaParts.title)!.replace(/\.$/, ''),
      year: Number(g.year),
      journal: clean(apaParts.journal),
      volume: clean(g.volume),
      issue: clean(g.issue),
      pages: pagesOf(g.pages),
    }
  }
  const nature = NATURE.exec(body)
  const natureParts = nature?.groups && splitTitleJournal(nature.groups.rest!)
  if (nature?.groups && natureParts) {
    const g = nature.groups
    return {
      style: 'nature',
      authors: clean(g.authors)!,
      title: clean(natureParts.title)!.replace(/\.$/, ''),
      year: Number(g.year),
      journal: clean(natureParts.journal),
      volume: clean(g.volume),
      issue: clean(g.issue),
      pages: pagesOf(g.pages),
    }
  }
  const science = SCIENCE.exec(body)
  const scienceParts = science?.groups && splitTitleJournal(science.groups.rest!)
  if (science?.groups && scienceParts) {
    const g = science.groups
    return {
      style: 'science',
      authors: clean(g.authors)!,
      title: clean(scienceParts.title)!.replace(/\.$/, ''),
      year: Number(g.year),
      journal: clean(scienceParts.journal),
      volume: clean(g.volume),
      issue: clean(g.issue),
      pages: pagesOf(g.pages),
    }
  }
  const frontiers = FRONTIERS.exec(body)
  const frontiersParts = frontiers?.groups && splitTitleJournal(frontiers.groups.rest!)
  if (frontiers?.groups && frontiersParts) {
    const g = frontiers.groups
    return {
      style: 'frontiers',
      authors: clean(g.authors)!.replace(/\.+$/, '.'),
      title: clean(frontiersParts.title)!.replace(/\.$/, ''),
      year: Number(g.year),
      journal: clean(frontiersParts.journal),
      volume: clean(g.volume),
      issue: clean(g.issue),
      pages: pagesOf(g.pages),
    }
  }
  return parseChicago(body)
}

/**
 * Chicago: the title is the quoted part; the authors are the part before the quotes (minus a
 * trailing year in author-date style); the journal runs from after the quotes to the first digit;
 * volume/issue/pages go to the lenient parser. Reject if the author part doesn't look like names
 * or the journal part doesn't look like a journal.
 */
function parseChicago(body: string): StyledEntry | null {
  const match = CHICAGO.exec(body)
  if (!match?.groups) return null
  const g = match.groups
  // The text before the quotes must be a finished author segment (ending with a comma or period,
  // looking like a list of names): in "Validation of the “WHODAS-2” in patients" the quotes are
  // inside the title.
  if (!/[,.]/.test(g.sep ?? '') || !comparableAuthors(g.authors!.replace(/[\s.,]*\(?(?:19|20)\d{2}[a-z]?\)?[\s.,]*$/, ''))?.complete) return null
  const authors = g.authors!.replace(/[\s.,]*\(?(?:19|20)\d{2}[a-z]?\)?[\s.,]*$/, '').replace(/[\s.,;:]+$/, '').trim()
  // Correction / Erratum / Reply before the quotes: the entry cites that notice, so don't match it
  // by the original article's title.
  if (!authors || /\d/.test(authors) || authors.length > 400 || /\b(?:erratum|correction|corrigendum|retraction|comment|reply)\b/i.test(authors)) return null
  // First author inverted as "Surname, Given name", the rest as "Given name Surname"
  // (`Novák, Jana, Petr Svoboda, and Eva Dvořák`): merge the first author back into one
  // segment.
  const firstInverted = /^([\p{Lu}][\p{L}'’\-]+(?:\s[\p{Lu}][\p{L}'’\-]+)?),\s([\p{Lu}][\p{Ll}'’\-]+(?:\s[\p{Lu}]\.)?)(?=,\s|\s(?:and|&)\s|$)/u
  const joined = authors.replace(firstInverted, '$1 $2')
  const rest = g.rest ?? ''
  const journal = rest.split(/\s*\d/)[0]!.replace(/^[\s.,;:]*(?:in\s+)?/i, '').replace(/[\s.,;:]+$/, '').trim()
  if (journal && !journalLike(journal.replace(/,/g, ""))) return null
  const locator = parseLocatorLoose(body)
  const year = Number(/(?<!\d)((?:19|20)\d{2})(?!\d)/.exec(g.authors!.slice(-12))?.[1] ?? '') || locator?.year
    || Number(/\((?:19|20)\d{2}\)/.exec(rest)?.[0]?.slice(1, 5) ?? '') || null
  return {
    style: 'chicago',
    authors: joined,
    title: g.title!.trim().replace(/[.,]$/, ''),
    year,
    journal: journal || null,
    volume: locator?.volume ?? null,
    issue: locator?.issue ?? null,
    pages: locator?.pages ?? null,
  }
}

/**
 * Pages accepted by the lenient parser: plain pages, or electronic page numbers with letters
 * (`e0158678`, `eadp3743`, `ii17`), optionally with an end page.
 */
const LOOSE_PAGES = String.raw`[A-Za-z]{0,4}\d+[A-Za-z]?(?:\s*[-–—‐]\s*[A-Za-z]{0,4}\d+[A-Za-z]?)?`
/** Trailing DOI, URL, PMID or access date: the only things allowed after volume/issue/pages. */
const TRAILING_IDS = /(?:[\s.,;]*(?:(?:doi:?\s*|https?:\/\/\S+|\b10\.\d{4,9}\/\S+|PMID:?\s*\d*|PMCID:?\s*\w*|\[?(?:accessed|cited)[^\]]*\]?)\S*))+[\s.,;]*$/i
/**
 * Common volume/issue/page forms (beyond Vancouver / GB). Only the segment at the **end** of the
 * entry is matched, directly preceded by the journal (a letter, period or closing parenthesis),
 * with only a DOI, URL or sentence end after the pages:
 * - `J Gastrointest Surg. (2014) 21:2080–8.`  (year in parentheses, volume:pages)
 * - `Vision Res. 51, 1491–1525 (2011).`        (volume, pages (year))
 * - `Chaos 27, 8–10.`                          (volume, pages)
 * - `J Clin Microbiol 65:e0083224.`, `Acta Crystallogr. D Biol. Crystallogr.66:220–2` (volume:pages)
 * - `PLoS One 20 (8), e0329385`                (volume (issue), pages)
 * - `Science Advances. 2024;13(51):eadp3743`  (year;volume(issue):e-page; the Vancouver parser
 *   does not accept four-letter e-pages)
 * - `Journal of Controlled Release 114 (2006): 100–109`,
 *   `Magn Reson Med 76, no. 5 (2016): 1420–1430` (Chicago)
 */
const LOOSE_LOCATOR = new RegExp(String.raw`(?:(?<![\d])\(\s*(?<year1>(?:19|20)\d{2})\s*\)\s*|(?<year2>(?:19|20)\d{2})(?:\s+[A-Za-z]{3,9})?\s*;\s*|(?<=[\p{L}.)]\s?))(?<volume>\d{1,4})(?:,\s*no\.\s*(?<issue2>[\w\-]{1,8}))?\s*(?:\(\s*(?<year4>(?:19|20)\d{2})\s*\)|\(\s*(?<issue>[^)]{1,12}?)\s*\))?\s*[:,]\s*(?<pages>${LOOSE_PAGES})\s*(?:\(\s*(?<year3>(?:19|20)\d{2})\s*\))?[\s.,;]*$`, 'u')

const MONTH_BEFORE = /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s*$/i

export interface LooseLocator {
  volume: string
  issue: string | null
  pages: string
  year: number | null
}

/**
 * When the Vancouver / GB volume/issue/pages can't be parsed, try again with the forms above
 * (used only for the website's field-by-field comparison; the shared `parseLocator` is left alone
 * because the desktop app also uses it for volume/page lookups). Returns null if nothing matches;
 * no guessing.
 */
export function parseLocatorLoose(entry: string): LooseLocator | null {
  const tail = entry.trim().replace(TRAILING_IDS, '').replace(/[\s.,;]+$/, '')
  const match = LOOSE_LOCATOR.exec(tail)
  if (!match?.groups) return null
  // "Published online October 29, 2024": the numbers after the month are day and year, not volume
  // and pages.
  if (MONTH_BEFORE.test(tail.slice(0, match.index))) return null
  const g = match.groups
  const year = g.year1 ?? g.year2 ?? g.year3 ?? g.year4
  return {
    volume: g.volume!,
    issue: (g.issue ?? g.issue2)?.replace(/\s+/g, ' ').trim() || null,
    pages: g.pages!.replace(/\s+/g, ''),
    year: year ? Number(year) : null,
  }
}
