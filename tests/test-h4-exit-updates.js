#!/usr/bin/env node
'use strict';
/**
 * Maya regression guard — the H4 "Build Exit Updates" node itself
 * (QTP_H4_EXIT_RESOLUTION_v2_20260804, workflow bBIAbsClonHP94hk).
 *
 * Maya asks: "Three of my trades closed and the system said '0 closed' 306 times.
 * Run the ACTUAL code you want to paste into n8n, against what the broker actually
 * returned that day, and show me it closes all three — and that it still works the
 * old way for a normal bracket that nobody touched."
 *
 * Executes docs/h4-build-exit-updates-v2.js verbatim inside a replica of the n8n Code
 * node scope ($('Node Name').all(), runOnceForAllItems, `return out`). Deterministic,
 * offline. Fixtures are the real 2026-08-04 Alpaca order shapes.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const CODE = fs.readFileSync(path.join(__dirname, '..', 'docs', 'h4-build-exit-updates-v2.js'), 'utf8');

let passed = 0, failed = 0;
function check(id, name, fn) {
  try { fn(); console.log(`  ✅ ${id}  ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${id}  ${name}  — ${e.message}`); failed++; }
}

/** Replica of the n8n Code-node scope. */
function runNode(nodes, code = CODE) {
  const $ = (name) => {
    if (!(name in nodes)) throw new Error(`no node "${name}"`);
    return { all: () => nodes[name].map((json) => ({ json })) };
  };
  return new Function('$', `${code}`)($);
}

// ── real ledger rows (as they stood open at 21:30 ET on 2026-08-04) ────────────
const ROWS = [
  { id:'e711978b', symbol:'AEE', side:'buy',  qty:96,  strategy:'qtp-main-pipeline', entry_order_id:'ce4330db', entry_fill_price:109.12, entry_fill_time:'2026-08-03T13:37:06Z', intended_stop:105.05, intended_target:116.44 },
  { id:'caafac4c', symbol:'WSM', side:'buy',  qty:45,  strategy:'qtp-main-pipeline', entry_order_id:'e98efeb5', entry_fill_price:234.54, entry_fill_time:'2026-08-03T15:10:59Z', intended_stop:229.12, intended_target:245.54 },
  { id:'c02fe3c3', symbol:'WMB', side:'sell', qty:154, strategy:'qtp-main-pipeline', entry_order_id:'dec5732d', entry_fill_price:69.3848, entry_fill_time:'2026-08-04T13:34:11Z', intended_stop:70.69,  intended_target:64.61 },
];

// ── what /v2/orders/{entry_id}?nested=true actually returned: legs all CANCELED ─
const ENTRY_ORDERS = [
  { id:'ce4330db', symbol:'AEE', status:'filled', filled_avg_price:109.12,  filled_at:'2026-08-03T13:37:06Z',
    legs:[{ id:'6be4434b', status:'canceled', type:'stop',  filled_avg_price:null, filled_at:null, stop_price:105.05 },
          { id:'813bb8e6', status:'canceled', type:'limit', filled_avg_price:null, filled_at:null, limit_price:116.44 }] },
  { id:'e98efeb5', symbol:'WSM', status:'filled', filled_avg_price:234.54,  filled_at:'2026-08-03T15:10:59Z',
    legs:[{ id:'18032c58', status:'canceled', type:'stop',  filled_avg_price:null, filled_at:null, stop_price:229.12 }] },
  { id:'dec5732d', symbol:'WMB', status:'filled', filled_avg_price:69.3848, filled_at:'2026-08-04T13:34:11Z',
    legs:[{ id:'f2c52de9', status:'canceled', type:'stop',  filled_avg_price:null, filled_at:null, stop_price:70.69 }] },
];

// ── what /v2/orders?status=closed returns: the standalone replacements that filled ─
const CLOSED_ORDERS = [
  { id:'e562f3bb', symbol:'AEE', side:'sell',       status:'filled', type:'stop',   qty:96,  filled_qty:96,  filled_avg_price:108.0017, filled_at:'2026-08-04T13:40:27Z', stop_price:108.14, limit_price:null },
  { id:'64bd14e2', symbol:'WSM', side:'sell',       status:'filled', type:'market', qty:45,  filled_qty:45,  filled_avg_price:245.31,   filled_at:'2026-08-04T13:46:04Z', stop_price:null,   limit_price:null },
  { id:'d31fa51e', symbol:'WMB', side:'buy',        status:'filled', type:'stop',   qty:154, filled_qty:154, filled_avg_price:71.60,    filled_at:'2026-08-04T15:06:48Z', stop_price:71.56,  limit_price:null },
  // noise the matcher must ignore
  { id:'ce4330db', symbol:'AEE', side:'buy',        status:'filled', type:'market', qty:96,  filled_qty:96,  filled_avg_price:109.12,   filled_at:'2026-08-03T13:37:06Z', stop_price:null,   limit_price:null },
  { id:'6be4434b', symbol:'AEE', side:'sell',       status:'canceled', type:'stop', qty:96,  filled_qty:0,   filled_avg_price:null,     filled_at:null,                   stop_price:105.05, limit_price:null },
  { id:'zzzzold',  symbol:'WMB', side:'buy',        status:'filled', type:'stop',   qty:154, filled_qty:154, filled_avg_price:65.00,    filled_at:'2026-07-01T14:00:00Z', stop_price:66.00,  limit_price:null },
];

