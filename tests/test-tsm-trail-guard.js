#!/usr/bin/env node
'use strict';
/**
 * Maya regression guard — Trailing Stop Manager + ledger integrity.
 *
 * Maya asks: "When my winner runs in my favor, does QTP actually MOVE the stop up to
 * protect the profit — or does it sit there and let the winner round-trip back to my
 * entry stop like it did on 07-24 (my worst day, -$1,382)? And does the P&L record
 * actually contain my winners, or only my losers?"
 *
 * Encodes the four bugs of QTP_TSM_TRAIL_FIX_v1 (live 95b0909f) + H5 v3 staleness +
 * the ledger winner-blindness that hid LDOS +855 / AFL +12. If any of these silently
 * regress, this suite goes red and blocks the commit.
 *
 * Run: node tests/test-tsm-trail-guard.js   (or: npm test)
 */
const assert = require('assert');
const { trailDecision, catchUpBlockedByExistingClose, isStaleLedgerRow, missingLedgerRows, barExtremeEvalPrice } =
  require('../lib/tsm/trail');

let passed = 0, failed = 0;
function check(id, name, fn) {
  try { fn(); console.log(`  ✅ ${id}  ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${id}  ${name}  — ${e.message}`); failed++; }
}

// ---- THE regression: a winner past Tier-1 MUST get its stop moved (not skipped) ----
check('TSM-01', 'SHORT winner past T1 with tier 0 -> STOP_REPLACE to breakeven (the 07-24 bug)', () => {
  // VRSN-shaped: short entry 271.55, ATR 3. T1 trigger=267.05, T2 trigger=262.55.
  // Price 265 is past T1 but not yet T2 -> must move stop to breakeven (tier 1).
  const d = trailDecision({ side: 'short', entry: 271.55, current: 265.0, atr: 3.0, tier: 0 });
  assert.ok(d, 'engine returned null -> NO trail action = the exact bug that cost the money');
  assert.strictEqual(d.action, 'STOP_REPLACE');
  assert.strictEqual(d.newTier, 1);
  assert.strictEqual(d.newStop, 271.60, `breakeven+BUF expected 271.60, got ${d.newStop}`);
});

check('TSM-02', 'LONG winner past T2 -> lock +1.5 ATR (not just breakeven)', () => {
  const d = trailDecision({ side: 'long', entry: 100, current: 104, atr: 1, tier: 1 });
  assert.ok(d, 'no action past T2');
  assert.strictEqual(d.newTier, 2);
  assert.strictEqual(d.newStop, 101.5, `T2 stop = entry+1.5ATR = 101.5, got ${d.newStop}`);
});

check('TSM-03', 'already at tier -> no duplicate replace (idempotent)', () => {
  // past T1 (in T1 band, not T2) but tier already 1 -> should NOT fire again
  const d = trailDecision({ side: 'short', entry: 271.55, current: 265.0, atr: 3.0, tier: 1 });
  assert.strictEqual(d, null, 'tier 1 already set and not past T2 -> must not re-issue');
});

check('TSM-04', 'price has NOT reached T1 -> no action (correctly leaves entry stop)', () => {
  const d = trailDecision({ side: 'short', entry: 271.55, current: 270.0, atr: 3.0, tier: 0 });
  assert.strictEqual(d, null, 'only 1.55 below entry (< 1.5*ATR=4.5) -> no trail yet');
});

// ---- FIX C: dead ATR must not silently mis-trail ----
check('TSM-05', 'zero/NaN ATR -> null, never a garbage stop at entry', () => {
  assert.strictEqual(trailDecision({ side: 'long', entry: 100, current: 110, atr: 0, tier: 0 }), null);
  assert.strictEqual(trailDecision({ side: 'long', entry: 100, current: 110, atr: NaN, tier: 0 }), null);
});

// ---- FIX D (master blocker): a protective STOP is NOT a duplicate close ----
check('TSM-06', 'own GTC protective stop does NOT block the catch-up/trail', () => {
  const openOrders = [{ side: 'buy', type: 'stop', status: 'new' }]; // the position's own stop (short -> buy-to-close stop)
  assert.strictEqual(
    catchUpBlockedByExistingClose(openOrders, 'buy'), false,
    'a stop order counted as a "duplicate close" -> trail engine never reached (the 07-24 master bug)'
  );
});

check('TSM-07', 'a REAL working market/limit close IS a duplicate -> correctly blocks', () => {
  const openOrders = [{ side: 'buy', type: 'market', status: 'new' }];
  assert.strictEqual(catchUpBlockedByExistingClose(openOrders, 'buy'), true);
});

// ---- H5 v3: swing holds are not "stale" while the broker still holds them ----
const NOW = Date.parse('2026-07-24T15:00:00Z');
const THREE_DAYS_AGO = Date.parse('2026-07-21T15:00:00Z');
check('H5-01', 'open row 3 days old WITH live broker position -> NOT stale', () => {
  assert.strictEqual(
    isStaleLedgerRow({ status: 'open', entryFillTimeMs: THREE_DAYS_AGO }, true, NOW), false,
    'swing hold flagged stale -> console redlined on every legit multi-day hold'
  );
});
check('H5-02', 'open row 3 days old with NO broker position -> stale (real orphan)', () => {
  assert.strictEqual(isStaleLedgerRow({ status: 'open', entryFillTimeMs: THREE_DAYS_AGO }, false, NOW), true);
});
check('H5-03', 'fresh open row (<2 days) -> never stale regardless of broker', () => {
  assert.strictEqual(isStaleLedgerRow({ status: 'open', entryFillTimeMs: NOW - 3600000 }, false, NOW), false);
});

