// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 TIKMOON LTD
/**
 * Browser entry for the website abbreviation checker (build and check an abbreviation list).
 * Bundled by `scripts/build.mjs` into `dist/abbreviation.js`; exports
 * `globalThis.MC_ABBR.analyze(text, split)` and wires up the UI when the page has one. The list is
 * built in the browser; only when the user ticks
 * "Find missing full terms with a model provided by MediCrab" and clicks the button
 * are the listed sentences sent (model.ts). Any failure keeps the local result.
 *
 * Main table: one row per abbreviation (one row each for abstract and main text when they are split);
 * rows can be ticked and the full form edited in place (this page only). Export only includes the
 * ticked rows of the main table. "Possibly not an abbreviation" is collapsed by default and not
 * exported; entries can be moved back to the main table one by one.
 */
import { analyze, type AnalyzeResult, type ListEntry, type Mark } from './detect'
import { fullTerm, submissionText, SUBMISSION_EN, toCsv, toTsv, type ExportRow } from './export'
import { callModel, mergeModelResult, planModelRequest, type ModelErrorCode, type ModelPlan } from './model'

type Messages = Record<string, string>

interface DocxGlobal {
  wireFileInput(options: { button: HTMLElement; input: HTMLInputElement; target: HTMLTextAreaElement; status: HTMLElement; onLoaded: () => void; msg: Messages; skipTables?: boolean }): void
}

const g = globalThis as typeof globalThis & { MC_ABBR?: { analyze: typeof analyze }; MC_DOCX?: DocxGlobal }
g.MC_ABBR = { analyze }

/** edited: the user changed the full form in the table (the model tidy-up no longer overwrites this row). */
interface Row { e: ListEntry; full: string; picked: boolean; section: ListEntry['section']; edited?: boolean }