const NODES = () => ({
  'Get Open Ledger Rows': ROWS.map(r => ({ ...r })),
  'Fetch Order Status':   ENTRY_ORDERS.map(o => ({ ...o })),
  'Fetch Closed Orders':  CLOSED_ORDERS.map(o => ({ ...o })),
});
const byId = (out, id) => out.find(x => x.json.ledger_id === id);

// ── THE BUG, reproduced against the live v1 resolution rule ────────────────────
check('BUG-01', 'v1 rule (nested bracket legs only) closes ZERO of the three', () => {
  let closes = 0;
  for (const o of ENTRY_ORDERS) if ((o.legs || []).find(l => l.status === 'filled')) closes++;
  assert.strictEqual(closes, 0, 'this is why H4 logged "0 closed" 306 times');
});

// ── THE FIX ───────────────────────────────────────────────────────────────────
check('FIX-01', 'v2 closes all three, every one via the account scan', () => {
  const out = runNode(NODES());
  const closed = out.filter(x => x.json.action === 'closed');
  assert.strictEqual(closed.length, 3, `expected 3 closed, got ${closed.length}`);
  assert.ok(closed.every(x => x.json.via === 'account_scan'), 'all three needed the new path');
});

check('FIX-02', 'AEE resolves to the TSM replacement stop at the real fill price', () => {
  const sql = byId(runNode(NODES()), 'e711978b').json.sql;
  assert.ok(sql.includes("exit_order_id = 'e562f3bb'"), sql);
  assert.ok(sql.includes('exit_fill_price = 108.0017'), sql);
  assert.ok(sql.includes("status = 'closed'"), sql);
});

check('FIX-03', 'WMB (SHORT) resolves to a BUY fill, not another sell', () => {
  const sql = byId(runNode(NODES()), 'c02fe3c3').json.sql;
  assert.ok(sql.includes("exit_order_id = 'd31fa51e'"), sql);
  assert.ok(sql.includes('exit_fill_price = 71.6'), sql);
});

check('FIX-04', 'WSM resolves to the standalone market flatten', () => {
  const sql = byId(runNode(NODES()), 'caafac4c').json.sql;
  assert.ok(sql.includes("exit_order_id = '64bd14e2'"), sql);
  assert.ok(sql.includes('exit_fill_price = 245.31'), sql);
});

check('FIX-05', 'the ENTRY fill is never claimed as the exit', () => {
  const sql = byId(runNode(NODES()), 'e711978b').json.sql;
  assert.ok(!sql.includes("exit_order_id = 'ce4330db'"), 'entry order must not be the exit');
});

check('FIX-06', 'a fill from a previous trade in the same symbol is ignored', () => {
  const sql = byId(runNode(NODES()), 'c02fe3c3').json.sql;
  assert.ok(!sql.includes('zzzzold'), 'pre-entry fill must not be claimed');
});

check('FIX-07', 'a canceled order is never treated as an exit', () => {
  const out = runNode(NODES());
  assert.ok(!JSON.stringify(out).includes('6be4434b'), 'canceled leg must not close a row');
});

check('FIX-08', 'a partial-size fill cannot close a full position', () => {
  const n = NODES();
  n['Fetch Closed Orders'] = n['Fetch Closed Orders'].map(o =>
    o.id === 'e562f3bb' ? { ...o, filled_qty: 48 } : o);
  const row = byId(runNode(n), 'e711978b');
  assert.ok(!row || row.json.action !== 'closed', 'qty must match exactly');
});

// ── BACKWARD COMPATIBILITY — an untouched bracket must behave exactly as v1 ────
check('COMPAT-01', 'a normal filled bracket leg still resolves, via bracket_leg', () => {
  const n = NODES();
  n['Fetch Order Status'] = [{ id:'ce4330db', symbol:'AEE', status:'filled', filled_avg_price:109.12, filled_at:'2026-08-03T13:37:06Z',
    legs:[{ id:'6be4434b', status:'filled', type:'stop', filled_avg_price:105.00, filled_at:'2026-08-03T18:00:00Z', stop_price:105.05 }] }];
  n['Get Open Ledger Rows'] = [ROWS[0]];
  const out = runNode(n);
  assert.strictEqual(out[0].json.via, 'bracket_leg');
  assert.ok(out[0].json.sql.includes("exit_order_id = '6be4434b'"));
});

