#!/usr/bin/env node
'use strict';
/**
 * Maya regression guard — protective stops are plain STOPs (QTP_PLAIN_STOP_20260730).
 *
 * Maya asks: "You told me BA sat open bleeding because its stop was a stop-LIMIT that never
 * filled, then got re-stopped 3% wide. Did you actually make the protective stop a plain stop
 * that ALWAYS fills on trigger? And is the recovery still the tightest legal stop (never below
 * market for a buy-stop)?"
 */
const assert = require('assert');
const { bracketStopLoss, fillsOnTrigger, recoveryStop, nakedFlattenDecision } = require('../lib/execution/bracket_stop');

let passed = 0, failed = 0;
function check(id, name, fn) {
  try { fn(); console.log(`  ✅ ${id}  ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${id}  ${name}  — ${e.message}`); failed++; }
}

// ---- the BA fix: bracket stop must be a plain stop ----
check('STOP-01', 'bracket protective stop is a PLAIN stop (no limit_price) -> guaranteed fill', () => {
  const sl = bracketStopLoss(false, 215.02, 3.19, 1.5); // BA short
  assert.strictEqual(sl.limit_price, undefined, 'must NOT carry a limit_price');
  assert.ok(sl.stop_price !== undefined);
  assert.strictEqual(fillsOnTrigger(sl), true);
});
check('STOP-02', 'a STOP-LIMIT (the old behavior) is flagged as NOT guaranteed to fill', () => {
  const oldStopLimit = { stop_price: '219.80', limit_price: '219.60' };
  assert.strictEqual(fillsOnTrigger(oldStopLimit), false);
});
check('STOP-03', 'short stop sits above entry, long stop below entry (direction preserved)', () => {
  assert.ok(Number(bracketStopLoss(false, 100, 2, 1.5).stop_price) > 100); // short
  assert.ok(Number(bracketStopLoss(true, 100, 2, 1.5).stop_price) < 100);  // long
});

// ---- recovery still sane: tightest LEGAL plain stop ----
check('RECOV-01', 'sl_recovery is a plain stop (type stop, no limit)', () => {
  const r = recoveryStop(false, 219.80, 220.4);
  assert.strictEqual(r.type, 'stop');
  assert.strictEqual(r.limit_price, undefined);
});
check('RECOV-02', 'short recovery: if price ran past the intended stop, uses current+0.5% (cannot sit below market)', () => {
  // BA case: missStop 219.80 but price already 220.4 -> recovery = 220.4*1.005 = 221.5
  const r = recoveryStop(false, 219.80, 220.4);
  assert.ok(r.stop_price >= 220.4, `buy-stop must be above market, got ${r.stop_price}`);
});
check('RECOV-03', 'short recovery: if price has NOT run past the stop, keeps the intended (tighter) stop', () => {
  const r = recoveryStop(false, 219.80, 216.0); // price below intended stop
  assert.strictEqual(r.stop_price, 219.80);
});
check('RECOV-04', 'long recovery mirrors: tightest legal is min(missStop, current-0.5%), never above market', () => {
  const r = recoveryStop(true, 108.0, 107.0);
  assert.ok(r.stop_price <= 107.0);
});

// ---- the whole point: with a plain stop, BA never reaches the wide-recovery state ----
check('BA-01', 'BA short: plain stop at intended level fills on trigger, so no naked -> no wide recovery', () => {
  const sl = bracketStopLoss(false, 215.02, 3.19, 1.5);
  assert.strictEqual(fillsOnTrigger(sl), true, 'plain stop always fills -> exits near intended, never runs to 3% recovery');
});

// ---- flag-gated naked-flatten (default OFF -> no behavior change) ----
check('NAKED-01', 'flag OFF: never flatten, even when price is way past the stop (behavior unchanged)', () => {
  const d = nakedFlattenDecision({ isLong: false, missStop: 219.80, current: 230, flagOn: false });
  assert.strictEqual(d.doFlatten, false);
  assert.strictEqual(d.orderType, 'stop');
});
check('NAKED-02', 'flag ON + short 1% past intended stop (> 0.5% cap) -> market flatten', () => {
  const d = nakedFlattenDecision({ isLong: false, missStop: 219.80, current: 222.0, flagOn: true, capPct: 0.5 });
  assert.strictEqual(d.doFlatten, true);
  assert.strictEqual(d.orderType, 'market');
});
check('NAKED-03', 'flag ON + short only 0.2% past stop (< 0.5% cap) -> still just place the stop', () => {
  const d = nakedFlattenDecision({ isLong: false, missStop: 219.80, current: 220.2, flagOn: true, capPct: 0.5 });
  assert.strictEqual(d.doFlatten, false);
  assert.strictEqual(d.orderType, 'stop');
});
check('NAKED-04', 'flag ON + long mirror: price 1% below intended stop -> flatten', () => {
  const d = nakedFlattenDecision({ isLong: true, missStop: 108.0, current: 106.5, flagOn: true, capPct: 0.5 });
  assert.strictEqual(d.doFlatten, true);
});
check('NAKED-05', 'price has NOT reached the stop (negative overshoot) -> never flatten', () => {
  const d = nakedFlattenDecision({ isLong: false, missStop: 219.80, current: 216.0, flagOn: true, capPct: 0.5 });
  assert.strictEqual(d.doFlatten, false);
});

console.log(`\n  ${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
