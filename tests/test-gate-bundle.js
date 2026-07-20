#!/usr/bin/env node
'use strict';
/**
 * A3 self-test — the vendored-inline gate bundle + stamper.
 *
 * Maya asks: "You want to paste this generated blob into the live trading node.
 * Prove it: is it valid JavaScript, does EVERY gate function actually work once
 * bundled, is it byte-identical every time (so a diff is meaningful), does
 * stamping it into a node round-trip, and if someone hand-edits the block, does
 * the sha catch them?"
 *
 * Deterministic + offline: builds the bundle from lib/gates, evaluates it in a
 * fresh VM context, exercises one function per gate, and round-trips the stamp.
 * Tests .ci/bundle-gates.js. Run: node tests/test-gate-bundle.js (or: npm test)
 */
const assert = require('assert');
const vm = require('vm');
const { buildBundle, stamp, extract, shaOfStamped, sha16 } = require('../.ci/bundle-gates');

let passed = 0, failed = 0;
function check(id, name, fn) {
  try { fn(); console.log(`  ✅ ${id}  ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${id}  ${name}  — ${e.message}`); failed++; }
}

// evaluate the IIFE and hand back the QTPGates object (script completion value)
function evalGates() {
  const { inner } = buildBundle();
  return vm.runInNewContext(inner + '\nQTPGates;', {});
}

// --- bundle is valid JS and exposes the namespace ---
check('GB-01', 'bundle evaluates to a QTPGates object', () => {
  const G = evalGates();
  assert.strictEqual(typeof G, 'object');
  assert.ok(G && !Array.isArray(G), 'QTPGates should be a plain object');
});

// --- every gate has at least one working function once bundled ---
check('GB-02', 'MTF: finalMtfPass works in-bundle (engine verdict alone)', () => {
  const G = evalGates();
  assert.strictEqual(G.finalMtfPass(true, 'FINAL_MTF_CONFLUENCE_PASS'), true);
  assert.strictEqual(G.finalMtfPass(false, 'FINAL_MTF_CONFLUENCE_PASS'), false);
});
check('GB-03', 'backtest: F2 shadow backtestValid works in-bundle', () => {
  const G = evalGates();
  assert.strictEqual(G.backtestValid(true, true), true);   // cohort on => valid
  assert.strictEqual(G.backtestValid(false, true), false); // cohort off + wouldBlock => enforced
});
check('GB-04', 'VC: vcScoreV2 boundary works in-bundle (raw 5.5 -> calib 7.0 pass)', () => {
  const G = evalGates();
  assert.strictEqual(G.vcScoreV2(5.5, {}).v2Pass, true);
  assert.strictEqual(G.vcScoreV2(5.4, {}).v2Pass, false);
});
check('GB-05', 'composite-opposition: >=2 veto works in-bundle', () => {
  const G = evalGates();
  const pg = { isPaperGated: true, isEntry: true };
  assert.strictEqual(G.compositeOpposition({ trend: true, market: true }, pg).block, true);
  assert.strictEqual(G.compositeOpposition({ trend: true }, pg).block, false);
});
check('GB-06', 'ai-conflict: HARD never waived works in-bundle', () => {
  const G = evalGates();
  assert.strictEqual(G.effectiveNonTrendAiConflict(true, false, true), true); // hard stays
  assert.strictEqual(G.resolveAiConflict(false, true, true), false);          // trend waived
});

// --- every exported name from lib/gates survives into the namespace ---
check('GB-07', 'all module exports present on QTPGates (no name dropped in bundling)', () => {
  const G = evalGates();
  const { names } = buildBundle();
  for (const n of names) assert.ok(n in G, `missing export in bundle: ${n}`);
  assert.ok(names.length >= 30, `expected the full gate surface, got ${names.length}`);
});

// --- deterministic: same bytes, same sha, every build ---
check('GB-08', 'bundle is byte-deterministic (sha stable across builds)', () => {
  const a = buildBundle(), b = buildBundle();
  assert.strictEqual(a.sha, b.sha);
  assert.strictEqual(a.code, b.code);
  assert.strictEqual(a.sha, sha16(a.inner), 'sentinel sha must equal sha of inner');
});

// --- stamp round-trips and is idempotent ---
check('GB-09', 'stamp into a node: extract returns the block; stamping twice is idempotent', () => {
  const { code, sha } = buildBundle();
  const node0 = "'use strict';\n// live node body\nconst side = $json.execution;\nreturn [{ json: {} }];\n";
  const once = stamp(node0, code);
  assert.ok(once.includes(code), 'stamped node must contain the block');
  assert.strictEqual(shaOfStamped(once), sha, 'sentinel sha readable from stamped node');
  const twice = stamp(once, code);
  assert.strictEqual(twice, once, 'stamping an already-stamped node must be a no-op');
  assert.strictEqual(extract(once), code, 'extract must return exactly the block');
});

// --- re-stamp swaps an old block for a new one (no duplication) ---
check('GB-10', 'stamp replaces a prior block rather than appending a second', () => {
  const { code } = buildBundle();
  const stale = code.replace(/const QTPGates/, 'const QTPGates /* stale */');
  const node = stamp("'use strict';\nreturn [];\n", stale);
  const restamped = stamp(node, code);
  const begins = (restamped.match(/QTP-GATES:BEGIN/g) || []).length;
  assert.strictEqual(begins, 1, 'exactly one gate block after re-stamp');
  assert.ok(restamped.includes(code) && !restamped.includes('/* stale */'), 'new block replaces stale');
});

// --- hand-edit of a stamped block is detectable via sha ---
check('GB-11', 'tampering a stamped block is caught (recomputed sha != sentinel sha)', () => {
  const { code, sha } = buildBundle();
  const node = stamp("'use strict';\nreturn [];\n", code);
  // simulate a sneaky in-node edit that keeps the sentinel but changes the body
  const tampered = node.replace('return { ', 'return { backdoor: 1, ');
  const claimed = shaOfStamped(tampered);
  const blk = extract(tampered);
  const innerTampered = blk.replace(/^\/\* ==== QTP-GATES:BEGIN[^\n]*\n/, '').replace(/\n\/\* ==== QTP-GATES:END ==== \*\/$/, '');
  assert.strictEqual(claimed, sha, 'sentinel still claims the original sha');
  assert.notStrictEqual(sha16(innerTampered), claimed, 'but recomputed sha differs => tamper detected');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
