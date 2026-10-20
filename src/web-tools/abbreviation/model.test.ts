// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 TIKMOON LTD
import { describe, expect, it } from 'vitest'
import { analyze, type ListEntry } from './detect'
import { callModel, MODEL_LIMITS, mergeModelResult, planModelRequest, sentenceAt, sentenceSpans, type ModelPlan } from './model'

// "Find missing full terms with a model provided by MediCrab": sentence selection, merge gate and failure
// fallback. No network; every fetch is fake.
// The AASM / AVENIR examples cover two kinds of full forms missed although they sit nearby (not
// adjacent, cross-language).
const TEXT = [
  'Abstract',
  'Patients with chronic kidney disease (CKD) were enrolled. Sleep was scored with AASM standards (American Academy of Sleep Medicine, 2020). Results were stable, e.g. in CKD stage 3.',
  'Introduction',
  'CKD is common. The PLINK software was used. We used the AVENIR cohort (Analyse des VENtes et Infections Respiratoires) here.',
  'Author contributions: DGH and P-YN designed the study.',
].join('\n')
const META = { lang: 'en', page: '/tools/abbreviation-checker/' }

function setup(text = TEXT, split = true): { entries: ListEntry[]; plan: ModelPlan } {
  const entries = analyze(text, split).entries
  const plan = planModelRequest(text, split, entries, META)
  if (!plan) throw new Error('no plan')
  return { entries, plan }
}
const idOf = (plan: ModelPlan, abbr: string): string => [...plan.itemAbbr].find(([, a]) => a === abbr)![0]
const sidOf = (plan: ModelPlan, abbr: string): string => plan.request.items.find((it) => it.id === idOf(plan, abbr))!.sentenceIds[0]!
const row = (entries: ListEntry[], abbr: string): ListEntry => entries.find((e) => e.abbr === abbr)!

describe('Sentence splitting', () => {
  it('No splits at e.g., decimals or inside parentheses; CJK splits on full stops', () => {
    const t = 'Values were 3.5 mg (range 1.2. to 4) here. Results were stable, e.g. In CKD. 结果稳定。下一句'
    expect(sentenceSpans(t).map(([s, e]) => t.slice(s, e))).toEqual(['Values were 3.5 mg (range 1.2. to 4) here.', 'Results were stable, e.g. In CKD.', '结果稳定。', '下一句'])
  })
  it('Overlong sentence is cut to the limit around this occurrence and still contains the abbreviation', () => {
    const t = `${'word '.repeat(200)}the XYZ marker ${'word '.repeat(200)}.`
    const at = t.indexOf('XYZ')
    const s = sentenceAt(t, at, 3)
    expect(s.text.length).toBeLessThanOrEqual(MODEL_LIMITS.sentenceChars)
    expect(t.slice(s.start, s.start + s.text.length)).toBe(s.text)
    expect(s.text).toContain('XYZ')
  })
})

describe('Sentence selection', () => {
  it('Sends first-occurrence sentences only for abbreviations without local full form; list first, then maybe', () => {
    const { plan } = setup()
    expect(plan.request.items.map((it) => it.abbr)).toEqual(['AASM', 'AVENIR', 'PLINK', 'VENtes', 'DGH', 'P-YN'])
    expect(plan.request.items.some((it) => it.abbr === 'CKD')).toBe(false)
    expect(plan.request.sentences.map((s) => s.text)).toEqual([
      'Sleep was scored with AASM standards (American Academy of Sleep Medicine, 2020).',
      'We used the AVENIR cohort (Analyse des VENtes et Infections Respiratoires) here.',
      'The PLINK software was used.',
      'Author contributions: DGH and P-YN designed the study.',
    ])
    // The same sentence is sent once and shared by two abbreviations; the full text is not sent
    expect(sidOf(plan, 'DGH')).toBe(sidOf(plan, 'P-YN'))
    expect(JSON.stringify(plan.request)).not.toContain('chronic kidney disease')
    expect(plan.chars).toBe(plan.request.sentences.reduce((n, s) => n + s.text.length, 0))
    expect(plan.omitted).toBe(0)
    expect(Object.keys(plan.request).sort()).toEqual(['items', 'lang', 'page', 'sentences'])
  })
  it('Sends nothing when all have full forms', () => {
    const text = 'Patients with chronic kidney disease (CKD) were enrolled. CKD was common.'
    expect(planModelRequest(text, false, analyze(text, false).entries, META)).toBeNull()
  })
  it('Truncates past the per-request limit without batching, counting what was not sent', () => {
    const text = Array.from({ length: 8 }, (_, i) => `Group ${String.fromCharCode(65 + i)} used the Q${String.fromCharCode(65 + i)}X kit.`).join('\n')
    const entries = analyze(text, false).entries
    const plan = planModelRequest(text, false, entries, META, { ...MODEL_LIMITS, items: 3 })!
    expect(plan.request.items.length).toBe(3)
    expect(plan.omitted).toBe(entries.filter((e) => e.long === null).length - 3)
    const byChars = planModelRequest(text, false, entries, META, { ...MODEL_LIMITS, totalChars: 60 })!
    expect(byChars.chars).toBeLessThanOrEqual(60)
    expect(byChars.omitted).toBeGreaterThan(0)
  })
})

