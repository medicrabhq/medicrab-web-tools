// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 TIKMOON LTD
import { describe, expect, it } from 'vitest'
import { parseLocatorLoose, parseStyledEntry } from './formats'

describe('parseStyledEntry', () => {
  it('Nature style: et al. authors, colon and digits in the title', () => {
    expect(parseStyledEntry('1. Bray, F. et al. Global cancer statistics 2022: GLOBOCAN estimates of incidence and mortality worldwide for 36 cancers in 185 countries. CA Cancer J. Clin. 74, 229–263 (2024). doi:10.3322/caac.21834')).toEqual({
      style: 'nature', authors: 'Bray, F. et al.',
      title: 'Global cancer statistics 2022: GLOBOCAN estimates of incidence and mortality worldwide for 36 cancers in 185 countries',
      journal: 'CA Cancer J. Clin.', year: 2024, volume: '74', issue: null, pages: '229–263',
    })
  })

  it('Nature style: authors joined with &, issue after volume', () => {
    expect(parseStyledEntry('Loibl, S., Poortmans, P., Morrow, M., Denkert, C. & Curigliano, G. Breast cancer. Lancet 397 (10286), 1750–1769 (2021). doi:10.1016/S0140-6736(20)32381-3')).toMatchObject({
      authors: 'Loibl, S., Poortmans, P., Morrow, M., Denkert, C. & Curigliano, G.', title: 'Breast cancer',
      journal: 'Lancet', volume: '397', issue: '10286', pages: '1750–1769', year: 2021,
    })
  })

  it('Nature style: DOI in the page position is not a page number', () => {
    expect(parseStyledEntry('Vilmun, B. M. et al. Impact of adding breast density to breast cancer risk models: a systematic review. Eur. J. Radiol. 127, 10.1016/J.EJRAD.2020.109019 (2020). doi:10.1016/j.ejrad.2020.109019')).toMatchObject({
      title: 'Impact of adding breast density to breast cancer risk models: a systematic review', volume: '127', pages: null, year: 2020,
    })
  })

  it('APA style', () => {
    expect(parseStyledEntry('Smith, J. A., & Doe, B. (2020). Effects of things on other things. Journal of Applied Things, 12(3), 45–67. https://doi.org/10.1234/abcd')).toEqual({
      style: 'apa', authors: 'Smith, J. A., & Doe, B.', title: 'Effects of things on other things',
      journal: 'Journal of Applied Things', year: 2020, volume: '12', issue: '3', pages: '45–67',
    })
  })

  it('Periods in the title (U.S., St.): find the boundary by whether the right side looks like a journal', () => {
    expect(parseStyledEntry('Smith, J. et al. Outcomes in the U.S. population. Nature 12, 1–10 (2020). doi:10.1234/example')).toMatchObject({
      title: 'Outcomes in the U.S. population', journal: 'Nature',
    })
    expect(parseStyledEntry('Smith, J. A., & Doe, B. (2020). St. John’s wort in the U.S. population. Journal of Applied Things, 12(3), 45–67.')).toMatchObject({
      title: 'St. John’s wort in the U.S. population', journal: 'Journal of Applied Things',
    })
  })

  it('A period after an abbreviation does not end the title', () => {
    expect(parseStyledEntry('Smith, J. et al. Mortality in the U.S. A Prospective Multicenter Cohort Study. Nature 12, 1–10 (2020).')).toMatchObject({
      title: 'Mortality in the U.S. A Prospective Multicenter Cohort Study', journal: 'Nature',
    })
  })

  it('Vancouver style is not handled here', () => {
    expect(parseStyledEntry('Maitland K, Kiguli S, Opoka RO, et al. Mortality after fluid bolus in African children with severe infection. N Engl J Med. 2011;364(26):2483–95.')).toBeNull()
  })
})