// ---- WY 07-30/31 scenario: T1 fired, T2 never met -> designed breakeven giveback ----
// (order_events ground truth: stop 25.05 -> 24.42 (width-sanity) -> 24.26 @10:45 ET = round2(entry+BUF),
//  held T1 overnight, gapped up, covered 24.29. +$383 open profit round-tripped to -$39 BY DESIGN.)
check('WY-01', 'short T1 fires: stop -> round2(entry+BUF) = 24.26 (matches live order)', () => {
  const d = trailDecision({ side: 'short', entry: 24.2052, current: 23.75, atr: 0.30, tier: 0 });
  assert.ok(d, 'T1 must fire');
  assert.strictEqual(d.newTier, 1);
  assert.strictEqual(d.newStop, 24.26);
});
check('WY-02', 'the giveback window: tier 1, price above T2 trigger -> NO further trail (documents design)', () => {
  // T2 trigger = entry - 3*atr = 23.3052; price 23.34 never reached it at a 15-min sample
  const d = trailDecision({ side: 'short', entry: 24.2052, current: 23.34, atr: 0.30, tier: 1 });
  assert.strictEqual(d, null, 'between T1 and T2 nothing locks -> winner can round-trip to breakeven');
});
check('WY-03', 'if T2 HAD been met, profit locks: stop -> entry - 1.5*atr', () => {
  const d = trailDecision({ side: 'short', entry: 24.2052, current: 23.30, atr: 0.30, tier: 1 });
  assert.ok(d, 'T2 must fire at/below trigger');
  assert.strictEqual(d.newTier, 2);
  assert.strictEqual(d.newStop, 23.76);
});

// ---- Conclave B: bar-extreme trigger evaluation (flag-gated; guards pinned) ----
check('BX-01', 'flag OFF -> eval price === point sample (byte-identical behavior)', () => {
  const v = barExtremeEvalPrice({ isLong: false, current: 23.75, atr: 0.30, flagOn: false,
    bars: [{ h: 24.0, l: 23.20 }] });
  assert.strictEqual(v, 23.75);
});
check('BX-02', 'WY-style: session low touched T2 between samples -> extreme (minus eps) fires T2', () => {
  // short entry 24.2052 atr 0.30 -> T2 trigger 23.3052. Point sample 23.40 would NOT fire.
  const ev = barExtremeEvalPrice({ isLong: false, current: 23.40, atr: 0.30, flagOn: true,
    bars: [{ h: 23.9, l: 23.20 }] }); // low 23.20 beyond trigger by 0.105 > eps 0.03
  const d = trailDecision({ side: 'short', entry: 24.2052, current: ev, atr: 0.30, tier: 1 });
  assert.ok(d, 'T2 must fire off the bar extreme');
  assert.strictEqual(d.newTier, 2);
});
check('BX-03', 'noise epsilon: a wick only just past the trigger does NOT fire', () => {
  // low 23.29 is 0.015 past trigger 23.3052 < eps 0.03 -> adj 23.32 stays above trigger
  const ev = barExtremeEvalPrice({ isLong: false, current: 23.40, atr: 0.30, flagOn: true,
    bars: [{ h: 23.9, l: 23.29 }] });
  const d = trailDecision({ side: 'short', entry: 24.2052, current: ev, atr: 0.30, tier: 1 });
  assert.strictEqual(d, null, 'single-print wick inside epsilon must be absorbed');
});
check('BX-04', 'never less favorable than the point sample', () => {
  const v = barExtremeEvalPrice({ isLong: false, current: 23.10, atr: 0.30, flagOn: true,
    bars: [{ h: 23.9, l: 23.50 }] }); // extreme worse than current
  assert.strictEqual(v, 23.10);
});
check('BX-05', 'idempotent: reprocessing the same bars at an advanced tier fires nothing (monotonic)', () => {
  const ev = barExtremeEvalPrice({ isLong: false, current: 23.40, atr: 0.30, flagOn: true,
    bars: [{ h: 23.9, l: 23.20 }] });
  const d = trailDecision({ side: 'short', entry: 24.2052, current: ev, atr: 0.30, tier: 2 });
  assert.strictEqual(d, null);
});
check('BX-06', 'long mirror: session high (minus eps) fires the tier', () => {
  const ev = barExtremeEvalPrice({ isLong: true, current: 101.0, atr: 1.0, flagOn: true,
    bars: [{ h: 103.2, l: 100.0 }] }); // entry 100, T2 trigger 103; high 103.2 - eps 0.1 = 103.1 >= 103
  const d = trailDecision({ side: 'long', entry: 100, current: ev, atr: 1.0, tier: 1 });
  assert.ok(d); assert.strictEqual(d.newTier, 2); assert.strictEqual(d.newStop, 101.5);
});

// ---- Ledger completeness: winners must not be invisible ----
check('LEDGER-01', 'broker-closed winner missing from ledger is flagged (LDOS/AFL 07-24)', () => {
  const brokerClosed = [{ symbol: 'LDOS', closedAtBroker: true }, { symbol: 'AFL', closedAtBroker: true }, { symbol: 'WMT', closedAtBroker: false }];
  const ledger = new Set(['FIS', 'VRSN']); // winners absent
  const missing = missingLedgerRows(brokerClosed, ledger);
  assert.deepStrictEqual(missing.sort(), ['AFL', 'LDOS'], `expected LDOS+AFL flagged, got ${missing}`);
});
check('LEDGER-02', 'when every closed position has a row -> nothing flagged', () => {
  const brokerClosed = [{ symbol: 'LDOS', closedAtBroker: true }];
  assert.deepStrictEqual(missingLedgerRows(brokerClosed, new Set(['LDOS'])), []);
});

console.log(`\n  ${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