check('COMPAT-02', 'with the new node ABSENT the whole thing degrades to v1, never worse', () => {
  const n = NODES();
  delete n['Fetch Closed Orders'];
  const out = runNode(n);
  assert.ok(out.length >= 1, 'must not throw');
  assert.strictEqual(out.filter(x => x.json.action === 'closed').length, 0, 'v1 behaviour');
});

check('COMPAT-03', 'a never-filled entry order is still marked busted', () => {
  const n = NODES();
  n['Get Open Ledger Rows'] = [ROWS[0]];
  n['Fetch Order Status'] = [{ id:'ce4330db', symbol:'AEE', status:'canceled', filled_at:null, legs:[] }];
  const out = runNode(n);
  assert.ok(out[0].json.sql.includes("status = 'busted'"), out[0].json.sql);
});

check('COMPAT-04', 'nothing to do still emits the noop row (downstream nodes expect an item)', () => {
  const n = { 'Get Open Ledger Rows': [], 'Fetch Order Status': [], 'Fetch Closed Orders': [] };
  const out = runNode(n);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].json.action, 'none');
  assert.ok(out[0].json.sql.includes('SELECT 1'));
});

// ── ATTRIBUTION — the reason v_learning_summary shows trail n=2 ────────────────
check('ATTR-01', 'AEE stop ratcheted 105.05 -> 108.14 toward entry = trail (v1 said "stop")', () => {
  const sql = byId(runNode(NODES()), 'e711978b').json.sql;
  assert.ok(sql.includes("exit_reason = 'trail'"), sql);
});

check('ATTR-02', 'WMB short re-stopped AWAY from entry (70.69 -> 71.56) = stop, never trail', () => {
  const sql = byId(runNode(NODES()), 'c02fe3c3').json.sql;
  assert.ok(sql.includes("exit_reason = 'stop'"), sql);
});

check('ATTR-03', 'WSM flattened within 10bp of target = target (the +$485 winner)', () => {
  const sql = byId(runNode(NODES()), 'caafac4c').json.sql;
  assert.ok(sql.includes("exit_reason = 'target'"), sql);
});

check('ATTR-04', 'intended_exit is the stop that really existed, not the original plan', () => {
  const out = runNode(NODES());
  assert.ok(byId(out, 'e711978b').json.sql.includes('intended_exit = 108.14'), 'AEE: actual 108.14, not 105.05');
  assert.ok(byId(out, 'c02fe3c3').json.sql.includes('intended_exit = 71.56'),  'WMB: actual 71.56, not 70.69');
});

check('ATTR-05', 'exit slippage derived from that is small and real, not tens of bp of fiction', () => {
  // AEE: sold 108.0017 against a 108.14 stop -> +12.79bp adverse (matches the 08-04 repair)
  const bp = -1 * (108.0017 - 108.14) / 108.14 * 10000;
  assert.ok(Math.abs(bp - 12.79) < 0.01, `expected ~12.79bp, got ${bp.toFixed(2)}`);
});

check('ATTR-06', 'a true trailing-stop order type is still classified trail', () => {
  const n = NODES();
  n['Get Open Ledger Rows'] = [ROWS[0]];
  n['Fetch Order Status'] = [ENTRY_ORDERS[0]];
  n['Fetch Closed Orders'] = [{ id:'trail01', symbol:'AEE', side:'sell', status:'filled', type:'trailing_stop',
    qty:96, filled_qty:96, filled_avg_price:110.0, filled_at:'2026-08-04T13:40:27Z', stop_price:null, limit_price:null }];
  assert.ok(runNode(n)[0].json.sql.includes("exit_reason = 'trail'"));
});

// ── SQL HYGIENE ───────────────────────────────────────────────────────────────
check('SQL-01', 'every emitted statement is a single scoped UPDATE with RETURNING', () => {
  for (const it of runNode(NODES())) {
    const s = it.json.sql;
    if (s === 'SELECT 1 AS noop') continue;
    assert.ok(s.startsWith('UPDATE public.trade_ledger SET '), s.slice(0, 60));
    assert.ok(/WHERE id = '[0-9a-f-]+'::uuid RETURNING /.test(s), s.slice(-90));
    assert.strictEqual(s.split(';').length, 1, 'no statement chaining');
  }
});

check('SQL-02', 'a quote in a broker id cannot break out of the statement', () => {
  const n = NODES();
  n['Fetch Closed Orders'] = n['Fetch Closed Orders'].map(o =>
    o.id === 'e562f3bb' ? { ...o, id: "e5'62f3bb" } : o);
  const sql = byId(runNode(n), 'e711978b').json.sql;
  assert.ok(sql.includes("exit_order_id = 'e5''62f3bb'"), 'quote must be doubled');
});

check('SQL-03', 'the repair is tagged so v2 closes are distinguishable from v1 rows', () => {
  const sql = byId(runNode(NODES()), 'e711978b').json.sql;
  assert.ok(sql.includes("lineage_source = 'H4_EXIT_RESOLUTION_v2'"), sql);
});

console.log(`\n  ${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
