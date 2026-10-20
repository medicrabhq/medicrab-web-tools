// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 TIKMOON LTD
/**
 * Core logic of the free website tool "abbreviation list builder and checker" (pure functions, shared by
 * the browser bundle and unit tests).
 *
 * Bundled by `scripts/build.mjs` into `dist/abbreviation.js`; the page calls
 * `globalThis.MC_ABBR.analyze(text, split)`. It returns data only; all wording is filled in by the page per
 * language. This file makes no network requests (model-based tidying lives in model.ts and sends
 * sentences only after the user opts in).
 *
 * The output is a list: for each abbreviation, its full term, first occurrence, first definition, count
 * and neutral marks (no full term found, used before being defined, full term written several ways...).
 * It does not judge which is right.
 * - Definition detection: English full terms use Schwartz-Hearst initial-letter alignment (all letters
 *   match, or the first letter + n-1 match); Chinese / Japanese / Korean full terms use structural
 *   constraints. Four forms are recognized: full term (ABBR), Chinese full term (English full term, ABBR),
 *   ABBR (full term), and ABBR, full term,.
 * - Columns: items with no full term in the text whose form or context looks like a proper name / ID /
 *   formula symbol go to "may not be abbreviations"; anything with a full term always stays in the list.
 * - Zones: the title (before the abstract heading) only records "also appears in the title"; table rows and
 *   figure/table captions count neither as occurrences nor as definitions; references are skipped and counted.
 */

export type Scope = 'front' | 'abstract' | 'body' | 'all'
/** Neutral marks: the page looks up text by `mark_<name>`. */
export type Mark = 'no_long' | 'defined_after_use' | 'defined_elsewhere' | 'several_longs' | 'variant' | 'case' | 'once' | 'common' | 'in_title' | 'model'
/**
 * Reasons for putting an item under "may not be abbreviations": proper name (product / gene / company),
 * ID, author initials, formula symbol; `model` = the model-based tidying judged it not an abbreviation
 * (model.ts).
 */
export type Why = 'name' | 'identifier' | 'initials' | 'formula' | 'model'

export interface Context { pre: string; hit: string; post: string }
/**
 * `para` is the paragraph number (source line number); `at` is the index of this occurrence within that
 * paragraph's text (the model-based tidying uses it to pick the containing sentence).
 */
export interface Loc { para: number; at: number; ctx: Context }

export interface ListEntry {
  abbr: string
  /** With split on, one row each for abstract and body; otherwise `all`. */
  scope: Scope
  /**
   * Full term of the first definition (for CJK manuscripts in the form "Chinese (English, ABBR)", this is the
   * English full term).
   */
  long: string | null
  /**
   * The full term was not found locally in the text but filled in after the user opted into model-based
   * tidying (already verified locally to appear verbatim in the source sentence).
   */
  longSource?: 'model'
  /** The Chinese full term in the form "Chinese full term (English full term, ABBR)". */
  longLocal?: string
  /** The different spellings of the full term when there is more than one (in order of appearance). */
  longs?: string[]
  /**
   * Has no full term of its own; the full term is taken from the abbreviation with the trailing hyphen
   * segment removed (UPSIT-R <- UPSIT).
   */
  variantOf?: string
  /** Other spellings differing only in case (HbA1c defined, later written Hba1c). */
  forms?: string[]
  firstUse: Loc
  firstDef?: Loc
  count: number
  marks: Mark[]
  section: 'list' | 'maybe_not'
  why?: Why
}

export interface AnalyzeResult {
  paragraphs: number
  abbreviations: number
  skippedReferences: number
  entries: ListEntry[]
}

interface Para { index: number; text: string; scope: Scope }

interface Definition {
  long: string
  lang: 'en' | 'local'
  /** The Chinese full term in the form "Chinese full term (English full term, ABBR)". */
  local?: string
  /**
   * For a low-confidence definition that carries an extra modifier for display, the part without the
   * modifier.
   */
  core?: string
}

interface Occurrence {
  para: Para
  at: number
  len: number
  surface: string
  def: Definition | null
  /** The context of this occurrence looks like a proper name / ID / author initials / formula. */
  suspect?: Why
}

const LOCAL = '぀-ヿ㐀-鿿가-힯' // Kana, Han characters, Hangul
const LOCAL_CHAR = new RegExp(`[${LOCAL}]`)
const HIRAGANA = /[ぁ-ゟ]/
const OPEN = '（(\\[［【'
const CLOSE = '）)\\]］】'
const SECTION_WORDS = new Set(('ABSTRACT INTRODUCTION BACKGROUND METHODS METHOD RESULTS DISCUSSION CONCLUSION CONCLUSIONS ' +
  'OBJECTIVE OBJECTIVES DESIGN SETTING SETTINGS PARTICIPANTS INTERVENTION INTERVENTIONS MAIN OUTCOMES OUTCOME MEASURES ' +
  'AND THE OF IN FOR WITH IMPORTANCE RELEVANCE KEY POINTS QUESTION FINDINGS MEANING REFERENCES TABLE FIGURE NOTE NOTES ' +
  'ACKNOWLEDGMENTS ACKNOWLEDGEMENTS FUNDING LIMITATIONS').split(' '))
const ROMAN = /^(?:I|II|III|IV|V|VI|VII|VIII|IX|X|XI|XII|XIII|XIV|XV)$/

/**
 * Abbreviations common in journals that usually need no expansion: still listed, only with a "common
 * usage" mark, and removable in one click before export. Specialty terms (eGFR, HbA1c) are not included.
 */
const COMMON = new Set(('CI OR HR RR SD SE SEM IQR ANOVA DNA RNA MRNA HIV AIDS COVID-19 SARS-COV-2 US USA UK EU WHO ' +
  'COVID PDF URL DOI PH UV ID SPSS SAS ISBN ORCID MEDLINE EMBASE PRISMA CONSORT STROBE PROSPERO AM PM ' +
  'BMI MRI CT PET ECG EKG EEG EMG CRP ESR WBC RBC HB HDL LDL TG TC IGG IGA IGM IGE PCR QPCR RT-PCR ' +
  'ELISA PBS EDTA DMSO BSA FBS ATP ADP CDNA SIRNA SHRNA SNP SNPS GWAS ICU NICU ED FDA NIH CDC ICD ICD-10 ICD-9 DSM NHS ALT AST ' +
  'GFP IV IM SC AUC ROC CNS GI NMR HPLC LC-MS FACS CRISPR EHR EMR NCI EMA MESH').split(' '))

const EN_STOP = new Set(['of', 'and', 'the', 'in', 'to', 'for', 'with', 'on', 'by', 'a', 'an', 'or', 'at', 'from', 'as', 'into', 'via', 'per',
  'de', 'du', 'des', 'la', 'le', 'les', 'et', 'da', 'do', 'dos', 'das', 'del', 'y', 'e', 'für', 'und', 'der'])
const VERBISH = /^(?:were|was|is|are|be|been|being|as|than|that|which|using|used|measured|included|including|assessed|by|with|of|and|or|the|a|an|in|on|for|to|from|at|as|its|their|our|this|these|those|serum|plasma)$/i

