#!/usr/bin/env node
'use strict';
/**
 * A2 unit test — VC Score Parser (calibrated v2) gate logic.
 *
 * Maya asks: "When Grok hands back a raw score, does the VC gate calibrate it
 * (x1.18 + 0.55), decide pass at exactly >=7, clamp garbage, and honor KILL /
 * STAND ASIDE overrides — the same way the live node does?"
 *
 * Table-driven, deterministic, no deps. Tests lib/gates/vc_score.js which is the
 * single source stamped into the live "VC Score Parser" node (baseline c91917bb).
 * Run: node tests/test-vc-score-gate.js   (or: npm test)
 */
const assert = require('assert');
const { VC, clampScore, round1, verdictFromScore, vcScoreV2 } = require('../lib/gates/vc_score');

let passed = 0, failed = 0;
function check(id, name, fn) {
  try { fn(); console.log(`  ✅ ${id}  ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${id}  ${name}  — ${e.message}`); failed++; }
}

// --- pinned constants (the contract other code depends on) ---
check('VC-01', 'calibration constants are 1.18 / 0.55 / threshold 7', () => {
  assert.strictEqual(VC.SHADOW_A, 1.18);
  assert.strictEqual(VC.SHADOW_B, 0.55);
  assert.strictEqual(VC.VC_THRESHOLD_LOCKED, 7);
});

// --- the pass/fail boundary (the number that actually gates trades) ---
check('VC-02', 'raw 5.4 -> calib 6.9 -> does NOT pass (<7)', () => {
  const r = vcScoreV2(5.4);
  assert.strictEqual(r.calibratedScore, 6.9, `calib=${r.calibratedScore}`);
  assert.strictEqual(r.v2Pass, false);
  assert.strictEqual(r.v2Verdict, 'REJECT');
});
check('VC-03', 'raw 5.5 -> calib 7.0 -> PASSES (exactly >=7)', () => {
  const r = vcScoreV2(5.5);
  assert.strictEqual(r.calibratedScore, 7.0, `calib=${r.calibratedScore}`);
  assert.strictEqual(r.v2Pass, true);
  assert.strictEqual(r.v2Verdict, 'WEAK');   // 7.0 -> WEAK band (<8)
});

// --- clamping garbage / out-of-range (fail-safe, no NaN leaks downstream) ---
check('VC-04', 'raw 11 clamps to legacy 10 then calib clamps to 10.0 -> PASS', () => {
  const r = vcScoreV2(11);
  assert.strictEqual(r.legacyScore, 10);
  assert.strictEqual(r.calibratedScore, 10.0);
  assert.strictEqual(r.v2Verdict, 'PASS');
});
check('VC-05', 'negative raw clamps to 0 -> calib 0.6 -> KILL, no pass', () => {
  const r = vcScoreV2(-5);
  assert.strictEqual(r.legacyScore, 0);
  assert.strictEqual(r.calibratedScore, 0.6);
  assert.strictEqual(r.v2Pass, false);
  assert.strictEqual(r.v2Verdict, 'KILL');
});
check('VC-06', 'non-numeric raw ("abc"/NaN/null) -> treated as 0, never NaN', () => {
  for (const bad of ['abc', NaN, null, undefined, {}]) {
    const r = vcScoreV2(bad);
    assert.strictEqual(r.legacyScore, 0, `legacy for ${String(bad)}`);
    assert.ok(Number.isFinite(r.calibratedScore), `calib finite for ${String(bad)}`);
    assert.strictEqual(r.v2Pass, false);
  }
});

// --- hard overrides mirror the live node ---
check('VC-07', 'isKill overrides an otherwise-passing score to no-pass/KILL', () => {
  const r = vcScoreV2(8, { isKill: true });   // 8 would calibrate to a PASS
  assert.strictEqual(r.v2Pass, false);
  assert.strictEqual(r.v2Verdict, 'KILL');
});
check('VC-08', 'standAside suppresses to NEUTRAL_SUPPRESSED / no-pass', () => {
  const r = vcScoreV2(8, { standAside: true });
  assert.strictEqual(r.v2Pass, false);
  assert.strictEqual(r.v2Verdict, 'NEUTRAL_SUPPRESSED');
});
check('VC-09', 'standAside wins the verdict label when both overrides set', () => {
  const r = vcScoreV2(8, { isKill: true, standAside: true });
  assert.strictEqual(r.v2Verdict, 'NEUTRAL_SUPPRESSED');  // sequential: standAside last
  assert.strictEqual(r.v2Pass, false);
});

// --- verdict bands (pins the KILL/REJECT/WEAK/PASS cutoffs) ---
check('VC-10', 'verdictFromScore band cutoffs: 3->KILL, 3.1->REJECT, 7->WEAK, 8->PASS', () => {
  assert.strictEqual(verdictFromScore(3), 'KILL');
  assert.strictEqual(verdictFromScore(3.1), 'REJECT');
  assert.strictEqual(verdictFromScore(6.9), 'REJECT');
  assert.strictEqual(verdictFromScore(7), 'WEAK');
  assert.strictEqual(verdictFromScore(7.9), 'WEAK');
  assert.strictEqual(verdictFromScore(8), 'PASS');
  assert.strictEqual(verdictFromScore(10), 'PASS');
});

// --- legacy parity preserved (v2 is additive, legacy unchanged) ---
check('VC-11', 'legacyScore preserved as clamped/rounded raw (parity)', () => {
  assert.strictEqual(vcScoreV2(6.34).legacyScore, 6.3);
  assert.strictEqual(vcScoreV2(9.99).legacyScore, 10);
  assert.strictEqual(round1(clampScore(6.34)), 6.3);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
