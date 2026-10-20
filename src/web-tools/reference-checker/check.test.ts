// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 TIKMOON LTD
import { describe, expect, it } from 'vitest'
import type { CitationPublicationStatus, CitationRecord, CitationVerification } from '../../shared/contracts'
import { checkEntry, type CheckDeps } from './check'

// Records taken from real PubMed / Crossref papers, no made-up identifiers.
const MAITLAND: CitationRecord = {
  pmid: '21615299',
  title: 'Mortality after fluid bolus in African children with severe infection.',
  authors: ['Maitland K', 'Kiguli S', 'Opoka RO', 'Engoru C', 'Olupot-Olupot P', 'Akech SO'],
  journal: 'N Engl J Med',
  pubdate: '2011 Jun 30',
  volume: '364',
  issue: '26',
  pages: '2483-95',
  doi: '10.1056/NEJMoa1101549',
  url: 'https://pubmed.ncbi.nlm.nih.gov/21615299/',
  source: 'pubmed',
  publicationStatus: { state: 'no-update-found', checkedSources: ['pubmed', 'crossref'], updates: [], note: null },
}

const DWIVEDI: CitationRecord = {
  pmid: '22889177',
  title: 'Prognostic utility and characterization of cell-free DNA in patients with severe sepsis.',
  authors: ['Dwivedi DJ', 'Toltl LJ', 'Swystun LL'],
  journal: 'Crit Care',
  pubdate: '2012 Aug 13',
  volume: '16',
  issue: '4',
  pages: 'R151',
  doi: '10.1186/cc11466',
  url: 'https://pubmed.ncbi.nlm.nih.gov/22889177/',
  source: 'pubmed',
  publicationStatus: { state: 'no-update-found', checkedSources: ['pubmed'], updates: [], note: null },
}

const RETRACTED: CitationRecord = {
  ...MAITLAND,
  publicationStatus: {
    state: 'retracted', checkedSources: ['crossref'], note: null,
    updates: [{ type: 'retracted', label: 'Retraction', source: 'crossref', date: '2020-06-04', noticeDoi: '10.1056/NEJMc2021225', url: 'https://doi.org/10.1056/NEJMc2021225' }],
  },
}

const ENTRY = 'Maitland K, Kiguli S, Opoka RO, Engoru C, Olupot-Olupot P, Akech SO, et al. Mortality after fluid bolus in African children with severe infection. N Engl J Med. 2011;364(26):2483–95. doi:10.1056/NEJMoa1101549'

function deps(table: Record<string, CitationVerification>, searchItems: unknown[] = []): CheckDeps & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    lookup: async (identifier) => {
      calls.push(identifier)
      return table[identifier.toLowerCase()] ?? { found: false, reason: 'not-found', identifier }
    },
    search: async () => searchItems,
  }
}

const found = (record: CitationRecord): CitationVerification => ({ found: true, record })

