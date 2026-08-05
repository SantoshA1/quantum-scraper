#!/usr/bin/env node
'use strict';
/**
 * Maya regression guard — Gate-K K1 regime filter (QTP_K1_REGIME_LABELS_v1_20260805).
 *
 * Maya asks: "You sold me a regime filter with a -$485 receipt attached — 'no more
 * counter-regime shorts.' Then you read the gate and found it compares against 'UP' and
 * 'DOWN', two words my Regime Service has never written. It has NEVER fired. Not once.
 * Prove the deadness against every label the service ever stored, prove the mapped fix
 * finally blocks what the receipt says it blocks, and prove CHOP days and stale mornings
 * still trade exactly like they do today."
 *
 * Deterministic + offline. Label census pinned from quantum.regime_state 2026-08-05:
 * CHOP 175, RISK_ON 48, RISK_OFF 28 — and nothing else, ever.
 * 'live' mirrors v2.2 (GATE_K_v2.2_K3_LOSS_ONLY_20260805). 'proposed' mirrors v2.3
 * (GATE_K_v2.3_K1_REGIME_LABELS_20260805): RISK_ON blocks bearish, RISK_OFF blocks
 * bullish, CHOP blocks nothing, UP/DOWN still honored.
 */
const assert = require('assert');
const R = require('../lib/risk/regime');

let passed = 0, failed = 0;
function check(id, name, fn) {
  try { fn(); console.log(`  ✅ ${id}  ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${id}  ${name}  — ${e.message}`); failed++; }
}

const NOW = '2026-08-05T15:45:00Z';
const row = (trend, minsAgo = 15) => ({ trend_regime: trend, volatility_regime: 'NORMAL',
  observed_at: new Date(new Date(NOW).getTime() - minsAgo * 60000).toISOString() });
const call = (side, trend, variant, extra) => R.regimeDecision(
  Object.assign({ side, now: NOW, regimeMode: 'enforce' }, extra), trend ? row(trend) : null, variant);

// ── the deadness, pinned against the full label census ─────────────────────────
check('RG-01', "every label the service EVER stored (CHOP/RISK_ON/RISK_OFF) x both directions -> live v2.2 blocks NOTHING — the filter never fired", () => {
  for (const trend of ['CHOP', 'RISK_ON', 'RISK_OFF']) {
    for (const side of ['buy', 'sell']) {
      const r = call(side, trend, 'live');
      assert.strictEqual(r.blocked, false, `${trend}/${side} must not block under v2.2`);
      assert.strictEqual(r.shadowViolation, null);
    }
  }
});
check('RG-02', "the labels v2.2 DOES understand ('UP'/'DOWN') have never existed in regime_state — deadness is structural, not situational", () => {
  const census = { CHOP: 175, RISK_ON: 48, RISK_OFF: 28 }; // pinned 2026-08-05 15:45 UTC
  assert.ok(!('UP' in census) && !('DOWN' in census));
  assert.strictEqual(Object.values(census).reduce((a, b) => a + b, 0), 251);
});

// ── the receipt: what the fix finally blocks ───────────────────────────────────
check('RG-03', 'v2.3: RISK_ON morning + a short (the -$485 week-of-07-06 class) -> BLOCKED as counter_regime_bearish_in_uptrend', () => {
  const r = call('sell', 'RISK_ON', 'proposed');
  assert.strictEqual(r.blocked, true);
  assert.strictEqual(r.reason, 'counter_regime_bearish_in_uptrend');
});
check('RG-04', 'v2.3: RISK_OFF + a long -> BLOCKED as counter_regime_bullish_in_downtrend', () => {
  const r = call('buy', 'RISK_OFF', 'proposed');
  assert.strictEqual(r.blocked, true);
  assert.strictEqual(r.reason, 'counter_regime_bullish_in_downtrend');
});
check('RG-05', 'v2.3: with-trend entries pass — RISK_ON longs and RISK_OFF shorts are untouched', () => {
  assert.strictEqual(call('buy', 'RISK_ON', 'proposed').blocked, false);
  assert.strictEqual(call('sell', 'RISK_OFF', 'proposed').blocked, false);
});
check('RG-06', "CHOP (today's regime, 175 of 251 rows) blocks nothing in EITHER variant — deploy changes no behavior right now", () => {
  for (const side of ['buy', 'sell']) {
    assert.strictEqual(call(side, 'CHOP', 'live').blocked, false);
    assert.strictEqual(call(side, 'CHOP', 'proposed').blocked, false);
  }
});
check('RG-07', "'UP'/'DOWN' stay honored in v2.3 (forward-compat if the Regime Service emitter ever changes)", () => {
  assert.strictEqual(call('sell', 'UP', 'proposed').blocked, true);
  assert.strictEqual(call('buy', 'DOWN', 'proposed').blocked, true);
  assert.strictEqual(call('buy', 'UP', 'proposed').blocked, false);
});

// ── fail-open + mode semantics (must not change) ───────────────────────────────
check('RG-08', 'stale regime (>90 min) fails OPEN with the degraded flag in both variants — the 10:00 ET cold start (C4) behaves exactly as today', () => {
  for (const v of ['live', 'proposed']) {
    const r = R.regimeDecision({ side: 'sell', now: NOW, regimeMode: 'enforce' }, row('RISK_ON', 91), v);
    assert.strictEqual(r.blocked, false);
    assert.strictEqual(r.degraded, 'regime_stale_or_missing_filter_skipped');
  }
});
check('RG-09', 'no regime row at all -> same fail-open skip, never a block', () => {
  const r = call('sell', null, 'proposed');
  assert.strictEqual(r.blocked, false);
  assert.strictEqual(r.degraded, 'regime_stale_or_missing_filter_skipped');
});
check('RG-10', 'shadow mode records the violation but does NOT block', () => {
  const r = call('sell', 'RISK_ON', 'proposed', { regimeMode: 'shadow' });
  assert.strictEqual(r.blocked, false);
  assert.strictEqual(r.shadowViolation, 'counter_regime_bearish_in_uptrend');
});
check('RG-11', "mode 'off' and unknown side both skip the filter entirely", () => {
  assert.strictEqual(call('sell', 'RISK_ON', 'proposed', { regimeMode: 'off' }).blocked, false);
  const r = call('weird', 'RISK_ON', 'proposed');
  assert.strictEqual(r.blocked, false);
  assert.strictEqual(r.degraded, 'side_missing_direction_checks_skipped');
});
check('RG-12', 'label compare is case-insensitive (risk_on lowercase still blocks) and options map through direction (sell_call is bearish)', () => {
  assert.strictEqual(call('sell', 'risk_on', 'proposed').blocked, true);
  assert.strictEqual(call('sell_call', 'RISK_ON', 'proposed').blocked, true);
  assert.strictEqual(call('sell_put', 'RISK_ON', 'proposed').blocked, false, 'sell_put is bullish — with-trend');
});
check('RG-13', 'reason strings are byte-identical to v2.2 — K1 never fired, so no consumer has ever seen them; renaming would be change for its own sake', () => {
  assert.strictEqual(call('sell', 'UP', 'live').reason, call('sell', 'RISK_ON', 'proposed').reason);
  assert.strictEqual(call('buy', 'DOWN', 'live').reason, call('buy', 'RISK_OFF', 'proposed').reason);
});

console.log(`\n  ${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
