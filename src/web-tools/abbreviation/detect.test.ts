// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 TIKMOON LTD
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'
import { beforeAll, describe, expect, it } from 'vitest'
import { analyze, sortEntries, type ListEntry } from './detect'
import { fullTerm, submissionText, SUBMISSION_EN, toCsv, toTsv, type ExportRow } from './export'

// Abbreviations and sentences in the examples are taken from real published text, not invented
// identifiers. Assertions only check data (full form, notes, sections), not page text.
const repo = join(dirname(fileURLToPath(import.meta.url)), '../../..')
let SAMPLE: Record<'en' | 'zh' | 'ja' | 'ko', string>
let MSG: Record<'en' | 'zh' | 'ja' | 'ko', Record<string, string>>

beforeAll(async () => {
  const tools = await import(pathToFileURL(join(repo, 'test/abbreviation-copy.mjs')).href)
  SAMPLE = { en: tools.abbreviation.en.sample, zh: tools.abbreviation.zh.sample, ja: tools.abbreviation.ja.sample, ko: tools.abbreviation.ko.sample }
  MSG = { en: tools.abbreviation.en.msg, zh: tools.abbreviation.zh.msg, ja: tools.abbreviation.ja.msg, ko: tools.abbreviation.ko.msg }
})

const run = (text: string, split = true): ListEntry[] => analyze(text, split).entries
const rows = (entries: ListEntry[], abbr: string): ListEntry[] => entries.filter((e) => e.abbr === abbr)

/**
 * Expectations: long = in the main table with a full form, first occurrence is the definition;
 * no_long = in the main table, no full form found; late = appears first, full form given later;
 * several = full form written several ways; elsewhere = no full form in this section but one in the
 * other; maybe = placed under "possibly not an abbreviation"; common = in the main table with the
 * "common abbreviation" note; absent = not in the list.
 */
type Want = 'long' | 'no_long' | 'late' | 'several' | 'elsewhere' | 'maybe' | 'common' | 'absent'
function expectAbbr(entries: ListEntry[], abbr: string, want: Want): void {
  const r = rows(entries, abbr)
  const desc = `${abbr}: ${JSON.stringify(r.map((x) => [x.scope, x.section, x.long, x.marks]))}`
  if (want === 'absent') return expect(r.filter((x) => x.section === 'list'), desc).toEqual([])
  expect(r.length, `${abbr} not listed`).toBeGreaterThan(0)
  if (want === 'maybe') return expect(r.every((x) => x.section === 'maybe_not'), desc).toBe(true)
  expect(r.every((x) => x.section === 'list'), desc).toBe(true)
  const marks = r.flatMap((x) => x.marks)
  if (want === 'long') {
    expect(r.every((x) => x.long), desc).toBe(true)
    expect(marks.filter((m) => ['no_long', 'defined_after_use', 'several_longs'].includes(m)), desc).toEqual([])
  } else if (want === 'no_long') expect(marks, desc).toContain('no_long')
  else if (want === 'late') expect(marks, desc).toContain('defined_after_use')
  else if (want === 'several') expect(marks, desc).toContain('several_longs')
  else if (want === 'elsewhere') expect(marks, desc).toContain('defined_elsewhere')
  else if (want === 'common') expect(marks, desc).toContain('common')
}

type Probe = [name: string, text: string, expect: Record<string, Want>]