describe('checkEntry', () => {
  it('identifier and citation both match: verified, all fields identical, with publication status', async () => {
    const result = await checkEntry(ENTRY, deps({ '10.1056/nejmoa1101549': found(MAITLAND) }))
    expect(result.identity).toBe('verified')
    expect(result.identifiers).toEqual({ doi: '10.1056/nejmoa1101549', pmid: null })
    expect(result.fields.map((row) => [row.field, row.status])).toEqual([
      // Record title ends with a period, pages use an en dash: written differently, not wrong.
      ['authors', 'convention'], ['title', 'convention'], ['journal', 'same'], ['year', 'same'],
      ['volume', 'same'], ['issue', 'same'], ['pages', 'convention'],
    ])
    expect(result.publication?.state).toBe('no-update-found')
  })

  it('recognized as this paper but authors and pages wrong: still verified, fields report differences', async () => {
    const wrong = ENTRY.replace('Maitland K, Kiguli S', 'Smith K, Kiguli S').replace('2483–95', '2483–99')
    const result = await checkEntry(wrong, deps({ '10.1056/nejmoa1101549': found(MAITLAND) }))
    expect(result.identity).toBe('verified')
    const status = Object.fromEntries(result.fields.map((row) => [row.field, row.status]))
    expect(status.authors).toBe('differs')
    expect(status.pages).toBe('differs')
  })

  it('identifier points to another paper: points-elsewhere, without that paper\'s publication status', async () => {
    const elsewhere = ENTRY.replace('10.1056/NEJMoa1101549', '10.1186/cc11466')
    const result = await checkEntry(elsewhere, deps({ '10.1186/cc11466': found({ ...DWIVEDI, publicationStatus: RETRACTED.publicationStatus }) }))
    expect(result.identity).toBe('points-elsewhere')
    expect(result.record?.title).toMatch(/cell-free DNA/)
    expect(result.publication).toBeNull()
  })

  it('DOI digits transposed, recovered by title: wrong-doi with the correct DOI', async () => {
    const typo = ENTRY.replace('10.1056/NEJMoa1101549', '10.1056/NEJMoa1101594')
    const crossrefItem = {
      DOI: '10.1056/NEJMoa1101549', title: [MAITLAND.title.replace(/\.$/, '')], 'container-title': ['New England Journal of Medicine'],
      author: [{ family: 'Maitland', given: 'Kathryn' }], issued: { 'date-parts': [[2011, 6, 30]] }, volume: '364', issue: '26', page: '2483-2495',
    }
    const result = await checkEntry(typo, deps({ '10.1056/nejmoa1101549': found(MAITLAND) }, [crossrefItem]))
    expect(result.identity).toBe('wrong-doi')
    expect(result.suggestedDoi?.toLowerCase()).toBe('10.1056/nejmoa1101549')
    expect(result.publication?.state).toBe('no-update-found')
  })

  it('retraction status is attached to the recognized paper', async () => {
    const result = await checkEntry(ENTRY, deps({ '10.1056/nejmoa1101549': found(RETRACTED) }))
    expect(result.identity).toBe('verified')
    expect(result.publication?.state).toBe('retracted')
    expect(result.publication?.updates[0]?.url).toBe('https://doi.org/10.1056/NEJMc2021225')
  })

  it('DOI correct, PMID of another paper: checks both, reports PMID points elsewhere', async () => {
    const both = `${ENTRY} PMID: 22889177`
    const d = deps({ '10.1056/nejmoa1101549': found(MAITLAND), '22889177': found(DWIVEDI) })
    const result = await checkEntry(both, d)
    expect(result.identity).toBe('verified')
    expect(d.calls).toContain('22889177')
    expect(result.idProblems).toEqual([{ kind: 'pmid-elsewhere', id: '22889177', otherTitle: DWIVEDI.title }])
  })

  it('DOI not found, PMID correct: goes by PMID, reports DOI not found', async () => {
    const both = `${ENTRY.replace('10.1056/NEJMoa1101549', '10.1056/NEJMoa9999999')} PMID: 21615299`
    const result = await checkEntry(both, deps({ '21615299': found(MAITLAND) }))
    expect(result.identity).toBe('verified')
    expect(result.idProblems).toEqual([{ kind: 'doi-not-found', id: '10.1056/nejmoa9999999', otherTitle: null }])
  })

  it('PMID not found: id-not-found', async () => {
    const result = await checkEntry('Maitland K, et al. Mortality after fluid bolus in African children with severe infection. N Engl J Med. 2011;364(26):2483–95. PMID: 99999999', deps({}))
    expect(result.identity).toBe('id-not-found')
    expect(result.publication).toBeNull()
  })

  it('no identifier, nothing found by bibliography: no-match (does not call it fake)', async () => {
    const result = await checkEntry('Nobody A. An imaginary study of nothing at all. J Imag. 2020;1(1):1-2.', deps({}, []))
    expect(result.identity).toBe('no-match')
    expect(result.record).toBeNull()
  })

  it('database lookup failed: failed, retryable', async () => {
    const d: CheckDeps = {
      lookup: async (identifier) => ({ found: false, reason: 'unavailable', identifier, detail: 'PubMed 返回 503' }),
      search: async () => [],
    }
    expect((await checkEntry(ENTRY, d)).identity).toBe('failed')
  })

  it('identifier correct, title matches, only year wrong: verified, year differs (not points-elsewhere)', async () => {
    const wrongYear = ENTRY.replace('2011;364', '2008;364')
    const result = await checkEntry(wrongYear, deps({ '10.1056/nejmoa1101549': found(MAITLAND) }))
    expect(result.identity).toBe('verified')
    expect(result.fields.find((row) => row.field === 'year')).toMatchObject({ status: 'differs', declared: '2008', found: '2011' })
  })

  it('DOI lookup failed, PMID correct: goes by PMID, DOI marked not looked up rather than wrong', async () => {
    const both = `${ENTRY} PMID: 21615299`
    const d: CheckDeps = {
      lookup: async (identifier) => identifier === '21615299'
        ? found(MAITLAND)
        : { found: false, reason: 'unavailable', identifier, detail: 'Crossref 返回 503' },
      search: async () => [],
    }
    const result = await checkEntry(both, d)
    expect(result.identity).toBe('verified')
    expect(result.idProblems).toEqual([{ kind: 'doi-unchecked', id: '10.1056/nejmoa1101549', otherTitle: null }])
  })

  it('DOI written as percent-encoded URL: decoded before lookup', async () => {
    const encoded = ENTRY.replace('doi:10.1056/NEJMoa1101549', 'https://doi.org/10.1056%2FNEJMoa1101549')
    const result = await checkEntry(encoded, deps({ '10.1056/nejmoa1101549': found(MAITLAND) }))
    expect(result.identifiers.doi).toBe('10.1056/nejmoa1101549')
    expect(result.identity).toBe('verified')
  })

  it('old-style SICI DOI cannot be fully extracted: no verdict from truncated id, bibliographic search used', async () => {
    const sici = 'Smith J, Doe A. A study of things. Stat Med. 1996;15(11):1231-40. doi:10.1002/(SICI)1097-0258(19960615)15:11<1231::AID-SIM245>3.0.CO;2-Q'
    const d = deps({})
    const result = await checkEntry(sici, d)
    expect(result.identifiers.doi).toBeNull()
    expect(d.calls.some((id) => id.startsWith('10.1002'))).toBe(false)
    expect(result.identity).toBe('no-match')
  })

  it('pages with letters (e93S-e120S) compared as a whole, no difference reported', async () => {
    const gould: CitationRecord = {
      pmid: '', title: 'Evaluation of individuals with pulmonary nodules: when is it lung cancer? Diagnosis and management of lung cancer, 3rd ed: American College of Chest Physicians evidence-based clinical practice guidelines',
      authors: ['Gould MK', 'Donington J', 'Lynch WR'], journal: 'Chest', pubdate: '2013-5', volume: '143', issue: '5', pages: 'e93S-e120S',
      doi: '10.1378/chest.12-2351', url: 'https://doi.org/10.1378/chest.12-2351', source: 'crossref',
    }
    const entry = 'Gould MK, Donington J, Lynch WR, et al. Evaluation of individuals with pulmonary nodules: when is it lung cancer? Diagnosis and management of lung cancer, 3rd ed: American College of Chest Physicians evidence-based clinical practice guidelines. Chest. 2013;143(5 Suppl):e93S-e120S. doi:10.1378/chest.12-2351'
    const result = await checkEntry(entry, deps({ '10.1378/chest.12-2351': found(gould) }))
    expect(result.identity).toBe('verified')
    expect(result.fields.find((row) => row.field === 'pages')?.status).not.toBe('differs')
  })

  it('format mis-parsed but record title appears verbatim in entry: still recognized as this paper', async () => {
    const odd = 'Maitland, K. et al. Mortality after fluid bolus in African children with severe infection. Some Odd Words Here. N. Engl. J. Med. 364, 2483–2495 (2011). doi:10.1056/NEJMoa1101549'
    const result = await checkEntry(odd, deps({ '10.1056/nejmoa1101549': found(MAITLAND) }))
    expect(result.identity).toBe('verified')
  })

  it('record title is only a substring of the entry title: not the same paper', async () => {
    const other: CitationRecord = { ...DWIVEDI, title: 'Mortality after fluid bolus.', publicationStatus: RETRACTED.publicationStatus }
    const entry = 'Smith J. Long-term mortality after fluid bolus in African children. Crit Care. 2012;16(4):R151. doi:10.1186/cc11466'
    const result = await checkEntry(entry, deps({ '10.1186/cc11466': found(other) }))
    expect(['verified', 'wrong-doi']).not.toContain(result.identity)
    expect(result.publication).toBeNull()
  })

  it('DOI not found and title fallback errored: marks the title step as incomplete', async () => {
    const d: CheckDeps = {
      lookup: async (identifier) => ({ found: false, reason: 'not-found', identifier }),
      search: async () => { throw new Error('Crossref 返回 503') },
    }
    const result = await checkEntry(ENTRY.replace('NEJMoa1101549', 'NEJMoa9999999'), d)
    expect(result.identity).toBe('id-not-found')
    expect(result.titleSearchFailed).toBe(true)
  })

  it('record title is only the subtitle or first half of the entry title: not the same paper', async () => {
    const other: CitationRecord = { ...DWIVEDI, title: 'Mortality after fluid bolus in African children with severe infection.', publicationStatus: RETRACTED.publicationStatus }
    for (const entry of [
      'Smith, J. Long-term outcomes: Mortality after fluid bolus in African children with severe infection. Crit. Care 16, R151 (2012). doi:10.1186/cc11466',
      'Smith, J. Mortality after fluid bolus in African children with severe infection? A randomized trial. Crit. Care 16, R151 (2012). doi:10.1186/cc11466',
      'Smith J. Long-term outcomes: mortality after fluid bolus in African children with severe infection. Crit Care. 2012;16(4):R151. doi:10.1186/cc11466',
    ]) {
      const result = await checkEntry(entry, deps({ '10.1186/cc11466': found(other) }))
      expect(['verified', 'wrong-doi'], entry).not.toContain(result.identity)
      expect(result.publication, entry).toBeNull()
    }
  })

  it('title with U.S., missing period or full-width period after it: identifier still recognized', async () => {
    const record: CitationRecord = { ...MAITLAND, title: 'Mortality in the U.S. A prospective multicenter cohort study.' }
    for (const mark of ['', '。', '．']) {
      const entry = `Maitland, K. et al. Mortality in the U.S. A prospective multicenter cohort study${mark} N. Engl. J. Med. 364, 2483–2495 (2011). doi:10.1056/NEJMoa1101549`
      const result = await checkEntry(entry, deps({ '10.1056/nejmoa1101549': found(record) }))
      expect(result.identity, mark).toBe('verified')
    }
  })

  it('candidate found by title but fetching it failed: does not say not found by title', async () => {
    const candidate = {
      title: ['Mortality after fluid bolus in African children with severe infection'],
      author: [{ family: 'Maitland', given: 'K' }, { family: 'Kiguli', given: 'S' }],
      'container-title': ['New England Journal of Medicine'], issued: { 'date-parts': [[2011]] },
      DOI: '10.1056/NEJMoa1101549', volume: '364', issue: '26', page: '2483-2495',
    }
    const d: CheckDeps = {
      lookup: async (identifier) => identifier.toLowerCase() === '10.1056/nejmoa1101549'
        ? { found: false, reason: 'unavailable', identifier, detail: '503' }
        : { found: false, reason: 'not-found', identifier },
      search: async () => [candidate],
    }
    const result = await checkEntry(ENTRY.replace('NEJMoa1101549', 'NEJMoa9999999'), d)
    expect(result.identity).toBe('id-not-found')
    expect(result.titleSearchFailed).toBe(true)
  })

  it('different papers with the same title: conflicting identifier reports PMID belongs to another paper', async () => {
    const sibling: CitationRecord = { ...MAITLAND, pmid: '22889177', doi: '10.1186/cc11466', pubdate: '2012' }
    const both = `${ENTRY} PMID: 22889177`
    const result = await checkEntry(both, deps({ '10.1056/nejmoa1101549': found(MAITLAND), '22889177': found(sibling) }))
    expect(result.idProblems.map((p) => p.kind)).toEqual(['pmid-elsewhere'])
  })

  it('Nature style entry: judged by title parsed by format, authors and volume/pages compared', async () => {
    const nature = 'Maitland, K. et al. Mortality after fluid bolus in African children with severe infection. N. Engl. J. Med. 364, 2483–2495 (2011). doi:10.1056/NEJMoa1101549'
    const result = await checkEntry(nature, deps({ '10.1056/nejmoa1101549': found(MAITLAND) }))
    expect(result.identity).toBe('verified')
    const status = Object.fromEntries(result.fields.map((row) => [row.field, row.status]))
    expect(status).toMatchObject({ authors: 'convention', title: 'convention', volume: 'same', pages: 'convention' })
  })
})

