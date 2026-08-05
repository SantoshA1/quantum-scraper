#!/usr/bin/env node
'use strict';
/**
 * Maya regression guard — ledger/broker reconciliation (QTP_LEDGER_BROKER_DIVERGENCE_v1).
 *
 * Maya asks: "My dashboard said I had six positions open. The broker said three. Three trades
 * had already closed hours earlier and nobody wrote it down — including one that MADE me $485.
 * Prove you can tell when the ledger is lying, prove you find the exit even when the trailing
 * stop manager swapped the order out, and prove a winner doesn't get filed as a loss."
 *
 * Deterministic + offline. Fixtures are the REAL 2026-08-04 order-event stream for AEE, WSM
 * and WMB, copied from quantum.order_events.
 */
const assert = require('assert');
const L = require('../lib/recon/ledger_divergence');

let passed = 0, failed = 0;
function check(id, name, fn) {
  try { fn(); console.log(`  ✅ ${id}  ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${id}  ${name}  — ${e.message}`); failed++; }
}
const near = (a, b, eps) => assert.ok(Math.abs(a - b) <= eps, `${a} !~ ${b}`);

// ── real ledger rows as they stood at 21:30 ET on 2026-08-04 ───────────────────
const ROW_AEE = { symbol: 'AEE', side: 'buy',  qty: 96,  entry_order_id: 'ce4330db', entry_fill_time: '2026-08-03T13:37:06Z', intended_stop: 105.05, intended_target: 116.44 };
const ROW_WSM = { symbol: 'WSM', side: 'buy',  qty: 45,  entry_order_id: 'e98efeb5', entry_fill_time: '2026-08-03T15:10:59Z', intended_stop: 229.12, intended_target: 245.54 };
const ROW_WMB = { symbol: 'WMB', side: 'sell', qty: 154, entry_order_id: 'dec5732d', entry_fill_time: '2026-08-04T13:34:11Z', intended_stop:  70.69, intended_target:  64.61 };

