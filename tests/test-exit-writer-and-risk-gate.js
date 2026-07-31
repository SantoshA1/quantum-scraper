#!/usr/bin/env node
'use strict';
/**
 * Maya regression guard — exit-writer/recon window fix + v_risk_gate_status + AFTO wiring (2026-07-29).
 *
 * Maya asks: "You told me a WMT short closed at the broker days ago but my ledger still
 * said OPEN — and the nightly reconciler kept missing it. Did you actually make the
 * reconciler SEE positions I've held more than 3 days, and does it still close them from
 * broker truth? And that risk-gate view you built — does it read right, and did you
 * quietly turn on a new trading halt when you wired it into AFTO?"
 */
const assert = require('assert');
const { ledgerRowVisibleToRecon, ledgerRowVisibleOld, healDecision, benignOrphanFilter } = require('../lib/recon/exit_heal');
const { riskGateStatus, aftoPause } = require('../lib/risk/gate_status');

const NOW = Date.parse('2026-07-29T22:00:00Z');
const daysAgo = (d) => new Date(NOW - d * 86400000).toISOString();

let passed = 0, failed = 0;
function check(id, name, fn) {
  try { fn(); console.log(`  ✅ ${id}  ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${id}  ${name}  — ${e.message}`); failed++; }
}

// ---- exit-writer / recon window fix ----
check('RECON-01', '6-day-old OPEN row (WMT-class swing) is now visible to the reconciler', () => {
  const wmt = { status: 'open', createdAt: daysAgo(6), side: 'sell', qty: 97, symbol: 'WMT' };
  assert.strictEqual(ledgerRowVisibleToRecon(wmt, NOW), true);
  assert.strictEqual(ledgerRowVisibleOld(wmt, NOW), false); // the old query would have dropped it
});
check('RECON-02', 'fresh closed row still visible; ancient closed row excluded (window kept for closed)', () => {
  assert.strictEqual(ledgerRowVisibleToRecon({ status: 'closed', createdAt: daysAgo(1) }, NOW), true);
  assert.strictEqual(ledgerRowVisibleToRecon({ status: 'closed', createdAt: daysAgo(9) }, NOW), false);
});
check('RECON-03', 'broker-closed short heals: exact opposite-qty fill group -> close from broker truth', () => {
  const row = { status: 'open', side: 'sell', qty: 97, symbol: 'WMT' };
  const fills = [{ symbol: 'WMT', side: 'buy', qty: 97, price: 111.40, transaction_time: '2026-07-27T14:21:00Z' }];
  const d = healDecision(row, fills);
  assert.strictEqual(d.heal, true);
  assert.strictEqual(d.exitPrice, 111.40);
  assert.strictEqual(d.exitReason, 'stop');
});
check('RECON-04', 'partial fills summing to full qty heal; a short fill group does NOT', () => {
  const row = { status: 'open', side: 'buy', qty: 207, symbol: 'ARE' };
  const full = [{ symbol: 'ARE', side: 'sell', qty: 103, price: 55.20, transaction_time: '2026-07-29T14:00:00Z' },
                { symbol: 'ARE', side: 'sell', qty: 52, price: 55.47, transaction_time: '2026-07-29T14:15:00Z' },
                { symbol: 'ARE', side: 'sell', qty: 52, price: 55.48, transaction_time: '2026-07-29T14:45:00Z' }];
  assert.strictEqual(healDecision(row, full).heal, true);
  const short = full.slice(0, 2);
  assert.strictEqual(healDecision(row, short).heal, false);
});
check('RECON-05', 'EOD-timed close -> exit_reason time; intraday -> stop', () => {
  const row = { status: 'open', side: 'buy', qty: 10, symbol: 'X' };
  const eod = [{ symbol: 'X', side: 'sell', qty: 10, price: 5, transaction_time: '2026-07-29T19:59:00Z' }];
  assert.strictEqual(healDecision(row, eod).exitReason, 'time');
});