const ZH: Probe[] = [
  ['Z01 Chinese term (English full term, ABBR)', '本研究纳入2型糖尿病（type 2 diabetes mellitus，T2DM）患者312例。T2DM患者均随访12个月，T2DM病程中位数为6年。', { T2DM: 'long' }],
  ['Z02 same, half-width comma', '慢性肾脏病（chronic kidney disease, CKD）是常见并发症。CKD分期按指南进行，CKD 3期以上者另行分析。', { CKD: 'long' }],
  ['Z03 full term (ABBR), full-width brackets', '糖化血红蛋白（HbA1c）是主要结局。各组HbA1c基线相近，随访时HbA1c下降0.8%。', { HbA1c: 'long' }],
  ['Z04 used before definition', '各组eGFR均有下降。估算肾小球滤过率（eGFR）按CKD-EPI公式计算，eGFR<60者为肾功能下降。', { eGFR: 'late', 'CKD-EPI': 'no_long' }],
  ['Z05 full term written two ways', '低密度脂蛋白胆固醇（LDL-C）是主要终点。\n次要终点包括甘油三酯水平；低密度脂蛋白（LDL-C）达标率见表2。LDL-C每降低1 mmol/L风险下降。', { 'LDL-C': 'several' }],
  ['Z06 ABBR (full term), mixed Chinese and English', '认知功能采用MMSE（简易精神状态检查量表）评估，MMSE<24分判为认知障碍，随访时复测MMSE。', { MMSE: 'long' }],
  ['Z07 no full term', '所有患者均于入院24 h内行PCI治疗，术后PCI相关并发症发生率为3.2%。', { PCI: 'no_long' }],
  ['Z08 units, statistics, stages', '收缩压（140±12）mmHg，n=30，P<0.05，HR=1.25，Ⅲ期患者占20%，TNM分期按第8版。', { mmHg: 'absent', HR: 'common' }],
  // The list does not judge near matches: one extra character means two spellings are listed (no "prefix
  // is a connector word" or "same if at least 3 characters" rules)
  ['Z09 one extra character before the definition', '本研究纳入经皮冠状动脉介入治疗（PCI）患者，行经皮冠状动脉介入治疗（PCI）后随访。PCI术后1年再评估。', { PCI: 'several' }],
  ['Z09b Chinese full term with one extra word', '心力衰竭（HF）患者入组。充血性心力衰竭（HF）患者随访。', { HF: 'several' }],
  ['Z09c word order swapped', '充血性心力衰竭（HF）患者入组。心力衰竭（HF）患者随访。', { HF: 'several' }],
  ['Z09d differs only in spaces and interpuncts', '经皮 冠状动脉介入治疗（PCI）后随访。经皮冠状动脉介入治疗（PCI）再评估。', { PCI: 'long' }],
  ['Z10 two forms with different prefixes', '高敏C反应蛋白（hs-CRP）升高提示炎症。\nC反应蛋白（hs-CRP）>3 mg/L定义为高风险，hs-CRP与结局相关。', { 'hs-CRP': 'several' }],
  ['Z11 abstract and main text listed separately', '摘要\n目的 探讨体重指数（BMI）与预后的关系。方法 BMI按WHO标准分组。\n1 引言\nBMI是常用指标。肥胖以BMI≥28判定。', { BMI: 'elsewhere' }],
  ['Z12 nothing after the references is listed', '血管紧张素转换酶抑制剂（ACEI）可降低蛋白尿，ACEI使用率为60%。\n参考文献\n[1] Zhang S, Li Q. ARB versus ACEI in CKD. Lancet. 2020.', { ACEI: 'long', ARB: 'absent' }],
  ['Z13 brackets hold a note, not a full term', '患者MoCA（详见附表）评分下降，MoCA<26分者占40%。', { MoCA: 'no_long' }],
]

