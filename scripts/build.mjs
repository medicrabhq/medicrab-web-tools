#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 TIKMOON LTD
/**
 * Build the two browser bundles into dist/ with the same options the live site uses.
 * platform=browser and no externals: if Node-only code slips into the sources, the build fails.
 *
 *   node scripts/build.mjs [--only=reference|abbreviation]
 */
import { build } from 'esbuild'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const only = process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length)

const common = {
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: ['es2020', 'chrome100', 'safari15', 'firefox100'],
  minify: true,
  legalComments: 'none',
  charset: 'utf8',
  logLevel: 'warning',
  // Ignore tsconfig.json (its strict flag would add "use strict"): output matches the live site.
  tsconfigRaw: {},
}

if (!only || only === 'reference') await build({
  ...common,
  entryPoints: [join(repo, 'src/web-tools/reference-checker/browser.ts')],
  outfile: join(repo, 'dist/reference-checker-engine.js'),
  banner: { js: '/* MediCrab reference checker */' },
})
if (!only || only === 'abbreviation') await build({
  ...common,
  entryPoints: [join(repo, 'src/web-tools/abbreviation/browser.ts')],
  outfile: join(repo, 'dist/abbreviation.js'),
  banner: { js: '/* MediCrab abbreviation list: runs in your browser; sentences are sent only when you choose the model option. */' },
})
console.log(`Built ${only ? `${only} tool` : 'dist/reference-checker-engine.js and dist/abbreviation.js'}`)
