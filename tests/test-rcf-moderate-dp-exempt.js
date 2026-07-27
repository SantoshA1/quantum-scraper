#!/usr/bin/env node
'use strict';
/**
 * Maya regression guard — RCF dp=MODERATE_DISTRIBUTION exemption.
 *
 * Maya asks: "You told me the CONTRA_BOTH veto was right on the swing horizon, but
 * then found the ONE flavor where it was wrong — a BUY whose dark pool is only
 * MODERATE_DISTRIBUTION actually went UP (+1.34% / 67% over 2 days). Did you actually
 * let those through now — at BOTH the RCF gate AND the VC kill — or does one of them
 * still quietly murder it? And did you keep killing the genuinely bad ones?"
 *
 * Encodes QTP_RCF_MODERATE_DP_EXEMPT_v1_20260727 (live 51c179ad, 3 coordinated edits:
 * RCF classifier + VC Gatekeeper prompt + VC Score Parser). If any silently regress
 * — the exemption stops firing, or a genuine both-leg CONTRA_BOTH stops being killed —
 * this suite goes red and blocks the commit.
 *
 * Run: node tests/test-rcf-moderate-dp-exempt.js   (or: npm test)
 */
const assert = require('assert');
const { rcfDecision, parserKill } = require('../lib/rcf/exempt');

let passed = 0, failed = 0;
function check(id, name, fn) {
  try { fn(); console.log(`  ✅ ${id}  ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${id}  ${name}  — ${e.message}`); failed++; }
}

// ---- RCF classifier gate ----
check('EXEMPT-01', 'winning cohort (BUY, opt=CONTRARIAN_SHORT, dp=MODERATE) passes when flag ON', () => {
  assert.strictEqual(rcfDecision('BUY', 'CONTRARIAN_SHORT', 'MODERATE_DISTRIBUTION', true), 'EXEMPT_PASS');
});
check('EXEMPT-02', 'flag OFF -> the same signal is still hard-vetoed (revertible)', () => {
  assert.strictEqual(rcfDecision('BUY', 'CONTRARIAN_SHORT', 'MODERATE_DISTRIBUTION', false), 'DROP');
});
check('EXEMPT-03', 'BUY CONTRA_BOTH with STRONG dp -> STILL dropped (no regression)', () => {
  assert.strictEqual(rcfDecision('BUY', 'CONTRARIAN_SHORT', 'STRONG_DISTRIBUTION', true), 'DROP');
});
check('EXEMPT-04', 'BUY GAMMA_SQUEEZE_DOWN + MODERATE dp -> exempt (both-leg, moderate dp)', () => {
  assert.strictEqual(rcfDecision('BUY', 'GAMMA_SQUEEZE_DOWN', 'MODERATE_DISTRIBUTION', true), 'EXEMPT_PASS');
});
check('EXEMPT-05', 'SELL CONTRA_BOTH -> dropped (exemption is BUY-only)', () => {
  assert.strictEqual(rcfDecision('SELL', 'CONTRARIAN_LONG', 'ACCUMULATION', true), 'DROP');
});
check('EXEMPT-06', 'single-leg (opt opposes, dp neutral) -> unchanged SINGLE_PASS', () => {
  assert.strictEqual(rcfDecision('BUY', 'CONTRARIAN_SHORT', 'NEUTRAL', true), 'SINGLE_PASS');
});
check('EXEMPT-07', 'clean BUY, no conflict -> PASS', () => {
  assert.strictEqual(rcfDecision('BUY', 'ACCUMULATION', 'ACCUMULATION', true), 'PASS');
});

// ---- VC Score Parser deterministic kill ----
check('VCKILL-01', 'exempt + model cites R3.2-SINGLE (cap 6) -> NOT force-killed', () => {
  assert.strictEqual(parserKill(true, 'WEAK', 6, ['R3.2-SINGLE']), false);
});
check('VCKILL-02', 'exempt + model cites genuine R3.2 (BOTH) -> STILL killed', () => {
  assert.strictEqual(parserKill(true, 'KILL', 0, ['R3.2 (BOTH: ...)']), true);
});
check('VCKILL-03', 'exempt + genuine non-R3.2 kill (bad setup) -> STILL killed', () => {
  assert.strictEqual(parserKill(true, 'KILL', 2, ['R7.1']), true);
});
check('VCKILL-04', 'NON-exempt + R3.2-SINGLE -> killed (legacy behavior unchanged)', () => {
  assert.strictEqual(parserKill(false, 'WEAK', 6, ['R3.2-SINGLE']), true);
});
check('VCKILL-05', 'NON-exempt clean pass -> not killed', () => {
  assert.strictEqual(parserKill(false, 'PASS', 8, ['R7']), false);
});

console.log(`\n  ${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
