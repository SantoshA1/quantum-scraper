#!/usr/bin/env node
/**
 * Aggregating test runner for the QTP gate/logic harnesses.
 * Discovers every tests/test-*.js file, runs each as a child process,
 * and exits non-zero if ANY suite fails. Used by `npm test` and CI.
 *
 * Run:  node tests/run-all.js   (or: npm test)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const dir = __dirname;
const files = fs.readdirSync(dir)
  .filter((f) => /^test-.*\.js$/.test(f))
  .sort();

if (files.length === 0) {
  console.error('run-all: no tests/test-*.js files found');
  process.exit(2);
}

let failedSuites = 0;
const results = [];

for (const f of files) {
  const full = path.join(dir, f);
  process.stdout.write(`\n──────── ${f} ────────\n`);
  const r = spawnSync(process.execPath, [full], { stdio: 'inherit' });
  const ok = r.status === 0;
  if (!ok) failedSuites++;
  results.push({ f, status: r.status, ok });
}

process.stdout.write('\n════════ SUMMARY ════════\n');
for (const r of results) {
  process.stdout.write(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.f}${r.ok ? '' : ' (exit ' + r.status + ')'}\n`);
}
process.stdout.write(`  ${results.length - failedSuites}/${results.length} suites passed\n`);

process.exit(failedSuites === 0 ? 0 : 1);