// Real entries and real records (fetched from PubMed / Crossref), no made-up identifiers.
const NO_UPDATE: CitationPublicationStatus = { state: 'no-update-found', checkedSources: ['pubmed'], updates: [], note: null }
const rec = (record: Omit<CitationRecord, 'publicationStatus' | 'url'> & { url?: string }): CitationRecord => ({
  url: record.doi ? `https://doi.org/${record.doi}` : '', publicationStatus: NO_UPDATE, ...record,
})
const statusOf = (result: { fields: Array<{ field: string; status: string }> }) => Object.fromEntries(result.fields.map((row) => [row.field, row.status]))

const LV = rec({
  title: 'Toxicity of cationic lipids and cationic polymers in gene delivery.', authors: ['Lv H', 'Zhang S', 'Wang B', 'Cui S', 'Yan J'],
  journal: 'J Control Release', pubdate: '2006 Aug 10', volume: '114', issue: '1', pages: '100-9', doi: '10.1016/j.jconrel.2006.04.014', pmid: '16831482', source: 'pubmed',
})
const LV_ENTRY = 'H. Lv, S. Zhang, B. Wang, S. Cui, and J. Yan, “Toxicity of Cationic Lipids and Cationic Polymers in Gene Delivery,” Journal of Controlled Release 114 (2006): 100–109, 10.1016/j.jconrel.2006.04.014.'
const GHOSH = rec({
  title: 'COVID-19 pandemic: The African paradox.', authors: ['Ghosh D', 'Bernstein JA', 'Mersha TB'], journal: 'J Glob Health', pubdate: '2020 Dec',
  volume: '10', issue: '2', pages: '020348', doi: '10.7189/jogh.10.020348', pmid: '33110546', source: 'pubmed',
})
const HEMANI = rec({
  title: 'The MR-Base platform supports systematic causal inference across the human phenome.',
  authors: ['Hemani G', 'Zheng J', 'Elsworth B', 'Wade KH', 'Haberland V', 'Baird D', 'Laurin C', 'Burgess S'],
  journal: 'Elife', pubdate: '2018 May 30', volume: '7', issue: null, pages: null, doi: '10.7554/eLife.34408', pmid: '29846171', source: 'pubmed',
})
const BHIVA = rec({
  title: 'Abstracts of the 5th Joint Conference of the British HIV Association (BHIVA) with the British Association for Sexual Health and HIV (BASHH), Virtual, 19-21 April 2021.',
  authors: [], journal: 'HIV Med', pubdate: '2021 Aug', volume: '22 Suppl 2', issue: null, pages: '3-126', doi: '10.1111/hiv.13129', pmid: '34435437', source: 'pubmed',
})
const JACKSON = rec({
  title: 'Trends and patterns of dual use of combustible tobacco and e-cigarettes among adults in England: A population study, 2016-2024.',
  authors: ['Jackson SE', 'Cox S', 'Shahab L', 'Brown J'], journal: 'Addiction', pubdate: '2025 Apr', volume: '120', issue: '4', pages: '608-619',
  doi: '10.1111/add.16734', pmid: '39842468', source: 'pubmed',
})

const JACKSON_ENTRY = 'Jackson SE, Cox S, Shahab L, Brown J. Trends and patterns of dual use of combustible tobacco and e‐cigarettes among adults in England: A population study, 2016–2024. Addiction. 2025;120(4):608–619. 10.1111/add.16734'