/** Chinese connector words. */
const CJK_CONNECTOR = /(?:以|由|的|和|与|及|在|对|受|即|为|称为|指|是|其|该|等|了|测定|检测|采用|使用|纳入|包括|评估|计算|合并|联合|患者|人群|の|を|は|が|と|に|で|や|および|における)/g
const TOKEN = /(?<![A-Za-z0-9α-ω-])[A-Za-z][A-Za-z0-9α-ω]*(?:-[A-Za-z0-9α-ω]+)*(?![A-Za-z0-9α-ω\-゠-ヿ])/g // Directly followed by katakana (`LDLコレステロール`): a compound word
const REF = /^\s*(?:\d+[.、\s]*)?(?:references?|bibliography|literature\s+cited|works\s+cited|reference\s+list|参考文献|引用文献|參考文獻|참고\s*문헌)\s*[:：]?\s*$/i
const ABS = /^\s*(?:abstract|summary|摘\s*要|要\s*旨|抄\s*録|要\s*約|초\s*록|요\s*약)(?![A-Za-z])\s*[:：]?/i
const BODY = /^\s*(?:\d+(?:\.\d+)*[.、\s]*)?(?:introduction|background|引\s*言|前\s*言|背\s*景|研究背景|緒\s*言|はじめに|序\s*論|서\s*론|배\s*경)(?![A-Za-z])\s*[:：]?/i
const GLOSSARY = /^\s*(?:abbreviations?|缩写|缩略语|缩写词|英文缩写|略語|略号|약어)\s*[:：]/i
/**
 * Table titles and figure captions: in English, the number must be followed by punctuation or a
 * capitalized title (excludes body sentences like "Figure 1 shows...").
 */
const CAPTION_EN = /^\s*(?:[Ss]upplementa(?:ry|l)\s+)?(?:Table|TABLE|Fig\.?|FIG\.?|Figure|FIGURE)\s*S?\d+[A-Za-z]?(?:\s*[.:|：．]|\s+[A-Z]|\s*$)/
const CAPTION_LOCAL = /^\s*(?:附?表|图|図|표|그림)\s*S?\d+[A-Za-z]?(?:[\s.:：．、]|$)/

const GREEK_LATIN: Record<string, string> = { α: 'a', β: 'b', γ: 'g', δ: 'd', ε: 'e', ζ: 'z', η: 'h', θ: 't', ι: 'i', κ: 'k', λ: 'l', μ: 'm', ν: 'n', ξ: 'x', ο: 'o', π: 'p', ρ: 'r', σ: 's', ς: 's', τ: 't', υ: 'u', φ: 'f', χ: 'c', ψ: 'p', ω: 'o' }
const latinize = (s: string): string => s.replace(/[α-ω]/g, (c) => GREEK_LATIN[c] ?? c)

const ELEMENTS = ('He Li Be Ne Na Mg Al Si Cl Ar Ca Sc Ti Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr Rb Sr Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te Xe Cs Ba La Ce ' +
  'Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa Np Pu Am Cm Bk Cf Es Fm Md No Lr H B C N O F P S K V Y I W U').split(' ')
const FORMULA = new RegExp(`^(?:(?:${ELEMENTS.join('|')})\\d*)+$`)
const FORMULA_EXCEPT = new Set(['PaO2', 'PaCO2', 'PvO2', 'PvCO2', 'PAO2'])
/**
 * Common software, journal and vendor names: go to "may not be abbreviations" when there is no full term
 * in the text.
 */
const NAMES = new Set(['MATLAB', 'PLINK', 'NVIDIA', 'BMJ', 'PLOS', 'JAMA', 'NEJM', 'IEEE', 'BMC'])
const COMPANY = new Set(['AG', 'GmbH', 'KG', 'LLC', 'PBC', 'SA', 'SAS', 'BV', 'NV', 'AB', 'KK', 'PLC', 'SpA', 'SRL', 'LP', 'LLP'])
const GENE = /^[A-Z]{2,6}\d{1,3}[A-Z]?$/
const COUNTRY = /\b(?:USA|U\.S\.A\.|UK|U\.K\.|United States|United Kingdom|Germany|Japan|China|Switzerland|Italy|France|Spain|Netherlands|The Netherlands|Sweden|Denmark|Canada|Australia|Korea|Belgium|Austria|Israel|India|Singapore|Ireland|Norway|Finland|Brazil|Taiwan|Rome|Tokyo|Osaka|Kyoto|Shanghai|Beijing|London|Paris|Boston|Cambridge|San Diego|Carlsbad|Waltham|Hercules|St\.? Louis|Rockford|Danvers|Darmstadt|Munich|Basel|Muttenz|Minneapolis|Burlingame|Madison|Rockville|Tewksbury|Santa Clara|Foster City|Billerica|Burlington|Woburn|Heidelberg|Mannheim|Penzberg|Zurich|Copenhagen|Stockholm|Uppsala|Leiden|Amsterdam|Seoul|Hamburg|Berlin|Milan|Madrid|Toronto|Montreal)\b|,\s*(?:AL|AZ|CA|CO|CT|FL|GA|IL|IN|MA|MD|MI|MN|MO|NC|NJ|NY|OH|OR|PA|TX|UT|VA|WA|WI)\s*(?:,|$)/
const VENDOR = /\b(?:Sigma(?:-Aldrich)?|Thermo(?: Fisher)?|Invitrogen|Qiagen|Roche|Bio-Rad|Abcam|Beckman(?: Coulter)?|Illumina|Promega|Merck|Agilent|Zeiss|Leica|Nikon|Olympus|Corning|Millipore|Takara|Novus(?:bio)?|Proteintech|GE Healthcare|PerkinElmer|Bayer|Siemens|Philips|Tosoh|Cytiva|Miltenyi|BioLegend|eBioscience|Santa Cruz|Cell Signaling|Bethyl|Jackson|Addgene|Lonza|Gibco|Eppendorf|Hamamatsu|Yokogawa|Bruker|Waters|Shimadzu|Ansys|Posit|MathWorks|StataCorp|GraphPad|SAS Institute|IBM)\b/
const UNITS = new Set(['MHz', 'kHz', 'GHz', 'THz', 'kDa', 'MBq', 'GBq', 'kPa', 'MPa', 'GPa', 'mSv', 'MeV', 'keV', 'GeV', 'mOsm', 'IU', 'mIU'])
const CATALOGUE = /#\s?\d{3,}|\b(?:cat(?:alog(?:ue)?)?\.?\s*(?:no\.?|#)|RRID)\b|\b[A-Z]{1,6}\d*-\d{3,}|\b\d{2,}-\d{3,}-\d{2,}\b|\bv\d+(?:\.\d+)*\b|\b(?:Inc|Ltd|LLC|GmbH|Corp|Co\.,?\s*Ltd|PBC|plc|Laboratories|Biotechnology|Biosciences|Scientific|Diagnostics)\b/i

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const upperCount = (s: string): number => (s.match(/[A-Z]/g) || []).length
const pluralStem = (s: string): string => (/^.+[A-Z0-9]s$/.test(s) ? s.slice(0, -1) : s)

// ---------------------------------------------------------------- Paragraphs and zones

function isHeadingLike(text: string): boolean {
  if (LOCAL_CHAR.test(text)) return false
  const letters = text.replace(/[^A-Za-z]/g, '')
  if (letters.length < 8 || text.trim().split(/\s+/).length < 3) return false
  return letters.replace(/[^A-Z]/g, '').length / letters.length > 0.8
}

/** A reference entry shaped like "number/authors. Title. Journal year;volume:pages". */
function looksLikeReference(t: string): boolean {
  if (t.length > 600 || !/\b(?:1[89]|20)\d{2}[a-z]?\b/.test(t)) return false
  const locator = /\d+\s*\(\s*[\dS-]+\s*\)\s*:\s*[e\d]|;\s*\d+\s*(?:\([^)]*\))?\s*:\s*[eE]?\d|\bdoi\b|10\.\d{4,}\/|\d+\s*:\s*\d+\s*[-–]\s*\d+/i.test(t)
  const lead = /^\s*(?:\[\d+\]|\d+[.)]?\s|[A-Z][A-Za-z'’-]+,?\s+(?:[A-Z]{1,3}\b|[A-Z]\.))/.test(t)
  return locator && lead
}

