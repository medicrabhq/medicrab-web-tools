// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 TIKMOON LTD
/**
 * Three exports of the abbreviation list (pure functions shared by the page and unit tests): copy as
 * table (TSV), download CSV (UTF-8 with BOM), and copy the submission abbreviations text.
 * All sorted alphabetically by abbreviation; the page passes in only the ticked main-table rows.
 */
import { sortEntries, type Scope } from './detect'

export interface ExportRow {
  abbr: string
  scope: Scope
  /** Full form shown on the page (possibly edited by the user); empty string means none. */
  full: string
  firstPara: number
  defPara?: number
  count: number
  /** Note text already written in the page language. */
  marks: string[]
  scopeLabel: string
}

export interface SubmissionStyle { head: string; pair: string; sep: string; end: string }

/**
 * Submission abbreviations wording for English manuscripts (follows manuscript language, not page
 * language).
 */
export const SUBMISSION_EN: SubmissionStyle = { head: 'Abbreviations: ', pair: '{abbr}, {full}', sep: '; ', end: '.' }

const LOCAL_TEXT = /[぀-ヿ㐀-鿿가-힯]/

/** CJK full form first, English full form in parentheses; if there is only one, use that one. */
export function fullTerm(long: string | null, longLocal?: string): string {
  if (!long) return ''
  if (!longLocal) return long
  return LOCAL_TEXT.test(longLocal) ? `${longLocal}（${long}）` : `${longLocal} (${long})`
}

/**
 * When the same abbreviation has one row each for abstract and main text, keep one row: the first row
 * that has a full form.
 */
function uniqueByAbbr(rows: ExportRow[]): ExportRow[] {
  const seen = new Map<string, ExportRow>()
  for (const r of sortEntries(rows)) {
    const prev = seen.get(r.abbr)
    if (!prev || (!prev.full && r.full)) seen.set(r.abbr, r)
  }
  return sortEntries([...seen.values()])
}

const tsvCell = (s: string): string => s.replace(/[\t\r\n]+/g, ' ').trim()

/** Two columns: abbreviation, full form. The first row is the header. */
export function toTsv(rows: ExportRow[], header: [string, string]): string {
  return [header, ...uniqueByAbbr(rows).map((r) => [r.abbr, r.full])].map((cols) => cols.map(tsvCell).join('\t')).join('\n')
}

const csvCell = (v: string | number | undefined): string => {
  const s = v === undefined ? '' : String(v)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/**
 * Columns: abbreviation, full form, section, first-occurrence paragraph, first-definition paragraph,
 * count, notes. With BOM so Excel opens it without garbled text.
 */
export function toCsv(rows: ExportRow[], header: string[]): string {
  const lines = [header, ...sortEntries(rows).map((r) => [r.abbr, r.full, r.scopeLabel, r.firstPara, r.defPara, r.count, r.marks.join('; ')])]
  return `\uFEFF${lines.map((cols) => cols.map(csvCell).join(',')).join('\r\n')}\r\n`
}

/**
 * "Abbreviations: BMI, body mass index; CI, confidence interval." Entries without a full form are left
 * out; also returns how many were left out.
 */
export function submissionText(rows: ExportRow[], style: SubmissionStyle): { text: string; skipped: number } {
  const unique = uniqueByAbbr(rows)
  const kept = unique.filter((r) => r.full.trim())
  const body = kept.map((r) => style.pair.replace('{abbr}', () => r.abbr).replace('{full}', () => r.full.trim())).join(style.sep)
  return { text: kept.length ? `${style.head}${body}${style.end}` : '', skipped: unique.length - kept.length }
}