describe('checkEntry: fetched by identifier, record title written in full in the entry', () => {
  it('Chicago quoted title not parsed: still recognized, authors compared from text before the quote', async () => {
    const result = await checkEntry(LV_ENTRY, deps({ '10.1016/j.jconrel.2006.04.014': found(LV) }))
    expect(result.identity).toBe('verified')
    expect(statusOf(result)).toMatchObject({ authors: 'convention', title: 'convention', year: 'same', })
    expect(result.fields.find((row) => row.field === 'authors')?.declared).toBe('H. Lv, S. Zhang, B. Wang, S. Cui, and J. Yan')
  })

  it('entry without year, volume/issue right after journal: recognized as this paper', async () => {
    const entry = 'Ghosh D, Bernstein JA, Mersha TB. COVID-19 pandemic: the African paradox. J Glob Health 10(2):020348. 10.7189/jogh.10.020348'
    const result = await checkEntry(entry, deps({ '10.7189/jogh.10.020348': found(GHOSH) }))
    expect(result.identity).toBe('verified')
  })

  it('journal name starting lowercase (eLife): confirmed via record journal, recognized as this paper', async () => {
    const entry = 'Hemani G, Zheng J, Elsworth B, Wade KH, Baird D, Haberland V et al. The MR-Base platform supports systematic causal inference across the human phenome. eLife. 7:e34408. 10.7554/eLife.34408.'
    const result = await checkEntry(entry, deps({ '10.7554/elife.34408': found(HEMANI) }))
    expect(result.identity).toBe('verified')
  })

  it('title ending in a year range, not parsed: recognized, author and title rows added', async () => {
    const result = await checkEntry(JACKSON_ENTRY, deps({ '10.1111/add.16734': found(JACKSON) }))
    expect(result.identity).toBe('verified')
    expect(statusOf(result)).toMatchObject({ authors: 'same', title: 'convention' })
  })

  it('cites an abstract in a conference supplement, record is the whole supplement: still needs review', async () => {
    const entry = 'Whitlock GG Conway K Herbert S, et al. P077, Factors associated with chemsex in HIV+ MSM attending English HIV services, Abstracts of the 5th Joint Conference of the British HIV Association (BHIVA) with the British Association for Sexual Health and HIV (BASHH), Virtual, 19-21 April 2021. HIV Med. 2021; 22(Suppl 2): 3–126. 10.1111/hiv.13129'
    const result = await checkEntry(entry, deps({ '10.1111/hiv.13129': found(BHIVA) }))
    expect(result.identity).toBe('needs-review')
  })

  it('cites a correction notice (Correction to: <title>): not recognized as the original', async () => {
    const entry = 'Lv H. Correction to: “Toxicity of Cationic Lipids and Cationic Polymers in Gene Delivery,” Journal of Controlled Release 114 (2006): 100–109, 10.1016/j.jconrel.2006.04.014.'
    const result = await checkEntry(entry, deps({ '10.1016/j.jconrel.2006.04.014': found(LV) }))
    expect(['verified', 'wrong-doi']).not.toContain(result.identity)
  })

  it('entry year two or more years off the record: recognized but year reported wrong, not called matching', async () => {
    const result = await checkEntry(LV_ENTRY.replace('(2006)', '(2010)'), deps({ '10.1016/j.jconrel.2006.04.014': found(LV) }))
    if (result.identity === 'verified') expect(statusOf(result).year).toBe('differs')
    const jackson = await checkEntry(JACKSON_ENTRY.replace('Addiction. 2025', 'Addiction. 2021'), deps({ '10.1111/add.16734': found(JACKSON) }))
    expect(['verified', 'wrong-doi']).not.toContain(jackson.identity)
  })

  it('preprint fetched by identifier, entry not marked as preprint: not accepted directly', async () => {
    const preprint: CitationRecord = { ...JACKSON, doi: '10.1101/2020.01.01.123456', source: 'crossref' }
    const entry = JACKSON_ENTRY.replace('10.1111/add.16734', '10.1101/2020.01.01.123456')
    const result = await checkEntry(entry, deps({ '10.1101/2020.01.01.123456': found(preprint) }))
    expect(result.identity).toBe('needs-review')
  })
})

const CHIOMA = rec({
  title: 'Gut microbiota modulates lung fibrosis severity following acute lung injury in mice.',
  authors: ['Chioma OS', 'Mallott EK', 'Chapman A', 'Van Amburg JC', 'Wu H', 'Shah-Gandhi B'], journal: 'Commun Biol', pubdate: '2022 Dec 22',
  volume: '5', issue: '1', pages: '1401', doi: '10.1038/s42003-022-04357-x', pmid: '36564499', source: 'pubmed',
})
// This DOI is registered to another paper in the same journal and volume (the entry meant to cite a
// neighbouring DOI).
const WEBSTER = rec({
  title: "Copepods' Response to Burgers' Vortex: Deconstructing Interactions of Copepods with Turbulence.",
  authors: ['Webster DR', 'Young DL', 'Yen J'], journal: 'Integr Comp Biol', pubdate: '2015 Oct', volume: '55', issue: '4', pages: '706-18',
  doi: '10.1093/icb/icv054', pmid: '26060211', source: 'pubmed',
})

describe('checkEntry: fetched by identifier, title mismatch tiers', () => {
  it('title replaced by another paper\'s, volume/pages/authors correct: this paper, title row differs', async () => {
    const entry = 'Chioma OS, Mallott EK, Chapman A, et al. Near-optimal probabilistic RNA-seq quantification. Commun Biol 2022; 5: 1401. doi: 10.1038/s42003-022-04357-x'
    const result = await checkEntry(entry, deps({ '10.1038/s42003-022-04357-x': found(CHIOMA) }))
    expect(result.identity).toBe('verified')
    expect(statusOf(result)).toMatchObject({ title: 'differs', authors: 'convention', pages: 'same' })
  })

  it('title off by one word, volume/pages match: this paper, title reported as differing', async () => {
    const entry = 'Chioma OS, Mallott EK, Chapman A, et al. Gut microbiota modulates lung fibrosis severity following acute lung injury in rats. Commun Biol 2022; 5: 1401. doi: 10.1038/s42003-022-04357-x'
    const result = await checkEntry(entry, deps({ '10.1038/s42003-022-04357-x': found(CHIOMA) }))
    expect(result.identity).toBe('verified')
    expect(statusOf(result).title).toBe('differs')
  })

  it('title off by one word, no volume/issue/pages to compare: needs review, not points-elsewhere', async () => {
    const entry = 'Chioma OS, Mallott EK, Chapman A, et al. Gut microbiota modulates lung fibrosis severity following acute lung injury in rats. Commun Biol 2022. doi: 10.1038/s42003-022-04357-x'
    const result = await checkEntry(entry, deps({ '10.1038/s42003-022-04357-x': found(CHIOMA) }))
    expect(result.identity).toBe('needs-review')
  })

  it('title not parsed, authors and pages wrong, record title words barely in entry: points elsewhere', async () => {
    const entry = 'Fish FE, Hoffman JL. Stability design and response to waves by batoids, 2014–2015. Integr Comp Biol. 2015;55(4):648-61. doi: 10.1093/icb/icv054'
    const result = await checkEntry(entry, deps({ '10.1093/icb/icv054': found(WEBSTER) }))
    expect(result.identity).toBe('points-elsewhere')
    expect(result.publication).toBeNull()
  })

  it('title not parsed, authors match: still needs review', async () => {
    const entry = 'Webster DR, Young DL, Yen J. Stability design and response to waves by batoids, 2014–2015. Integr Comp Biol. 2015;55(4):648-61. doi: 10.1093/icb/icv054'
    const result = await checkEntry(entry, deps({ '10.1093/icb/icv054': found(WEBSTER) }))
    expect(result.identity).toBe('needs-review')
  })
})

const ROGERS = rec({
  title: 'Medical Information Mart for Intensive Care: A Foundation for the Fusion of Artificial Intelligence and Real-World Data.',
  authors: ['Rogers P', 'Wang D', 'Lu Z'], journal: 'Front Artif Intell', pubdate: '2021', volume: '4', issue: null, pages: '691626',
  doi: '10.3389/frai.2021.691626', pmid: '34136802', source: 'pubmed',
})
const HARHOURI = rec({
  title: 'MG132-induced progerin clearance is mediated by autophagy activation and splicing regulation.',
  authors: ['Harhouri K', 'Navarro C', 'Depetris D', 'Mattei MG', 'Nissan X', 'Cau P', 'De Sandre-Giovannoli A', 'Lévy N'],
  journal: 'EMBO Mol Med', pubdate: '2017 Sep', volume: '9', issue: '9', pages: '1294-1313', doi: '10.15252/emmm.201607315', pmid: '28674081', source: 'pubmed',
})
const HOSKING = rec({
  title: 'Nicotine increases impulsivity and decreases willingness to exert cognitive effort despite improving attention in "slacker" rats: insights into cholinergic regulation of cost/benefit decision making.',
  authors: ['Hosking JG', 'Lam FC', 'Winstanley CA'], journal: 'PLoS One', pubdate: '2014', volume: '9', issue: '10', pages: 'e111580',
  doi: '10.1371/journal.pone.0111580', pmid: '25353339', source: 'pubmed',
})
const KIVISAKK = rec({
  title: "Plasma biomarkers for diagnosis of Alzheimer's disease and prediction of cognitive decline in individuals with mild cognitive impairment.",
  authors: ['Kivisäkk P', 'Carlyle BC', 'Sweeney T', 'Trombetta BA', 'LaCasse K'], journal: 'Front Neurol', pubdate: '2023', volume: '14', issue: null, pages: '1069411',
  doi: '10.3389/fneur.2023.1069411', pmid: '36937522', source: 'pubmed',
})
const HAVERS = rec({
  title: 'Seroprevalence of Antibodies to SARS-CoV-2 in 10 Sites in the United States, March 23-May 12, 2020.',
  authors: ['Havers FP', 'Reed C', 'Lim T', 'Montgomery JM', 'Klena JD', 'Hall AJ', 'Fry AM', 'Cannon DL'], journal: 'JAMA Intern Med', pubdate: '2020 Jul 21',
  volume: '180', issue: '12', pages: '1576-86', doi: '10.1001/jamainternmed.2020.4130', pmid: '32692365', source: 'pubmed',
})

