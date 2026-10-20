// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 TIKMOON LTD
/*
 * MediCrab free tool: page interactions for the reference checker. Splitting and matching live in
 * reference-checker-engine.js (window.MCRefCheck); queries go from the browser directly to PubMed,
 * Crossref and doi.org, never through MediCrab servers.
 */
(function () {
  const data = JSON.parse(document.getElementById('tool-data').textContent)
  const msg = data.msg
  const engine = window.MCRefCheck
  const $ = (id) => document.getElementById(id)
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  const f = (key, vars = {}) => msg[key].replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '')
  const CONCURRENCY = 3
  // Retraction, withdrawal and expression of concern override "fields differ" as the main verdict;
  // a correction only adds an extra label.
  const SERIOUS = new Set(['retracted', 'withdrawn', 'expression-of-concern', 'reinstated'])
  const PUB_CLASS = { retracted: 'bad', withdrawn: 'bad', 'expression-of-concern': 'warn', reinstated: 'warn', corrected: 'warn', notice: 'warn' }
  const FIELDS = ['authors', 'title', 'journal', 'year', 'volume', 'issue', 'pages']
  const KINDS = ['wrong-id', 'not-found', 'retracted', 'differs', 'review', 'no-match', 'failed', 'ok']

  let rows = []
  let controller = null
  let filter = 'all'
  let checkedText = null

  const idName = (kind) => (kind.startsWith('pmid') ? 'PMID' : 'DOI')
  const sourceName = (s) => msg[`src_${s}`] || s
  const linkOf = (rec) => (rec?.doi ? `https://doi.org/${rec.doi}` : rec?.url || null)
  const a = (href, text) => `<a href="${esc(href)}" target="_blank" rel="noopener">${text}</a>`

  const partlyUnchecked = (r) => (r.unchecked || []).length > 0

  /** [label, style, category] */
  function verdict(row) {
    const r = row.result
    if (!r) return row.error ? [msg.vFailed, 'info', 'failed'] : [msg.vChecking, 'info', 'pending']
    const owns = r.identity === 'verified' || r.identity === 'wrong-doi'
    const pub = owns && r.publication ? r.publication.state : null
    if (r.identity === 'verified') {
      if (SERIOUS.has(pub)) return [f('vFoundStatus', { status: msg[`pub_${pub}`] }), PUB_CLASS[pub], 'retracted']
      const wrong = r.idProblems.filter((p) => !p.kind.endsWith('unchecked'))
      if (wrong.length) return [f('vIdWrong', { id: idName(wrong[0].kind) }), 'bad', 'wrong-id']
      // A title mismatch (identifier, volume/pages and authors all match, but the title is wrong) matters
      // more than other wrong fields: show it in red.
      if (r.fields.some((x) => x.field === 'title' && x.status === 'differs')) return [msg.vDiffers, 'bad', 'differs']
      if (r.fields.some((x) => x.status === 'differs')) return [msg.vDiffers, 'warn', 'differs']
      // Volume or pages missing from the entry (or not parsed): the article was identified, but don't
      // say "citation matches".
      if (partlyUnchecked(r)) return [msg.vFoundPartial || msg.vMatch, 'ok', 'ok']
      return [msg.vMatch, 'ok', 'ok']
    }
    if (r.identity === 'wrong-doi') return [SERIOUS.has(pub) ? f('vWrongDoiStatus', { status: msg[`pub_${pub}`] }) : msg.vWrongDoi, 'bad', SERIOUS.has(pub) ? 'retracted' : 'wrong-id']
    if (r.identity === 'points-elsewhere') return [f('vElsewhere', { id: r.identifiers.doi ? 'DOI' : 'PMID' }), 'bad', 'wrong-id']
    if (r.identity === 'needs-review') return [msg.vReview, 'warn', 'review']
    if (r.identity === 'id-not-found') return [r.identifiers.pmid && !r.identifiers.doi ? msg.vPmidNotFound : msg.vDoiNotFound, 'bad', 'not-found']
    if (r.identity === 'no-match') return [msg.vNoMatch, 'info', 'no-match']
    return [msg.vFailed, 'info', 'failed']
  }

  function explain(r) {
    if (r.identity === 'id-not-found') return r.identifiers.pmid && !r.identifiers.doi ? msg.nPmidNotFound : r.titleSearchFailed ? msg.nDoiNotFoundPartial : msg.nDoiNotFound
    if (r.identity === 'no-match') return msg.nNoMatch
    if (r.identity === 'needs-review') return msg.nReview
    if (r.identity === 'points-elsewhere') return f('nElsewhere', { id: r.identifiers.doi ? 'DOI' : 'PMID' })
    return ''
  }

  function recordHtml(r) {
    const rec = r.record
    if (!rec) return ''
    const ids = [rec.doi && `DOI ${esc(rec.doi)}`, rec.pmid && `PMID ${esc(rec.pmid)}`].filter(Boolean).join(' · ')
    const label = r.identity === 'points-elsewhere' ? msg.recElsewhere : r.identity === 'needs-review' ? msg.recClosest : msg.recFound
    const link = linkOf(rec)
    return `<div class="ref-record"><b>${esc(label)}</b> ${esc(rec.title)}<br>${esc(rec.journal)} ${esc(rec.pubdate)}${ids ? ` · ${link ? a(link, ids) : ids}` : ''}</div>`
  }

  function pubHtml(r) {
    const pub = r.publication
    if (!pub) return ''
    if (pub.state === 'unknown' || !pub.checkedSources.length) return `<p class="tool-note">${esc(msg.nPubUnknown)}</p>`
    if (pub.state === 'no-update-found') return `<p class="tool-note">${esc(f('nNoUpdate', { sources: pub.checkedSources.map(sourceName).join(msg.and) }))}</p>`
    if (!msg[`pub_${pub.state}`]) return ''
    const u = pub.updates[0]
    const detail = u ? `${esc(u.label)}${u.date ? `, ${esc(u.date)}` : ''}${u.url ? ` · ${a(u.url, esc(msg.notice))}` : ''}` : ''
    return `<p class="tool-note"><span class="tool-badge ${PUB_CLASS[pub.state]}">${esc(msg[`pub_${pub.state}`])}</span> ${detail}</p>`
  }

  function idNoteText(p) {
    const id = idName(p.kind)
    const other = id === 'PMID' ? 'DOI' : 'PMID'
    const key = p.kind.endsWith('unchecked') ? 'nIdUnchecked' : p.kind.endsWith('not-found') ? 'nIdNotFound' : p.otherTitle ? 'nIdElsewhereTitle' : 'nIdElsewhere'
    return f(key, { id, value: p.id, other, title: p.otherTitle || '' })
  }

  /** Retraction status or an identifier lookup failed this time: this entry is worth a "retry". */
  const incomplete = (row) => Boolean(row.result && (row.result.titleSearchFailed || row.result.idProblems.some((p) => p.kind.endsWith('unchecked'))
    || (['verified', 'wrong-doi'].includes(row.result.identity) && row.result.publication
      && (row.result.publication.state === 'unknown' || !row.result.publication.checkedSources.length))))
  const retryable = (row) => Boolean(row.error) || incomplete(row)

  function pubStatusText(pub) {
    if (!pub) return ''
    if (pub.state === 'unknown' || !pub.checkedSources.length) return msg.nPubUnknown
    if (pub.state === 'no-update-found') return msg.notRetracted
    return msg[`pub_${pub.state}`] ?? ''
  }

  function itemHtml(row, index) {
    const [label, cls, kind] = verdict(row)
    const r = row.result
    const num = row.entry.number ?? index + 1
    let body = `<p class="ref-orig">${esc(row.entry.text)}</p>`
    let extra = ''
    if (r && kind === 'ok') {
      const rec = r.record
      const link = linkOf(rec)
      const where = rec ? `${esc(rec.journal)} ${esc(rec.pubdate)}` : ''
      const pub = r.publication
      const quiet = pub?.state === 'no-update-found' && pub.checkedSources.length
      if (rec) body += `<p class="tool-note">${link ? a(link, where) : where}${rec.pmid ? ` · PMID ${esc(rec.pmid)}` : ''}${quiet ? ` · ${esc(msg.notRetracted)}` : ''}</p>`
      for (const p of r.idProblems) body += `<p class="tool-note">${esc(idNoteText(p))}</p>`
      if (partlyUnchecked(r) && msg.nUnchecked) {
        body += `<p class="tool-note">${esc(f('nUnchecked', { fields: r.unchecked.map((x) => msg[`field_${x}`]).join(msg.listSep) }))}</p>`
      }
      if (pub && !quiet && !msg[`pub_${pub.state}`]) body += pubHtml(r)
    } else if (r) {
      const note = explain(r)
      if (note) body += `<p class="tool-note">${esc(note)}</p>`
      if (r.identity === 'wrong-doi' && r.suggestedDoi) {
        body += `<p class="tool-note">${esc(msg.yourDoi)} <code>${esc(r.identifiers.doi)}</code> → ${esc(msg.registeredDoi)} ${a(`https://doi.org/${r.suggestedDoi}`, `<code>${esc(r.suggestedDoi)}</code>`)}</p>`
      }
      for (const p of r.idProblems) body += `<p class="tool-note">${esc(idNoteText(p))}</p>`
      body += recordHtml(r)
      // When the user needs to compare by eye, also list the matching fields to help judge whether it
      // is the same article; otherwise list only the fields that differ.
      const review = r.identity === 'needs-review'
      const shown = r.fields.filter((x) => x.status === 'differs' || (review && (x.status === 'same' || x.status === 'convention')))
      if (shown.length) {
        const mark = (x) => (!review ? '' : x.status === 'differs' ? (msg.rowDiffers ? ` · ${esc(msg.rowDiffers)}` : '') : (msg.rowMatches ? ` · ${esc(msg.rowMatches)}` : ''))
        body += `<table class="ref-fields"><tbody>${shown.map((x) => `<tr><th>${esc(msg[`field_${x.field}`])}${mark(x)}</th><td>${esc(msg.youWrote)} ${esc(x.declared)}<br>${esc(msg.recordHas)} ${esc(x.found)}</td></tr>`).join('')}</tbody></table>`
      }
      body += pubHtml(r)
      const pub = r.publication?.state
      if (pub && !SERIOUS.has(pub) && msg[`pub_${pub}`]) extra = `<span class="tool-badge ${PUB_CLASS[pub]}">${esc(msg[`pub_${pub}`])}</span>`
    } else if (row.error) {
      body += `<p class="tool-note">${esc(msg.nFailed)}</p>`
    }
    if (r && kind === 'ok' && r.publication?.state && msg[`pub_${r.publication.state}`] && !SERIOUS.has(r.publication.state)) {
      extra = `<span class="tool-badge ${PUB_CLASS[r.publication.state]}">${esc(msg[`pub_${r.publication.state}`])}</span>`
      body += pubHtml(r)
    }
    const border = kind === 'ok' ? 'ok' : cls === 'bad' ? 'bad' : cls === 'warn' ? 'warn' : ''
    return `<article class="tool-row ${border}"><div class="tool-item-head"><span class="ref-num">${esc(num)}.</span><span class="tool-badge ${cls}">${esc(label)}</span>${extra}</div>${body}</article>`
  }

  function render() {
    const counts = {}
    for (const row of rows) { const k = verdict(row)[2]; counts[k] = (counts[k] || 0) + 1 }
    const chips = [['all', msg.chipAll, rows.length], ...KINDS.map((k) => [k, msg[`chip_${k}`], counts[k] || 0]).filter((c) => c[2])]
    $('summary').innerHTML = chips.map(([k, label, n]) => `<button type="button" class="tool-chip" data-k="${k}" aria-pressed="${filter === k}">${esc(label)} <b>${n}</b></button>`).join('')
    const shown = rows.map((row, i) => [row, i]).filter(([row]) => filter === 'all' || verdict(row)[2] === filter)
    $('list').innerHTML = shown.map(([row, i]) => itemHtml(row, i)).join('')
  }

  function warningText(w) {
    switch (w.kind) {
      case 'long-entry': return f('wLong', { n: w.index + 1 })
      case 'short-entry': return f('wShort', { n: w.index + 1 })
      case 'numbering-gap': return f('wGap', { list: w.missing.join(msg.listSep) })
      case 'numbering-duplicate': return f('wDuplicate', { list: w.numbers.join(msg.listSep) })
      case 'leading-text': return f('wLeading', { text: w.text.length > 80 ? `${w.text.slice(0, 80)}…` : w.text })
      case 'too-many': return f('wTooMany', { limit: w.limit, total: w.total })
      default: return ''
    }
  }

  function detect() {
    const text = $('input').value
    if (!text.trim()) { $('detected').innerHTML = ''; return null }
    const split = engine.split(text)
    const notes = split.warnings.map(warningText).filter(Boolean)
    const head = f(split.entries.length === 1 ? 'detectedOne' : 'detected', { n: split.entries.length })
    $('detected').innerHTML = `<b>${esc(head)}</b>${split.confident ? '' : ` ${esc(msg.checkSplit)}`}${notes.length ? `<ul>${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}`
    $('stale').hidden = checkedText === null || text === checkedText
    return split
  }

  function setRunning(running) {
    $('run').disabled = running
    $('stop').hidden = !running
    $('after').hidden = running || !rows.length
    $('retry').hidden = running || !rows.some(retryable)
  }

  // Each start or clear begins a new generation; when an older generation's query finishes and
  // finds itself stale, it does nothing.
  let generation = 0

  async function runRows(indexes) {
    controller?.abort()
    controller = new AbortController()
    const signal = controller.signal
    const run = ++generation
    const batch = rows
    const total = indexes.length
    let done = 0
    const current = () => run === generation
    const tick = () => { $('progress').textContent = f('progress', { done, total }); $('bar').style.width = `${(done / total) * 100}%` }
    $('progress-wrap').hidden = false
    setRunning(true)
    tick()
    const queue = [...indexes]
    const worker = async () => {
      while (queue.length && !signal.aborted) {
        const row = batch[queue.shift()]
        row.result = null
        row.error = null
        try {
          const result = await engine.check(row.entry.text, signal)
          if (signal.aborted) break
          if (result.identity === 'failed') row.error = 'failed'
          else row.result = result
        } catch (error) {
          if (signal.aborted) break
          row.error = String(error)
        }
        done++
        if (current()) { tick(); render() }
      }
    }
    try {
      await Promise.all(Array.from({ length: CONCURRENCY }, worker))
    } finally {
      if (current()) {
        for (const i of indexes) if (!batch[i].result && !batch[i].error) batch[i].error = 'stopped'
        $('progress').textContent = signal.aborted ? f('stopped', { done, total }) : f('finished', { total })
        setRunning(false)
        render()
      }
    }
  }

  $('run').onclick = () => {
    const split = detect()
    if (!split || !split.entries.length) return
    rows = split.entries.map((entry) => ({ entry, result: null, error: null }))
    filter = 'all'
    checkedText = $('input').value
    $('stale').hidden = true
    $('results').hidden = false
    render()
    runRows(rows.map((_, i) => i))
  }
  $('stop').onclick = () => controller?.abort()
  $('retry').onclick = () => {
    const failed = rows.map((row, i) => (retryable(row) ? i : -1)).filter((i) => i >= 0)
    if (failed.length) runRows(failed)
  }
  $('summary').onclick = (e) => { const b = e.target.closest('.tool-chip'); if (b) { filter = b.dataset.k; render() } }
  $('sample').onclick = () => { $('input').value = data.sample; detect() }
  $('clear').onclick = () => {
    controller?.abort()
    generation++
    setRunning(false)
    $('progress-wrap').hidden = true
    $('input').value = ''
    rows = []
    checkedText = null
    $('detected').innerHTML = ''
    $('results').hidden = true
    $('stale').hidden = true
  }
  let timer = null
  $('input').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(detect, 300) })

  function reportRows() {
    return rows.map((row, i) => {
      const r = row.result
      const pub = r?.publication
      return {
        number: row.entry.number ?? i + 1,
        verdict: verdict(row)[0],
        text: row.entry.text,
        differs: r ? r.fields.filter((x) => x.status === 'differs').map((x) => `${msg[`field_${x.field}`]}: ${msg.youWrote} ${x.declared}; ${msg.recordHas} ${x.found}`).join(' | ') : '',
        idNotes: r ? r.idProblems.map(idNoteText).join(' | ') : '',
        title: r?.record?.title ?? '',
        journal: r?.record?.journal ?? '',
        date: r?.record?.pubdate ?? '',
        doi: r?.record?.doi ?? '',
        pmid: r?.record?.pmid ?? '',
        suggested: r?.suggestedDoi ?? '',
        status: r && ['verified', 'wrong-doi'].includes(r.identity) ? pubStatusText(pub) : '',
        notice: pub?.updates?.[0]?.url ?? '',
      }
    })
  }

  // Spreadsheet apps execute cells starting with = + - @ as formulas; prefix a single quote.
  const cell = (value) => {
    const text = String(value ?? '')
    return `"${(/^[=+\-@\t\r]/.test(text) ? `'${text}` : text).replace(/"/g, '""')}"`
  }

  $('csv').onclick = () => {
    const keys = ['number', 'verdict', 'text', 'differs', 'idNotes', 'title', 'journal', 'date', 'doi', 'pmid', 'suggested', 'status', 'notice']
    const lines = [keys.map((k) => cell(msg[`csv_${k}`])).join(','), ...reportRows().map((row) => keys.map((k) => cell(row[k])).join(','))]
    const link = document.createElement('a')
    link.href = URL.createObjectURL(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }))
    link.download = 'reference-check.csv'
    link.click()
    setTimeout(() => URL.revokeObjectURL(link.href), 1000)
  }

  $('copy').onclick = async () => {
    const lines = reportRows().map((row) => {
      const parts = [`${row.number}. ${row.verdict}`]
      if (row.idNotes) parts.push(row.idNotes)
      if (row.suggested) parts.push(`${msg.registeredDoi} ${row.suggested}`)
      if (row.differs) parts.push(row.differs)
      if (row.status && row.status !== msg.notRetracted) parts.push(row.status)
      return parts.join(' — ')
    })
    try {
      await navigator.clipboard.writeText(`${lines.join('\n')}\n\n${msg.reportFooter}`)
      $('copy').textContent = msg.copied
    } catch {
      $('copy').textContent = msg.copyFailed
    }
    setTimeout(() => { $('copy').textContent = msg.copy }, 1600)
  }
})()
