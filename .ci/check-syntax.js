#!/usr/bin/env node
/**
 * Syntax check for shippable JS (root *.js).
 *
 * Several of these files are EXTRACTED n8n Code-node bodies (signal-state-machine,
 * trailing-stop, etc.) which legitimately use top-level `await` — valid inside n8n's
 * async node wrapper but not as a standalone script, so `node --check` rejects them.
 * We therefore compile each file wrapped in an async function via vm (syntax-only,
 * never executed), which validates both standalone modules and node bodies uniformly.
 *
 * Run:  node .ci/check-syntax.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
// Shippable modules + extracted n8n node bodies only. Root-level `test-*.js` are
// ad-hoc/legacy scripts (some ESM) not run by the suite and not deployed; the real
// harnesses live in tests/ and self-validate by executing under `npm test`.
const files = fs.readdirSync(ROOT).filter(
  (f) => f.endsWith('.js') && !/^test-/.test(f) && fs.statSync(path.join(ROOT, f)).isFile()
);

let failed = 0;
for (const f of files) {
  let src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  src = src.replace(/^#![^\n]*\n/, '\n'); // strip shebang (invalid inside the wrapper)
  try {
    // Wrap in async IIFE so top-level await in n8n node bodies is valid.
    new vm.Script('(async () => {\n' + src + '\n})', { filename: f });
    console.log(`  OK    ${f}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL  ${f} :: ${e.message.split('\n')[0]}`);
  }
}
console.log(`\n${files.length - failed}/${files.length} files parse cleanly.`);
process.exit(failed === 0 ? 0 : 1);