function isTableLine(text: string): boolean {
  return (text.match(/\t/g) || []).length >= 2 || CAPTION_EN.test(text) || CAPTION_LOCAL.test(text)
}

export function scopeParagraphs(raw: string, split: boolean): { paragraphs: Para[]; skippedReferences: number } {
  const lines = raw.replace(/\r\n?/g, '\n').replace(/[‐‑]/g, '-')
    .replace(/\\begin\{document\}[\s\S]*?\\end\{document\}|\$\$[^$]*\$\$/g, (m) => ' '.repeat(m.length)) // Letters inside formulas (LaTeX) are not abbreviations
    .split(/\n+/).map((t) => t.trim()).filter(Boolean)
  let end = lines.length
  let skippedReferences = 0
  const heading = lines.findIndex((t) => REF.test(t))
  if (heading >= 0) {
    end = heading
    skippedReferences = lines.length - heading - 1
  } else {
    for (let i = 3; i + 2 < lines.length; i++) {
      if (looksLikeReference(lines[i]!) && looksLikeReference(lines[i + 1]!) && looksLikeReference(lines[i + 2]!)) {
        end = i
        skippedReferences = lines.length - i
        break
      }
    }
  }
  const abstractAt = lines.slice(0, Math.min(end, 15)).findIndex((t) => ABS.test(t))
  const out: Para[] = []
  let scope: Scope = 'all'
  for (let i = 0; i < end; i++) {
    const text = lines[i]!
    const front = abstractAt > 0 && i < abstractAt
    if (split && scope === 'all' && ABS.test(text)) scope = 'abstract'
    if (split && scope === 'abstract' && BODY.test(text) && text.length < 60) scope = 'body'
    if (GLOSSARY.test(text) || isHeadingLike(text) || isTableLine(text)) continue
    out.push({ index: i + 1, text, scope: front ? 'front' : scope })
  }
  if (!out.some((p) => p.scope === 'body')) for (const p of out) if (p.scope !== 'front') p.scope = 'all'
  return { paragraphs: out, skippedReferences }
}

// ---------------------------------------------------------------- Definition detection

/**
 * Characters of the short form that take part in alignment: Greek letters map to Latin, plural s is
 * dropped; digits absent from the long form are not required.
 */
function alignChars(abbr: string, long: string): string {
  const chars = latinize(pluralStem(abbr)).toLowerCase().replace(/[^a-z0-9]/g, '')
  return [...chars].filter((c) => !/\d/.test(c) || long.includes(c)).join('')
}

/**
 * Longest common subsequence length: how many abbreviation letters land, in order, on word starts of the
 * full term.
 */