// ---- benign-orphan filter (the ZBRA 2nd-exit-leg that lingered on the console) ----
check('ORPHAN-01', "a 2nd exit leg of a fully-closed position (ZBRA) is NOT flagged as orphan", () => {
  const rows = [{ id: 'z1', symbol: 'ZBRA', status: 'closed' }];
  const fills = [{ symbol: 'ZBRA', side: 'sell', order_id: 'leg2' }];
  assert.deepStrictEqual(benignOrphanFilter(fills, rows, []), []);
});
check('ORPHAN-02', 'a fill for a symbol still OPEN in the ledger stays flagged (real orphan)', () => {
  const rows = [{ id: 'o1', symbol: 'FOO', status: 'open' }];
  const fills = [{ symbol: 'FOO', side: 'buy', order_id: 'x' }];
  assert.strictEqual(benignOrphanFilter(fills, rows, []).length, 1);
});
check('ORPHAN-03', 'a fill for a symbol with NO ledger row at all stays flagged (real orphan)', () => {
  const fills = [{ symbol: 'GHOST', side: 'sell', order_id: 'x' }];
  assert.strictEqual(benignOrphanFilter(fills, [], []).length, 1);
});
check('ORPHAN-04', 'a just-healed symbol (now closed) is treated as reconciled -> not orphan', () => {
  const rows = [{ id: 'h1', symbol: 'ARE', status: 'open' }];
  const fills = [{ symbol: 'ARE', side: 'sell', order_id: 'extra' }];
  assert.deepStrictEqual(benignOrphanFilter(fills, rows, ['h1']), []); // h1 healed -> ARE reconciled-closed
});

// ---- v_risk_gate_status contract ----
check('GATE-01', 'all-protected book -> unprotected 0, ALLOW/GO (matches live 3/3)', () => {
  const rows = [{ protection_status: 'FULLY_PROTECTED' }, { protection_status: 'FULLY_PROTECTED' }, { protection_status: 'FULLY_PROTECTED' }];
  const s = riskGateStatus(rows);
  assert.strictEqual(s.unprotected_positions, 0);
  assert.strictEqual(s.new_entry_status, 'ALLOW_WITH_NORMAL_GATES');
  assert.strictEqual(s.phase_2_status, 'GO');
});
check('GATE-02', 'an unprotected position that blocks entries -> BLOCK_NEW_ENTRIES', () => {
  const rows = [{ protection_status: 'FULLY_PROTECTED' }, { protection_status: 'UNPROTECTED', blocks_new_entries: true }];
  const s = riskGateStatus(rows);
  assert.strictEqual(s.unprotected_positions, 1);
  assert.strictEqual(s.new_entry_status, 'BLOCK_NEW_ENTRIES');
});

// ---- AFTO wiring: building the view must NOT re-arm a trading halt ----
check('AFTO-01', 'unprotected>0 with flag OFF (default) does NOT pause — behaviour preserved', () => {
  assert.strictEqual(aftoPause({ marketHoliday: false, inSession: true, scannerSignals: 50, deadLetters: 0, unprotected: 2, tradingBlocked: false, pauseOnUnprotectedEnabled: false }), false);
});
check('AFTO-02', 'unprotected>0 with flag ON pauses — PO can arm the guard now the view exists', () => {
  assert.strictEqual(aftoPause({ marketHoliday: false, inSession: true, scannerSignals: 50, deadLetters: 0, unprotected: 2, tradingBlocked: false, pauseOnUnprotectedEnabled: true }), true);
});
check('AFTO-03', 'existing pause triggers still fire (dead letters, zero-signal, broker block)', () => {
  assert.strictEqual(aftoPause({ marketHoliday: false, inSession: true, scannerSignals: 0, deadLetters: 0, unprotected: 0, tradingBlocked: false, pauseOnUnprotectedEnabled: false }), true);
  assert.strictEqual(aftoPause({ marketHoliday: false, inSession: false, scannerSignals: 99, deadLetters: 1, unprotected: 0, tradingBlocked: false, pauseOnUnprotectedEnabled: false }), true);
  assert.strictEqual(aftoPause({ marketHoliday: false, inSession: false, scannerSignals: 99, deadLetters: 0, unprotected: 0, tradingBlocked: true, pauseOnUnprotectedEnabled: false }), true);
});

console.log(`\n  ${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
