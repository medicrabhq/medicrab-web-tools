// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 TIKMOON LTD
import { compareJournals } from '../shared/reference-field-compare'
import registry from './journal-registry.json'

export interface JournalRegistryRecord {
  id: string
  zh: string
  en: string
  issn: string[]
  doiPrefixes: string[]
}

interface JournalRegistryFile {
  schemaVersion: number
  records: JournalRegistryRecord[]
}

function loadRegistry(): readonly JournalRegistryRecord[] {
  const raw = registry as JournalRegistryFile
  if (!Number.isInteger(raw.schemaVersion) || raw.schemaVersion < 1 || !Array.isArray(raw.records)) {
    throw new Error('journal-registry.json 顶层格式无效')
  }
  const ids = new Set<string>()
  for (const [index, record] of raw.records.entries()) {
    const label = `journal-registry.json records[${index}]`
    if (!record || typeof record !== 'object') throw new Error(`${label} 不是对象`)
    if (!/^[a-z0-9-]{2,40}$/.test(record.id ?? '')) throw new Error(`${label}.id 无效`)
    if (ids.has(record.id)) throw new Error(`${label}.id 重复：${record.id}`)
    ids.add(record.id)
    if (typeof record.zh !== 'string' || !record.zh.trim()) throw new Error(`${label}.zh 缺失`)
    if (typeof record.en !== 'string') throw new Error(`${label}.en 必须是字符串`)
    if (!Array.isArray(record.issn) || !Array.isArray(record.doiPrefixes)) {
      throw new Error(`${label} 缺少 issn 或 doiPrefixes`)
    }
  }
  return Object.freeze(raw.records.map((record) => Object.freeze({
    id: record.id,
    zh: record.zh.trim(),
    en: record.en.trim(),
    issn: record.issn.map((value) => normalizeIssn(value)).filter(Boolean),
    doiPrefixes: record.doiPrefixes.map((value) => compactDoiPrefix(value)).filter(Boolean),
  })))
}

const records = loadRegistry()

function compactText(value: string): string {
  return value.normalize('NFKC').replace(/[\s\u3000《》]/g, '').toLowerCase()
}

export function normalizeIssn(value: string): string {
  return value.replace(/[^0-9Xx]/g, '').toUpperCase()
}

export function compactDoiPrefix(value: string): string {
  return value.toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//, '').replace(/\/+$/, '').trim()
}

function nameHits(declared: string, record: JournalRegistryRecord): boolean {
  const needle = compactText(declared)
  if (!needle) return false
  if (needle === compactText(record.zh) || (record.en && needle === compactText(record.en))) return true
  return Boolean(record.en && ['same', 'convention'].includes(compareJournals(declared, record.en).kind))
    || ['same', 'convention'].includes(compareJournals(declared, record.zh).kind)
}

export function resolveJournal(name: string | null | undefined): JournalRegistryRecord | null {
  const value = name?.trim()
  if (!value) return null
  return records.find((record) => nameHits(value, record)) ?? null
}

export function journalAnchorHits(input: {
  declaredJournal?: string | null
  candidateJournal?: string | null
  candidateDoi?: string | null
  candidateIssn?: string | null
}): boolean {
  const row = resolveJournal(input.declaredJournal)
  if (!row) return false
  const doi = compactDoiPrefix(input.candidateDoi ?? '')
  if (doi && row.doiPrefixes.some((prefix) => doi === prefix || doi.startsWith(`${prefix}/`) || doi.startsWith(prefix))) {
    return true
  }
  const issn = normalizeIssn(input.candidateIssn ?? '')
  if (issn && row.issn.includes(issn)) return true
  const candidateJournal = input.candidateJournal?.trim()
  if (candidateJournal && row.en && ['same', 'convention'].includes(compareJournals(candidateJournal, row.en).kind)) {
    return true
  }
  return false
}