const EN: Probe[] = [
  ['E01 HbA1c with two full terms', 'Glycated hemoglobin (HbA1c) was the primary outcome.\nHemoglobin A1c (HbA1c) fell by 0.8% and HbA1c was stable thereafter.', { HbA1c: 'several' }],
  ['E02 one prefix word missing: only the first full term is listed', 'Estimated glomerular filtration rate (eGFR) was computed.\nGlomerular filtration rate (eGFR) declined, and eGFR slopes differed.', { eGFR: 'long' }],
  ['E03 Greek letters', 'Serum TNF-α and IFN-γ were measured. TNF-α rose in both arms; IFN-γ did not change. TGF-β1 was also higher.', { 'TNF-α': 'no_long', 'IFN-γ': 'no_long', 'TGF-β1': 'no_long' }],
  ['E04 plural and singular merged into one row', 'We searched for randomized controlled trials (RCTs). Eligible RCTs were pooled; each RCT was assessed for bias.', { RCTs: 'long', RCT: 'absent' }],
  ['E05 statistics in brackets are not definitions', 'Mortality was lower with treatment (aHR, 0.82; 95% CI, 0.70-0.95). In older adults the aHR was 0.75.', { aHR: 'no_long' }],
  ['E06 units, Roman numerals, author initials', 'Mean arterial pressure was 90 mmHg (n = 30, stage III). Two reviewers (JS and MK) screened studies. IL-6 rose.', { mmHg: 'absent', III: 'absent', JS: 'maybe', MK: 'maybe' }],
  ['E07 note in brackets', 'MMSE (see Supplementary Table) scores declined, and MMSE below 24 indicated impairment.', { MMSE: 'no_long' }],
  ['E08 square-bracket definition', 'Body mass index [BMI] was recorded. BMI was higher in cases, and BMI predicted risk.', { BMI: 'long' }],
  ['E09 definition after a semicolon', 'We identified variants (single nucleotide polymorphisms; SNPs) linked to risk. SNPs were clumped, and SNPs with low MAF were removed.', { SNPs: 'long' }],
  ['E10 abbreviation in the title', 'SGLT2 inhibitors and kidney outcomes\nAbstract\nSodium-glucose cotransporter 2 (SGLT2) inhibitors were studied. SGLT2 use rose.\nIntroduction\nSodium-glucose cotransporter 2 (SGLT2) inhibitors reduce risk. SGLT2 inhibitors are widely used.', { SGLT2: 'long' }],
  ['E11 citation superscript attached to the abbreviation', 'Resting-state EEG31 recordings were analysed. Electroencephalography (EEG) was recorded for 5 min; EEG artefacts were removed.', { EEG31: 'absent', EEG: 'long' }],
  ['E14 variants of the references heading', 'Atrial fibrillation (AF) was common. AF recurred.\nLiterature Cited\nSmith J. NOAC use in AF. NEJM. 2020.', { AF: 'long', NOAC: 'absent', NEJM: 'absent' }],
  ['E15 ABBR, full term,', 'The NIHSS, National Institutes of Health Stroke Scale, was recorded. NIHSS fell by 4 points.', { NIHSS: 'long' }],
]

const JA_KO: Probe[] = [
  ['J1 Japanese', '2型糖尿病（T2DM）患者を対象とした。T2DM群では、HbA1cが低下した。', { T2DM: 'long', HbA1c: 'no_long' }],
  ['J2 Japanese term (English: ABBR)', '慢性腎臓病（chronic kidney disease：CKD）の患者を対象とした。CKDの進行を評価し、CKD分類も記録した。', { CKD: 'long' }],
  ['J3 used before definition', 'eGFRは低下した。\n推算糸球体濾過量（eGFR）はCKD-EPI式で算出した。eGFRの年間低下速度を比較した。', { eGFR: 'late' }],
  ['J4 full term written two ways', '低密度リポタンパクコレステロール（LDL-C）を測定した。\n副次評価項目として高密度リポタンパクコレステロール（LDL-C）も評価した。LDL-Cは低下した。', { 'LDL-C': 'several' }],
  ['J5 brackets hold a note', 'MoCA（詳細は付録参照）のスコアが低下した。MoCAが26点未満の者は40%であった。', { MoCA: 'no_long' }],
  ['K1 Korean', '만성 신장병(CKD) 환자를 포함하였다. CKD 환자에서 eGFR이 감소하였다.', { CKD: 'long', eGFR: 'no_long' }],
  ['K2 Korean term (English, ABBR)', '만성 신장병(chronic kidney disease, CKD) 환자를 포함하였다. CKD 진행을 평가하였고 CKD 병기도 기록하였다.', { CKD: 'long' }],
  ['K3 used before definition', 'eGFR이 감소하였다.\n추정 사구체 여과율(eGFR)은 CKD-EPI 공식으로 계산하였다. eGFR 연간 감소 속도를 비교하였다.', { eGFR: 'late' }],
  ['K4 full term written two ways', '저밀도 지단백 콜레스테롤(LDL-C)을 측정하였다.\n고밀도 지단백 콜레스테롤(LDL-C)도 평가하였다. LDL-C는 감소하였다.', { 'LDL-C': 'several' }],
  ['K5 brackets hold a note', 'MoCA(부록 참조) 점수가 감소하였다. MoCA 26점 미만은 40%였다.', { MoCA: 'no_long' }],
]