function mount(): void {
  const dataNode = document.getElementById('tool-data')
  if (!dataNode) return
  const data = JSON.parse(dataNode.textContent || '{}') as { msg: Messages; sample: string; file: Messages }
  const msg = data.msg
  const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T
  const esc = (s: unknown): string => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))
  const f = (key: string, vars: Record<string, string | number> = {}): string => (msg[key] ?? '').replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ''))
  let last: AnalyzeResult | null = null
  let rows: Row[] = []
  let localText = false
  let plan: ModelPlan | null = null
  /** Whether this analysis has already been tidied up (avoids sending twice). */
  let modelDone = false
  /** Service temporarily off: the page stops showing the tidy-up option. */
  let modelOff = false
  const modelPanel = document.getElementById('model')

  const scopeLabel = (e: ListEntry): string => (e.scope === 'abstract' || e.scope === 'body' ? f(`scope_${e.scope}`) : '')
  const markText = (e: ListEntry, m: Mark): string => f(`mark_${m}`, {
    n: e.longs?.length ?? 0, list: (e.longs ?? e.forms ?? []).join(msg.listSep || '; '), base: e.variantOf ?? '',
  })
  const marksOf = (r: Row): string[] => [...r.e.marks.map((m) => markText(r.e, m)), ...(r.section === 'maybe_not' && r.e.why ? [f(`why_${r.e.why}`)] : [])]

  const ctxHtml = (loc: ListEntry['firstUse']): string =>
    `<span class="abbr-para">${esc(f('para', { n: loc.para }))}</span><q>${esc(loc.ctx.pre)}<mark>${esc(loc.ctx.hit)}</mark>${esc(loc.ctx.post)}</q>`

  // When the first occurrence is the definition, the first-definition column only shows the paragraph
  // number and does not repeat the sentence
  const sameLoc = (a: ListEntry['firstUse'], b: ListEntry['firstUse']): boolean => a.para === b.para && a.ctx.pre === b.ctx.pre && a.ctx.post === b.ctx.post

  function rowHtml(r: Row, i: number): string {
    const e = r.e
    const scope = scopeLabel(e)
    const lead = r.section === 'list'
      ? `<input type="checkbox" class="abbr-pick" data-i="${i}"${r.picked ? ' checked' : ''} aria-label="${esc(f('pick', { abbr: e.abbr }))}">`
      : `<button type="button" class="btn ghost abbr-move" data-i="${i}">${esc(msg.moveToList)}</button>`
    const marks = marksOf(r).map((t) => `<span class="abbr-mark">${esc(t)}</span>`).join('')
    return `<tr><td class="abbr-c-pick">${lead}</td>
      <td class="abbr-c-abbr"><span class="tool-abbr">${esc(e.abbr)}</span>${scope ? `<span class="tool-scope">${esc(scope)}</span>` : ''}</td>
      <td class="abbr-c-full"><input type="text" class="abbr-full" data-i="${i}" value="${esc(r.full)}" placeholder="${esc(msg.fullPlaceholder)}" aria-label="${esc(f('fullFor', { abbr: e.abbr }))}"></td>
      <td class="abbr-c-ctx">${ctxHtml(e.firstUse)}</td>
      <td class="abbr-c-ctx">${!e.firstDef ? '<span class="abbr-none">—</span>' : sameLoc(e.firstDef, e.firstUse) ? `<span class="abbr-para">${esc(f('para', { n: e.firstDef.para }))}</span>` : ctxHtml(e.firstDef)}</td>
      <td class="abbr-c-n">${e.count}</td>
      <td class="abbr-c-marks">${marks}</td></tr>`
  }

  const tableHtml = (list: [Row, number][]): string => `<table class="abbr-table"><thead><tr><th class="abbr-c-pick"></th><th>${esc(msg.col_abbr)}</th><th>${esc(msg.col_full)}</th><th>${esc(msg.col_first)}</th><th>${esc(msg.col_def)}</th><th>${esc(msg.col_count)}</th><th>${esc(msg.col_marks)}</th></tr></thead>
    <tbody>${list.map(([r, i]) => rowHtml(r, i)).join('')}</tbody></table>`

  function render(): void {
    if (!last) return
    const main = rows.map((r, i) => [r, i] as [Row, number]).filter(([r]) => r.section === 'list')
    const maybe = rows.map((r, i) => [r, i] as [Row, number]).filter(([r]) => r.section === 'maybe_not')
    const count = (list: [Row, number][]): number => new Set(list.map(([r]) => r.e.abbr)).size
    const skipped = last.skippedReferences ? ` <span class="tool-hint">${esc(f('skippedRefs', { n: last.skippedReferences }))}</span>` : ''
    $('summary').innerHTML = `<p class="tool-sum">${esc(f('summary', { n: count(main) }))}${skipped}</p>`
    $('list').innerHTML = main.length ? tableHtml(main) : `<div class="tool-empty">${esc(msg.noneFound)}</div>`
    $('maybe').hidden = !maybe.length
    $('maybe-title').textContent = f('maybeTitle', { n: count(maybe) })
    $('maybe-list').innerHTML = maybe.length ? tableHtml(maybe) : ''
    $('actions').hidden = !main.length
  }

  function run(): void {
    const text = $<HTMLTextAreaElement>('input').value
    $('export-status').textContent = ''
    if (!text.trim()) { $('results').hidden = true; return }
    last = analyze(text, $<HTMLInputElement>('split').checked)
    localText = (text.match(/[぀-ヿ㐀-鿿가-힯]/g) || []).length > text.length * 0.1
    rows = last.entries.map((e) => ({ e, full: fullTerm(e.long, e.longLocal), picked: e.section === 'list', section: e.section }))
    $('results').hidden = false
    render()
    planModel(text)
  }

  // ------------------------------------------------ Model tidy-up (off by default; sends only after
  // ticking and clicking the button)

  const modelError: Record<ModelErrorCode, string | undefined> = {
    ip_daily: msg.modelLimit, site_daily: msg.modelLimit, ip_minute: msg.modelMinute, disabled: msg.modelDisabled,
    too_large: msg.modelTooLarge, origin_not_allowed: msg.modelOrigin,
    unavailable: msg.modelFailed, upstream_failed: msg.modelFailed, invalid_request: msg.modelFailed, network: msg.modelFailed,
  }
  const modelStatus = (text: string, download = false): void => {
    $('model-status').textContent = text
    $('model-download').hidden = !download
  }
  function showModelBody(): void {
    const on = $<HTMLInputElement>('model-on').checked && !!plan && !modelDone
    $('model-body').hidden = !on
  }
  function planModel(text: string): void {
    if (!modelPanel) return
    modelDone = false
    modelStatus('')
    const lang = document.documentElement.dataset.locale || document.documentElement.lang || 'en'
    plan = last && !modelOff ? planModelRequest(text, $<HTMLInputElement>('split').checked, last.entries, { lang, page: location.pathname }) : null
    modelPanel.hidden = !plan
    if (!plan) return
    $('model-count').textContent = f('modelCount', { n: plan.request.sentences.length, chars: plan.chars.toLocaleString() })
    // Preview: the original sentence, with the abbreviations being asked about highlighted
    $('model-sentences').innerHTML = plan.preview.map((p) => {
      let html = ''
      let pos = 0
      for (const h of [...p.hits].sort((x, y) => x.at - y.at)) {
        if (h.at < pos) continue
        html += `${esc(p.text.slice(pos, h.at))}<mark>${esc(p.text.slice(h.at, h.at + h.len))}</mark>`
        pos = h.at + h.len
      }
      return `<li>${html}${esc(p.text.slice(pos))}</li>`
    }).join('')
    $('model-omitted').hidden = !plan.omitted
    $('model-omitted').textContent = plan.omitted ? f('modelOmitted', { n: plan.omitted }) : ''
    $<HTMLButtonElement>('model-run').disabled = false
    showModelBody()
  }
  async function runModel(): Promise<void> {
    if (!plan || !last || modelDone || !$<HTMLInputElement>('model-on').checked) return
    const sent = plan
    const btn = $<HTMLButtonElement>('model-run')
    btn.disabled = true
    modelStatus(msg.modelRunning!)
    const outcome = await callModel(sent.request, { endpoint: modelPanel?.dataset.endpoint || undefined })
    if (plan !== sent) return // The list was regenerated in the meantime
    if (!outcome.ok) {
      const limit = outcome.code === 'ip_daily' || outcome.code === 'site_daily'
      modelStatus(modelError[outcome.code] ?? msg.modelFailed!, limit)
      if (outcome.code === 'disabled') {
        modelOff = true
        $<HTMLInputElement>('model-on').checked = false
        $<HTMLInputElement>('model-on').disabled = true
        $('model-body').hidden = true
      } else btn.disabled = false
      return
    }
    const merged = mergeModelResult(rows.map((r) => r.e), sent, outcome.data)
    // Count only rows actually changed in the table (rows whose full form the user edited, or edited while
    // waiting, are left alone and not counted)
    const filled = new Set<string>()
    const movedAbbr = new Set<string>()
    rows = rows.map((r, i) => {
      const e = merged.entries[i]!
      if (e === r.e || r.edited || r.full.trim()) return r
      const moved = r.section === r.e.section ? e.section : r.section // Do not move entries the user moved by hand
      if (e.longSource) filled.add(e.abbr)
      if (moved !== r.section) movedAbbr.add(e.abbr)
      return { ...r, e, full: e.longSource ? fullTerm(e.long, e.longLocal) : r.full, section: moved, picked: moved === 'list' && r.section !== 'list' ? true : r.picked }
    })
    modelDone = true
    $('model-body').hidden = true
    render()
    modelStatus(filled.size || movedAbbr.size ? f('modelDone', { filled: filled.size, moved: movedAbbr.size }) : msg.modelDoneNone!)
  }
  if (modelPanel) {
    $<HTMLInputElement>('model-on').checked = false
    $<HTMLInputElement>('model-on').onchange = showModelBody
    $('model-run').onclick = () => { void runModel() }
  }
  const updateCount = (): void => { $('count').textContent = f('chars', { n: $<HTMLTextAreaElement>('input').value.length.toLocaleString() }) }

  const picked = (): ExportRow[] => rows.filter((r) => r.section === 'list' && r.picked).map((r) => ({
    abbr: r.e.abbr, scope: r.e.scope, full: r.full.trim(), firstPara: r.e.firstUse.para, defPara: r.e.firstDef?.para, count: r.e.count, marks: marksOf(r), scopeLabel: scopeLabel(r.e),
  }))

  function status(text: string): void {
    $('export-status').textContent = text
  }
  async function copy(text: string, done: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text)
      status(done)
    } catch {
      status(msg.copyFailed!)
    }
  }

  $('run').onclick = run
  $('sample').onclick = () => { $<HTMLTextAreaElement>('input').value = data.sample; updateCount(); run() }
  $('clear').onclick = () => { $<HTMLTextAreaElement>('input').value = ''; updateCount(); $('results').hidden = true }
  $<HTMLInputElement>('split').onchange = () => { if (!$('results').hidden) run() }
  $('input').oninput = updateCount
  g.MC_DOCX?.wireFileInput({ button: $('open-file'), input: $<HTMLInputElement>('file'), target: $<HTMLTextAreaElement>('input'), status: $('file-status'), onLoaded: run, msg: data.file, skipTables: true })

  const onTable = (e: Event): void => {
    const t = e.target as HTMLElement
    const i = Number(t.dataset.i)
    const r = rows[i]
    if (!r) return
    if (t.classList.contains('abbr-pick')) r.picked = (t as HTMLInputElement).checked
    else if (t.classList.contains('abbr-full')) { r.full = (t as HTMLInputElement).value; r.edited = true }
  }
  for (const id of ['list', 'maybe-list']) {
    $(id).addEventListener('change', onTable)
    $(id).addEventListener('input', onTable)
  }
  $('maybe-list').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('.abbr-move')
    const r = b ? rows[Number(b.dataset.i)] : undefined
    if (!r) return
    // Move the abstract and main-text rows of the same abbreviation together
    for (const x of rows) if (x.e.abbr === r.e.abbr && x.section === 'maybe_not') { x.section = 'list'; x.picked = true }
    render()
  })
  $('uncheck-common').onclick = () => {
    for (const r of rows) if (r.e.marks.includes('common')) r.picked = false
    render()
  }
  $('copy').onclick = () => {
    const list = picked()
    if (!list.length) return status(msg.noneChecked!)
    void copy(toTsv(list, [msg.col_abbr!, msg.col_full!]), msg.copied!)
  }
  $('copy-sub').onclick = () => {
    const list = picked()
    if (!list.length) return status(msg.noneChecked!)
    const style = localText ? { head: msg.sub_head!, pair: msg.sub_pair!, sep: msg.sub_sep!, end: msg.sub_end! } : SUBMISSION_EN
    const { text, skipped } = submissionText(list, style)
    if (!text) return status(msg.subNone!)
    void copy(text, skipped ? f('subSkipped', { n: skipped }) : msg.copied!)
  }
  $('csv').onclick = () => {
    const list = picked()
    if (!list.length) return status(msg.noneChecked!)
    const csv = toCsv(list, [msg.col_abbr!, msg.col_full!, msg.csv_scope!, msg.csv_first!, msg.csv_def!, msg.col_count!, msg.col_marks!])
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = msg.csvName || 'abbreviations.csv'
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    status(msg.downloaded!)
  }
  updateCount()
}

if (typeof document !== 'undefined') mount()