// ── real order-event stream (parent_order_id present only on true bracket legs) ─
const EVENTS = [
  // AEE: original bracket stop canceled, TSM replacement fills the next morning
  { symbol:'AEE', side:'sell:sell_to_close', order_status:'HELD',     order_type:'stop',   broker_order_id:'6be4434b', parent_order_id:'ce4330db', filled_quantity:0,  avg_fill_price:null,     stop_price:105.05, event_ts:'2026-08-03T13:36:08Z' },
  { symbol:'AEE', side:'buy:buy_to_open',    order_status:'FILLED',   order_type:'market', broker_order_id:'ce4330db', parent_order_id:null,       filled_quantity:96, avg_fill_price:109.1200, stop_price:null,   event_ts:'2026-08-03T13:37:06Z' },
  { symbol:'AEE', side:'sell:sell_to_close', order_status:'CANCELED', order_type:'stop',   broker_order_id:'6be4434b', parent_order_id:'ce4330db', filled_quantity:0,  avg_fill_price:null,     stop_price:105.05, event_ts:'2026-08-03T13:45:14Z' },
  { symbol:'AEE', side:'sell:sell_to_close', order_status:'NEW',      order_type:'stop',   broker_order_id:'e562f3bb', parent_order_id:null,       filled_quantity:0,  avg_fill_price:null,     stop_price:108.14, event_ts:'2026-08-03T13:45:16Z' },
  { symbol:'AEE', side:'SELL',               order_status:'FILLED',   order_type:'stop',   broker_order_id:'e562f3bb', parent_order_id:null,       filled_quantity:96, avg_fill_price:108.0017, stop_price:108.14, event_ts:'2026-08-04T13:40:27Z' },
  // WSM: stop canceled, flattened by a standalone MARKET order one second later
  { symbol:'WSM', side:'BUY',                order_status:'FILLED',   order_type:'market', broker_order_id:'e98efeb5', parent_order_id:null,       filled_quantity:45, avg_fill_price:234.5400, stop_price:null,   event_ts:'2026-08-03T15:10:59Z' },
  { symbol:'WSM', side:'sell:sell_to_close', order_status:'CANCELED', order_type:'stop',   broker_order_id:'5ca1bfa0', parent_order_id:null,       filled_quantity:0,  avg_fill_price:null,     stop_price:229.12, event_ts:'2026-08-04T13:46:01Z' },
  { symbol:'WSM', side:'SELL',               order_status:'FILLED',   order_type:'market', broker_order_id:'64bd14e2', parent_order_id:null,       filled_quantity:45, avg_fill_price:245.3100, stop_price:null,   event_ts:'2026-08-04T13:46:04Z' },
  // WMB: 15-minute naked window, then re-stopped 3% away and taken out
  { symbol:'WMB', side:'buy:buy_to_close',   order_status:'HELD',     order_type:'stop',   broker_order_id:'f2c52de9', parent_order_id:'dec5732d', filled_quantity:0,  avg_fill_price:null,     stop_price:70.69,  event_ts:'2026-08-04T13:31:02Z' },
  { symbol:'WMB', side:'sell:sell_to_open',  order_status:'FILLED',   order_type:'market', broker_order_id:'dec5732d', parent_order_id:null,       filled_quantity:154,avg_fill_price:69.3848,  stop_price:null,   event_ts:'2026-08-04T13:34:11Z' },
  { symbol:'WMB', side:'buy:buy_to_close',   order_status:'CANCELED', order_type:'stop',   broker_order_id:'f2c52de9', parent_order_id:'dec5732d', filled_quantity:0,  avg_fill_price:null,     stop_price:70.69,  event_ts:'2026-08-04T13:45:12Z' },
  { symbol:'WMB', side:'buy:buy_to_close',   order_status:'NEW',      order_type:'stop',   broker_order_id:'d31fa51e', parent_order_id:null,       filled_quantity:0,  avg_fill_price:null,     stop_price:71.56,  event_ts:'2026-08-04T14:00:23Z' },
  { symbol:'WMB', side:'BUY',                order_status:'FILLED',   order_type:'stop',   broker_order_id:'d31fa51e', parent_order_id:null,       filled_quantity:154,avg_fill_price:71.6000,  stop_price:71.56,  event_ts:'2026-08-04T15:06:48Z' },
];

// ── THE BUG ───────────────────────────────────────────────────────────────────
check('BUG-01', 'the old bracket-leg lookup finds NO exit for any of the three (H4 said "0 closed" 306x)', () => {
  for (const row of [ROW_AEE, ROW_WSM, ROW_WMB]) {
    const r = L.resolveExitOld(row, EVENTS);
    assert.strictEqual(r.found, false, `${row.symbol} should be invisible to the old rule`);
  }
});

check('BUG-02', 'the bracket leg TSM replaced was canceled unfilled — there was never anything to find', () => {
  const leg = EVENTS.find(e => e.broker_order_id === '6be4434b' && e.order_status === 'CANCELED');
  assert.ok(leg, 'AEE original bracket stop exists');
  assert.strictEqual(Number(leg.filled_quantity), 0, 'it never filled');
});

// ── THE FIX ───────────────────────────────────────────────────────────────────
check('FIX-01', 'AEE exit is found on the TSM replacement order, at the real fill price', () => {
  const r = L.resolveExit(ROW_AEE, EVENTS);
  assert.strictEqual(r.found, true);
  assert.strictEqual(r.exitOrderId, 'e562f3bb');
  near(r.exitPrice, 108.0017, 1e-9);
});

check('FIX-02', 'WSM exit is found on a standalone MARKET flatten', () => {
  const r = L.resolveExit(ROW_WSM, EVENTS);
  assert.strictEqual(r.found, true);
  assert.strictEqual(r.exitOrderId, '64bd14e2');
  assert.strictEqual(r.orderType, 'market');
});

