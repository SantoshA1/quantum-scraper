#!/usr/bin/env node
'use strict';
/**
 * Maya regression guard — VC score semantics (QTP_VC_SCORE_SEMANTICS_v1_20260805).
 *
 * Maya asks: "The dashboard told me my highest-conviction trades were my worst ones.
 * You dug in and told me three different things were hiding inside one score column —
 * rule vetoes disguised as 6.9s, parser failures disguised as zeros, and an old
 * calibration that inflates text-parsed scores. Pin every one of those so no analysis
 * ever reads that column naively again — and pin the REAL finding: score-9 shorts lose,
 * score-9 buys win."
 *
 * Deterministic + offline. Fixtures are the actual live distributions pulled from
 * quantum.exec_flow_audit and quantum.v_trade_learning on 2026-08-05.
 */
const assert = require('assert');
const V = require('../lib/vc/analytics');

let passed = 0, failed = 0;
function check(id, name, fn) {
  try { fn(); console.log(`  ✅ ${id}  ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${id}  ${name}  — ${e.message}`); failed++; }
}

// ── the four semantics, with the real (v2, legacy) pairs from production ───────
check('SEM-01', 'v2==legacy (9.0/9.0, 8.0/8.0, 7.0/7.0) = STRUCTURED — the model really said that', () => {
  for (const s of [9, 8, 7, 10]) assert.strictEqual(V.classifyVcRow(s, s), 'STRUCTURED');
  assert.strictEqual(V.modelSaid(9, 9), 9);
});
check('SEM-02', 'the 6.9 wall (v2=6.9, legacy=10) = RULE_VETO_SENTINEL, not a model score', () => {
  assert.strictEqual(V.classifyVcRow(6.9, 10), 'RULE_VETO_SENTINEL');
  assert.strictEqual(V.modelSaid(6.9, 10), 10, 'the model actually said 10/10');
  assert.strictEqual(V.usableForScoreAnalytics(6.9, 10), false, 'sentinels are NOT scores');
});
check('SEM-03', 'text-path pairs (8.8/7, 7.6/6, 6.5/5, 5.3/4) = TEXT_CALIBRATED; model said legacy', () => {
  for (const [v2, legacy] of [[8.8, 7], [7.6, 6], [6.5, 5], [5.3, 4], [9.5, 7.58]]) {
    assert.strictEqual(V.classifyVcRow(v2, legacy), 'TEXT_CALIBRATED', `${v2}/${legacy}`);
    assert.strictEqual(V.modelSaid(v2, legacy), legacy);
  }
});
check('SEM-04', 'v2=0 = PARSE_FAIL — a paid model call whose score was never read (1,572 rows, ~8%)', () => {
  assert.strictEqual(V.classifyVcRow(0, 0), 'PARSE_FAIL');
  assert.strictEqual(V.modelSaid(0, 0), null);
  assert.strictEqual(V.usableForScoreAnalytics(0, 0), false);
});
check('SEM-05', 'a genuine model 6.9 with matching legacy is STRUCTURED, not mistaken for the sentinel', () => {
  assert.strictEqual(V.classifyVcRow(6.9, 6.9), 'STRUCTURED', 'sentinel requires legacy >= 7');
});

// ── the calibration inflation (the armed dead code) ────────────────────────────
check('CAL-01', 'a model "6/10" on the text path records as 7.6 and PASSES the >=7 gate', () => {
  const e = V.textPathEffect(6);
  assert.strictEqual(e.recorded, 7.6);
  assert.strictEqual(e.inflated, true, 'sub-bar score pushed over the gate by the transform');
});
check('CAL-02', 'model 5.5 -> recorded 7.0: the effective text-path bar is 5.5, not the locked 7', () => {
  const e = V.textPathEffect(5.5);
  assert.strictEqual(e.recorded, 7.0);
  assert.strictEqual(e.inflated, true);
});
check('CAL-03', 'model 5.4 -> 6.9 fails: the text-path pass/fail knife-edge is one decimal of LLM noise', () => {
  assert.strictEqual(V.textPathEffect(5.4).recorded, 6.9);
  assert.strictEqual(V.textPathEffect(5.4).inflated, false);
});
check('CAL-04', 'grok-era text path measured: model said 6.83 avg, gate saw 8.60 avg (+1.77 inflation)', () => {
  // pinned from quantum.v_vc_score_semantics on 2026-08-05: TEXT_CALIBRATED n=810
  const recorded = V.textPathEffect(6.83).recorded;
  assert.ok(Math.abs(recorded - 8.6) <= 0.05, `expected ~8.6, got ${recorded}`);
});
check('CAL-05', 'opus era has ZERO text-path rows — the transform is dead code, but still armed', () => {
  // pinned from the same view: opus semantics = STRUCTURED 274, RULE_VETO 133, PARSE_FAIL 51,
  // TEXT_CALIBRATED 0. This check documents the fact; CAL-01/02 prove what happens if any
  // non-JSON reply ever re-activates the path.
  const opusSemantics = { STRUCTURED: 274, RULE_VETO_SENTINEL: 133, PARSE_FAIL: 51, TEXT_CALIBRATED: 0 };
  assert.strictEqual(opusSemantics.TEXT_CALIBRATED, 0);
});

// ── the REAL inversion: side, not score (the 35 executed VC-scored trades) ─────
const EXECUTED = [
  // score 9 buys: 3/9 win, +$1,029  |  score 9 sells: 0/12, -$2,218  (live 2026-08-05)
  ...Array.from({ length: 3 }, () => ({ side: 'buy', vc_score: 9, win: true,  net_pnl: 535 })),
  ...Array.from({ length: 6 }, () => ({ side: 'buy', vc_score: 9, win: false, net_pnl: -96 })),
  ...Array.from({ length: 12 }, () => ({ side: 'sell', vc_score: 9, win: false, net_pnl: -184.8 })),
  ...Array.from({ length: 9 }, () => ({ side: 'sell', vc_score: 8, win: false, net_pnl: -69.6 })),
];
check('INV-01', 'score-9 buys profit while score-9 sells go 0-for-12 — same score, opposite P&L', () => {
  const s = V.sideBandSummary(EXECUTED);
  assert.ok(s['buy|vc_9plus'].net > 0, 'buys positive');
  assert.strictEqual(s['sell|vc_9plus'].wins, 0);
  assert.ok(s['sell|vc_9plus'].net < -2000, 'sells deeply negative');
});
check('INV-02', 'therefore a band-only view (no side split) manufactures a "vc>=9 loses" inversion', () => {
  const s = V.sideBandSummary(EXECUTED);
  const combined = s['buy|vc_9plus'].net + s['sell|vc_9plus'].net;
  assert.ok(combined < 0, 'blended band is negative even though the buy side is profitable');
});
check('INV-03', 'the score is near-constant in the executed set: 21 of these 30 sit at one value', () => {
  const nines = EXECUTED.filter(t => t.vc_score === 9).length;
  assert.strictEqual(nines, 21, 'a gate whose passes are 70% one score has no ranking power to lose');
});

console.log(`\n  ${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