describe('Targeted probes (four languages)', () => {
  for (const [name, text, expectMap] of [...ZH, ...EN, ...JA_KO]) {
    it(name, () => {
      const entries = run(text)
      for (const [abbr, want] of Object.entries(expectMap)) expectAbbr(entries, abbr, want)
    })
  }
})

describe('Page examples', () => {
  it('English example: skips 1 reference; LDL-C spellings differing only by a hyphen are not two spellings', () => {
    const r = analyze(SAMPLE.en, true)
    expect(r.skippedReferences).toBe(1)
    const ldl = rows(r.entries, 'LDL-C')
    expect(ldl.length).toBeGreaterThan(0)
    expect(ldl.some((x) => x.marks.includes('several_longs'))).toBe(false)
  })
  it('Four-language examples give the same list and notes (Chinese example as reference)', () => {
    const shape = (lang: 'en' | 'zh' | 'ja' | 'ko', split: boolean) => analyze(SAMPLE[lang], split).entries.map((e) => [e.abbr, e.scope, e.section, e.count, e.marks.join(',')].join('|'))
    for (const split of [false, true]) for (const lang of ['en', 'ja', 'ko'] as const) expect(shape(lang, split), `${lang} split=${split}`).toEqual(shape('zh', split))
  })
  it('Four-language examples all list eGFR and HbA1c, sorted alphabetically', () => {
    for (const lang of ['en', 'zh', 'ja', 'ko'] as const) {
      const entries = analyze(SAMPLE[lang], true).entries
      expect(entries.map((e) => e.abbr)).toEqual(sortEntries(entries).map((e) => e.abbr))
      for (const abbr of ['eGFR', 'HbA1c', 'T2DM']) expect(rows(entries, abbr).some((x) => x.long), `${lang} ${abbr}`).toBe(true)
    }
  })
})