check('FIX-03', 'WMB (a SHORT) resolves its exit to a BUY fill, not to another sell', () => {
  const r = L.resolveExit(ROW_WMB, EVENTS);
  assert.strictEqual(r.found, true);
  assert.strictEqual(r.exitOrderId, 'd31fa51e');
  near(r.exitPrice, 71.60, 1e-9);
});

check('FIX-04', 'the entry fill is never mistaken for the exit', () => {
  const r = L.resolveExit(ROW_AEE, EVENTS);
  assert.notStrictEqual(r.exitOrderId, 'ce4330db', 'entry order must not be claimed as the exit');
});

check('FIX-05', 'a partial-size fill cannot close a full position', () => {
  const half = EVENTS.map(e => (e.broker_order_id === 'e562f3bb' && e.order_status === 'FILLED')
    ? { ...e, filled_quantity: 48 } : e);
  assert.strictEqual(L.resolveExit(ROW_AEE, half).found, false, 'qty must match exactly');
});

check('FIX-06', 'a fill BEFORE the entry cannot be the exit (re-entered symbol)', () => {
  const stale = [{ ...EVENTS[4], event_ts: '2026-07-01T13:00:00Z', broker_order_id: 'oldfill' }, ...EVENTS];
  assert.strictEqual(L.resolveExit(ROW_AEE, stale).exitOrderId, 'e562f3bb', 'earlier unrelated fill ignored');
});

// ── ATTRIBUTION: the winner must not be filed as a loss ────────────────────────
check('ATTR-01', 'AEE: stop ratcheted 105.05 -> 108.14 toward entry = TRAIL, not a plain stop', () => {
  const x = L.resolveExit(ROW_AEE, EVENTS);
  const reason = L.classifyExitReason({ side:'buy', intendedStop:ROW_AEE.intended_stop,
    intendedTarget:ROW_AEE.intended_target, orderType:x.orderType, stopPrice:x.stopPrice, exitPrice:x.exitPrice });
  assert.strictEqual(reason, 'trail');
});

check('ATTR-02', 'WSM: flattened within 10bp of target = TARGET (the +$485 winner)', () => {
  const x = L.resolveExit(ROW_WSM, EVENTS);
  const reason = L.classifyExitReason({ side:'buy', intendedStop:ROW_WSM.intended_stop,
    intendedTarget:ROW_WSM.intended_target, orderType:x.orderType, stopPrice:x.stopPrice, exitPrice:x.exitPrice });
  assert.strictEqual(reason, 'target');
});

check('ATTR-03', 'WMB: short re-stopped AWAY from entry (70.69 -> 71.56) = STOP, never a trail', () => {
  const x = L.resolveExit(ROW_WMB, EVENTS);
  const reason = L.classifyExitReason({ side:'sell', intendedStop:ROW_WMB.intended_stop,
    intendedTarget:ROW_WMB.intended_target, orderType:x.orderType, stopPrice:x.stopPrice, exitPrice:x.exitPrice });
  assert.strictEqual(reason, 'stop', 'a stop moved away from entry is a recovery, not profit-locking');
});

check('ATTR-04', 'the live H5 heal would have mislabelled BOTH ratchets as plain "stop"', () => {
  // H5 hard-codes: exit_reason = lastFill >= 19:29 ? 'time' : 'stop'
  const h5 = (ts) => (String(ts).slice(11, 16) >= '19:29' ? 'time' : 'stop');
  assert.strictEqual(h5('2026-08-04T13:40:27Z'), 'stop');
  const x = L.resolveExit(ROW_AEE, EVENTS);
  const truth = L.classifyExitReason({ side:'buy', intendedStop:105.05, intendedTarget:116.44,
    orderType:x.orderType, stopPrice:x.stopPrice, exitPrice:x.exitPrice });
  assert.notStrictEqual(h5(x.exitTime), truth,
    'this disagreement is why exit_reason=trail shows n=2 while trail is the only profitable bucket');
});

