// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 TIKMOON LTD
import { describe, expect, it } from 'vitest'
import { MAX_ENTRIES, splitReferenceList } from './split'

// Formats taken from real reference lists (Vancouver, Nature style, with PMIDs).
const VANCOUVER = `References

1. Zaeck LM, Lamers MM, Verstrepen BE, Bestebroer TM, van Royen ME, Götz H, et al. Low levels of monkeypox virus-neutralizing antibodies after MVA-BN vaccination in healthy individuals. Nat Med. 2023;29(1):270-8. doi:10.1038/s41591-022-02090-w
2. Berry MT, Khan SR, Schlub TE, Notaras A, Kunasekaran M, Grulich AE, et al. Predicting vaccine effectiveness for mpox. Nat Commun. 2024;15(1):3856. doi:10.1038/s41467-024-48180-w
3. Pischel L, Martini BA, Yu N, Cacesse D, Tracy M, Kharbanda K, et al. Vaccine effectiveness of 3rd generation mpox vaccines against mpox and disease severity: A systematic review and meta-analysis. Vaccine. 2024;42(25). doi:10.1016/j.vaccine.2024.06.021`

const NATURE_UNNUMBERED = `Bray, F. et al. Global cancer statistics 2022: GLOBOCAN estimates of incidence and mortality worldwide for 36 cancers in 185 countries. CA Cancer J. Clin. 74, 229–263 (2024). doi:10.3322/caac.21834
Loibl, S., Poortmans, P., Morrow, M., Denkert, C. & Curigliano, G. Breast cancer. Lancet 397 (10286), 1750–1769 (2021). doi:10.1016/S0140-6736(20)32381-3
Hopper, J. L. et al. Childhood body mass index and adult mammographic density measures that predict breast cancer risk. Breast Cancer Res. Treat. 156, 163–170 (2016). doi:10.1007/s10549-016-3719-x`