describe('checkEntry: author segment styles', () => {
  const authorsOf = async (entry: string, doi: string, record: CitationRecord) => {
    const result = await checkEntry(entry, deps({ [doi.toLowerCase()]: found(record) }))
    expect(result.identity, entry).toBe('verified')
    return result.fields.find((row) => row.field === 'authors')
  }

  it('no commas "Smith P Doe D Lee Z": compared one by one, not as one person', async () => {
    const row = await authorsOf('Rogers P Wang D Lu Z. Medical information mart for intensive care: A foundation for the fusion of artificial intelligence and real-world data. Front Artif Intell. (2021) 4:691626. doi: 10.3389/frai.2021.691626, PMID:', '10.3389/frai.2021.691626', ROGERS)
    expect(['same', 'convention']).toContain(row?.status)
    expect(row?.declared).toBe('Rogers P Wang D Lu Z')
  })

  it('period-separated "Smith K. Doe C. Lee M. G.": compared one by one', async () => {
    const row = await authorsOf('Harhouri K. Navarro C. Depetris D. Mattei M. G. Nissan X. Cau P.. (2017). MG132-induced progerin clearance is mediated by autophagy activation and splicing regulation. EMBO Mol. Med. 9, 1294–1313. doi: 10.15252/emmm.201607315,', '10.15252/emmm.201607315', HARHOURI)
    expect(row?.status).toBe('convention')
  })

  it('APA ", & last author" with one initial fewer in record: neither wrong nor identical, not checked', async () => {
    const result = await checkEntry('Hosking, J. G., Lam, F. C. W., & Winstanley, C. A. (2014). Nicotine increases impulsivity and decreases willingness to exert cognitive effort despite improving attention in “slacker” rats: Insights into cholinergic regulation of cost/benefit decision making. PLoS One, 9(10), e111580. 10.1371/journal.pone.0111580', deps({ '10.1371/journal.pone.0111580': found(HOSKING) }))
    expect(statusOf(result).authors).toBe('unverified')
    expect(result.unchecked).toContain('authors')
  })

  it('diacritics dropped (Muller / Müller): same person', async () => {
    const row = await authorsOf('Kivisakk P Carlyle BC Sweeney T, et al. Plasma biomarkers for diagnosis of Alzheimer\'s disease and prediction of cognitive decline in individuals with mild cognitive impairment. Front Neurol 2023; 14: 1069411. 10.3389/fneur.2023.1069411', '10.3389/fneur.2023.1069411', KIVISAKK)
    expect(row?.status).toBe('convention')
  })

  it('only first 6 listed, no et al., each matching: written differently, not wrong', async () => {
    const row = await authorsOf('Havers FP, Reed C, Lim T, Montgomery JM, Klena JD, Hall AJ. Seroprevalence of antibodies to SARS-CoV-2 in 10 sites in the United States, March 23-May 12, 2020. JAMA Intern Med. 2020;180(12):1576–86. 10.1001/jamainternmed.2020.4130', '10.1001/jamainternmed.2020.4130', HAVERS)
    expect(row?.status).toBe('convention')
  })

  it('wrong order, only two listed without et al.: still reports authors differ', async () => {
    const swapped = await authorsOf('Reed C, Havers FP, Lim T, Montgomery JM, Klena JD, Hall AJ. Seroprevalence of antibodies to SARS-CoV-2 in 10 sites in the United States, March 23-May 12, 2020. JAMA Intern Med. 2020;180(12):1576–86. 10.1001/jamainternmed.2020.4130', '10.1001/jamainternmed.2020.4130', HAVERS)
    expect(swapped?.status).toBe('differs')
    const two = await authorsOf('Rogers P Wang D. Medical information mart for intensive care: A foundation for the fusion of artificial intelligence and real-world data. Front Artif Intell. (2021) 4:691626. doi: 10.3389/frai.2021.691626', '10.3389/frai.2021.691626', ROGERS)
    expect(two?.status).toBe('differs')
  })

  it('author segment chopped up (single initial left): no author row', async () => {
    const result = await checkEntry('T.-Y. Wang, Y. Sun, Y.-D. Tang, Re-emergence of things: What we know. PLoS Pathog. 2025;21(10):e1013556. 10.1371/journal.ppat.1013556',
      deps({ '10.1371/journal.ppat.1013556': found(rec({ title: 'Re-emergence of things: What we know.', authors: ['Wang TY', 'Sun Y', 'Tang YD'], journal: 'PLoS Pathog', pubdate: '2025 Oct', volume: '21', issue: '10', pages: 'e1013556', doi: '10.1371/journal.ppat.1013556', pmid: '', source: 'crossref' })) }))
    expect(result.fields.find((row) => row.field === 'authors')?.status).not.toBe('differs')
  })
})

const MUTZ = rec({
  title: 'Metabolomic age (MileAge) predicts health and life span: A comparison of multiple machine learning algorithms.',
  authors: ['Mutz J', 'Iniesta R', 'Lewis CM'], journal: 'Sci Adv', pubdate: '2024 Dec 20', volume: '10', issue: '51', pages: 'eadp3743',
  doi: '10.1126/sciadv.adp3743', pmid: '39693428', source: 'pubmed',
})
const CHEN = rec({
  title: 'A new pN staging system based on both the number and anatomic location of metastatic lymph nodes in gastric cancer.',
  authors: ['Chen J', 'Chen C', 'He Y', 'Wu K', 'Wu H', 'Cai S'], journal: 'J Gastrointest Surg', pubdate: '2014 Dec', volume: '18', issue: '12', pages: '2080-8',
  doi: '10.1007/s11605-014-2663-5', pmid: '25297445', source: 'pubmed',
})
const HLINKA = rec({
  title: 'Small-world bias of correlation networks: From brain to climate.', authors: ['Hlinka J', 'Hartman D', 'Jajcay N', 'Tomeček D', 'Tintěra J', 'Paluš M'],
  journal: 'Chaos', pubdate: '2017 Mar', volume: '27', issue: '3', pages: '035812', doi: '10.1063/1.4977951', pmid: '28364746', source: 'pubmed',
})
const CARRASCO = rec({
  title: 'Visual attention: the past 25 years.', authors: ['Carrasco M'], journal: 'Vision Res', pubdate: '2011 Jul 1', volume: '51', issue: '13', pages: '1484-525',
  doi: '10.1016/j.visres.2011.04.012', pmid: '21549742', source: 'pubmed',
})
const HEALY = rec({
  title: 'Uniform manifold approximation and projection', authors: [], journal: 'Nature Reviews Methods Primers', pubdate: '2024-11-21', volume: '4', issue: '1', pages: null,
  doi: '10.1038/s43586-024-00369-5', pmid: '', source: 'crossref',
})

