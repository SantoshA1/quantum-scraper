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
const { trailDecision, catchUpBlockedByExistingClose, isStaleLedgerRow, missingLedgerRows } =
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