describe('splitReferenceList', () => {
  it('Numbered Vancouver list: drop the heading line, one entry per number', () => {
    const result = splitReferenceList(VANCOUVER)
    expect(result.mode).toBe('numbered')
    expect(result.entries.map((entry) => entry.number)).toEqual([1, 2, 3])
    expect(result.entries[0]!.text).toMatch(/^Zaeck LM/)
    expect(result.entries[2]!.text).toMatch(/vaccine\.2024\.06\.021$/)
    expect(result.confident).toBe(true)
    expect(result.warnings).toEqual([])
  })

  it('PDF line wraps are joined into one entry, no space inserted where a DOI breaks at line end', () => {
    const text = `[1] Maitland K, Kiguli S, Opoka RO, et al. Mortality after fluid bolus in
African children with severe infection. N Engl J Med. 2011;364(26):2483–95. doi:10.1056/NEJ-
Moa1101549
[2] Ford N, Hargreaves S, Shanks L. Mortality after fluid bolus in children with shock due to
sepsis or severe infection: a systematic review and meta-analysis. PLoS ONE. 2012;7(8):e43953.`
    const result = splitReferenceList(text)
    expect(result.entries).toHaveLength(2)
    expect(result.entries[0]!.text).toContain('fluid bolus in African children')
    expect(result.entries[0]!.text).toContain('doi:10.1056/NEJ-Moa1101549')
    expect(result.entries[1]!.text).toContain('due to sepsis or severe')
  })

  it('No numbers, one entry per line (numbers lost when copying Word auto-numbering)', () => {
    const result = splitReferenceList(NATURE_UNNUMBERED)
    expect(result.mode).toBe('lines')
    expect(result.entries).toHaveLength(3)
    expect(result.entries.every((entry) => entry.number === null)).toBe(true)
    expect(result.confident).toBe(true)
  })

  it('Unnumbered PDF wraps: lowercase starts and unfinished previous lines are joined and flagged as not confident', () => {
    const text = `Bray, F. et al. Global cancer statistics 2022: GLOBOCAN estimates of incidence and mortality
worldwide for 36 cancers in 185 countries. CA Cancer J. Clin. 74, 229–263 (2024).
Loibl, S., Poortmans, P., Morrow, M., Denkert, C. & Curigliano, G. Breast cancer. Lancet 397
(10286), 1750–1769 (2021).`
    const result = splitReferenceList(text)
    expect(result.entries).toHaveLength(2)
    expect(result.entries[0]!.text).toContain('mortality worldwide for 36 cancers')
    expect(result.entries[1]!.text).toContain('Lancet 397 (10286)')
    expect(result.confident).toBe(false)
  })

  it('A line ending in a URL is finished; the next capitalized line starts a new entry', () => {
    const text = `World Health Organization (WHO). Smallpox and mpox: WHO position paper. Available from: https://www.who.int/teams/immunization/position-papers/smallpox
Shamier MC, Zaeck LM, Götz HM, et al. Scenarios of future mpox outbreaks. Euro Surveill. 2024;29(17).`
    expect(splitReferenceList(text).entries).toHaveLength(2)
  })

  it('With blank-line paragraphs, split by paragraph and join wraps within each', () => {
    const text = `Bray, F. et al. Global cancer statistics 2022.
CA Cancer J. Clin. 74, 229–263 (2024).

Loibl, S. et al. Breast cancer. Lancet 397, 1750–1769 (2021).`
    const result = splitReferenceList(text)
    expect(result.mode).toBe('paragraphs')
    expect(result.entries.map((entry) => entry.text)).toEqual([
      'Bray, F. et al. Global cancer statistics 2022. CA Cancer J. Clin. 74, 229–263 (2024).',
      'Loibl, S. et al. Breast cancer. Lancet 397, 1750–1769 (2021).',
    ])
  })

  it('Several [n] on one line are split on consecutive numbers; non-consecutive brackets in text stay', () => {
    const text = '[1] Smith J. A study of things [see 12]. J Test. 2020;1:1-2. [2] Doe A. Another long study title here. J Test. 2021;2:3-4. [3] Roe B. Third study with a long enough title. J Test. 2022;3:5-6.'
    const result = splitReferenceList(text)
    expect(result.entries.map((entry) => entry.number)).toEqual([1, 2, 3])
    expect(result.entries[0]!.text).toContain('[see 12]')
  })

  it('Skipped numbers, repeated numbers and text before the first number are all reported, not dropped', () => {
    const text = `Some heading text that is not a reference
1. Smith J. A study of things. J Test. 2020;1:1-2.
2. Doe A. Another study title. J Test. 2021;2:3-4.
2. Roe B. Duplicate number study. J Test. 2022;3:5-6.
5. Poe C. Gap study title here. J Test. 2023;4:7-8.`
    const result = splitReferenceList(text)
    expect(result.entries).toHaveLength(4)
    expect(result.warnings).toContainEqual({ kind: 'numbering-duplicate', numbers: [2] })
    expect(result.warnings).toContainEqual({ kind: 'numbering-gap', missing: [3, 4] })
    expect(result.warnings.some((warning) => warning.kind === 'leading-text')).toBe(true)
    expect(result.confident).toBe(false)
  })

  it('Lines starting with pages or years are not entry numbers (2021;36 is not entry 2021)', () => {
    const text = `1. Smith J. A study of things. J Test.
2021;36(5):1159-63.
2. Doe A. Another study title. J Test. 2021;2:3-4.`
    const result = splitReferenceList(text)
    expect(result.entries).toHaveLength(2)
    expect(result.entries[0]!.text).toBe('Smith J. A study of things. J Test. 2021;36(5):1159-63.')
  })

  it('An overly long entry is flagged as possibly several entries run together', () => {
    const long = Array.from({ length: 16 }, (_, i) => `Author${i} X. Title number ${i} of a study. J Test. 2020;1:1-2.`).join(' ')
    const result = splitReferenceList(`1. ${long}\n2. Doe A. Short enough study. J Test. 2021;2:3-4.`)
    expect(result.warnings).toContainEqual({ kind: 'long-entry', index: 0 })
    expect(result.confident).toBe(false)
  })

  it('Over the limit, keep only the first MAX_ENTRIES entries and say so', () => {
    const text = Array.from({ length: MAX_ENTRIES + 5 }, (_, i) => `${i + 1}. Author A. Title of study ${i}. J Test. 2020;1:1-2.`).join('\n')
    const result = splitReferenceList(text)
    expect(result.entries).toHaveLength(MAX_ENTRIES)
    expect(result.warnings).toContainEqual({ kind: 'too-many', limit: MAX_ENTRIES, total: MAX_ENTRIES + 5 })
  })

  it('Wrapped lines starting with "4)" or "1)": other style or out-of-sequence number is no new entry', () => {
    const text = `1. Dwivedi DJ, Toltl LJ. Prognostic utility of cell-free DNA. Crit Care. 2012;16(
4):R151. doi:10.1186/cc11466
2. Loibl S, Poortmans P. Breast cancer. Lancet 397 (10286), 1750–1769 (202
1). doi:10.1016/S0140-6736(20)32381-3
3. Doe A. Another study title. J Test. 2021;2:3-4.`
    const result = splitReferenceList(text)
    expect(result.entries.map((entry) => entry.number)).toEqual([1, 2, 3])
    expect(result.confident).toBe(true)
  })

  it('No numbers, authors on their own line: a line with no year yet joins the next line', () => {
    const text = `Dwivedi DJ, Toltl LJ, Swystun LL, Pogue J, Liaw KL, Weitz JI, et al.
Prognostic utility of cell-free DNA in patients with severe sepsis. Crit Care. 2012;16(4):R151.
Loibl, S., Poortmans, P., Morrow, M., Denkert, C. & Curigliano, G.
Breast cancer. Lancet 397, 1750–1769 (2021).`
    const result = splitReferenceList(text)
    expect(result.entries).toHaveLength(2)
    expect(result.entries[1]!.text).toBe('Loibl, S., Poortmans, P., Morrow, M., Denkert, C. & Curigliano, G. Breast cancer. Lancet 397, 1750–1769 (2021).')
    expect(result.confident).toBe(false)
  })

  it('Extra trailing blank lines do not change the split', () => {
    const text = 'Smith J. A correct article. Nature. 2020;1:1-2.\nJones B. Another correct article. Nature. 2021;2:3-4.\n\n\n'
    expect(splitReferenceList(text).entries).toHaveLength(2)
  })

  it('Large number gaps still start entries and report missing numbers; same-style backward numbers are flagged', () => {
    const jump = splitReferenceList('1. Smith J. A correct article. Nature. 2020;1:1-2.\n7. Jones B. Another correct article. Nature. 2021;2:3-4.')
    expect(jump.entries.map((entry) => entry.number)).toEqual([1, 7])
    expect(jump.warnings).toContainEqual({ kind: 'numbering-gap', missing: [2, 3, 4, 5, 6] })
    const back = splitReferenceList('5. Smith J. A correct article. Nature. 2020;1:1-2.\n2. Jones B. Another correct article. Nature. 2021;2:3-4.')
    expect(back.confident).toBe(false)
  })

  it('DOI ending with a period before a line break: the period ends the sentence and is not glued to the next line', () => {
    const text = `1. Dwivedi DJ, Toltl LJ. Prognostic utility of cell-free DNA. Crit Care. 2012;16(4):R151. doi:10.1186/cc11466.
(PubMedPMID:22889177;PubMedCentralPMCID:3580740).
2. Doe A. A study. J Test. 2021;2:3-4. doi:10.1016/j.
ijcard.2020.01.001`
    const result = splitReferenceList(text)
    expect(result.entries[0]!.text).toContain('doi:10.1186/cc11466. (PubMed')
    expect(result.entries[1]!.text).toContain('doi:10.1016/j.ijcard.2020.01.001')
  })

  it('Mixed numbering styles (1. and 2)): not split, but flagged as doubtful', () => {
    const result = splitReferenceList('1. Smith J. A correct article. Nature. 2020;1:1-2.\n2) Jones B. Another correct article. Nature. 2021;2:3-4.')
    expect(result.confident).toBe(false)
  })

  it('Empty input', () => {
    expect(splitReferenceList('  \n\n References \n')).toMatchObject({ entries: [], mode: 'empty' })
  })
})