describe('Full-form detection', () => {
  it('Chinese term (English full form, abbreviation): full form is the English, Chinese kept separately', () => {
    const [t2dm] = rows(run('本研究纳入2型糖尿病（type 2 diabetes mellitus，T2DM）患者。T2DM患者随访12个月。'), 'T2DM')
    expect([t2dm!.long, t2dm!.longLocal]).toEqual(['type 2 diabetes mellitus', '2型糖尿病'])
    expect(fullTerm(t2dm!.long, t2dm!.longLocal)).toBe('2型糖尿病（type 2 diabetes mellitus）')
  })
  it('Strip a connector before a Chinese full form, but not characters inside the word (`和体重指数` -> `体重指数`)', () => {
    const [bmi] = rows(run('次要结局还包括低密度脂蛋白胆固醇（LDL-C）和体重指数（BMI）。BMI 按 WHO 标准分组。'), 'BMI')
    expect(bmi!.long).toBe('体重指数')
  })
  it('Statistics in parentheses are not definitions; supplier parentheses go to "possibly not an abbreviation"', () => {
    expectAbbr(run('Hospitalization was lower (HRR, 0.82; 95% CI 0.7-0.9). HRR was stable.'), 'HRR', 'no_long')
    expectAbbr(run('Samples were collected using a MIR Spirobank Smart spirometer (MIR, Rome, Italy). MIR data were exported.'), 'MIR', 'maybe')
  })
  it('A parenthesised list is not a definition: temporary MCS (IABP, Impella, VA-ECMO, or temporary VAD)', () => {
    expectAbbr(run('Outcomes included (ii) initiation of temporary MCS (IABP, Impella, VA-ECMO, or temporary VAD). IABP use was rare.'), 'IABP', 'no_long')
  })
  it('A long run that happens to match is not a full form (association between ... outcomes (AUROC 0.81))', () => {
    const entries = run('Model 1 linked the association between inflammatory burden and severe outcomes (AUROC, 0.809).\nThe area under the receiver operating characteristic curve (AUROC) was reported. AUROC values were compared.')
    expect(rows(entries, 'AUROC').flatMap((x) => x.marks)).not.toContain('several_longs')
  })
  it('Look back when an initial falls mid-word: American Academy of Sleep Medicine (AASM)', () => {
    expect(rows(run('Sleep stages were scored according to the American Academy of Sleep Medicine (AASM) criteria. AASM rules apply.'), 'AASM')[0]!.long).toBe('American Academy of Sleep Medicine')
  })
  it('Full forms with a colon and a confidence level: SPIRIT, 95% CIs', () => {
    expect(rows(run('We followed the Standard Protocol Items: Recommendations for Interventional Trials (SPIRIT) guideline. SPIRIT items are listed.'), 'SPIRIT')[0]!.long)
      .toBe('Standard Protocol Items: Recommendations for Interventional Trials')
    expect(rows(run('The paper reported hazard ratios (HRs) and 95% confidence intervals (95% CIs). CIs were wide.'), 'CIs')[0]!.long).toBe('confidence intervals')
  })
  it('Capitalised words in the full form match several letters: WHR adjusted for BMI (WHRadjBMI), cfDNA', () => {
    expect(rows(run('An association was additionally observed between higher PGS for WHR adjusted for BMI (WHRadjBMI) and MRS. WHRadjBMI rose.'), 'WHRadjBMI')[0]!.long).toBe('WHR adjusted for BMI')
    expect(rows(run('The fraction was then treated with a red blood cell lysis buffer and circulating DNA (cfDNA) was kept. cfDNA was stored.'), 'cfDNA')[0]!.long).toBe('circulating DNA')
  })
  it('Two or three abbreviations joined in parentheses: split the full form by letters', () => {
    const entries = run('Glucagon-like peptide-1 receptor agonists (GLP-1 RAs) such as semaglutide were used. GLP-1 RAs lowered weight.')
    expect(rows(entries, 'GLP-1')[0]!.long).toBe('Glucagon-like peptide-1')
    expect(rows(entries, 'RAs')[0]!.long).toBe('receptor agonists')
  })
  it('Roman-numeral-shaped abbreviations are listed when defined: instrumental variables (IVs)', () => {
    expect(rows(run('We used germline variants as instrumental variables (IVs) to strengthen causal inference. IVs were clumped.'), 'IVs')[0]!.long).toBe('instrumental variables')
  })
  it('Variant inheritance: UPSIT-R without its own full form takes UPSIT\'s, and is marked', () => {
    const entries = run('The University of Pennsylvania Smell Identification Test (UPSIT) is common. We used the revised UPSIT (UPSIT-R) and UPSIT-R scores rose.')
    const [r] = rows(entries, 'UPSIT-R')
    expect([r!.long, r!.variantOf, r!.marks.includes('variant'), r!.section]).toEqual(['University of Pennsylvania Smell Identification Test', 'UPSIT', true, 'list'])
  })
})