// ── DIVERGENCE DETECTOR ───────────────────────────────────────────────────────
const BROKER_2130 = [
  { symbol:'AES', quantity:-731 }, { symbol:'WMT', quantity:-95 }, { symbol:'XPEV', quantity:-858 },
];
const LEDGER_BEFORE = [
  { symbol:'WMB', qty:154 }, { symbol:'XPEV', qty:858 }, { symbol:'WSM', qty:45 },
  { symbol:'AEE', qty:96 },  { symbol:'AES', qty:731 },  { symbol:'WMT', qty:95 },
];

check('DIV-01', 'the exact 2026-08-04 state is flagged: 3 phantom-open symbols', () => {
  const rows = L.classifyDivergence(LEDGER_BEFORE, BROKER_2130);
  const phantom = rows.filter(r => r.divergence === 'PHANTOM_OPEN').map(r => r.symbol);
  assert.deepStrictEqual(phantom, ['AEE', 'WMB', 'WSM']);
  assert.strictEqual(L.reconHealth(rows).status, 'DIVERGENT');
});

check('DIV-02', 'after the repair the same book reads CLEAN', () => {
  const after = LEDGER_BEFORE.filter(r => !['WMB', 'WSM', 'AEE'].includes(r.symbol));
  const rows = L.classifyDivergence(after, BROKER_2130);
  assert.strictEqual(L.reconHealth(rows).status, 'CLEAN');
  assert.strictEqual(L.reconHealth(rows).phantomOpen, 0);
});

check('DIV-03', 'a broker position with no ledger row is caught too (the opposite failure)', () => {
  const rows = L.classifyDivergence([], [{ symbol:'NVDA', quantity:100 }]);
  assert.strictEqual(rows[0].divergence, 'UNLEDGERED_POSITION');
});

check('DIV-04', 'a size mismatch is caught, not rounded away', () => {
  const rows = L.classifyDivergence([{ symbol:'AES', qty:731 }], [{ symbol:'AES', quantity:-700 }]);
  assert.strictEqual(rows[0].divergence, 'QTY_DIVERGENCE');
});

check('DIV-05', 'a stale broker snapshot can never report CLEAN', () => {
  const rows = L.classifyDivergence([{ symbol:'AES', qty:731 }], [{ symbol:'AES', quantity:-731 }]);
  assert.strictEqual(L.reconHealth(rows, false).status, 'CLEAN');
  assert.strictEqual(L.reconHealth(rows, true).status, 'DIVERGENT', 'stale snapshot = cannot vouch');
});

// ── THE OTHER THING TODAY'S STREAM SHOWS ──────────────────────────────────────
check('NAKED-01', 'WMB was unprotected for 15 minutes before being re-stopped 3% away', () => {
  const gaps = L.nakedWindows(EVENTS.filter(e => e.symbol === 'WMB'));
  assert.strictEqual(gaps.length, 1, 'exactly one naked window');
  const mins = gaps[0].gapMs / 60000;
  assert.ok(mins > 14 && mins < 16, `expected ~15 min, got ${mins.toFixed(1)}`);
});

check('NAKED-02', 'a 2-second cancel/replace is NOT reported as a naked window (AEE)', () => {
  const gaps = L.nakedWindows(EVENTS.filter(e => e.symbol === 'AEE'));
  assert.strictEqual(gaps.length, 0, 'sub-minute swaps are normal TSM churn');
});

check('SIDE-01', "Alpaca's side spellings all normalize (SELL_SHORT, buy_to_close, sell:sell_to_close)", () => {
  assert.strictEqual(L.normSide('SELL_SHORT'), 'sell');
  assert.strictEqual(L.normSide('buy:buy_to_close'), 'buy');
  assert.strictEqual(L.normSide('sell:sell_to_close'), 'sell');
  assert.strictEqual(L.normSide('BUY'), 'buy');
});

console.log(`\n  ${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
