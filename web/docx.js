// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 TIKMOON LTD
/* MediCrab free tool: reads a local Word file in the browser, with no network access or upload. */
/**
 * Read a .docx in the browser: parse the zip central directory, inflate word/document.xml with
 * DecompressionStream, then extract paragraph text. No network access, no upload.
 */
async function readDocxText(buffer, options = {}) {
  const bytes = new Uint8Array(buffer)
  const view = new DataView(buffer)
  let eocd = -1
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('not-zip')
  const count = view.getUint16(eocd + 10, true)
  let offset = view.getUint32(eocd + 16, true)
  const decoder = new TextDecoder()
  for (let n = 0; n < count; n++) {
    if (view.getUint32(offset, true) !== 0x02014b50) break
    const method = view.getUint16(offset + 10, true)
    const size = view.getUint32(offset + 20, true)
    const nameLen = view.getUint16(offset + 28, true)
    const extraLen = view.getUint16(offset + 30, true)
    const commentLen = view.getUint16(offset + 32, true)
    const local = view.getUint32(offset + 42, true)
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLen))
    offset += 46 + nameLen + extraLen + commentLen
    if (name !== 'word/document.xml') continue
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true)
    const raw = bytes.subarray(start, start + size)
    let xmlBytes
    if (method === 0) xmlBytes = raw
    else if (method === 8) xmlBytes = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer())
    else throw new Error('unsupported')
    return docxXmlToText(decoder.decode(xmlBytes), options)
  }
  throw new Error('not-docx')
}

/**
 * Strip tables (<w:tbl>…</w:tbl>, including nested tables). Used by the abbreviation checker:
 * abbreviations in tables are conventionally defined in table footnotes, so tables are not read as
 * body text.
 */
function stripDocxTables(xml) {
  let out = ''
  let depth = 0
  let last = 0
  for (const m of xml.matchAll(/<w:tbl[\s>]|<\/w:tbl>/g)) {
    if (m[0] === '</w:tbl>') {
      if (depth > 0 && --depth === 0) last = m.index + m[0].length
    } else if (depth++ === 0) {
      out += xml.slice(last, m.index)
    }
  }
  return depth > 0 ? out : out + xml.slice(last)
}

/**
 * options.skipTables: skip text inside tables (for the abbreviation checker; the P-value tool
 * needs tables, so they are read by default).
 */
function docxXmlToText(xml, options = {}) {
  const unescape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&amp;/g, '&')
  const paragraphs = []
  if (options.skipTables) xml = stripDocxTables(xml)
  for (const p of xml.matchAll(/<w:p[\s>][\s\S]*?<\/w:p>/g)) {
    let text = ''
    for (const piece of p[0].matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br(?:\s[^>]*)?\/>/g)) {
      text += piece[1] !== undefined ? unescape(piece[1]) : piece[0].startsWith('<w:tab') ? '\t' : '\n'
    }
    if (text.trim()) paragraphs.push(text)
  }
  return paragraphs.join('\n')
}

/** Pick a file or drag it in: .docx, .txt and .md are all read locally. */
async function readLocalFile(file, options = {}) {
  const name = file.name.toLowerCase()
  if (name.endsWith('.docx')) return readDocxText(await file.arrayBuffer(), options)
  if (name.endsWith('.txt') || name.endsWith('.md')) return file.text()
  if (name.endsWith('.doc')) throw new Error('old-doc')
  throw new Error('type')
}
/**
 * msg: localized messages supplied by the page (reading / loaded / oldDoc / type / notDocx /
 * unsupported / failed), with {name} replaced by the file name. skipTables: don't read tables in
 * Word files.
 */
function wireFileInput({ button, input, target, status, onLoaded, msg, skipTables = false }) {
  const say = (key, name = '') => { status.textContent = (msg[key] || msg.failed).replace('{name}', name) }
  const errorKey = { 'old-doc': 'oldDoc', type: 'type', 'not-zip': 'notDocx', 'not-docx': 'notDocx', unsupported: 'unsupported' }
  const load = async (file) => {
    if (!file) return
    say('reading', file.name)
    try {
      target.value = await readLocalFile(file, { skipTables })
      target.dispatchEvent(new Event('input'))
      say('loaded', file.name)
      onLoaded()
    } catch (error) {
      say(errorKey[error.message] || 'failed')
    }
  }
  button.onclick = () => input.click()
  input.onchange = () => { load(input.files[0]); input.value = '' }
  target.addEventListener('dragover', (e) => { e.preventDefault(); target.classList.add('drop') })
  target.addEventListener('dragleave', () => target.classList.remove('drop'))
  target.addEventListener('drop', (e) => { e.preventDefault(); target.classList.remove('drop'); load(e.dataTransfer.files[0]) })
}

globalThis.MC_DOCX = { readDocxText, docxXmlToText, readLocalFile, wireFileInput }