describe('"Possibly not an abbreviation"', () => {
  it('Letter-digit shapes like EQ5D and SGLT2 stay in the list; runs of gene names are still collapsed', () => {
    expectAbbr(run('Participants completed the EQ5D questionnaire. EQ5D scores improved.'), 'EQ5D', 'no_long')
    expectAbbr(run('SGLT2 inhibitors were prescribed. SGLT2 use increased.'), 'SGLT2', 'no_long')
    expectAbbr(run('We knocked down CCDC22, CCDC93, COMMD1 in HeLa cells. CCDC22 loss was strongest.'), 'CCDC22', 'maybe')
  })
  it('Author initials, lot numbers, licences and formula variables go to the collapsed section, with reasons', () => {
    const entries = run('Data extraction was performed by two researchers within the past 3 years (DGH and P-YN). Approval was obtained from the Cyprus National Bioethics Committee (EEBK/EΠ/2022/32). The covariance is covY1,Y2=EY1Y2-EY1EY2 for each pair. Published under a CC BY 4.0 licence.')
    const why = (abbr: string): [string, string | undefined] => { const r = rows(entries, abbr)[0]!; return [r.section, r.why] }
    expect(why('DGH')).toEqual(['maybe_not', 'initials'])
    expect(why('P-YN')).toEqual(['maybe_not', 'initials'])
    expect(why('EEBK')).toEqual(['maybe_not', 'identifier'])
    expect(why('BY')).toEqual(['maybe_not', 'identifier'])
    expect(why('EY1Y2-EY1EY2')).toEqual(['maybe_not', 'formula'])
  })
  it('Gene and unambiguous shapes (mutations, formulas, catalogue numbers) collapse; figure refs, units unlisted', () => {
    const entries = run('LRMDA and SNX17 share a common mechanism. SNX17 recognises sorting motifs. Cells were kept at 5% CO2. The S328A mutant was stable (S8D and S8H Fig). The field was 3 MHz.')
    // Do not collapse on letter-digit shape alone: without a gene list or supplier context, keep it in the
    // list marked as no full form found
    expectAbbr(entries, 'SNX17', 'no_long')
    expectAbbr(entries, 'CO2', 'maybe')
    expectAbbr(entries, 'S328A', 'maybe')
    expect(rows(entries, 'S8D').concat(rows(entries, 'MHz'))).toEqual([])
  })
  it('Anything with a full form in the text stays in the main table', () => {
    const entries = run('Small interfering RNA targeting sorting nexin 17 (SNX17) was used. SNX17 knockdown reduced uptake.')
    expectAbbr(entries, 'SNX17', 'long')
  })
  it('Frequent abbreviation seen once in supplier parentheses (DNA) is not a product name', () => {
    const text = 'DNA was extracted (DNA kit, Qiagen, Germany). ' + Array.from({ length: 12 }, (_, i) => `DNA sample ${i + 1} was sequenced.`).join(' ')
    expectAbbr(run(text), 'DNA', 'common')
  })
  it('Unambiguous shapes still stay out of the main table (original sentences)', () => {
    const quiet: [string, string][] = [
      ['PBC', 'The R software (Version 4.5.2) in the RStudio Platform (Version 2026.04.0; 2009–2026 Posit Software, PBC) was used for all statistical analyses [35].'],
      ['S1G', 'Our analysis expanded this repertoire, including one completely lacking the CTF/NFI C-terminal domain itself, and another lacking all predicted domains (S1G and S1H Fig).'],
      ['DpnI', 'Non-amplified DNA was removed through DpnI digestion at 37 °C for 1 h.'],
      ['JUICES', 'During the past month, how often did you drink 100% PURE FRUIT JUICES such as orange, apple, grape, etc.? DO NOT INCLUDE fruit-flavored drinks with added sugars like fruit juices.'],
      ['AG', 'Samples were applied onto DBS collection cards (CAMAG AG, Muttenz, Switzerland), which allow for precise, standardized blood volume collection.'],
      ['NaOH', '600µl of freshly prepared 10% DMSO (v/v) in 1M NaOH in PBS was then added to the pellets.'],
      ['A300-028A', 'Antibodies used in this study were as follows: anti-COPS2 (Bethyl Laboratories, A300-028A, rabbit), anti-COPS5 (Bethyl Laboratories, A300-014A, rabbit).'],
      ['fOR', 'The RESTORE study (sleep RESTriction therapy fOR insomnia) recruited adults.'],
    ]
    for (const [abbr, text] of quiet) expectAbbr(run(text), abbr, 'absent')
  })
  it('Hyphens: merge into defined abbreviations; no capital part is not one; undefined parts list the whole word', () => {
    const entries = run('Electroencephalography (EEG) was recorded. EEG-based features were used. A Bland-Altman plot was drawn. Kidney function was estimated with CKD-EPI.')
    expect(rows(entries, 'EEG')[0]!.count).toBe(2)
    expect(rows(entries, 'Bland-Altman')).toEqual([])
    expectAbbr(entries, 'CKD-EPI', 'no_long')
  })
})

