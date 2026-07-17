#!/usr/bin/env node
'use strict';
/**
 * A2 unit test — MTF confluence decision + F1-B shadow gate.
 *
 * Maya asks: "Does MTF pass on the engine's verdict alone (not a secret 65/65
 * re-check), does the cohort shadow only block sub-40 garbage, and does turning
 * the cohort off behave exactly like before the shadow was added?"
 *
 * Encodes G22 (the removed mtfScore>=65 && aiMtfScore>=65 double-check must stay
 * gone) and the 39/40/41 floor boundary the Conclave named. Tests lib/gates/mtf.js.
 * Run: node tests/test-mtf-gate.js  (or: npm test)
 */
const assert = require('assert');
const { MTF, isEntry, finalMtfPass, mtfConfluenceBlock, detLegPass, aiLegPass } = require('../lib/gates/mtf');

let passed = 0, failed = 0;
function check(id, name, fn) {
  try { fn(); console.log(`  ✅ ${id}  ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${id}  ${name}  — ${e.message}`); failed++; }
}

// --- pass gate is the engine verdict alone ---
check('MTF-01', 'finalMtfPass true only when engine ran AND emitted FINAL_MTF_CONFLUENCE_PASS', () => {
  assert.strictEqual(finalMtfPass(true, 'FINAL_MTF_CONFLUENCE_PASS'), true);
  assert.strictEqual(finalMtfPass(true, 'final_mtf_confluence_pass'), true);   // case-insensitive
  assert.strictEqual(finalMtfPass(false, 'FINAL_MTF_CONFLUENCE_PASS'), false); // engine not seen
  assert.strictEqual(finalMtfPass(true, 'FINAL_MTF_CONFLUENCE_BLOCK'), false);
});

// --- G22: no combined 65/65 re-check; a low-score engine PASS still passes ---
check('MTF-02', 'G22 — engine PASS with mtfScore 50 & aiMtfScore 50 (<65) still passes; not re-blocked', () => {
  // if a 65/65 double-check existed, this would fail. It must NOT.
  assert.strictEqual(finalMtfPass(true, 'FINAL_MTF_CONFLUENCE_PASS'), true);
  const r = mtfConfluenceBlock({ execution: 'SELL', mtfEngineSeen: true, finalMtfDecision: 'FINAL_MTF_CONFLUENCE_PASS', mtfScore: 50, cohortActive: 0 });
  assert.strictEqual(r.pass, true);
  assert.strictEqual(r.wouldBlock, false);   // passed => not blocked, regardless of 50<65
  assert.strictEqual(r.block, false);
});

// --- floor boundary 39/40/41 (shadow ON) ---
check('MTF-03', 'floor: shadow-on blocks score 39, allows 40 and 41 (default floor 40)', () => {
  const mk = (s) => mtfConfluenceBlock({ execution: 'BUY', mtfEngineSeen: true, finalMtfDecision: 'FINAL_MTF_CONFLUENCE_BLOCK', mtfScore: s, cohortActive: 1 });
  assert.strictEqual(mk(39).block, true, 'score 39 must floor-block');
  assert.strictEqual(mk(40).block, false, 'score 40 is NOT < 40 -> no floor block');
  assert.strictEqual(mk(41).block, false, 'score 41 -> no floor block');
});

// --- cohort demotion: off blocks a mid-score engine-block; on lets it through ---
check('MTF-04', 'demotion — score 50 engine-block: cohort OFF blocks, cohort ON passes', () => {
  const base = { execution: 'SELL', mtfEngineSeen: true, finalMtfDecision: 'FINAL_MTF_CONFLUENCE_BLOCK', mtfScore: 50 };
  assert.strictEqual(mtfConfluenceBlock({ ...base, cohortActive: 0 }).block, true);  // pre-F1-B behavior
  assert.strictEqual(mtfConfluenceBlock({ ...base, cohortActive: 1 }).block, false); // shadow: 50>=40
});

// --- cohort-off byte-equivalence: block === would-block ---
check('MTF-05', 'cohort OFF is byte-equivalent to pre-shadow (block === wouldBlock)', () => {
  for (const [dec, score] of [['FINAL_MTF_CONFLUENCE_PASS', 80], ['FINAL_MTF_CONFLUENCE_BLOCK', 30], ['FINAL_MTF_CONFLUENCE_BLOCK', 60]]) {
    const r = mtfConfluenceBlock({ execution: 'BUY', mtfEngineSeen: true, finalMtfDecision: dec, mtfScore: score, cohortActive: 0 });
    assert.strictEqual(r.block, r.wouldBlock, `${dec}/${score}`);
  }
});

// --- floor only fires on a real positive score; score 0 (no MTF data) is not floored ---
check('MTF-06', 'shadow-on: score 0 (no MTF data) does NOT floor-block', () => {
  const r = mtfConfluenceBlock({ execution: 'BUY', mtfEngineSeen: true, finalMtfDecision: 'FINAL_MTF_CONFLUENCE_BLOCK', mtfScore: 0, cohortActive: 1 });
  assert.strictEqual(r.floorBlock, false);
  assert.strictEqual(r.block, false);
});

// --- non-entry never blocks ---
check('MTF-07', 'non-entry (STAND ASIDE) never blocks on MTF', () => {
  assert.strictEqual(isEntry('STAND ASIDE'), false);
  const r = mtfConfluenceBlock({ execution: 'STAND ASIDE', mtfEngineSeen: true, finalMtfDecision: 'FINAL_MTF_CONFLUENCE_BLOCK', mtfScore: 10, cohortActive: 1 });
  assert.strictEqual(r.block, false);
});

// --- per-leg attribution thresholds (det>=65, ai>=60) ---
check('MTF-08', 'det leg passes at score>=65, ai leg at >=60; explicit text overrides', () => {
  assert.strictEqual(detLegPass(true, '', 65), true);
  assert.strictEqual(detLegPass(true, '', 64), false);
  assert.strictEqual(aiLegPass(true, '', 60), true);
  assert.strictEqual(aiLegPass(true, '', 59), false);
  assert.strictEqual(detLegPass(true, 'PASS', 10), true);        // explicit PASS beats score
  assert.strictEqual(detLegPass(true, 'BLOCK', 99), false);      // explicit BLOCK beats score
  assert.strictEqual(aiLegPass(false, 'PASS', 99), false);       // engine not seen
});

// --- entry set is exactly the live set ---
check('MTF-09', 'entry set = BUY/SELL/LONG/SHORT/BULLISH/BEARISH (case-insensitive)', () => {
  for (const e of ['buy', 'Sell', 'LONG', 'short', 'bullish', 'BEARISH']) assert.strictEqual(isEntry(e), true, e);
  for (const e of ['STAND ASIDE', 'NEUTRAL', '', 'HOLD']) assert.strictEqual(isEntry(e), false, e);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