describe('Merge', () => {
  it('Accepts full forms found verbatim in the sentence, marked as model-supplied; local full forms untouched', () => {
    const { entries, plan } = setup()
    const res = mergeModelResult(entries, plan, { items: [
      { id: idOf(plan, 'AASM'), isAbbreviation: true, long: 'American Academy of Sleep Medicine', definedIn: sidOf(plan, 'AASM') },
      { id: idOf(plan, 'PLINK'), isAbbreviation: false, long: null, definedIn: null },
    ] })
    const aasm = row(res.entries, 'AASM')
    expect([aasm.long, aasm.longSource, aasm.section, aasm.marks.includes('model'), aasm.marks.includes('no_long')]).toEqual(['American Academy of Sleep Medicine', 'model', 'list', true, false])
    expect(aasm.firstDef?.para).toBe(2)
    expect(aasm.firstDef?.ctx.hit).toBe('American Academy of Sleep Medicine')
    expect(row(res.entries, 'PLINK').section).toBe('maybe_not') // Already under "possibly not an abbreviation", so it does not count as moved
    expect(res.entries.filter((e) => e.abbr === 'CKD')).toEqual(entries.filter((e) => e.abbr === 'CKD'))
    expect(res.entries.length).toBe(entries.length)
    expect([res.filled, res.dropped]).toEqual([1, 0])
  })
  it('Drops full forms not in the sentence, pointing to the wrong sentence, or equal to the abbreviation', () => {
    const { entries, plan } = setup()
    const res = mergeModelResult(entries, plan, { items: [
      { id: idOf(plan, 'AASM'), isAbbreviation: true, long: 'American Association of Sleep Medicine', definedIn: sidOf(plan, 'AASM') },
      { id: idOf(plan, 'AVENIR'), isAbbreviation: true, long: 'Analyse des VENtes et Infections Respiratoires', definedIn: sidOf(plan, 'AASM') },
      { id: idOf(plan, 'DGH'), isAbbreviation: true, long: 'DGH', definedIn: sidOf(plan, 'DGH') },
    ] })
    for (const a of ['AASM', 'AVENIR', 'DGH']) expect([row(res.entries, a).long, row(res.entries, a).longSource]).toEqual([null, undefined])
    expect([res.filled, res.dropped]).toEqual([0, 3])
  })
  it('Accepts a cross-language full form when it appears verbatim', () => {
    const { entries, plan } = setup()
    const res = mergeModelResult(entries, plan, { items: [{ id: idOf(plan, 'AVENIR'), isAbbreviation: true, long: 'Analyse des VENtes et Infections Respiratoires', definedIn: sidOf(plan, 'AVENIR') }] })
    expect(row(res.entries, 'AVENIR').long).toBe('Analyse des VENtes et Infections Respiratoires')
  })
  it('Cannot add abbreviations or change abbreviation and first occurrence; entries with local full forms stay as is', () => {
    const { entries, plan } = setup()
    const res = mergeModelResult(entries, plan, { items: [
      { id: 'a999', isAbbreviation: true, long: 'Sleep', definedIn: sidOf(plan, 'AASM') },
      { id: idOf(plan, 'AASM'), abbr: 'XYZ', isAbbreviation: true, long: 'American Academy of Sleep Medicine', definedIn: sidOf(plan, 'AASM') },
      { id: idOf(plan, 'AASM'), isAbbreviation: false, long: null, definedIn: null }, // The second item with the same id is ignored
    ] })
    expect(res.entries.map((e) => e.abbr)).toEqual(entries.map((e) => e.abbr))
    expect(row(res.entries, 'AASM').firstUse).toEqual(row(entries, 'AASM').firstUse)
    expect(row(res.entries, 'AASM').section).toBe('list')
    // CKD is not in the request: forging its id cannot change it
    const forged = mergeModelResult(entries, { ...plan, itemAbbr: new Map(plan.itemAbbr) }, { items: [{ id: 'CKD', isAbbreviation: false, long: null, definedIn: null }] })
    expect(forged.entries).toEqual(entries)
  })
  it('Not an abbreviation: list entries without full form move to "possibly not"; is one: move back to list', () => {
    const { entries, plan } = setup()
    const res = mergeModelResult(entries, plan, { items: [
      { id: idOf(plan, 'AVENIR'), isAbbreviation: false, long: null, definedIn: null },
      { id: idOf(plan, 'DGH'), isAbbreviation: true, long: null, definedIn: null },
    ] })
    expect([row(res.entries, 'AVENIR').section, row(res.entries, 'AVENIR').why]).toEqual(['maybe_not', 'model'])
    expect([row(res.entries, 'DGH').section, row(res.entries, 'DGH').why]).toEqual(['list', undefined])
    expect([res.movedOut, res.movedIn]).toEqual([1, 1])
  })
  it('Changes nothing when the response format is wrong', () => {
    const { entries, plan } = setup()
    for (const bad of [null, 'x', { items: 'x' }, { items: [null, 3, { id: 5 }] }]) expect(mergeModelResult(entries, plan, bad).entries).toEqual(entries)
  })
})