describe('parseStyledEntry: Science / Frontiers / Chicago', () => {
  it('Science style: initials first, comma after authors', () => {
    expect(parseStyledEntry('B. A. Devlin, C. J. Smith, S. D. Bilbo, Sickness and the social brain: How the immune system regulates behavior across species. Brain. Behav. Evol. 97, 197–210 (2021), 10.1159/000521476.')).toMatchObject({
      style: 'science', authors: 'B. A. Devlin, C. J. Smith, S. D. Bilbo', title: 'Sickness and the social brain: How the immune system regulates behavior across species',
      journal: 'Brain. Behav. Evol.', year: 2021, volume: '97', pages: '197–210',
    })
  })

  it('Frontiers style: "Surname Initials." separated by spaces only, year in parentheses', () => {
    expect(parseStyledEntry('Schiff L. Migliori B. Chen Y. Carter D. Bonilla C. Hall J.. (2022). Integrating deep learning and unbiased automated high-content screening to identify complex disease signatures in human fibroblasts. Nat. Commun. 13:1590. doi: 10.1038/s41467-022-28423-4,')).toMatchObject({
      style: 'frontiers', authors: 'Schiff L. Migliori B. Chen Y. Carter D. Bonilla C. Hall J.', journal: 'Nat. Commun.', year: 2022, volume: '13', pages: '1590',
    })
  })

  it('Chicago: quoted title, volume (year): pages and volume, no. issue (year): pages', () => {
    expect(parseStyledEntry('H. Lv, S. Zhang, B. Wang, S. Cui, and J. Yan, “Toxicity of Cationic Lipids and Cationic Polymers in Gene Delivery,” Journal of Controlled Release 114 (2006): 100–109, 10.1016/j.jconrel.2006.04.014.')).toMatchObject({
      style: 'chicago', authors: 'H. Lv, S. Zhang, B. Wang, S. Cui, and J. Yan', title: 'Toxicity of Cationic Lipids and Cationic Polymers in Gene Delivery',
      journal: 'Journal of Controlled Release', year: 2006, volume: '114', issue: null, pages: '100–109',
    })
    expect(parseStyledEntry('R. Frost, A. T. Hess, T. W. Okell, et al., “Prospective Motion Correction and Selective Reacquisition Using Volumetric Navigators for Vessel‐Encoded Arterial Spin Labeling Dynamic Angiography,” Magnetic Resonance in Medicine 76, no. 5 (2016): 1420–1430, 10.1002/mrm.26040.')).toMatchObject({
      journal: 'Magnetic Resonance in Medicine', year: 2016, volume: '76', issue: '5', pages: '1420–1430',
    })
  })

  it('Chicago: merge an inverted first author back; reject entries citing a correction notice', () => {
    expect(parseStyledEntry('Šafářová, Nicole, Marián Kolenič, and Filip Španiel. 2025. “Beyond Dopamine: Exploring Anti-Inflammatory Mechanisms of Antipsychotics.” Progress in Neuro-Psychopharmacology & Biological Psychiatry 141: 111459.')?.authors)
      .toBe('Šafářová Nicole, Marián Kolenič, and Filip Španiel')
    expect(parseStyledEntry('Lv H. Correction to: “Toxicity of Cationic Lipids and Cationic Polymers in Gene Delivery,” Journal of Controlled Release 114 (2006): 100–109.')).toBeNull()
  })
})

describe('parseLocatorLoose', () => {
  it.each([
    ['J Gastrointest Surg. (2014) 21:2080–8. doi: 10.1007/s11605-014-2663-5', { volume: '21', issue: null, pages: '2080–8', year: 2014 }],
    ['Vision Res. 51, 1491–1525 (2011). 10.1016/j.visres.2011.04.012', { volume: '51', pages: '1491–1525', year: 2011 }],
    ['Chaos 27, 8–10. doi: 10.1063/1.4977951', { volume: '27', pages: '8–10' }],
    ['Science Advances. 2024;13(51):eadp3743. doi: 10.1126/sciadv.adp3743', { volume: '13', issue: '51', pages: 'eadp3743', year: 2024 }],
    ['J Clin Microbiol 65:e0083224. doi: 10.1128/jcm.00832-24', { volume: '65', pages: 'e0083224' }],
    ['PLoS One 20 (8), e0329385. 10.1371/journal.pone.0329385', { volume: '20', issue: '8', pages: 'e0329385' }],
  ])('%s', (entry, expected) => {
    expect(parseLocatorLoose(`Author A. Some title here. ${entry}`)).toMatchObject(expected)
  })

  it('No guessing when the entry does not end with volume/issue/pages', () => {
    expect(parseLocatorLoose('Smith J. Something in 10 sites, 2020. Some Journal.')).toBeNull()
    expect(parseLocatorLoose('Smith J. Results from 12, 345 patients in the cohort study')).toBeNull()
  })
})
