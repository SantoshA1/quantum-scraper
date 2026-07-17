#!/usr/bin/env node
'use strict';
/**
 * A2 unit test — AI-CONFLICT guard + bias-threshold + secondary-confirmation
 * (entry-quality composite, part 2/2).
 *
 * Maya asks: "Is a HARD conflict ever waived (it must not be), does a SOFT conflict
 * only get waived under the full paper soft-allow (paper-gated, vc>=10, bias>=60,
 * backtestValid, secondary + cross-asset confirmed), does the trend conflict have
 * its own separate allow, and are the 55/60 bias bars exactly right?"
 *
 * Tests lib/gates/ai_conflict.js. Run: node tests/test-ai-conflict-gate.js (or npm test)
 */
const assert = require('assert');
const {
  BIAS, biasThresholdPass,
  hardNonTrendAiConflict, softNonTrendAiConflict,
  strictSecondaryConfirmation, paperRelaxedSecondaryVolume, paperRelaxedSecondaryCrossAsset,
  paperSecondaryConfirmation, secondaryConfirmation,
  paperSoftNonTrendAllow, effectiveNonTrendAiConflict,
  paperSoftTrendAllow, resolveAiConflict,
} = require('../lib/gates/ai_conflict');

let passed = 0, failed = 0;
function check(id, name, fn) {
  try { fn(); console.log(`  ✅ ${id}  ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${id}  ${name}  — ${e.message}`); failed++; }
}

// --- constants: the exact bias bars ---
check('AC-01', 'bias bars: threshold 55, soft-allow 60, observation 50, vc bar 10', () => {
  assert.strictEqual(BIAS.BIAS_THRESHOLD, 55);
  assert.strictEqual(BIAS.PAPER_AI_SOFT_ALLOW_BIAS_THRESHOLD, 60);
  assert.strictEqual(BIAS.PAPER_OBSERVATION_THRESHOLD, 50);
  assert.strictEqual(BIAS.VC_PAPER_SECONDARY_BAR, 10);
});

// --- bias threshold boundary 54/55 and 59/60 ---
check('AC-02', 'biasThresholdPass: >= bar (54 fail/55 pass @55; 59 fail/60 pass @60); NaN fails', () => {
  assert.strictEqual(biasThresholdPass(54, 55), false);
  assert.strictEqual(biasThresholdPass(55, 55), true);
  assert.strictEqual(biasThresholdPass(59, 60), false);
  assert.strictEqual(biasThresholdPass(60, 60), true);
  assert.strictEqual(biasThresholdPass(NaN, 55), false);
  assert.strictEqual(biasThresholdPass(undefined, 55), false);
});

// --- hard vs soft membership ---
check('AC-03', 'hard = opposite|sentiment; soft = hold|lowConf|weakVerdict', () => {
  assert.strictEqual(hardNonTrendAiConflict({ explicitOppositeConflict: true }), true);
  assert.strictEqual(hardNonTrendAiConflict({ sentimentConflict: true }), true);
  assert.strictEqual(hardNonTrendAiConflict({}), false);
  assert.strictEqual(softNonTrendAiConflict({ explicitHoldConflict: true }), true);
  assert.strictEqual(softNonTrendAiConflict({ lowAIConfidence: true }), true);
  assert.strictEqual(softNonTrendAiConflict({ weakAIVerdict: true }), true);
  assert.strictEqual(softNonTrendAiConflict({}), false);
});

// --- HARD is never waived ---
check('AC-04', 'effectiveNonTrend: HARD stays true even if a soft-allow is granted', () => {
  assert.strictEqual(effectiveNonTrendAiConflict(true, false, true), true);   // hard, allow present => still true
  assert.strictEqual(effectiveNonTrendAiConflict(true, true, true), true);
});

// --- SOFT waived only under a granted allow ---
check('AC-05', 'effectiveNonTrend: SOFT waived iff allow granted', () => {
  assert.strictEqual(effectiveNonTrendAiConflict(false, true, false), true);  // soft, no allow => conflict
  assert.strictEqual(effectiveNonTrendAiConflict(false, true, true), false);  // soft, allow => waived
  assert.strictEqual(effectiveNonTrendAiConflict(false, false, false), false);// clean
});

// --- paper soft-allow requires the FULL conviction stack ---
check('AC-06', 'paperSoftNonTrendAllow: all-of gate; any missing precondition denies', () => {
  const ok = {
    isPaperGated: true, vcScore: 10, bias_score: 60, backtestValid: true,
    secondaryConfirmation: true, crossAssetConfirmed: true, soft: true, hard: false,
  };
  assert.strictEqual(paperSoftNonTrendAllow(ok), true);
  assert.strictEqual(paperSoftNonTrendAllow({ ...ok, bias_score: 59 }), false);     // bias below 60
  assert.strictEqual(paperSoftNonTrendAllow({ ...ok, vcScore: 9 }), false);         // vc below 10
  assert.strictEqual(paperSoftNonTrendAllow({ ...ok, backtestValid: false }), false);
  assert.strictEqual(paperSoftNonTrendAllow({ ...ok, secondaryConfirmation: false }), false);
  assert.strictEqual(paperSoftNonTrendAllow({ ...ok, crossAssetConfirmed: false }), false);
  assert.strictEqual(paperSoftNonTrendAllow({ ...ok, hard: true }), false);         // hard present => never
  assert.strictEqual(paperSoftNonTrendAllow({ ...ok, soft: false }), false);        // nothing to waive
  assert.strictEqual(paperSoftNonTrendAllow({ ...ok, isPaperGated: false }), false);
});