describe('Sections and notes', () => {
  it('Table rows and figure/table captions count neither as occurrences nor as definitions', () => {
    expect(rows(run('Chronic kidney disease (CKD) was common.\nTable 1. Baseline characteristics by UACR\nVariable\tCKD\tNo CKD\nUACR, mg/g\t45\t12\nCKD progression was faster.'), 'UACR')).toEqual([])
  })
  it('References are cut off by heading or content, and the skipped count is recorded', () => {
    expect(analyze('Atrial fibrillation (AF) was common. AF recurred.\nLiterature Cited\nSmith J. NOAC use in AF. NEJM. 2020.\nLee K. AF. Lancet. 2019.', true).skippedReferences).toBe(2)
    const body = 'Atrial fibrillation (AF) was common. AF recurred in many patients during follow-up.\nAF was treated.\nAF was monitored.\n'
    const refs = ['1. Smith J, Lee K. NOAC use in AF. N Engl J Med. 2020;383(4):1436-46.', '2. Wang L, Chen H. DOAC dosing. Lancet. 2019;12:45-52.', '3. Kim S, Park J. AF burden. JAMA. 2018;320(2):100-9.']
    const r = analyze(body + refs.join('\n'), true)
    expect(r.skippedReferences).toBe(3)
    expect(r.entries.filter((x) => ['NOAC', 'DOAC', 'JAMA'].includes(x.abbr))).toEqual([])
  })
  it('Abbreviations in the title: noted as "also in title", no separate row', () => {
    const entries = run('SGLT2 inhibitors and kidney outcomes\nAbstract\nSodium-glucose cotransporter 2 (SGLT2) inhibitors were studied. SGLT2 use rose.')
    expect(entries.filter((x) => x.abbr === 'SGLT2').map((x) => [x.scope, x.marks])).toEqual([['all', ['in_title']]])
  })
  it('One row each for abstract and main text when split; one row when turned off', () => {
    const text = 'Abstract\nBody mass index (BMI) was recorded.\nIntroduction\nBMI was higher in cases.'
    expect(rows(run(text, true), 'BMI').map((x) => [x.scope, x.marks])).toEqual([['abstract', ['common']], ['body', ['defined_elsewhere', 'common']]])
    expect(rows(run(text, false), 'BMI').map((x) => [x.scope, x.count])).toEqual([['all', 2]])
  })
  it('Case variants merge into one entry, listing the other spellings', () => {
    const [r] = rows(run('Glycated hemoglobin (HbA1c) was measured. At 12 months Hba1c fell, and HbA1C was lower.'), 'HbA1c')
    expect([r!.forms, r!.marks.includes('case'), r!.count]).toEqual([['Hba1c', 'HbA1C'], true, 3])
  })
  it('Common abbreviations are listed with a "common abbreviation" note; single occurrences are noted "appears once"', () => {
    const entries = run('DNA was extracted. The OR was 1.2 (95% CI 1.0-1.4). BMI was recorded at baseline.')
    for (const abbr of ['DNA', 'OR', 'CI', 'BMI']) expectAbbr(entries, abbr, 'common')
    expect(rows(entries, 'BMI')[0]!.marks).toEqual(['no_long', 'once', 'common'])
  })
})