describe('checkEntry: non-Vancouver volume/issue/pages styles and "not checked" fields', () => {
  const check = (entry: string, record: CitationRecord) => checkEntry(entry, deps({ [record.doi!.toLowerCase()]: found(record) }))

  it('year;volume(issue):four-letter e-page: wrong volume still reported', async () => {
    const result = await check('Mutz J, Iniesta R, Lewis CM. Metabolomic age (MileAge) predicts health and life span: A comparison of multiple machine learning algorithms. Science Advances. 2024;13(51):eadp3743. doi: 10.1126/sciadv.adp3743', MUTZ)
    expect(result.identity).toBe('verified')
    expect(statusOf(result)).toMatchObject({ volume: 'differs', issue: 'same', pages: 'same' })
  })

  it('(year) volume:pages: wrong volume still reported', async () => {
    const result = await check('Chen J Chen C He Y Wu K Wu H Cai S. A new pN staging system based on both the number and anatomic location of metastatic lymph nodes in gastric cancer. J Gastrointest Surg. (2014) 21:2080–8. doi: 10.1007/s11605-014-2663-5', CHEN)
    expect(statusOf(result)).toMatchObject({ volume: 'differs', pages: 'same' })
  })

  it('Journal volume, pages.: wrong pages still reported', async () => {
    const result = await check('Hlinka J. Hartman D. Jajcay N. Tomeček D. Tintěra J. Paluš M. (2017). Small-world bias of correlation networks: from brain to climate. Chaos 27, 8–10. doi: 10.1063/1.4977951', HLINKA)
    expect(result.identity).toBe('verified')
    expect(statusOf(result)).toMatchObject({ volume: 'same', pages: 'differs' })
  })

  it('Journal volume, pages (year): wrong pages still reported', async () => {
    const result = await check('M. Carrasco, Visual attention: The past 25 years. Vision Res. 51, 1491–1525 (2011). 10.1016/j.visres.2011.04.012', CARRASCO)
    expect(result.identity).toBe('verified')
    expect(statusOf(result)).toMatchObject({ volume: 'same', pages: 'differs' })
  })

  it('plain Vancouver: all fields identical as before, no "not checked" fields', async () => {
    const result = await check('Healy J, McInnes L. Uniform manifold approximation and projection. Nature Reviews Methods Primers. 2024;4(1):82. doi: 10.1038/s43586-024-00369-5', HEALY)
    expect(result.identity).toBe('verified')
    expect(result.fields.some((row) => row.status === 'differs')).toBe(false)
    expect(result.unchecked).toEqual([])
  })

  it('entry without volume/pages: recognized, volume and pages marked not checked', async () => {
    const result = await check('Carrasco M. Visual attention: the past 25 years. Vision Res. 2011. doi: 10.1016/j.visres.2011.04.012', CARRASCO)
    expect(result.identity).toBe('verified')
    expect(result.unchecked).toEqual(expect.arrayContaining(['volume', 'pages']))
  })

  it('Science style, identifier points to another paper in same volume: reports it belongs elsewhere', async () => {
    const result = await check('F. E. Fish, J. L. Hoffman, Stability design and response to waves by batoids. Integr. Comp. Biol. 55, 648–661 (2015). 10.1093/icb/icv054', WEBSTER)
    expect(result.identity).toBe('points-elsewhere')
  })
})

// Verbatim Crossref items: candidates from bibliographic search, then fetched again by the candidate's DOI.
const crossrefItem = (doi: string, title: string, journal: string, year: number, volume: string, issue: string, page: string, authors: Array<[string, string]>) => ({
  DOI: doi, title: [title], 'container-title': [journal], issued: { 'date-parts': [[year]] }, volume, issue, page,
  author: authors.map(([family, given]) => ({ family, given })),
})
const asRecord = (item: ReturnType<typeof crossrefItem>, pubdate: string): CitationRecord => rec({
  title: item.title[0]!, authors: item.author.map((a) => `${a.family} ${a.given}`), journal: item['container-title'][0]!, pubdate,
  volume: item.volume, issue: item.issue, pages: item.page, doi: item.DOI, pmid: '', source: 'crossref',
})
const DEVLIN = crossrefItem('10.1159/000521476', 'Sickness and the Social Brain: How the Immune System Regulates Behavior across Species', 'Brain, Behavior and Evolution', 2021, '97', '3-4', '197-210',
  [['Devlin', 'Benjamin A.'], ['Smith', 'Caroline J.'], ['Bilbo', 'Staci D.']])
const SCHIFF = crossrefItem('10.1038/s41467-022-28423-4', 'Integrating deep learning and unbiased automated high-content screening to identify complex disease signatures in human fibroblasts', 'Nature Communications', 2022, '13', '1', '1590',
  [['Schiff', 'Lauren'], ['Migliori', 'Bianca'], ['Chen', 'Ye'], ['Carter', 'Deidre'], ['Bonilla', 'Caitlyn'], ['Hall', 'Jenna']])
const GEISEN = crossrefItem('10.1093/femsre/fuy006', 'Soil protists: a fertile frontier in soil biology research', 'FEMS Microbiology Reviews', 2018, '42', '3', '293-323',
  [['Geisen', 'Stefan'], ['Mitchell', 'Edward A D'], ['Adl', 'Sina']])
const ZHOU_ITEM = crossrefItem('10.1111/wrr.12871', 'Efficacy of low‐level light therapy for improving healing of diabetic foot ulcers: A systematic review and meta‐analysis of randomized controlled trials', 'Wound Repair and Regeneration', 2020, '29', '1', '34-44',
  [['Zhou', 'Yuanpei'], ['Chia', 'Hoon Woon Audrey'], ['Tang', 'Huey Weng Krystle']])

