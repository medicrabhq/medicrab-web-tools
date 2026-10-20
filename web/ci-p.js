// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 TIKMOON LTD
/*
 * MediCrab free tool: consistency of confidence intervals and P values. Computed entirely in the
 * browser; data never leaves the device. SE and P are derived from the CI (Altman & Bland, BMJ
 * 2011;343:d2304); the two-sided P uses the regularized incomplete gamma function.
 */
(function () {
  const LANCZOS = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7]
  function lnGamma(z) {
    if (z === 0.5) return 0.5 * Math.log(Math.PI)
    let x = LANCZOS[0]
    const s = z - 1
    for (let i = 1; i < LANCZOS.length; i++) x += LANCZOS[i] / (s + i)
    const t = s + 7.5
    return 0.5 * Math.log(2 * Math.PI) + (s + 0.5) * Math.log(t) - t + Math.log(x)
  }
  function gammaQ(a, x) {
    if (x === 0) return 1
    if (x < a + 1 || x < 12) {
      let term = 1 / a
      let sum = term
      for (let n = 1; n <= 300; n++) { term *= x / (a + n); sum += term; if (Math.abs(term) < Math.abs(sum) * 1e-15) break }
      return 1 - Math.exp(a * Math.log(x) - x - lnGamma(a) + Math.log(sum))
    }
    let b = x + 1 - a
    let c = 1e30
    let d = 1 / b
    let h = d
    for (let i = 1; i <= 300; i++) {
      const an = -i * (i - a)
      b += 2
      d = an * d + b; if (Math.abs(d) < 1e-30) d = 1e-30
      c = b + an / c; if (Math.abs(c) < 1e-30) c = 1e-30
      d = 1 / d
      const delta = d * c
      h *= delta
      if (Math.abs(delta - 1) < 1e-15) break
    }
    return Math.exp(a * Math.log(x) - x - lnGamma(a) + Math.log(h))
  }
  const twoSidedP = (z) => gammaQ(0.5, z * z / 2)
  /** Standard normal quantile (Acklam's approximation, relative error about 1e-9). */
  function normInv(p) {
    const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239]
    const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572]
    const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783]
    const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416]
    const tail = (q) => (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    if (p < 0.02425) return tail(Math.sqrt(-2 * Math.log(p)))
    if (p > 0.97575) return -tail(Math.sqrt(-2 * Math.log(1 - p)))
    const q = p - 0.5
    const r = q * q
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  }
  const Z = { 90: 1.6448536269514722, 95: 1.959963984540054, 99: 2.5758293035489004 }
  /**
   * Confidence level to two-sided critical value; constants for the three common levels, the
   * normal quantile otherwise.
   */
  const zFor = (level) => Z[level] || -normInv((100 - level) / 200)
  /** Supported range of confidence levels (%). */
  const levelOk = (level) => Number.isFinite(level) && level >= 50 && level <= 99.9

  // Character-for-character, same-length replacement: superscript digits, minus signs, middle dots,
  // full-width comparison signs. Paragraph mode matches on the replaced text, while quotes are still
  // cut from the original text at the same positions.
  const NORM = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', '⁻': '-', '⁺': '+', '−': '-', '‒': '-', '⋅': '.', '·': '.', '＝': '=', '＜': '<', '＞': '>' }
  const normText = (s) => String(s ?? '').replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁻⁺−‒⋅·＝＜＞]/g, (ch) => NORM[ch])
  const clean = (s) => normText(s).trim().replace(/[–—]/g, '-').replace(/^\./, '0.').replace(/^-\./, '-0.')
  function parseNum(s) {
    let t = clean(s)
    if (/^-?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(t)) t = t.replace(/,/g, '') // Thousands separator commas
    if (!/^-?\d*\.?\d+$/.test(t)) return null
    return { value: Number(t), half: 0.5 * 10 ** -(t.split('.')[1] || '').length, text: t }
  }
  // Numeric P-value forms, shared by single-result and paragraph modes (applied to text after
  // normText): decimals, integers, or scientific notation a×10^−b, a x 10-b, ae−b.
  // Must not be followed by another digit or by a partial exponent (×10, e, e−, e -), so we don't
  // read only the mantissa.
  const PNUM = String.raw`(?:\d*\.?\d+\s*(?:[×x*✕]\s*10\s*\^?\s*|[eE]\s*)[-–+]?\s*\d+|\d*\.\d+|\d+)(?!\d|\.\d|\s*[×x*✕]\s*10|[eE](?![A-Za-z])|\s+[eE]\s*[-–+\d])`
  const POP = String.raw`(<=|>=|=|<|>|≤|≥)`
  const P_FULL = new RegExp(String.raw`^${POP}?\s*(${PNUM})$`)
  const P_SCI = /^(\d*\.?\d+)\s*(?:[×x*✕]\s*10\s*\^?\s*|[eE]\s*)([-–+]?)\s*(\d+)$/
  function parseP(s) {
    const t = normText(s).trim().replace(/^p\s*(?:-?\s*value|值|値|값)?\s*/i, '')
    const m = P_FULL.exec(t)
    if (!m) return null
    const op = m[1] === '≤' || m[1] === '<=' ? '<' : m[1] === '≥' || m[1] === '>=' ? '>' : (m[1] || '=')
    const prefix = op === '=' ? '' : op
    const sci = P_SCI.exec(m[2])
    if (!sci) {
      const v = parseNum(m[2])
      if (!v || v.value > 1) return null
      return { op, value: v.value, half: v.half, text: `${prefix}${m[2]}` }
    }
    // Scientific notation: rounding range depends on the number of mantissa digits
    const mant = parseNum(sci[1])
    const exp = Number(`${sci[2] === '+' || sci[2] === '' ? '' : '-'}${sci[3]}`)
    const scale = 10 ** exp
    const value = mant.value * scale
    if (!(value >= 0 && value <= 1)) return null
    return { op, value, half: mant.half * scale, text: `${prefix}${mant.text}×10^${exp}` }
  }
  function fmtP(p) {
    if (!Number.isFinite(p)) return '—'
    if (p < 0.0001) return '<0.0001'
    return p < 0.001 ? p.toFixed(4) : p.toFixed(3)
  }
  const fmt = (x, digits) => Number.isFinite(x) ? x.toFixed(digits) : '—'

  /**
   * One result to computed values and per-item conclusions. msg is the localized message text
   * supplied by the page.
   */
  function checkResult({ type, est, lo, hi, level = 95, p = null }, msg) {
    const f = (key, vars = {}) => msg[key].replace(/\{(\w+)\}/g, (_, k) => vars[k])
    const ratio = type === 'ratio'
    if (!levelOk(level)) return { error: msg.eLevel }
    const z = zFor(level)
    const alpha = Number(((100 - level) / 100).toFixed(6))
    const tr = (x) => ratio ? Math.log(x) : x
    const nullText = ratio ? '1' : '0'
    const checks = []
    if (lo.value === hi.value) return { error: msg.eEqual }
    if (lo.value > hi.value) {
      ;[lo, hi] = [hi, lo]
      checks.push({ level: 'warn', text: msg.cSwapped })
    }
    if (ratio && (est.value <= 0 || lo.value <= 0)) return { error: msg.eRatio }

    const outside = est.value + est.half < lo.value - lo.half || est.value - est.half > hi.value + hi.half
    checks.push(outside
      ? { level: 'bad', text: f('cOutside', { est: est.text, lo: lo.text, hi: hi.text }), note: msg.cOutsideNote }
      : { level: 'ok', text: msg.cInside })

    const se = (tr(hi.value) - tr(lo.value)) / (2 * z)
    const pc = twoSidedP(tr(est.value) / se)
    let pMin = 1
    let pMax = 0
    for (const e of [est.value - est.half, est.value + est.half]) for (const l of [lo.value - lo.half, lo.value + lo.half]) for (const h of [hi.value - hi.half, hi.value + hi.half]) {
      if ((ratio && (e <= 0 || l <= 0)) || !(l < h)) continue
      const pp = twoSidedP(tr(e) / ((tr(h) - tr(l)) / (2 * z)))
      pMin = Math.min(pMin, pp)
      pMax = Math.max(pMax, pp)
    }
    const nullV = ratio ? 1 : 0
    if (est.value - est.half <= nullV && est.value + est.half >= nullV) pMax = 1

    const mid = (tr(lo.value) + tr(hi.value)) / 2
    const halfWidth = (tr(hi.value) - tr(lo.value)) / 2
    const rel = (n) => ratio ? n.half / n.value : n.half
    const slack = Math.max(rel(est), rel(lo), rel(hi)) * 1.5
    const off = Math.abs(tr(est.value) - mid)
    if (!outside) {
      if (off > slack && off / halfWidth > 0.2) {
        const centered = ratio ? Math.exp(mid) : mid
        checks.push({ level: 'warn', text: f('cAsym', { v: fmt(centered, Math.max(2, (est.text.split('.')[1] || '').length)) }), note: ratio ? msg.cAsymRatioNote : msg.cAsymDiffNote })
      } else {
        checks.push({ level: 'ok', text: ratio ? msg.cSymRatio : msg.cSymDiff })
      }
    }

    // Includes/excludes the null value only if it still holds after rounding (no direction is judged
    // when an endpoint can touch the null value within its rounding range)
    const includesNull = lo.value + lo.half < nullV && hi.value - hi.half > nullV
    const excludesNull = hi.value + hi.half < nullV || lo.value - lo.half > nullV
    if (p) {
      const pLow = p.op === '>' ? p.value : p.op === '<' ? 0 : p.value - p.half
      const pHigh = p.op === '<' ? p.value : p.op === '>' ? 1 : p.value + p.half
      if ((includesNull && pHigh <= alpha) || (excludesNull && pLow >= alpha)) {
        checks.push({ level: 'bad', text: f(includesNull ? 'cNullIn' : 'cNullOut', { nv: nullText, p: p.text }), note: f(includesNull ? 'cNullInNote' : 'cNullOutNote', { level, a: String(alpha) }) })
      } else if (outside) {
        // A P value derived when the point estimate lies outside the interval is meaningless
      } else if (pHigh >= pMin && pLow <= pMax) {
        checks.push({ level: 'ok', text: f('cPOk', { p: p.text }) })
      } else {
        // "Close": the |z| values of the two P values differ by at most 0.3 (inequalities use the boundary
        // value)
        const dz = Math.abs(-normInv(p.value / 2) - Math.abs(tr(est.value) / se))
        checks.push(dz <= 0.3
          ? { level: 'na', text: f('cPNear', { p: p.text, pc: fmtP(pc) }), note: msg.cPNearNote }
          : { level: 'warn', text: f('cPOff', { p: p.text, pc: fmtP(pc) }), note: f('cPOffNote', { min: fmtP(pMin), max: fmtP(pMax) }) })
      }
    }
    const worst = checks.some((c) => c.level === 'bad') ? 'bad' : checks.some((c) => c.level === 'warn') ? 'warn' : 'ok'
    return { ratio, outside, se, z: tr(est.value) / se, p: pc, pMin, pMax, checks, worst }
  }

  function ciFromP({ type, est, p, level = 95 }, msg) {
    const ratio = type === 'ratio'
    if (!(p > 0 && p < 1)) return { error: msg.eP }
    if (ratio && est <= 0) return { error: msg.eRatio }
    const t = ratio ? Math.log(est) : est
    if (t === 0) return { error: msg.eNull }
    const se = Math.abs(t) / -normInv(p / 2)
    const z = zFor(level)
    return { se, lo: ratio ? Math.exp(t - z * se) : t - z * se, hi: ratio ? Math.exp(t + z * se) : t + z * se }
  }

  const DIFF_LABEL = /^(?:SMD|MD|RD|β|[Mm]ean difference|[Rr]isk difference|均数差|率差|差值|平均差|リスク差|평균\s*차이|위험\s*차이)$/
  const LABEL = String.raw`(?<![A-Za-z])(?:a?OR|AOR|a?HR|AHR|a?RR|ARR|IRR|PR|SMD|MD|RD|β|[Oo]dds ratio|[Hh]azard ratio|[Rr]isk ratio|[Rr]elative risk|[Rr]ate ratio|[Mm]ean difference|[Rr]isk difference|比值比|风险比|危险比|相对危险度|均数差|率差|差值|オッズ比|ハザード比|リスク比|相対リスク|平均差|リスク差|오즈비|교차비|위험비|상대\s*위험도|평균\s*차이|위험\s*차이)(?![A-Za-z])`
  // All regexes below apply to text after normText.
  const NUM = String.raw`[-–]?(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?(?!\d|,\d)|\d*\.?\d+)`
  const CIWORD = String.raw`(?<![A-Za-z])(?:CI|CrI|[Cc]onfidence\s+[Ii]nterval|[Cc]redible\s+[Ii]nterval)(?![A-Za-z])(?:\s*[\[(]\s*CI(?![A-Za-z])\s*[\])]?\s*[,:：]?)?|置信区间|可信区间|信頼区間|신뢰\s*구간`
  // Confidence interval: optionally with the level written out in full (99.75% is not truncated to
  // 75%), then the lower and upper limits
  const CI_RE = new RegExp(String.raw`(?:(?<![\d.,])(\d+(?:\.\d+)?)\s*%\s*)?(?:${CIWORD})\s*[:：=,，]?\s*[(（\[]?\s*(${NUM})\s*%?\s*(to|至|~|～|,|，|;|；|–|—|(?<=\d)--(?=\d)|(?<=\d)\s*-)\s*(${NUM})\s*%?\s*[)）\]]?`, 'g')
  const LABEL_RE = new RegExp(LABEL, 'g')
  const NUM_RE = new RegExp(NUM, 'g')
  const P_PREFIX = new RegExp(String.raw`(?<![A-Za-z])[Pp]\s*(?:-?\s*value|值|値|값)?\s*${POP}\s*`, 'g')
  const P_NUM = new RegExp(String.raw`^${PNUM}`)
  // Look for the P value only after this result and before the next effect measure or the end of
  // the sentence
  const P_STOP = new RegExp(String.raw`。|\.\s+(?=[A-Z][a-z])|${LABEL}`)

  /**
   * Find the point estimate between the measure name and the confidence interval: explicit
   * assignments like "= number" or ": number" take priority; otherwise take the first complete
   * number, skipping numbers in units (directly after a letter, / or ^, or after per / `每`) and the
   * confidence level.
   */
  function findEstimate(gap) {
    const usable = (t) => {
      const pre = gap.slice(0, t.index)
      if (pre.length > 40 || /[。;；]/.test(pre)) return false
      const post = gap.slice(t.index + t[0].length)
      if (post.length > 40 || /。/.test(post)) return false
      return !/^\s*%\s*(?:CI|CrI|[Cc]onfidence|[Cc]redible|置信|可信|信頼|신뢰)/.test(post) // Confidence level, not a point estimate
    }
    const toks = [...gap.matchAll(NUM_RE)].filter(usable)
    const assigned = toks.find((t) => /[=:：]\s*$/.test(gap.slice(0, t.index)))
    if (assigned) return assigned
    return toks.find((t) => !(t.index > 0 && /[A-Za-z\d.,/^]/.test(gap[t.index - 1])) && !/(?:\bper|每)\s*$/.test(gap.slice(0, t.index))) || null
  }

  function batchScan(raw, msg) {
    const text = normText(raw)
    const out = []
    let prevEnd = 0
    for (const m of text.matchAll(CI_RE)) {
      const winStart = Math.max(prevEnd, m.index - 120)
      const labels = [...text.slice(winStart, m.index).matchAll(LABEL_RE)]
      let label = null
      let estTok = null
      let gapStart = 0
      let li = labels.length
      while (!estTok && li-- > 0) {
        label = labels[li]
        gapStart = winStart + label.index + label[0].length
        estTok = findEstimate(text.slice(gapStart, m.index))
      }
      // The quote starts at the beginning of the joined measure name, e.g. "odds ratio (OR) 1.02",
      // "OR (aOR): 2.65"
      let quoteStart = gapStart - (label?.[0].length ?? 0)
      while (estTok && li > 0 && /^[\s([\]),，:：]{0,4}$/.test(text.slice(winStart + labels[li - 1].index + labels[li - 1][0].length, winStart + labels[li].index))) quoteStart = winStart + labels[--li].index
      const ciEnd = m.index + m[0].length
      prevEnd = ciEnd
      if (!estTok) continue
      const est = parseNum(estTok[0])
      const lo = parseNum(m[2])
      const hi = parseNum(m[4])
      if (!est || !lo || !hi) continue
      const level = m[1] == null ? 95 : Number(m[1])
      const tail = text.slice(ciEnd, ciEnd + 40)
      const stop = P_STOP.exec(tail)
      const seg = stop ? tail.slice(0, stop.index) : tail
      let p = null
      let pUnread = false
      let pEnd = ciEnd
      P_PREFIX.lastIndex = 0
      const pre = P_PREFIX.exec(seg)
      if (pre && pre.index <= 24) {
        const num = P_NUM.exec(seg.slice(pre.index + pre[0].length))
        p = num ? parseP(`${pre[1]}${num[0]}`) : null
        if (p) pEnd = ciEnd + pre.index + pre[0].length + num[0].length
        else pUnread = true
      }
      prevEnd = pEnd
      const quote = raw.slice(quoteStart, pEnd)
      // An adjacent "--" is read as a separator (e.g. 1.60--8.60); with a negative lower limit it may
      // also mean "to a negative number", so the reading is ambiguous: don't compute, ask the user to
      // check
      const r = m[3] === '--' && lo.value < 0
        ? { error: msg.eDashPair }
        : checkResult({ type: DIFF_LABEL.test(label[0]) ? 'diff' : 'ratio', est, lo, hi, level, p }, msg)
      out.push({ quote, p, pUnread, r })
    }
    return out
  }

  globalThis.MC_CIP = { checkResult, ciFromP, batchScan, parseNum, parseP, twoSidedP, normInv }
  if (typeof document === 'undefined') return

  const data = JSON.parse(document.getElementById('tool-data').textContent)
  const msg = data.msg
  const $ = (id) => document.getElementById(id)
  const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]))
  const f = (key, vars = {}) => msg[key].replace(/\{(\w+)\}/g, (_, k) => vars[k])
  const ICON = { ok: '✓', warn: '!', bad: '✕', na: '·' }

  document.querySelectorAll('.tool-tab').forEach((tab) => {
    tab.onclick = () => {
      document.querySelectorAll('.tool-tab').forEach((t) => t.setAttribute('aria-selected', String(t === tab)))
      document.querySelectorAll('[data-panel]').forEach((panel) => { panel.hidden = panel.dataset.panel !== tab.dataset.tab })
    }
  })
  const checksHtml = (checks) => `<ul class="tool-checks">${checks.map((c) => `<li class="${c.level}"><span class="i">${ICON[c.level]}</span><span>${esc(c.text)}${c.note ? `<small>${esc(c.note)}</small>` : ''}</span></li>`).join('')}</ul>`
  const stat = (k, v, s) => `<div class="tool-stat"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div><div class="s">${esc(s)}</div></div>`

  $('o-run').onclick = () => {
    const est = parseNum($('o-est').value)
    const lo = parseNum($('o-lo').value)
    const hi = parseNum($('o-hi').value)
    const out = $('o-out')
    if (!est || !lo || !hi) { out.innerHTML = `<p class="tool-err">${esc(msg.eFill)}</p>`; return }
    const pText = $('o-p').value.trim()
    const p = pText ? parseP(pText) : null
    if (pText && !p) { out.innerHTML = `<p class="tool-err">${esc(msg.ePFormat)}</p>`; return }
    const r = checkResult({ type: $('o-type').value, est, lo, hi, level: Number($('o-level').value), p }, msg)
    if (r.error) { out.innerHTML = `<p class="tool-err">${esc(r.error)}</p>`; return }
    out.innerHTML = `<div class="tool-stats">${stat(msg.sP, r.outside ? '—' : fmtP(r.p), r.outside ? msg.sPOutside : f('sPRange', { min: fmtP(r.pMin), max: fmtP(r.pMax) }))}${stat(msg.sZ, fmt(r.z, 2), r.ratio ? msg.sLog : msg.sRaw)}${stat(msg.sSE, fmt(r.se, 4), r.ratio ? msg.sLog : msg.sRaw)}</div>${checksHtml(r.checks)}`
  }
  $('o-sample').onclick = () => {
    Object.assign($('o-type'), { value: 'ratio' })
    $('o-est').value = '1.37'; $('o-lo').value = '1.05'; $('o-hi').value = '1.83'; $('o-level').value = '95'; $('o-p').value = '0.21'
    $('o-run').click()
  }

  $('b-run').onclick = () => {
    const rows = batchScan($('b-text').value, msg)
    const out = $('b-out')
    if (!rows.length) { out.innerHTML = `<p class="tool-sum">${esc(msg.bNone)}</p>`; return }
    const bad = rows.filter((x) => x.r.worst === 'bad').length
    const warn = rows.filter((x) => x.r.error || x.r.worst === 'warn').length
    out.innerHTML = `<p class="tool-sum">${esc(f('bSum', { n: rows.length, bad, warn }))}</p><div class="tool-rows">${rows.map((x) => {
      if (x.r.error) return `<div class="tool-row warn"><q>${esc(x.quote)}</q><div class="line">${esc(x.r.error)}</div></div>`
      const line = (x.r.outside ? msg.bOutside : f('bCalc', { pc: fmtP(x.r.p), min: fmtP(x.r.pMin), max: fmtP(x.r.pMax) })) + (x.p ? f('bReported', { p: x.p.text }) : x.pUnread ? msg.bPUnread : msg.bNoP)
      return `<div class="tool-row ${x.r.worst}"><q>${esc(x.quote)}</q><div class="line">${esc(line)}</div>${checksHtml(x.r.checks.filter((c) => c.level !== 'ok'))}</div>`
    }).join('')}</div>`
  }
  $('b-sample').onclick = () => { $('b-text').value = data.sample; $('b-run').click() }
  globalThis.MC_DOCX.wireFileInput({ button: $('b-open'), input: $('b-file'), target: $('b-text'), status: $('b-status'), onLoaded: () => $('b-run').click(), msg: data.file })

  $('c-run').onclick = () => {
    const est = parseNum($('c-est').value)
    const p = parseNum($('c-p').value)
    const out = $('c-out')
    if (!est || !p) { out.innerHTML = `<p class="tool-err">${esc(msg.eFillP)}</p>`; return }
    const level = Number($('c-level').value)
    const r = ciFromP({ type: $('c-type').value, est: est.value, p: p.value, level }, msg)
    if (r.error) { out.innerHTML = `<p class="tool-err">${esc(r.error)}</p>`; return }
    const digits = Math.max(2, (est.text.split('.')[1] || '').length)
    out.innerHTML = `<div class="tool-stats">${stat(f('sCI', { level }), `${fmt(r.lo, digits)} – ${fmt(r.hi, digits)}`, msg.sCISub)}${stat(msg.sSE, fmt(r.se, 4), $('c-type').value === 'ratio' ? msg.sLog : msg.sRaw)}</div><p class="tool-hint">${esc(msg.cHint)}</p>`
  }
})()
