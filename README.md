# MediCrab web tools

Source code of the three free browser tools on the MediCrab website. They run in your browser, are free and need no sign-up.

| Tool | Live page | Source |
| --- | --- | --- |
| Reference checker | https://www.medicrab.com/tools/reference-checker/ | `src/web-tools/reference-checker/`, the shared matching code in `src/main/` and `src/shared/`, and `web/reference-checker.js` |
| Abbreviation list generator & checker | https://www.medicrab.com/tools/abbreviation-checker/ | `src/web-tools/abbreviation/` and `web/docx.js` |
| P value from confidence interval calculator | https://www.medicrab.com/tools/p-value-from-confidence-interval/ | `web/ci-p.js` and `web/docx.js` |

## What each tool does

### Reference checker

Paste a reference list (up to 200 references at a time). Each reference is looked up in PubMed and Crossref to see:

- whether its DOI or PMID exists in PubMed, Crossref or the DOI system (when a reference gives both, both are checked);
- whether the identifier belongs to the paper you cited. A real identifier that leads to a different paper is flagged separately;
- for a DOI that is not found or leads to another paper, the paper is searched for by title and the DOI registered for it is shown;
- whether authors, title, journal, year, volume, issue and pages match the record. Differences in capitalization, punctuation or how a page range is written are not flagged;
- retractions, corrections and expressions of concern recorded in Crossref, with a link to the notice; PubMed's retraction and expression-of-concern flags are checked too.

References without a DOI or PMID are searched for by title, year, volume and pages, and count as found only when one record clearly fits. Missing or repeated reference numbers in the list are reported too. "No matching record found" is a reason to look a reference up by hand, not proof that it is fake.

### Abbreviation list generator & checker

Lists every abbreviation in a manuscript with its full term, first use, first definition and number of uses, and exports the list (table, CSV, or a one-paragraph list for submission). Notes point out abbreviations without a full term, used before they are defined, or spelled out in more than one way. Works for English, Chinese, Japanese and Korean manuscripts. `.docx`, `.txt` and `.md` files are read in the browser.

### P value from confidence interval calculator

Enter an odds ratio, hazard ratio, risk ratio or mean difference with its confidence interval. The calculator estimates the two-sided P value and checks it against the P value and point estimate written in the paper: whether the estimate lies inside its interval, whether the interval and the P value contradict each other, how far the derived P value is from the reported one, and whether the interval is symmetric. It allows for rounding of the published numbers. You can also paste a whole results paragraph, or compute a confidence interval from a P value. The method is that of Altman and Bland ([BMJ 2011;343:d2304](https://doi.org/10.1136/bmj.d2304)).

## Privacy

- **Reference checker:** lookups go from your browser directly to PubMed, Crossref and doi.org; your list is not sent to MediCrab. Each lookup contains the identifier or the bibliographic details needed to search, so those services receive them, just as when you search their websites yourself.
- **Abbreviation checker:** by default the list is made in your browser and nothing is uploaded. The model option is optional: only if you tick "Find missing full terms with a model provided by MediCrab" and click "Send and find" does the page send, for each abbreviation without a full term, the first sentence in which it appears, to MediCrab's endpoint (`https://api-crab.medicrab.com/v1/tools/abbreviations`). You can review these sentences before sending. Uses per day are limited.
- **CI → P calculator:** numbers and files are processed in your browser and never uploaded.

## Limitations

- The reference checker does not check whether a cited paper supports the sentence that cites it, does not check citation style (APA, Vancouver, AMA), and does not check citation numbers in the main text.
- Most books, guidelines, conference abstracts, theses, reports, web pages and some regional journals are not in PubMed or Crossref, so they often end up as "No matching record found". Check these on the publisher's or library's page.
- The abbreviation checker does not judge whether a full term is correct. Abbreviations in tables and figure legends are not listed, and the reference list is skipped.
- The CI → P calculator uses a normal approximation (on the log scale for ratios, on the original scale for differences). Exact, profile-likelihood, bootstrap and t-based methods can give somewhat different P values.
- Paragraph mode pairs text by distance, not by sentence. It looks for intervals introduced by a confidence-interval word (such as "95% CI"; bracketed numbers without one are not read as intervals). For each interval it takes the nearest effect measure (OR, HR, RR, mean difference and so on) in the 120 characters before it, and after the end of the previous result, and uses the number written between that measure and the interval as the point estimate. The estimate must be within 40 characters of both, and a Chinese full stop between them, or a semicolon between the measure and the number, stops the match, but an English full stop does not: `OR 1.25. The 95% CI 1.10-1.40.` is still read as one result. A P value is read only if it starts within 24 characters after the interval, before the end of the sentence or the next effect measure. Check each paired result against the quoted text shown with it.

## Repository layout

```
src/main/, src/shared/       reference matching code shared with the MediCrab desktop app
src/web-tools/               browser entry points, web-only logic and tests
web/                         handwritten page scripts (reference-checker.js, ci-p.js, docx.js)
test/abbreviation-copy.mjs   sample texts used by the abbreviation tests
scripts/build.mjs            builds dist/reference-checker-engine.js and dist/abbreviation.js
```

The bundles expose `window.MCRefCheck` (reference checker engine) and `globalThis.MC_ABBR` (abbreviation checker). `web/ci-p.js` exposes `globalThis.MC_CIP` (the CI → P calculations and the paragraph scanner) and `web/docx.js` exposes `globalThis.MC_DOCX` (reading `.docx`, `.txt` and `.md` files in the browser); both can be loaded without a page, for example in tests. The page scripts in `web/` expect the page markup and a `#tool-data` JSON element with the page's messages; the page HTML and copy are generated by the website build and are not part of this repository.

## Build and test

Requires Node.js `^20.19.0 || >=22.12.0` (the range the pinned test tooling supports).

```sh
npm install
npm run build      # dist/reference-checker-engine.js, dist/abbreviation.js
npm test           # vitest; offline, all network calls are stubbed
npm run typecheck
```

## Relationship to the MediCrab desktop app

The reference-matching core in `src/main/` and `src/shared/` (identifier lookup, bibliographic matching, field comparison helpers) is shared with the MediCrab desktop app and is maintained upstream there. The web tool adds its own parsing of pasted lists, field-by-field comparison and result tiers in `src/web-tools/reference-checker/`, so its results are not guaranteed to match the desktop app's. Pull requests to the shared core are welcome; they are applied upstream and released here with the next update.

## License

Copyright (C) 2026 TIKMOON LTD, operator of MediCrab.

Licensed under the GNU Affero General Public License v3.0 only (`AGPL-3.0-only`). See [LICENSE](LICENSE). Contributions: see [CONTRIBUTING.md](CONTRIBUTING.md).