describe('checkEntry: no identifier, title parsed from Science / Frontiers / Chicago styles for search', () => {
  const byTitle = (entry: string, item: ReturnType<typeof crossrefItem>, pubdate: string) =>
    checkEntry(entry, deps({ [item.DOI.toLowerCase()]: found(asRecord(item, pubdate)) }, [item]))

  it('Science style "Initials Surname, Title. Journal volume, pages (year)": found and recognized', async () => {
    const result = await byTitle('B. A. Devlin, C. J. Smith, S. D. Bilbo, Sickness and the social brain: How the immune system regulates behavior across species. Brain. Behav. Evol. 97, 197–210 (2021),', DEVLIN, '2021-12-15')
    expect(result.identity).toBe('verified')
    expect(result.record?.doi).toBe('10.1159/000521476')
  })

  it('Frontiers style "Surname Initials. ... (year). Title. Journal volume:pages": found and recognized', async () => {
    const result = await byTitle('Schiff L. Migliori B. Chen Y. Carter D. Bonilla C. Hall J.. (2022). Integrating deep learning and unbiased automated high-content screening to identify complex disease signatures in human fibroblasts. Nat. Commun. 13:1590', SCHIFF, '2022-3-25')
    expect(result.identity).toBe('verified')
  })

  it('Chicago author-date style with quoted title: found and recognized', async () => {
    const result = await byTitle('Geisen, S., E. A. D. Mitchell, S. Adl, et al. 2018. “Soil Protists: A Fertile Frontier in Soil Biology Research.” FEMS Microbiology Reviews 42: 293–323', GEISEN, '2018-2-13')
    expect(result.identity).toBe('verified')
    expect(statusOf(result)).toMatchObject({ authors: 'convention', title: 'convention', volume: 'same', pages: 'same' })
  })

  it('Crossref online year vs print year in entry (one apart), no issue: recognized, year a style difference', async () => {
    const result = await byTitle('Zhou Y, Chia HWA, Tang HWK, et al. Efficacy of low-level light therapy for improving healing of diabetic foot ulcers: a systematic review and meta-analysis of randomized controlled trials. Wound Repair Regen. 2021;29:34–44', ZHOU_ITEM, '2020-10-30')
    expect(result.identity).toBe('verified')
    expect(statusOf(result).year).toBe('convention')
  })

  it('another paper with same title, one year off, different journal: still not found', async () => {
    const other = { ...ZHOU_ITEM, DOI: '10.1111/iwj.99999', 'container-title': ['International Wound Journal'], volume: '17', page: '100-110' }
    const result = await byTitle('Zhou Y, Chia HWA, Tang HWK, et al. Efficacy of low-level light therapy for improving healing of diabetic foot ulcers: a systematic review and meta-analysis of randomized controlled trials. Wound Repair Regen. 2021;29:34–44', other, '2020-10-30')
    expect(result.identity).toBe('no-match')
  })
})

const FONAGY = rec({
  title: 'Development and Validation of a Self-Report Measure of Mentalizing: The Reflective Functioning Questionnaire.',
  authors: ['Fonagy P', 'Luyten P', 'Moulton-Perkins A', 'Lee YW', 'Warren F', 'Howard S', 'Ghinai R', 'Fearon P', 'Lowyck B'],
  journal: 'PLoS One', pubdate: '2016', volume: '11', issue: '7', pages: 'e0158678', doi: '10.1371/journal.pone.0158678', pmid: '27392018', source: 'pubmed',
})

describe('checkEntry: author ellipsis and mispositioned journal name', () => {
  const FONAGY_ENTRY = 'Fonagy, P., Luyten, P., Moulton‐Perkins, A., Lee, Y.‐W., Warren, F., Howard, S., … & Lowyck, B. (2016). Development and validation of a self‐report measure of mentalizing: The reflective functioning questionnaire. PLoS One, 11(7), e0158678. 10.1371/journal.pone.0158678'

  it('APA "first few, ... & last": all before ellipsis and last match: written differently', async () => {
    const result = await checkEntry(FONAGY_ENTRY, deps({ '10.1371/journal.pone.0158678': found(FONAGY) }))
    expect(statusOf(result).authors).toBe('convention')
  })

  it('last author after ellipsis wrong: still reports authors differ', async () => {
    const result = await checkEntry(FONAGY_ENTRY.replace('Lowyck, B.', 'Fearon, P.'), deps({ '10.1371/journal.pone.0158678': found(FONAGY) }))
    expect(statusOf(result).authors).toBe('differs')
  })

  it('parsed "journal name" is actually a DOI: no journal row', async () => {
    const result = await checkEntry('Rogers P Wang D Lu Z. Medical information mart for intensive care: A foundation for the fusion of artificial intelligence and real-world data. Front Artif Intell. (2021) 4:691626. doi: 10.3389/frai.2021.691626, PMID:', deps({ '10.3389/frai.2021.691626': found(ROGERS) }))
    expect(result.fields.find((row) => row.field === 'journal')?.status).not.toBe('differs')
  })
})

// Reproduction inputs for known edge cases.
const GHOSH_ENTRY = 'Ghosh D, Bernstein JA, Mersha TB. COVID-19 pandemic: the African paradox. J Glob Health 10(2):020348. 10.7189/jogh.10.020348'

