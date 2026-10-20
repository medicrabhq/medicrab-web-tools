# Contributing

Bug reports and pull requests are welcome. For a wrong result, please include the input (for the reference checker, the reference as written and the record you expected it to match) and what the tool showed.

## Before you open a pull request

- Run `npm test` and `npm run build`; both must pass.
- Add a test for the case you fix.
- Use real, public examples in tests (real references, real DOIs and PMIDs). Do not include unpublished manuscripts or personal data.
- Files under `src/main/` and `src/shared/` are shared with the MediCrab desktop app and maintained upstream there. Pull requests to these files are reviewed here, applied upstream and released here with the next update.

## Licensing of contributions

By submitting a pull request or other contribution to this repository, you agree that:

1. your contribution is licensed under the GNU Affero General Public License v3.0 only (AGPL-3.0-only), the license of this repository; and
2. you grant TIKMOON LTD a perpetual, worldwide, non-exclusive, royalty-free, irrevocable license to use, modify, sublicense and distribute your contribution under other license terms as well, including in the MediCrab desktop app.

You confirm that you have the right to make the contribution under these terms (for example, that it is your own work or that your employer permits it).