function lcs(a: string, b: string): number {
  const row = new Array<number>(b.length + 1).fill(0)
  for (let i = 1; i <= a.length; i++) {
    let prev = 0
    for (let j = 1; j <= b.length; j++) {
      const keep = row[j]!
      row[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(row[j]!, row[j - 1]!)
      prev = keep
    }
  }
  return row[b.length]!
}

function shStart(short: string, long: string): { start: number; positions: number[] } | null {
  let s = short.length - 1
  let l = long.length - 1
  const positions: number[] = []
  while (s >= 0) {
    const c = short[s]!
    while (l >= 0 && (long[l] !== c || (s === 0 && l > 0 && /[a-z0-9]/.test(long[l - 1]!)))) l--
    if (l < 0) return null
    positions.unshift(l)
    l--
    s--
  }
  return { start: long.lastIndexOf(' ', positions[0]!) + 1, positions }
}

/**
 * The content word right after the first word of the full term must use an abbreviation letter (excludes
 * "complicated by suboptimal positive airway pressure (CPAP)");
 * if the other words are capitalized but the first word is lowercase, the first word is most likely
 * preceding text ("published Associated Risk Syndrome (PARS)").
 */
function plausibleStart(long: string, short: string): boolean {
  const content = long.split(/[\s/-]+/).filter((w) => w && !EN_STOP.has(w.toLowerCase())).map((text) => ({ text }))
  if (content.length >= 3 && /^[a-z]/.test(content[0]!.text) && content.slice(1).every((w) => /^[A-Z]/.test(w.text))) return false
  if (content.length < 2) return true
  const rest = new Set([...short].slice(1))
  return rest.has(latinize(content[1]!.text[0]!).toLowerCase())
}

/**
 * Find the full term in the preceding English text: returns high confidence (all letters match) or low
 * confidence (first letter + n-1 uppercase letters match).
 */
function alignEnglish(candidate: string, abbr: string, opts: { anchorStart?: boolean; strictOnly?: boolean } = {}): Definition | null {
  const words = candidate.trim().split(/\s+/).filter(Boolean)
  if (!words.length) return null
  const letters = latinize(pluralStem(abbr)).replace(/[^A-Za-z0-9]/g, '').length
  // Schwartz-Hearst length limit min(|A|+5, 2|A|), counting content words only
  // (area under the receiver operating characteristic curve (AUC))
  const maxWords = Math.min(letters + 5, letters * 2)
  const order = opts.anchorStart ? words.keys() : [...words.keys()].reverse()
  let take = 0
  let contentSeen = 0
  for (const i of order) {
    if (!EN_STOP.has(words[i]!.toLowerCase())) contentSeen++
    if (contentSeen > maxWords) break
    take++
  }
  const window = opts.anchorStart ? words.slice(0, take) : words.slice(words.length - take)
  const original = window.join(' ')
  const lower = latinize(original).toLowerCase()
  const abbrWord = new RegExp(`(?:^|[^A-Za-z0-9])${escapeRegExp(abbr)}(?![A-Za-z0-9])`)
  const base = pluralStem(abbr).split(/[-\s]/)[0]!
  const abbrDigits = new Set(abbr.match(/\d/g) || [])
  // The full term must not contain the abbreviation itself (pwPMS, WHRadjBMI, NEBNext), digits the
  // abbreviation lacks (UPSIT from 1984), or symbols like -, +, =
  const valid = (long: string): boolean => long.replace(/[^A-Za-z]/g, '').length > abbr.replace(/[^A-Za-z]/g, '').length && !abbrWord.test(long)
    && !long.includes(base) && ![...(long.match(/\d/g) || [])].some((d) => !abbrDigits.has(d)) && /^[A-Za-z0-9\u00c0-\u024fα-ω\s'’,:/–-]+$/.test(long) && !/:\s*$/.test(long)
    && !EN_STOP.has((long.split(/\s+/)[0] || '').toLowerCase())
  const short = alignChars(abbr, lower)
  if (short) {
    const hit = shStart(short, lower)
    if (hit && (!opts.anchorStart || hit.start === 0)) {
      let long = original.slice(hit.start)
      const letterSeq = [...short].filter((c) => /[a-z]/.test(c)).join('')
      const initialsOf = (v: string): string => latinize(v).toLowerCase().split(/[\s/-]+/).filter((w) => w && !EN_STOP.has(w)).map((w) => w[0]).join('')
      // When the first letter lands mid-word (the a in Academy), if going back one or two words puts every
      // letter on a word start, take the longer one (American Academy of Sleep Medicine)
      if (!opts.anchorStart && initialsOf(long) !== letterSeq) {
        const before = original.slice(0, hit.start).trim().split(/\s+/).filter(Boolean)
        for (let j = 1; j <= Math.min(2, before.length); j++) {
          const wider = `${before.slice(-j).join(' ')} ${long}`
          if (initialsOf(wider) === letterSeq && valid(wider)) { long = wider; break }
        }
      }
      // For full terms of three or more content words, at least half the letters must land on word starts
      // (excludes chance matches like "association between ... outcomes (AUROC)")
      const content = long.split(/\s+/).filter((w) => !EN_STOP.has(w.toLowerCase())).length
      const initials = initialsOf(long)
      if (valid(long) && (content < 3 || lcs(letterSeq, initials) >= Math.ceil(letterSeq.length / 2)) && plausibleStart(long, short)) return { long, lang: 'en' }
    }
  }
  if (opts.strictOnly) return null
  // Low confidence: the first letter matches a word start, and the remaining uppercase letters (and digits
  // present in the long form) match in order, at least n-1 of them. The window counts all words (the
  // standard Schwartz-Hearst limit, not relaxed)
  const narrow = opts.anchorStart ? words.slice(0, maxWords) : words.slice(-maxWords)
  return relaxedAlign(narrow, abbr, valid, opts.anchorStart)
}

function relaxedAlign(window: string[], abbr: string, valid: (long: string) => boolean, anchorStart?: boolean): Definition | null {
  const lower = latinize(window.join(' ')).toLowerCase()
  const stem = latinize(pluralStem(abbr))
  const first = stem.replace(/[^A-Za-z0-9]/g, '')[0]?.toLowerCase()
  if (!first) return null
  const req = [first, ...[...stem.slice(1)].filter((c) => /[A-Z]/.test(c) || (/\d/.test(c) && lower.includes(c))).map((c) => c.toLowerCase())]
  const nonAcronym = /[a-z]/.test(stem.slice(1)) || /\d/.test(stem)
  const need = req.length <= 2 && !nonAcronym ? req.length : Math.max(1, req.length - 1)
  const lw = lower.split(' ')
  const range = anchorStart ? [0] : [...lw.keys()].reverse()
  for (const k of range) {
    const w = lw[k]!
    if (!w || w[0] !== first || EN_STOP.has(w) || VERBISH.test(w)) continue
    const rest = lw.slice(k).join(' ')
    let matched = 1
    let pos = 1
    for (const c of req.slice(1)) {
      const idx = rest.indexOf(c, pos)
      if (idx >= 0) { matched++; pos = idx + 1 }
    }
    const span = window.slice(k)
    const content = span.filter((w) => !EN_STOP.has(w.toLowerCase()))
    // An all-caps word itself matches several letters (WHR adjusted for BMI (WHRadjBMI), circulating DNA
    // (cfDNA))
    const covered = content.reduce((n, w) => n + (/^[A-Z0-9]{2,}$/.test(w) ? w.length : 1), 0)
    const titleTail = content.length >= 3 && /^[a-z]/.test(content[0]!) && content.slice(1).every((w) => /^[A-Z]/.test(w))
    if (!titleTail && matched >= need && covered >= need && span.every((w) => /^[A-Za-z][A-Za-z'’-]*$/.test(w)) && !span.every((w) => /^[A-Z0-9-]+$/.test(w))
      && (!anchorStart || content.length >= 2)) {
      let from = k
      // Non-initialism abbreviations (HbA1c) often carry a modifier: glycated hemoglobin (HbA1c). Affects only
      // the displayed full term.
      if (nonAcronym && from > 0 && !VERBISH.test(window[from - 1]!) && /^[A-Za-z-]+$/.test(window[from - 1]!)) from--
      const long = window.slice(from).join(' ')
      if (valid(long)) return { long, lang: 'en', core: from === k ? undefined : span.join(' ') }
    }
  }
  return null
}

/**
 * Strip preceding text from the full term: take the part after the last connector word that still has >= 3
 * characters (a connector character inside a word, e.g. in `和体重指数`, is not a break point).
 */
function stripConnector(segment: string, keepShort: boolean): string {
  const ends = [...segment.matchAll(CJK_CONNECTOR)].map((m) => m.index! + m[0].length).reverse()
  for (const end of ends) {
    const rest = segment.slice(end).trim()
    if (rest.replace(/\s/g, '').length >= 3) return rest
  }
  const last = ends[0] === undefined ? segment : segment.slice(ends[0]).trim()
  return last.replace(/\s/g, '').length >= 2 || keepShort ? last : segment.trim()
}

function localExpansion(before: string): string {
  const run = (before.match(new RegExp(`[0-9A-Za-z${LOCAL}][${LOCAL}0-9A-Za-z\\-–/\\s]{0,29}$`)) || [''])[0].trim()
  if (!run) return ''
  if (/[가-힯]/.test(run)) {
    // Korean: walk back word by word, stopping at a word carrying a particle (`연구는`, `병용이`, `및`)
    const words = run.split(/\s+/)
    const kept: string[] = []
    for (let i = words.length - 1; i >= 0 && kept.length < 5; i--) {
      if (kept.length && (words[i] === '및' || /(?:은|는|이|가|을|를|의|에|에서|와|과|로|으로)$/.test(words[i]!))) break
      kept.unshift(words[i]!)
    }
    return kept.join(' ')
  }
  if (HIRAGANA.test(run)) {
    // Japanese terms are mostly kanji / katakana, while hiragana is mostly particles: take the part after the
    // last hiragana
    const tail = run.slice(run.search(/[ぁ-ゟ][^ぁ-ゟ]*$/) + 1).trim()
    if (tail.replace(new RegExp(`[^A-Za-z${LOCAL}]`, 'g'), '').length >= 2) return tail
  }
  const parts = run.replace(/–/g, '-').split('-')
  parts[0] = stripConnector(parts[0]!, parts.length > 1)
  return parts.join('-').trim()
}

/**
 * "ABBR (Chinese full term)": at least 3 characters, no digits and no pointer words such as "see / see
 * details / appendix / table / figure", and not ending with a connector word.
 */
function validLocalLong(content: string): boolean {
  const c = content.trim()
  if ((c.match(new RegExp(`[${LOCAL}]`, 'g')) || []).length < 3) return false
  if (/[0-9=%<>≤≥±]/.test(c)) return false
  if (/见|見|参照|参见|參見|詳細は|详细|附表|附图|附录|付録|^[表图図]|[表图図]\s*S?\d|부록|참조|그림\s*\d|표\s*\d/.test(c)) return false
  return !/(?:的|和|与|及|或|等|の|と|や|및)$/.test(c)
}

/** An abbreviation in parentheses may be preceded by a confidence level: 95% confidence intervals (95% CIs). */
const BRACKET_OPEN = new RegExp(`[${OPEN}]\\s*(?:\\d{2}(?:\\.\\d)?\\s?%\\s*)?$`)
const AFTER_CLOSE = new RegExp(`^\\s*(?:[,，;；][^${CLOSE}]{0,40})?[${CLOSE}]`)
/**
 * "full term (ABBR approval number: ...)", "full term (FPFV, anticipated date of ...)": the parentheses
 * contain other text too, so only high-confidence alignment is accepted.
 */
const AFTER_LONG = new RegExp(`^(?:\\s*[,，;；:：]|\\s+)[^${OPEN}${CLOSE}]{1,160}[${CLOSE}]`)
const MULTI_TOKEN = /^[A-Za-z][A-Za-z0-9α-ω-]*(?:\s+[A-Za-z][A-Za-z0-9α-ω-]*){1,2}$/
const IN_PAREN_SEP = new RegExp(`[${OPEN}]["“‘]?([^${OPEN}${CLOSE}]{2,160}?)\\s*[,，;；:：]["”’]?\\s*$`)
const CLOSE_NEXT = new RegExp(`^\\s*[${CLOSE}]`)
const REVERSE = new RegExp(`^\\s*[${OPEN}]([^${OPEN}${CLOSE}]{2,100})[${CLOSE}]`)
const APPOSITIVE = /^\s*[,，]\s*([A-Za-z][^,，.;；:：()（）[\]]{3,120}?)\s*[,，]/

/**
 * "Medical Sciences Interdivisional Research Ethics Committee (MS IDREC)": split the full term by letter
 * alignment and return the segment for the index-th abbreviation.
 */
function splitLong(long: string, tokens: string[], index: number): string {
  const lower = latinize(long).toLowerCase()
  const chars = tokens.map((t) => alignChars(t, lower))
  const hit = shStart(chars.join(''), lower)
  if (!hit) return long
  const starts = chars.map((_, i) => {
    const offset = chars.slice(0, i).join('').length
    return i === 0 ? 0 : lower.lastIndexOf(' ', hit.positions[offset]!) + 1
  })
  if (starts.some((x, i) => i > 0 && x <= starts[i - 1]!)) return long
  const part = long.slice(starts[index] ?? 0, starts[index + 1] ?? long.length).trim()
  return part || long
}

/** Whether this occurrence is a definition. */
function findDefinition(text: string, at: number, surface: string): Definition | null {
  const before = text.slice(0, at)
  const after = text.slice(at + surface.length)
  // 0. full term (GLP-1 RAs): two or three abbreviations written together in the parentheses, aligned as one
  const multiOpen = before.match(new RegExp(`[${OPEN}]([^${OPEN}${CLOSE}]{0,40})$`))
  const multiClose = after.match(new RegExp(`^([^${OPEN}${CLOSE}]{0,40})[${CLOSE}]`))
  if (multiOpen && multiClose) {
    const content = `${multiOpen[1]}${surface}${multiClose[1]}`.trim()
    const tokens = content.split(/\s+/)
    if (MULTI_TOKEN.test(content) && tokens.every((t) => isAbbreviation(pluralStem(t)))) {
      const head = before.slice(0, before.length - multiOpen[0].length).replace(/\s+$/, '')
      const segment = head.split(/[.;:!?()[\]{},，；：。！？、（）"“”]/).pop() || ''
      const def = alignEnglish(segment, content, { strictOnly: true })
      if (def) return { ...def, long: splitLong(def.long, tokens, multiOpen[1]!.trim() ? multiOpen[1]!.trim().split(/\s+/).length : 0) }
      if (multiOpen[1]!.trim()) return null
    }
  }
  // 1. full term (ABBR), full term [ABBR]
  const open = before.match(BRACKET_OPEN)
  const shortTail = !!open && AFTER_CLOSE.test(after)
  const inside = open ? (after.match(new RegExp(`^[^${CLOSE}]*`)) || [''])[0] : ''
  // (aHR, 0.82; 95% CI...), (HR 1.2): statistic parentheses; (CST, #2038, rabbit): vendor parentheses.
  // Neither is a definition
  if (open && (/^[\s,，;；:：=]*[<>=≤≥~]?\s*[-−]?\d/.test(inside) || COUNTRY.test(inside) || CATALOGUE.test(inside) || VENDOR.test(inside))) return null
  // (IABP, Impella, VA-ECMO, or temporary VAD): a coordinated list in parentheses, not a definition; only
  // high-confidence alignment is accepted
  const listed = !!open && /^\s*[,，;；]/.test(inside) && /[,，、]|\b(?:or|and)\b/.test(inside.replace(/^\s*[,，;；]/, ''))
  if (open && (shortTail || AFTER_LONG.test(after))) {
    const head = before.slice(0, before.length - open[0].length).replace(/\s+$/, '')
    const tail = (head.match(/\S+$/) || [''])[0]
    if (LOCAL_CHAR.test(tail) && shortTail) {
      const local = localExpansion(head)
      if (local.replace(new RegExp(`[^A-Za-z${LOCAL}]`, 'g'), '').length >= 2) return { long: local, lang: 'local' }
      return null
    }
    const segment = head.split(/[.;:!?()[\]{},，；：。！？、（）"“”]/).pop() || ''
    const def = alignEnglish(segment, surface, { strictOnly: !shortTail || listed })
      // Full term containing a colon: Standard Protocol Items: Recommendations for Interventional Trials (SPIRIT)
      ?? alignEnglish(head.split(/[.;!?()[\]{},，；。！？、（）"“”]/).pop() || '', surface, { strictOnly: true })
    if (def || shortTail) return def
  }
  // 2. Chinese full term (English full term, ABBR), (single nucleotide polymorphisms; SNPs),
  // Japanese term (English: ABBR)
  const inner = before.match(IN_PAREN_SEP)
  if (inner && CLOSE_NEXT.test(after)) {
    const content = inner[1]!
    const head = before.slice(0, inner.index).replace(/\s+$/, '')
    const local = LOCAL_CHAR.test((head.match(/\S+$/) || [''])[0]) ? localExpansion(head) : ''
    const english = (content.match(/[A-Za-z][A-Za-z0-9α-ω\s'’-]*$/) || [''])[0]
    if (english && !LOCAL_CHAR.test(english)) {
      const def = alignEnglish(english, surface)
      if (def) return { ...def, local: local || undefined }
    }
    if (!/[A-Za-z]/.test(content) && validLocalLong(content)) return { long: content.trim(), lang: 'local' }
  }
  // 3. ABBR (full term), ABBR [full term]
  const rev = after.match(REVERSE)
  if (rev) {
    const content = rev[1]!.trim()
    if (LOCAL_CHAR.test(content)) {
      if (validLocalLong(content)) return { long: content, lang: 'local' }
    } else if (!/[0-9=%<>≤≥±]/.test(content)) {
      const def = alignEnglish(content.replace(/^the\s+/i, ''), surface, { anchorStart: true })
      if (def) return def
    }
  }
  // 4. ABBR, full term, (appositive; high confidence only)
  const app = after.match(APPOSITIVE)
  if (app) {
    const def = alignEnglish(app[1]!, surface, { anchorStart: true, strictOnly: true })
    if (def && def.long.trim() === app[1]!.trim()) return def
  }
  return null
}

// ---------------------------------------------------------------- Candidate filtering

function isAbbreviation(token: string): boolean {
  if (token.length < 2 || token.length > 12) return false
  if (upperCount(token) < 2) return false
  if (ROMAN.test(token) || SECTION_WORDS.has(token)) return false
  if (/^[A-Z][a-z]+[A-Z][a-z]{2,}$/.test(token)) return false // McDonald, PubMed
  if (/[a-z]/.test(token) && EN_STOP.has(token.toLowerCase())) return false // fOR, written to spell out an acronym in a title
  return true
}

/**
 * In a hyphenated compound, a long segment with only one uppercase letter (based, anti, Bland) is a
 * modifier.
 */
const isModifier = (seg: string): boolean => /^(?:[A-Z][a-z]{2,}|[a-z]{3,})$/.test(seg)
const isPart = (seg: string): boolean => (seg.match(/[A-Za-z]/g) || []).length >= 2

/**
 * Supplementary figure/table numbers and ranges (S1G, S2-S6, S13A-B, I1-I7) and stages with letters (IVa):
 * never abbreviations, with or without parentheses.
 */
function isPanelOrRange(token: string): boolean {
  if (/^S\d{1,2}[A-Z]$/.test(token)) return true
  if (/^(?:I|II|III|IV|V|VI)[a-c]$/.test(token)) return true
  const segs = token.split('-')
  return segs.length >= 2 && segs.every((x) => /^[A-Z]?\d+[A-Z]?$/.test(x) || /^[A-Z]$/.test(x)) && /\d/.test(token)
}

/**
 * Clearly not abbreviations by form: mutations, restriction enzymes, chemical formulas, catalog numbers,
 * supplementary figure numbers, mixed-case product names.
 */
function excludedByShape(token: string): boolean {
  if (/^[A-Z]\d{2,4}[A-Z]$/.test(token)) return true // S328A, L119D
  if (/^[A-Z][a-z]{2}[A-Z]?I{1,3}$/.test(token)) return true // DpnI, EcoRI
  if (!FORMULA_EXCEPT.has(token) && FORMULA.test(token) && (/\d/.test(token) || /[A-Z][a-z]/.test(token))) return true // CO2, NaOH, HCl
  if (/\d{4,}/.test(token)) return true // A300-028A
  if (isPanelOrRange(token)) return true
  if (UNITS.has(token)) return true
  for (const seg of token.split('-')) {
    // XBridge, GTPase, MegaPRS: a segment with uppercase letters that has >= 3 consecutive lowercase letters;
    // a leading pro (proBNP) does not count
    const body = seg.replace(/^pro(?=[A-Z])/, '')
    if (upperCount(seg) >= 1 && /[a-z]{3,}/.test(body) && !isModifier(seg)) return true
  }
  return false
}

interface Candidate {
  key: string
  offset: number
  len: number
  parts?: string[]
  /**
   * Looks like a mutation, chemical formula, catalog number or mixed-case product name: goes to "may not be
   * abbreviations" when there is no full term.
   */
  shape?: Why
}

// ---------------------------------------------------------------- Main flow

export function contextOf(text: string, at: number, len: number): Context {
  const s = Math.max(0, at - 28)
  const e = Math.min(text.length, at + len + 40)
  return { pre: (s > 0 ? '…' : '') + text.slice(s, at), hit: text.slice(at, at + len), post: text.slice(at + len, e) + (e < text.length ? '…' : '') }
}

const locOf = (o: Occurrence): Loc => ({ para: o.para.index, at: o.at, ctx: contextOf(o.para.text, o.at, o.len) })
const normalizeEnglish = (value: string): string => latinize(value).toLowerCase().replace(/['’]s\b/g, '').split(/[\s\-–‐]+/).map((w) => w.replace(/['’]/g, '').replace(/s$/, '')).join('')
/**
 * CJK full terms are normalized only for spelling differences (whitespace, hyphens, interpuncts, quotes and
 * similar punctuation); one extra content character counts as another spelling.
 */
const normalizeLocal = (value: string): string => value.replace(/[\s\-–‐·・‧、，,.。'"‘’“”「」]/g, '')

/**
 * Deduplicate full terms given in different places (normalizing whitespace, case, hyphens, plurals); only
 * more than one spelling within the same language counts as "full term written several ways".
 */
function distinctLongs(defs: Definition[]): string[] | null {
  const en: { key: string; core?: string; long: string }[] = []
  const local: string[] = []
  for (const d of defs) {
    if (d.lang === 'en') {
      const key = normalizeEnglish(d.long)
      const core = d.core ? normalizeEnglish(d.core) : undefined
      if (!en.some((x) => x.key === key || x.key === core || (x.core && (x.core === key || x.core === core)))) en.push({ key, core, long: d.long })
    }
    const lo = d.lang === 'local' ? d.long : d.local
    if (lo && !local.some((x) => normalizeLocal(x) === normalizeLocal(lo))) local.push(lo)
  }
  if (en.length > 1) return en.map((x) => x.long)
  if (local.length > 1) return local
  return null
}

/**
 * Author contribution and acknowledgment sentences: uppercase strings in them are most likely name
 * initials (DGH, P-YN).
 */
const AUTHOR_LINE = /\b(?:author\s+contributions?|contributed|conceived|conceptuali[sz]ation|conceptuali[sz]ed|designed the|wrote the|drafted|supervised the|critically revised|edited the manuscript|approved the final)\b/i
const INITIALS = /^[A-Z]{2,4}$|^[A-Z]{1,2}-[A-Z]{1,3}$/
/** Creative Commons licenses (CC BY, CC BY-NC-ND 4.0). */
const LICENSE = /\bCC[ -]?(?:BY|0)(?:[- ](?:NC|ND|SA))*(?:\s*\d\.\d)?\b/g

export function analyze(raw: string, split: boolean): AnalyzeResult {
  const { paragraphs, skippedReferences } = scopeParagraphs(raw, split)
  const fullText = paragraphs.map((p) => p.text).join('\n')
  const lowerWords = new Set(fullText.match(/(?<![A-Za-z])[a-z]+(?![A-Za-z])/g) || [])
  // The ordinary capitalized form (Cullin) also counts: CULLIN is just the same word in all caps
  for (const w of fullText.match(/(?<![A-Za-z])[A-Z][a-z]{3,}(?![A-Za-z])/g) || []) lowerWords.add(w.toLowerCase())
  /** The lowercase ordinary word appears in the text (including -s / -ed / -ing forms): INCLUDE <-> included. */
  const wordInText = (w: string): boolean => {
    const x = w.toLowerCase()
    const stem = x.replace(/(?:ed|es|s|ing)$/, '')
    return [x, `${x}s`, `${x}es`, `${x}d`, `${x}ed`, `${x}ing`, x.replace(/e$/, 'ing'), ...(stem.length >= 4 ? [stem] : [])].some((v) => lowerWords.has(v))
  }
  const citationStyle = (fullText.match(/[a-z]\d{1,3}(?:[,–-]\d{1,3})*(?![\dA-Za-z.])/g) || []).length >= 3

  // 1. Occurrences and definitions of all word forms
  const raws: Occurrence[] = []
  for (const para of paragraphs) {
    for (const m of para.text.matchAll(TOKEN)) {
      const surface = m[0]
      if (upperCount(surface) < 1 && !/-/.test(surface)) continue
      // Roman-numeral-shaped ones (IVs) also get a definition lookup: instrumental variables (IVs)
      const shaped = (isAbbreviation(pluralStem(surface)) || ROMAN.test(pluralStem(surface))) && !isPanelOrRange(surface)
      const def = shaped && para.scope !== 'front' ? findDefinition(para.text, m.index!, surface) : null
      raws.push({ para, at: m.index!, len: surface.length, surface, def })
    }
  }
  const defined = new Set<string>()
  for (const o of raws) if (o.def) { defined.add(o.surface); defined.add(pluralStem(o.surface)) }
  const surfaceCount = new Map<string, number>()
  for (const o of raws) surfaceCount.set(o.surface, (surfaceCount.get(o.surface) || 0) + 1)
  const standalone = new Set(raws.map((o) => o.surface))
  const isKnown = (s: string): boolean => defined.has(s) || defined.has(pluralStem(s)) || COMMON.has(s.toUpperCase())

  // 2. Assign each occurrence to an abbreviation (or to none)
  function resolve(surface: string): Candidate | null {
    if (defined.has(surface)) return { key: pluralStem(surface), offset: 0, len: surface.length }
    let key = surface
    let offset = 0
    let parts: string[] | undefined
    if (surface.includes('-')) {
      const segs = surface.split('-')
      const runs: { text: string; offset: number }[] = []
      let pos = 0
      let current: { text: string; offset: number } | null = null
      for (const seg of segs) {
        if (isModifier(seg)) { if (current) runs.push(current); current = null } else if (current) current.text += `-${seg}`
        else current = { text: seg, offset: pos }
        pos += seg.length + 1
      }
      if (current) runs.push(current)
      if (!runs.length) return null // Bland-Altman, Cole-Palmer
      if (runs.length === 1) { key = runs[0]!.text; offset = runs[0]!.offset } else parts = runs.map((r) => r.text)
      if (!parts) {
        const inner = key.split('-').filter(isPart)
        if (inner.length >= 2) parts = inner
      }
    }
    if (defined.has(key)) return { key: pluralStem(key), offset, len: key.length }
    const len = key.length
    key = pluralStem(key)
    if (citationStyle) {
      const m = key.match(/^(.*[A-Za-z])(\d{1,3})$/)
      if (m && standalone.has(m[1]!) && isKnown(m[1]!) && isAbbreviation(m[1]!)) return { key: m[1]!, offset, len: m[1]!.length }
    }
    // In manuscripts that do not use superscript citations, an item that appears only once and becomes an
    // already-defined abbreviation after dropping trailing digits (EEG31 = EEG + superscript 31): not listed
    const glued = key.match(/^(.*[A-Za-z])(\d{1,3})$/)
    if (!citationStyle && glued && defined.has(glued[1]!) && (surfaceCount.get(surface) || 0) === 1) return null
    if (defined.has(key)) return { key, offset, len }
    if (!isAbbreviation(key) || UNITS.has(key) || isPanelOrRange(key)) return null
    if (excludedByShape(key)) return { key, offset, len, shape: /\d{4,}/.test(key) ? 'identifier' : 'name' }
    if (parts) {
      const open = parts.filter((p) => !isKnown(p) && !excludedByShape(p))
      if (!open.length) return null // GFP-VPS26C: both segments are defined or common
      return { key, offset, len, parts: open }
    }
    return { key, offset, len }
  }

  interface Group { occ: Occurrence[]; front: Occurrence[]; flags: Set<string>; supplier: number; parts?: string[]; shape?: Why }
  const entries = new Map<string, Group>()
  const entry = (key: string): Group => {
    let e = entries.get(key)
    if (!e) { e = { occ: [], front: [], flags: new Set(), supplier: 0 }; entries.set(key, e) }
    return e
  }

  // Parenthesis classification: vendor parentheses (country / city, company suffix, catalog number, version)
  // and author-initials parentheses
  const parenSpans = new Map<Para, { start: number; end: number; supplier: boolean; authors: boolean }[]>()
  const licenseSpans = new Map<Para, [number, number][]>()
  for (const para of paragraphs) {
    const spans: { start: number; end: number; supplier: boolean; authors: boolean }[] = []
    for (const m of para.text.matchAll(/[（(]([^()（）]{2,200})[)）]/g)) {
      const content = m[1]!
      const supplier = COUNTRY.test(content) || CATALOGUE.test(content) || VENDOR.test(content)
      // (JS and MK), (DGH and P-YN): two or three name initials side by side, each appearing only this once
      const initials = '[A-Z]{1,3}(?:-[A-Z]{1,3})?'
      const authorMatch = content.match(new RegExp(`^\\s*${initials}(?:\\s*(?:,|and|&|、)\\s*${initials}){1,2}\\s*$`))
      const authors = !!authorMatch && (content.match(/[A-Z]+(?:-[A-Z]+)?/g) || []).every((t) => t.replace('-', '').length >= 2 && (surfaceCount.get(t) || 0) <= 1)
      spans.push({ start: m.index!, end: m.index! + m[0].length, supplier, authors })
    }
    parenSpans.set(para, spans)
    licenseSpans.set(para, [...para.text.matchAll(LICENSE)].map((m) => [m.index!, m.index! + m[0].length]))
  }

  for (const o of raws) {
    const c = resolve(o.surface)
    if (!c) continue
    const text = o.para.text
    const spans = parenSpans.get(o.para) || []
    const inside = spans.find((s) => o.at > s.start && o.at < s.end)
    const afterText = text.slice(o.at + o.len)
    const beforeText = text.slice(0, o.at)
    let suspect: Why | undefined = c.shape
    if (!o.def) {
      const chunk = (beforeText.match(/\S*$/) || [''])[0] + o.surface + (afterText.match(/^\S*/) || [''])[0]
      if (inside?.authors || (AUTHOR_LINE.test(text) && INITIALS.test(c.key) && !COMMON.has(c.key))) suspect = 'initials'
      // Ethics approval and grant numbers (11/NW/0382, EEBK/EΠ/2022/32) and licenses (CC BY)
      else if ((/\d\/$/.test(beforeText) && /^\/\d/.test(afterText)) || (/\/.*\//.test(chunk) && /\d/.test(chunk))
        || (licenseSpans.get(o.para) || []).some(([s, t]) => o.at >= s && o.at < t)) suspect = 'identifier'
      // Letter strings inside formulas (covY1,Y2=EY1Y2, (XTX)-1, detY~TY~) and IDs (NP_001180200)
      // HR=1.25, SD = 4.1 are values, not formulas
      else if (/[=∑∏^~−×…_]$/.test(beforeText) || /^[∑∏^~−×_]/.test(afterText) || /^=(?!\s*[-−<>≤≥]?\s*\d)/.test(afterText) || /^\)[−^~]/.test(afterText) || /…\s*,\s*$/.test(beforeText)
        || /^(?:[A-Z][ijkmnt])+$/.test(c.key) // YiYj: a variable whose subscripts were flattened
        || (/^N[A-Z]$/.test(c.key) && /^\s*=\s*\d/.test(afterText)) // NH = 18: sample size N with a subscript
        || ((beforeText.match(/\$/g) || []).length % 2 === 1 && afterText.includes('$'))) suspect = 'formula'
      else if (COMPANY.has(c.key) && /(?:^|\s)[A-Z][\w&.-]*,?\s+$/.test(beforeText) && /^\s*(?:[,;)）.]|$)/.test(afterText)) suspect = 'name'
    }
    const e = entry(c.key)
    if (c.parts) e.parts = c.parts
    if (c.shape) e.shape = c.shape
    if (inside?.supplier && !o.def) { e.supplier++; suspect ??= 'name' }
    // Uppercase strings in the same phrase (<= 4 words) before a vendor parenthesis: most likely a product name
    // (Ansys HFSS 2023 R2 (Ansys, ...))
    const next = spans.find((s) => s.start >= o.at + o.len && /^[^,;.()（）]{0,40}$/.test(text.slice(o.at + o.len, s.start))
      && text.slice(o.at + o.len, s.start).trim().split(/\s+/).filter(Boolean).length <= 4)
    if (next?.supplier || /^[®™]/.test(afterText)) e.supplier++
    const occ: Occurrence = { ...o, at: o.at + c.offset, len: c.len, surface: c.key === o.surface ? o.surface : text.slice(o.at + c.offset, o.at + c.offset + c.len), suspect }
    if (occ.para.scope === 'front') e.front.push(occ)
    else e.occ.push(occ)
  }

  // Runs of gene names in a comma list (CCDC22, CCDC93, COMMD1-10)
  for (const para of paragraphs) {
    const tokens = [...para.text.matchAll(TOKEN)]
    let run: string[] = []
    const flush = (): void => {
      const shape = (t: string): string => t.replace(/[A-Z]/g, 'A').replace(/[a-z]/g, 'a').replace(/\d/g, '9')
      const labels = run.length >= 3 && run.every((t) => t.includes('-') && shape(t) === shape(run[0]!)) && run.every((t) => !defined.has(t)) // (W-DM, W-MD, C-DM, C-MD): group labels
      if (labels || (run.length >= 3 && run.filter((t) => GENE.test(t) || /^[A-Z]{2,6}\d{1,3}-\d+$/.test(t)).length >= 2)) for (const t of run) entries.get(pluralStem(t))?.flags.add('gene')
      run = []
    }
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]!
      if (run.length) {
        const prev = tokens[i - 1]!
        const between = para.text.slice(prev.index! + prev[0].length, t.index!)
        if (!/^\s*[,，、]\s*$/.test(between)) flush()
      }
      run.push(t[0])
    }
    flush()
  }

  // All-caps ordinary words (RESEARCH, JUICES): the lowercase form appears in the text as an ordinary word
  // (>= 5 letters), or the word sits in a run of all-caps words
  const shoutRuns = new Map<Para, [number, number][]>()
  for (const para of paragraphs) {
    const runs: [number, number][] = []
    for (const m of para.text.matchAll(/(?<![A-Za-z])[A-Z]{2,}(?:\s+[A-Z]{2,}){2,}(?![A-Za-z])/g)) {
      if (m[0].split(/\s+/).some((w) => w.length >= 4 && wordInText(w))) runs.push([m.index!, m.index! + m[0].length])
    }
    shoutRuns.set(para, runs)
  }
  for (const [key, e] of [...entries]) {
    if (defined.has(key) || !/^[A-Z]{2,}$/.test(key)) continue
    const shouting = e.occ.length > 0 && e.occ.every((o) => (shoutRuns.get(o.para) || []).some(([s, t]) => o.at >= s && o.at < t))
    if (shouting || (key.length >= 4 && wordInText(key))) entries.delete(key)
  }

  // 3. Case variants (HbA1c defined, later written Hba1c, HbA1C): merge into one entry and record the other
  // spellings
  const caseForms = new Map<string, { form: string; occ: Occurrence }[]>()
  for (const key of [...entries.keys()]) {
    const e = entries.get(key)
    if (!e) continue
    if (key.length < 3 || !(/\d/.test(key) || /[a-z]/.test(key)) || !e.occ.some((o) => o.def)) continue
    const re = new RegExp(`(?<![A-Za-z0-9-])${escapeRegExp(key)}(?![A-Za-z0-9-])`, 'gi')
    for (const para of paragraphs) {
      if (para.scope === 'front') continue
      for (const m of para.text.matchAll(re)) {
        if (m[0] === key || defined.has(m[0])) continue
        if (!caseForms.has(key)) caseForms.set(key, [])
        caseForms.get(key)!.push({ form: m[0], occ: { para, at: m.index!, len: m[0].length, surface: m[0], def: null } })
        entries.delete(m[0])
      }
    }
  }

  const geneFamilies = new Set<string>()
  const lettered = new Map<string, number>()
  for (const t of standalone) {
    const m = GENE.test(t) ? t.match(/^(.*?)\d{1,2}[A-Z]?$/) : null
    if (m && m[1]) geneFamilies.add(m[1])
    const l = t.match(/^(.+)-[A-Z]$/)
    if (l) lettered.set(l[1]!, (lettered.get(l[1]!) || 0) + 1)
  }

  // 4. Emit list rows per abbreviation
  const out: ListEntry[] = []
  for (const [abbr, e] of entries) {
    if (!e.occ.length) continue
    const allDefs = e.occ.filter((o) => o.def)
    // Variant inheritance: UPSIT-R has no full term of its own, but UPSIT (trailing hyphen segment removed) does
    let inherited: { base: string; def: Occurrence } | null = null
    if (!allDefs.length && abbr.includes('-')) {
      const base = abbr.replace(/-[^-]+$/, '')
      const d = entries.get(base)?.occ.find((o) => o.def)
      if (d) inherited = { base, def: d }
    }
    const hasLong = allDefs.length > 0 || !!inherited
    const sibling = abbr.match(/^(.+)-[A-Z]$/)
    // Seen in vendor parentheses: counts as a product name only if rarely used, or a sizable share of
    // occurrences is in vendor context (DNA appearing 100 times, once in parentheses, does not count)
    const supplierLike = e.supplier > 0 && (e.occ.length <= 5 || e.supplier / e.occ.length >= 0.2)
    // Alphanumeric form alone (EQ5D, SGLT2) does not make a gene name: needs a gene list, gene family or vendor
    // context
    const nameLike = supplierLike || NAMES.has(abbr) || e.flags.has('gene') || /v\d+$/.test(abbr)
      || geneFamilies.has(abbr) // PBX and PBX3: gene family name
      || (!!sibling && (lettered.get(sibling[1]!) || 0) >= 2) // MH-A, MH-B: domain numbering
      || (!!e.parts && e.parts.every((p) => GENE.test(p) || isKnown(p) || excludedByShape(p)))
    const suspects = e.occ.map((o) => o.suspect)
    const allSuspect = suspects.every(Boolean)
    const why: Why | undefined = e.shape ?? (allSuspect ? suspects[0] : nameLike ? 'name' : undefined)
    const section: ListEntry['section'] = !hasLong && (nameLike || allSuspect || !!e.shape) ? 'maybe_not' : 'list'
    const longs = distinctLongs(allDefs.map((o) => o.def!))
    const forms = caseForms.get(abbr)
    const common = COMMON.has(abbr.toUpperCase())

    const byScope = new Map<Scope, Occurrence[]>()
    for (const o of [...e.occ, ...(forms || []).map((x) => x.occ)].sort((a, b) => a.para.index - b.para.index || a.at - b.at)) {
      if (!byScope.has(o.para.scope)) byScope.set(o.para.scope, [])
      byScope.get(o.para.scope)!.push(o)
    }
    // Abstract and body rows display the same spelling (if AORs is defined, both show AORs)
    const shownAs = (allDefs[0] ?? e.occ[0]!).surface
    const shown = pluralStem(shownAs) === abbr ? shownAs : abbr
    let firstRow = true
    for (const [scope, occ] of byScope) {
      const first = occ[0]!
      const defs = occ.filter((o) => o.def)
      const marks: Mark[] = []
      let def: Occurrence | undefined = defs[0]
      if (def) {
        if (!first.def) marks.push('defined_after_use')
      } else if (allDefs.length) {
        def = allDefs.find((d) => d.para.scope !== scope) ?? allDefs[0]
        marks.push('defined_elsewhere')
      } else if (inherited) {
        def = inherited.def
        marks.push('variant')
      } else marks.push('no_long')
      if (longs) marks.push('several_longs')
      const rowForms = forms?.filter((x) => x.occ.para.scope === scope).map((x) => x.form)
      if (rowForms?.length) marks.push('case')
      if (e.occ.length === 1) marks.push('once')
      if (common) marks.push('common')
      if (firstRow && e.front.length) marks.push('in_title')
      out.push({
        abbr: shown,
        scope,
        long: def ? def.def!.long : null,
        ...(def?.def!.local ? { longLocal: def.def!.local } : {}),
        ...(longs ? { longs } : {}),
        ...(inherited && marks.includes('variant') ? { variantOf: inherited.base } : {}),
        ...(rowForms?.length ? { forms: [...new Set(rowForms)] } : {}),
        firstUse: locOf(first),
        ...(def ? { firstDef: locOf(def) } : {}),
        count: occ.length,
        marks,
        section,
        ...(section === 'maybe_not' && why ? { why } : {}),
      })
      firstRow = false
    }
  }
  return { paragraphs: paragraphs.length, abbreviations: entries.size, skippedReferences, entries: sortEntries(out) }
}

// ---------------------------------------------------------------- Sorting

const SCOPE_ORDER: Record<Scope, number> = { front: 0, abstract: 1, body: 2, all: 3 }

/**
 * Sort by abbreviation alphabetically (case-insensitive, Greek letters sorted as Latin); for the same
 * abbreviation, abstract before body.
 */
export function sortEntries<T extends { abbr: string; scope: Scope }>(list: T[]): T[] {
  return [...list].sort((a, b) => latinize(a.abbr).localeCompare(latinize(b.abbr), 'en', { sensitivity: 'base', numeric: true })
    || a.abbr.localeCompare(b.abbr) || SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope])
}