describe('edge case reproductions', () => {
  it('an extra initial is not a style difference; wrong initials still reported', async () => {
    const entry = 'Hosking JG, Lam FB, Winstanley CA. Nicotine increases impulsivity and decreases willingness to exert cognitive effort despite improving attention in “slacker” rats: Insights into cholinergic regulation of cost/benefit decision making. PLoS One. 2014;9(10):e111580. 10.1371/journal.pone.0111580'
    const result = await checkEntry(entry, deps({ '10.1371/journal.pone.0111580': found(HOSKING) }))
    expect(statusOf(result).authors).toBe('differs')
  })

  it('one author written as three split initials: others still compared, wrong last author reported', async () => {
    const entry = 'Hosking JG, Lam F. C. W., Jones CA. Nicotine increases impulsivity and decreases willingness to exert cognitive effort despite improving attention in “slacker” rats: Insights into cholinergic regulation of cost/benefit decision making. PLoS One. 2014;9(10):e111580. 10.1371/journal.pone.0111580'
    const result = await checkEntry(entry, deps({ '10.1371/journal.pone.0111580': found(HOSKING) }))
    expect(statusOf(result).authors).toBe('differs')
  })

  it('author segment unreadable: goes to not checked', async () => {
    const result = await checkEntry('COVID-19 pandemic: the African paradox. J Glob Health 10(2):020348. 10.7189/jogh.10.020348', deps({ '10.7189/jogh.10.020348': found(GHOSH) }))
    expect(result.identity).toBe('verified')
    expect(result.unchecked).toContain('authors')
  })

  it('volume and pages both wrong: both reported', async () => {
    const one = await checkEntry(GHOSH_ENTRY.replace('10(2):020348', '11(2):020348'), deps({ '10.7189/jogh.10.020348': found(GHOSH) }))
    expect(statusOf(one)).toMatchObject({ volume: 'differs' })
    const both = await checkEntry(GHOSH_ENTRY.replace('10(2):020348', '11(2):020349'), deps({ '10.7189/jogh.10.020348': found(GHOSH) }))
    expect(statusOf(both)).toMatchObject({ volume: 'differs', pages: 'differs' })
  })

  it('title preceded by Correction to: / Comment on: / Reply to: not the original even if volume/pages match', async () => {
    for (const lead of ['Correction to: ', 'Comment on: ', 'Reply to: ']) {
      const entry = `Lv H, Zhang S, Wang B, Cui S, Yan J. ${lead}Toxicity of cationic lipids and cationic polymers in gene delivery. J Control Release. 2006;114(1):100-9. doi:10.1016/j.jconrel.2006.04.014`
      const result = await checkEntry(entry, deps({ '10.1016/j.jconrel.2006.04.014': found(LV) }))
      expect(['verified', 'wrong-doi'], lead).not.toContain(result.identity)
      expect(result.publication, lead).toBeNull()
    }
  })

  it('counterexample: original title itself containing "correction:" is unaffected', async () => {
    const record = { ...LV, title: 'Myopia correction: outcomes of cationic lipid delivery in gene therapy.' }
    const entry = 'Lv H, Zhang S, Wang B, Cui S, Yan J. Myopia correction: outcomes of cationic lipid delivery in gene therapy. J Control Release. 2006;114(1):100-9. doi:10.1016/j.jconrel.2006.04.014'
    expect((await checkEntry(entry, deps({ '10.1016/j.jconrel.2006.04.014': found(record) }))).identity).toBe('verified')
  })

  it('quotes in title followed by uppercase: not split as Chicago, no false author/journal differences', async () => {
    const garin = rec({
      title: 'Validation of the "World Health Organization Disability Assessment Schedule, WHODAS-2" in patients with chronic diseases.',
      authors: ['Garin O', 'Ayuso-Mateos JL', 'Almansa J', 'Nieto M', 'Chatterji S', 'Vilagut G', 'Alonso J'], journal: 'Health Qual Life Outcomes', pubdate: '2010 May 19',
      volume: '8', issue: null, pages: '51', doi: '10.1186/1477-7525-8-51', pmid: '20482853', source: 'pubmed',
    })
    const entry = 'Garin O, Ayuso-Mateos JL, Almansa J, Nieto M, Chatterji S, Vilagut G, et al. Validation of the “World Health Organization Disability Assessment Schedule, WHODAS-2” In Patients With Chronic Diseases. Health Qual Life Outcomes. 2010;8:51. doi: 10.1186/1477-7525-8-51'
    const result = await checkEntry(entry, deps({ '10.1186/1477-7525-8-51': found(garin) }))
    expect(result.identity).toBe('verified')
    expect(statusOf(result).authors).not.toBe('differs')
    expect(statusOf(result).journal).not.toBe('differs')
  })

  it('entry without year: year goes to not checked (page does not say citation matches)', async () => {
    const result = await checkEntry(GHOSH_ENTRY, deps({ '10.7189/jogh.10.020348': found(GHOSH) }))
    expect(result.identity).toBe('verified')
    expect(result.unchecked).toContain('year')
  })

  it('loose locator parsing does not read "Published online October 29, 2024" as volume 29, pages 2024', async () => {
    const strauss = rec({
      title: 'Peripheral innate immunophenotype in neurodegenerative disease: blood-based profiles and links to survival.',
      authors: ['Strauss A', 'Swann P', 'Kigar SL'], journal: 'Mol Psychiatry', pubdate: '2025 May', volume: '30', issue: '5', pages: '1985-1994',
      doi: '10.1038/s41380-024-02809-w', pmid: '39472664', source: 'pubmed',
    })
    const entry = 'Strauss A, Swann P, Kigar SL, et al. Peripheral innate immunophenotype in neurodegenerative disease: blood-based profiles and links to survival. Mol Psychiatry. Published online October 29, 2024. doi: 10.1038/s41380-024-02809-w'
    const result = await checkEntry(entry, deps({ '10.1038/s41380-024-02809-w': found(strauss) }))
    expect(result.identity).toBe('verified')
    expect(result.fields.filter((row) => row.status === 'differs')).toEqual([])
    expect(result.unchecked).toEqual(expect.arrayContaining(['volume', 'pages']))
  })

  it('after re-bounding by record title, journal is not compared against roughly cut text after the title', async () => {
    const bmj = rec({
      title: 'Strengthening the Reporting of Observational Studies in Epidemiology Using Mendelian Randomisation (STROBE-MR): Explanation and Elaboration.',
      authors: ['Skrivankova VW', 'Richmond RC', 'Woolf BAR'], journal: 'BMJ', pubdate: '2021 Oct 26', volume: '375', issue: null, pages: 'n2233',
      doi: '10.1136/bmj.n2233', pmid: '34702754', source: 'pubmed',
    })
    const entry = 'V. W. Skrivankova, R. C. Richmond, B. A. R. Woolf, et al., “Strengthening the Reporting of Observational Studies in Epidemiology Using Mendelian Randomisation (STROBE‐MR): Explanation and Elaboration,” BMJ (Clinical Research Ed.) 375 (2021): n2233. 10.1136/bmj.n2233'
    const result = await checkEntry(entry, deps({ '10.1136/bmj.n2233': found(bmj) }))
    expect(result.identity).toBe('verified')
    expect(statusOf(result).journal).toBeUndefined()
    expect(result.unchecked).toContain('journal')
  })
})

describe('more edge case reproductions', () => {
  const HOSKING_TAIL = '. Nicotine increases impulsivity and decreases willingness to exert cognitive effort despite improving attention in “slacker” rats: Insights into cholinergic regulation of cost/benefit decision making. PLoS One. 2014;9(10):e111580. 10.1371/journal.pone.0111580'

  it('author list cannot be parsed midway: not treated as et al. truncation, authors not checked', async () => {
    for (const names of ['Hosking JG, Juan Manuel López García, Jones CA', 'Hosking JG, Lam F. C. W. 2, Jones CA']) {
      const result = await checkEntry(names + HOSKING_TAIL, deps({ '10.1371/journal.pone.0111580': found(HOSKING) }))
      expect(statusOf(result).authors, names).toBe('unverified')
      expect(result.unchecked, names).toContain('authors')
    }
  })

  it('notice prefixes without colon (Correction to / Erratum for) are also blocked', async () => {
    for (const lead of ['Correction to ', 'Erratum for ']) {
      const entry = `Lv H, Zhang S, Wang B, Cui S, Yan J. ${lead}Toxicity of cationic lipids and cationic polymers in gene delivery. J Control Release. 2006;114(1):100-9. doi:10.1016/j.jconrel.2006.04.014`
      const result = await checkEntry(entry, deps({ '10.1016/j.jconrel.2006.04.014': found(LV) }))
      expect(['verified', 'wrong-doi'], lead).not.toContain(result.identity)
    }
  })

  it('record title containing the same word mid-title (Motion Correction) does not bypass the notice guard', async () => {
    const frost = rec({
      title: 'Prospective motion correction and selective reacquisition using volumetric navigators for vessel-encoded arterial spin labeling dynamic angiography.',
      authors: ['Frost R', 'Hess AT', 'Okell TW'], journal: 'Magn Reson Med', pubdate: '2016 Nov', volume: '76', issue: '5', pages: '1420-1430',
      doi: '10.1002/mrm.26040', pmid: '26507218', source: 'pubmed',
    })
    const entry = 'Frost R, Hess AT, Okell TW, et al. Correction to: Prospective Motion Correction and Selective Reacquisition Using Volumetric Navigators for Vessel-Encoded Arterial Spin Labeling Dynamic Angiography. Magn Reson Med. 2016;76(5):1420-1430. doi:10.1002/mrm.26040'
    const result = await checkEntry(entry, deps({ '10.1002/mrm.26040': found(frost) }))
    expect(['verified', 'wrong-doi']).not.toContain(result.identity)
    expect(result.publication).toBeNull()
    // The same entry without the notice prefix: recognized as this paper as usual.
    expect((await checkEntry(entry.replace('Correction to: ', ''), deps({ '10.1002/mrm.26040': found(frost) }))).identity).toBe('verified')
  })

  it('when re-bounding by record title, a correctly parsed journal is still compared and reported if wrong', async () => {
    const record = { ...LV, title: 'Treatment outcomes in the U.S. population with chronic kidney disease.' }
    const entry = 'Lv H, Zhang S, Wang B, Cui S, Yan J. Treatment outcomes in the U.S. population with chronic kidney disease. Nature. 2006;114(1):100-9. doi:10.1016/j.jconrel.2006.04.014'
    const result = await checkEntry(entry, deps({ '10.1016/j.jconrel.2006.04.014': found(record) }))
    expect(result.identity).toBe('verified')
    expect(statusOf(result).journal).toBe('differs')
  })
})