describe('Export', () => {
  const row = (abbr: string, full: string, extra: Partial<ExportRow> = {}): ExportRow => ({ abbr, scope: 'all', full, firstPara: 1, count: 2, marks: [], scopeLabel: '', ...extra })
  const list = [row('eGFR', 'estimated glomerular filtration rate'), row('BMI', 'body mass index'), row('TNF-α', ''), row('CI', 'confidence interval, "95%"'), row('ACEI', 'angiotensin-converting enzyme inhibitor')]
  it('Copy as table: two columns, alphabetical, with header', () => {
    expect(toTsv(list, ['Abbreviation', 'Full term']).split('\n')).toEqual(['Abbreviation\tFull term', 'ACEI\tangiotensin-converting enzyme inhibitor', 'BMI\tbody mass index', 'CI\tconfidence interval, "95%"', 'eGFR\testimated glomerular filtration rate', 'TNF-α\t'])
  })
  it('CSV: UTF-8 BOM, comma and quote escaping, alphabetical', () => {
    const csv = toCsv(list, ['A', 'B', 'C', 'D', 'E', 'F', 'G'])
    expect(csv.startsWith('﻿A,B,C,D,E,F,G\r\nACEI,')).toBe(true)
    expect(csv).toContain('CI,"confidence interval, ""95%""",,1,,2,')
    expect(csv.trimEnd().split('\r\n').map((l) => l.split(',')[0])).toEqual(['﻿A', 'ACEI', 'BMI', 'CI', 'eGFR', 'TNF-α'])
  })
  it('Submission abbreviations: entries without full form left out and counted; abstract/main-text rows appear once', () => {
    const twoRows = [...list, row('BMI', 'body mass index', { scope: 'body' })]
    expect(submissionText(twoRows, SUBMISSION_EN)).toEqual({ text: 'Abbreviations: ACEI, angiotensin-converting enzyme inhibitor; BMI, body mass index; CI, confidence interval, "95%"; eGFR, estimated glomerular filtration rate.', skipped: 1 })
    expect(submissionText([row('BMI', '体重指数')], { head: MSG.zh.sub_head!, pair: MSG.zh.sub_pair!, sep: MSG.zh.sub_sep!, end: MSG.zh.sub_end! }).text).toBe('缩略语：BMI，体重指数。')
    expect(submissionText([row('X', '$1 & $2')], SUBMISSION_EN).text).toBe('Abbreviations: X, $1 & $2.')
  })
  it('Greek letters sort as Latin letters', () => {
    expect(sortEntries([row('TNF-α', ''), row('TGF-β', ''), row('Tc', '')]).map((r) => r.abbr)).toEqual(['Tc', 'TGF-β', 'TNF-α'])
  })
})

describe('Word reading (web/docx.js)', () => {
  const ctx: { MC_DOCX?: { docxXmlToText(xml: string, options?: { skipTables?: boolean }): string } } = {}
  vm.createContext(ctx)
  vm.runInContext(readFileSync(join(repo, 'web/docx.js'), 'utf8'), ctx)
  const p = (t: string): string => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`
  const xml = `<w:body>${p('Chronic kidney disease (CKD) was common.')}<w:tbl><w:tblPr/><w:tr><w:tc>${p('UACR')}<w:tbl><w:tr><w:tc>${p('nested')}</w:tc></w:tr></w:tbl></w:tc></w:tr></w:tbl>${p('CKD progression was faster.')}</w:body>`
  it('Abbreviation list skips tables (including nested tables)', () => {
    expect(ctx.MC_DOCX!.docxXmlToText(xml, { skipTables: true })).toBe('Chronic kidney disease (CKD) was common.\nCKD progression was faster.')
  })
  it('Tables are read by default (the P-value tool needs numbers in tables)', () => {
    expect(ctx.MC_DOCX!.docxXmlToText(xml)).toContain('UACR')
  })
})