// --- secondary confirmation: strict vs paper-relaxed ---
check('AC-07', 'strict secondary: volume>1.25 or strong/aligned cross-asset', () => {
  assert.strictEqual(strictSecondaryConfirmation({ volume_ratio: 1.26 }), true);
  assert.strictEqual(strictSecondaryConfirmation({ volume_ratio: 1.25 }), false); // strictly >
  assert.strictEqual(strictSecondaryConfirmation({ cross_asset: 'STRONG' }), true);
  assert.strictEqual(strictSecondaryConfirmation({ cross_asset: 'SPY ALIGNED' }), true);
  assert.strictEqual(strictSecondaryConfirmation({ cross_asset: 'MIXED' }), false);
});
check('AC-08', 'paper-relaxed secondary: vol>0.95, or neutral/blank/aligned cross-asset', () => {
  assert.strictEqual(paperRelaxedSecondaryVolume(0.96), true);
  assert.strictEqual(paperRelaxedSecondaryVolume(0.95), false); // strictly >
  assert.strictEqual(paperRelaxedSecondaryCrossAsset(''), true);
  assert.strictEqual(paperRelaxedSecondaryCrossAsset('NEUTRAL'), true);
  assert.strictEqual(paperRelaxedSecondaryCrossAsset('MIXED'), false);
});
check('AC-09', 'paperSecondaryConfirmation: needs paper+vc>=10+bias>=55+backtest+ (relaxedVol|relaxedCA)', () => {
  const base = { isPaperGated: true, vcScore: 10, bias_score: 55, backtestValid: true, volume_ratio: 0.96, cross_asset: 'MIXED' };
  assert.strictEqual(paperSecondaryConfirmation(base), true);                       // via relaxed volume
  assert.strictEqual(paperSecondaryConfirmation({ ...base, volume_ratio: 0.90, cross_asset: 'NEUTRAL' }), true); // via relaxed CA
  assert.strictEqual(paperSecondaryConfirmation({ ...base, volume_ratio: 0.90, cross_asset: 'MIXED' }), false);  // neither
  assert.strictEqual(paperSecondaryConfirmation({ ...base, bias_score: 54 }), false);
  assert.strictEqual(secondaryConfirmation(false, true), true);
  assert.strictEqual(secondaryConfirmation(false, false), false);
});

// --- trend allow is separate; and the final resolution ---
check('AC-10', 'paperSoftTrendAllow needs clean non-trend side (effectiveNonTrend===false)', () => {
  const ok = { isPaperGated: true, vcScore: 10, bias_score: 55, backtestValid: true, secondaryConfirmation: true, trendConflict: true, effectiveNonTrend: false };
  assert.strictEqual(paperSoftTrendAllow(ok), true);
  assert.strictEqual(paperSoftTrendAllow({ ...ok, effectiveNonTrend: true }), false); // non-trend not clean
  assert.strictEqual(paperSoftTrendAllow({ ...ok, bias_score: 54 }), false);
});
check('AC-11', 'resolveAiConflict = effectiveNonTrend OR (trend AND !trendAllow)', () => {
  assert.strictEqual(resolveAiConflict(true, false, false), true);   // non-trend conflict
  assert.strictEqual(resolveAiConflict(false, true, false), true);   // trend, unwaived
  assert.strictEqual(resolveAiConflict(false, true, true), false);   // trend, waived
  assert.strictEqual(resolveAiConflict(false, false, false), false); // clean entry
});

// --- end-to-end: a SOFT-only paper entry with full conviction clears the guard ---
check('AC-12', 'E2E: soft-only conflict, full paper conviction => aiConflict false (waived)', () => {
  const hard = false, soft = true, trendConflict = false;
  const softAllow = paperSoftNonTrendAllow({
    isPaperGated: true, vcScore: 12, bias_score: 61, backtestValid: true,
    secondaryConfirmation: true, crossAssetConfirmed: true, soft, hard,
  });
  assert.strictEqual(softAllow, true);
  const eff = effectiveNonTrendAiConflict(hard, soft, softAllow);
  assert.strictEqual(eff, false);
  const trendAllow = paperSoftTrendAllow({ isPaperGated: true, vcScore: 12, bias_score: 61, backtestValid: true, secondaryConfirmation: true, trendConflict, effectiveNonTrend: eff });
  assert.strictEqual(resolveAiConflict(eff, trendConflict, trendAllow), false); // entry clears
});

// --- end-to-end: a HARD conflict with identical conviction still blocks ---
check('AC-13', 'E2E: hard conflict, same conviction => aiConflict true (never waived)', () => {
  const hard = true, soft = false, trendConflict = false;
  const softAllow = paperSoftNonTrendAllow({
    isPaperGated: true, vcScore: 12, bias_score: 61, backtestValid: true,
    secondaryConfirmation: true, crossAssetConfirmed: true, soft, hard,
  });
  assert.strictEqual(softAllow, false); // hard blocks the allow itself
  const eff = effectiveNonTrendAiConflict(hard, soft, softAllow);
  assert.strictEqual(resolveAiConflict(eff, trendConflict, false), true); // entry blocked
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