describe('Request and failure fallback', () => {
  const fakeFetch = (status: number, body: unknown, seen: { url?: string; init?: RequestInit }[] = []): typeof fetch =>
    (async (url: string, init: RequestInit) => {
      seen.push({ url, init })
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch

  it('Success: POSTs JSON to the endpoint without credentials and returns items', async () => {
    const { plan } = setup()
    const seen: { url?: string; init?: RequestInit }[] = []
    const out = await callModel(plan.request, { fetchImpl: fakeFetch(200, { items: [{ id: 'a1', isAbbreviation: true, long: null, definedIn: null }] }, seen) })
    expect(out).toEqual({ ok: true, data: { items: [{ id: 'a1', isAbbreviation: true, long: null, definedIn: null }] } })
    expect(seen[0]!.url).toBe('https://api-crab.medicrab.com/v1/tools/abbreviations')
    expect([seen[0]!.init!.method, seen[0]!.init!.credentials, JSON.parse(String(seen[0]!.init!.body))]).toEqual(['POST', 'omit', plan.request])
  })
  it.each([
    [429, 'ip_daily'], [429, 'site_daily'], [429, 'ip_minute'], [503, 'disabled'], [503, 'unavailable'], [502, 'upstream_failed'],
    [413, 'too_large'], [403, 'origin_not_allowed'], [400, 'invalid_request'],
  ])('%i %s: reports the code', async (status, code) => {
    const { plan } = setup()
    const out = await callModel(plan.request, { fetchImpl: fakeFetch(status, { error: { code, message: 'x', retryAfter: 60 } }) })
    expect(out).toEqual({ ok: false, code, retryAfter: 60 })
  })
  it('Errors without code, bad JSON, malformed success, offline and timeout all fold into a fallback code', async () => {
    const { plan } = setup()
    expect(await callModel(plan.request, { fetchImpl: fakeFetch(500, '<html>') })).toEqual({ ok: false, code: 'upstream_failed' })
    expect(await callModel(plan.request, { fetchImpl: fakeFetch(413, '') })).toEqual({ ok: false, code: 'too_large' })
    expect(await callModel(plan.request, { fetchImpl: fakeFetch(200, { result: [] }) })).toEqual({ ok: false, code: 'upstream_failed' })
    expect(await callModel(plan.request, { fetchImpl: (async () => { throw new TypeError('Failed to fetch') }) as unknown as typeof fetch })).toEqual({ ok: false, code: 'network' })
    const hang = ((_: string, init: RequestInit) => new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted'))))) as unknown as typeof fetch
    expect(await callModel(plan.request, { fetchImpl: hang, timeoutMs: 20 })).toEqual({ ok: false, code: 'network' })
  })
})
