#!/usr/bin/env node
'use strict';
/**
 * Maya regression guard — H4 Exit-Fill Sync "Get Open Ledger Rows" SELECT-completeness
 * gap (found 2026-08-06 while investigating the PO's "no new executions" report).
 *
 * Maya asks: "Your 08-04 fix to close positions TSM re-stopped was tested 22/22 and has
 * been running green every 5 minutes since. Four of MY real positions closed at the
 * broker today and this week and NONE of them ever left status='open' in the ledger.
 * Run the ACTUAL upstream query text against the ACTUAL 'Build Exit Updates' code, with
 * what the broker actually returned for WMT/AEP/WRB/APA, and show me why — then prove
 * your fix closes all four with the real numbers, and prove it can never silently drop
 * a field like this again."
 *
 * Two independent defects, both confirmed against live Supabase + n8n execution 527111
 * (2026-08-06T19:00:35Z) before any fix was written:
 *   (1) "Get Open Ledger Rows" never SELECTs `qty`. Build Exit Updates's account-scan
 *       match requires Math.abs(filled_qty - r.qty) < 1e-9; Number(undefined) is NaN;
 *       any comparison against NaN is false. The match can never succeed. Silent no-op
 *       since the hour QTP_H4_EXIT_RESOLUTION_v2_20260804 shipped.
 *   (2) "Fetch Closed Orders" only looks back 7 days. Alpaca's `after` filters on order
 *       SUBMISSION time, not fill time. WMT's qualifying replacement stop was submitted
 *       2026-07-30T13:45:11Z, ~5h15m before the 7-day cutoff at the 19:00:35Z run — it
 *       never enters the scan pool regardless of the qty fix.
 *
 * Deterministic + offline. Executes the ACTUAL docs/h4-build-exit-updates-v2.js verbatim
 * (same harness as tests/test-h4-exit-updates.js). Fixtures are the real captured rows
 * from trade_ledger, quantum.order_events, and n8n execution 527111's node output for
 * WMT, AEP, WRB, and APA — QTP's only four broker-closed-but-ledger-open positions.
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

function runNode(nodes, code = CODE) {
  const $ = (name) => {
    if (!(name in nodes)) throw new Error(`no node "${name}"`);
    return { all: () => nodes[name].map((json) => ({ json })) };
  };
  return new Function('$', `${code}`)($);
}

// ── real rows AS THE LIVE (buggy) SELECT actually returns them (no qty, no entry_fill_time) ─
const BUGGY_ROWS = [
  { id:'6e33161d-cb5d-4de1-83b9-235cd8d73deb', user_id:'04a6a5d7-ddc0-437f-b95b-5340941c0742', strategy:'qtp-main-pipeline', mode:'paper', symbol:'WMT', side:'sell', entry_order_id:'7c1ddb11-cb24-4bb9-9451-bda0570daaba', entry_fill_price:'112.4700', intended_stop:'115.8100', intended_target:'105.8200' },
  { id:'0a37556c-9534-4d21-9b32-20b0ecc10625', user_id:'04a6a5d7-ddc0-437f-b95b-5340941c0742', strategy:'qtp-main-pipeline', mode:'paper', symbol:'AEP', side:'sell', entry_order_id:'75fbddc8-5a7f-47bc-b74b-17a3ef929861', entry_fill_price:'126.0300', intended_stop:'132.2200', intended_target:'113.6300' },
  { id:'ecc21be6-3e08-4125-895b-22d596ac452f', user_id:'04a6a5d7-ddc0-437f-b95b-5340941c0742', strategy:'qtp-main-pipeline', mode:'paper', symbol:'WRB', side:'buy',  entry_order_id:'20ff4d42-46d7-47d0-b5a0-101368c6d949', entry_fill_price:'73.0553',  intended_stop:'70.8300',  intended_target:'74.5200' },
  { id:'efdbecf1-f0d2-4ef4-99ee-8918c4ce8295', user_id:'04a6a5d7-ddc0-437f-b95b-5340941c0742', strategy:'qtp-main-pipeline', mode:'paper', symbol:'APA', side:'buy',  entry_order_id:'1495d6a5-07b8-4253-b9fa-bf8081871363', entry_fill_price:'35.9000',  intended_stop:'34.4800',  intended_target:'38.7100' },
];
// ── same real rows AS THE FIXED SELECT will return them (qty + entry_fill_time added) ──
const FIXED_ROWS = [
  { ...BUGGY_ROWS[0], qty:'95.000000',  entry_fill_time:'2026-07-30T13:32:07.539883Z' },
  { ...BUGGY_ROWS[1], qty:'84.000000',  entry_fill_time:'2026-08-05T17:35:54.411898Z' },
  { ...BUGGY_ROWS[2], qty:'148.000000', entry_fill_time:'2026-08-06T13:33:37.209444Z' },
  { ...BUGGY_ROWS[3], qty:'298.000000', entry_fill_time:'2026-08-06T14:06:00.212098Z' },
];

// ── real "Fetch Order Status" (entry order + nested legs, all canceled) — captured n8n execution 527111 ──
const ENTRY_ORDERS = [
  { id:'7c1ddb11-cb24-4bb9-9451-bda0570daaba', symbol:'WMT', status:'filled', filled_avg_price:112.47, filled_at:'2026-07-30T13:32:07.539883Z',
    legs:[{ id:'54d6ef80-ce13-493b-b6ea-178e46d3932a', status:'canceled', type:'limit', filled_avg_price:null, filled_at:null }] },
  { id:'75fbddc8-5a7f-47bc-b74b-17a3ef929861', symbol:'AEP', status:'filled', filled_avg_price:126.03, filled_at:'2026-08-05T17:35:54.411898Z',
    legs:[{ id:'9270e184-9e0a-4f55-86cf-3ccf30b483ee', status:'canceled', type:'limit', filled_avg_price:null, filled_at:null },
          { id:'9941f179-a87f-4946-a44e-254470f859aa', status:'canceled', type:'stop',  filled_avg_price:null, filled_at:null, stop_price:132.22 }] },
  { id:'20ff4d42-46d7-47d0-b5a0-101368c6d949', symbol:'WRB', status:'filled', filled_avg_price:73.05527, filled_at:'2026-08-06T13:33:37.209444Z',
    legs:[{ id:'9ae7e181-c0fc-472e-be70-280a81d0ce80', status:'canceled', type:'limit', filled_avg_price:null, filled_at:null },
          { id:'4c1cc11d-2b1f-43d7-859d-7aeb453f0a3a', status:'canceled', type:'stop',  filled_avg_price:null, filled_at:null, stop_price:70.83 }] },
  { id:'1495d6a5-07b8-4253-b9fa-bf8081871363', symbol:'APA', status:'filled', filled_avg_price:35.9, filled_at:'2026-08-06T14:06:00.212098Z',
    legs:[{ id:'2b0dee8c-dc4a-49c4-90d4-f0632b67795b', status:'canceled', type:'limit', filled_avg_price:null, filled_at:null },
          { id:'d83f5bbd-80ae-4c51-b093-aa451b269ac6', status:'canceled', type:'stop',  filled_avg_price:null, filled_at:null, stop_price:34.48 }] },
];

// ── real "Fetch Closed Orders" pool AS THE LIVE 7-DAY WINDOW actually returned it at
//    2026-08-06T19:00:35Z (execution 527111): AEP/WRB/APA present, WMT genuinely absent ──
const CLOSED_ORDERS_7DAY = [
  { id:'d45400fb-a364-44cf-af28-f472ce96a2bb', symbol:'AEP', side:'buy',  status:'filled', type:'stop',   qty:84,  filled_qty:84,  filled_avg_price:127.34369, filled_at:'2026-08-06T13:33:55.534756Z', stop_price:127.16, limit_price:null },
  { id:'f93e4ddc-a880-4068-8fe5-cfc7150e9d44', symbol:'WRB', side:'sell', status:'filled', type:'market', qty:148, filled_qty:148, filled_avg_price:71.99,     filled_at:'2026-08-06T13:46:06.555059Z', stop_price:null,   limit_price:null },
  { id:'e0ca2fe0-a688-4731-8a5f-651117787d29', symbol:'APA', side:'sell', status:'filled', type:'market', qty:298, filled_qty:298, filled_avg_price:35.748456, filled_at:'2026-08-06T14:30:15.018696Z', stop_price:null,   limit_price:null },
  // noise: canceled/entry orders that must not be claimed
  { id:'9270e184-9e0a-4f55-86cf-3ccf30b483ee', symbol:'AEP', side:'buy',  status:'canceled', type:'limit', qty:84,  filled_qty:0, filled_avg_price:null, filled_at:null, stop_price:null, limit_price:113.63 },
  { id:'75fbddc8-5a7f-47bc-b74b-17a3ef929861', symbol:'AEP', side:'sell', status:'filled',   type:'market',qty:84,  filled_qty:84, filled_avg_price:126.03, filled_at:'2026-08-05T17:35:54.411898Z', stop_price:null, limit_price:null },
  // WMT's real closing order is deliberately NOT here — this is the actual live pool.
];
// ── the SAME pool, WIDENED to 14 days: adds WMT's real closing order (submitted 2026-07-30
//    13:45:11Z, which the 7-day cutoff excludes but 14 days comfortably includes) ──
const CLOSED_ORDERS_14DAY = [
  ...CLOSED_ORDERS_7DAY,
  { id:'dd2fe238-e6e2-4414-adc4-8e0181440a9f', symbol:'WMT', side:'buy', status:'filled', type:'stop', qty:95, filled_qty:95, filled_avg_price:113.91, filled_at:'2026-08-06T13:31:03.729Z', stop_price:113.48, limit_price:null },
];

const byId = (out, id) => out.find(x => x.json.ledger_id === id);
const NODES = (rows, closed) => ({
  'Get Open Ledger Rows': rows,
  'Fetch Order Status':   ENTRY_ORDERS.map(o => ({ ...o })),
  'Fetch Closed Orders':  closed,
});

// ── GAP-01: reproduce today's exact live failure — buggy SELECT, real 7-day pool ───────
check('GAP-01', 'buggy SELECT (no qty) + live 7-day pool: WMT/AEP/WRB/APA all stay open — the actual 19:00:35Z outcome', () => {
  const out = runNode(NODES(BUGGY_ROWS, CLOSED_ORDERS_7DAY));
  const closed = out.filter(x => x.json.action === 'closed');
  assert.strictEqual(closed.length, 0, `expected 0 closed (this IS execution 527111's real result), got ${closed.length}`);
});

check('GAP-01b', 'the failure is specifically Number(undefined) vs filled_qty, not a data problem — same pool, qty added, AEP alone now resolves', () => {
  const rowsWithQtyOnly = BUGGY_ROWS.map((r, i) => ({ ...r, qty: FIXED_ROWS[i].qty }));
  const out = runNode(NODES(rowsWithQtyOnly, CLOSED_ORDERS_7DAY));
  const aep = byId(out, '0a37556c-9534-4d21-9b32-20b0ecc10625');
  assert.strictEqual(aep.json.action, 'closed', 'qty alone is enough to unblock AEP (entry_fill_time falls back to o.filled_at)');
});

// ── GAP-02: fixed SELECT (qty + entry_fill_time), still the live 7-day pool ────────────
check('GAP-02', 'fixed rows + live 7-day pool: AEP/WRB/APA close with exact real numbers; WMT still does NOT (independent window bug)', () => {
  const out = runNode(NODES(FIXED_ROWS, CLOSED_ORDERS_7DAY));

  const wmt = byId(out, '6e33161d-cb5d-4de1-83b9-235cd8d73deb');
  assert.ok(!wmt || wmt.json.action !== 'closed', 'WMT must NOT close yet — its real closer is outside the 7-day pool');

  const aep = byId(out, '0a37556c-9534-4d21-9b32-20b0ecc10625');
  assert.strictEqual(aep.json.action, 'closed');
  assert.ok(aep.json.sql.includes("exit_order_id = 'd45400fb-a364-44cf-af28-f472ce96a2bb'"), aep.json.sql);
  assert.ok(aep.json.sql.includes('exit_fill_price = 127.34369'), aep.json.sql);
  assert.ok(aep.json.sql.includes("exit_reason = 'trail'"), 'AEP stop 127.16 tightened vs intended 132.22 (short) = trail');

  const wrb = byId(out, 'ecc21be6-3e08-4125-895b-22d596ac452f');
  assert.strictEqual(wrb.json.action, 'closed');
  assert.ok(wrb.json.sql.includes("exit_order_id = 'f93e4ddc-a880-4068-8fe5-cfc7150e9d44'"), wrb.json.sql);
  assert.ok(wrb.json.sql.includes('exit_fill_price = 71.99'), wrb.json.sql);
  assert.ok(wrb.json.sql.includes("exit_reason = 'manual'"), 'WRB market panic-close, not a stop/target mechanism');

  const apa = byId(out, 'efdbecf1-f0d2-4ef4-99ee-8918c4ce8295');
  assert.strictEqual(apa.json.action, 'closed');
  assert.ok(apa.json.sql.includes("exit_order_id = 'e0ca2fe0-a688-4731-8a5f-651117787d29'"), apa.json.sql);
  assert.ok(apa.json.sql.includes('exit_fill_price = 35.748456'), apa.json.sql);
});

check('GAP-02b', 'realized P&L implied by the closing fills matches the incident math — losses, not the smaller unrealized snapshots quoted earlier today', () => {
  const r2 = (n) => Math.round(n * 100) / 100;
  assert.strictEqual(r2(-1 * (113.91 - 112.47) * 95), -136.8, 'WMT short: -136.80');
  assert.strictEqual(r2(-1 * (127.34369 - 126.03) * 84), -110.35, 'AEP short: -110.35 (governance snapshot never quoted this one)');
  assert.strictEqual(r2(1 * (71.99 - 73.0553) * 148), -157.66, 'WRB long: -157.66 realized, worse than the -143.60 unrealized snapshot in gov 190');
  assert.strictEqual(r2(1 * (35.748456 - 35.9) * 298), -45.16, 'APA long: -45.16 realized, close to the -47.68 unrealized snapshot in gov 190');
});

// ── GAP-03: fixed rows + widened 14-day pool — WMT now also resolves ───────────────────
check('GAP-03', 'fixed rows + 14-day pool: WMT now closes too, with the real stop fill', () => {
  const out = runNode(NODES(FIXED_ROWS, CLOSED_ORDERS_14DAY));
  const wmt = byId(out, '6e33161d-cb5d-4de1-83b9-235cd8d73deb');
  assert.strictEqual(wmt.json.action, 'closed');
  assert.strictEqual(wmt.json.via, 'account_scan');
  assert.ok(wmt.json.sql.includes("exit_order_id = 'dd2fe238-e6e2-4414-adc4-8e0181440a9f'"), wmt.json.sql);
  assert.ok(wmt.json.sql.includes('exit_fill_price = 113.91'), wmt.json.sql);
  assert.ok(wmt.json.sql.includes("exit_reason = 'trail'"), 'WMT stop 113.48 tightened vs intended 115.81 (short) = trail');

  const all = out.filter(x => x.json.action === 'closed');
  assert.strictEqual(all.length, 4, 'all four of QTPs real broker-closed-but-ledger-open positions now resolve');
});

// ── GAP-04: lockstep — the deployed SQL text actually carries both fixes ───────────────
check('GAP-04', 'deployed "Get Open Ledger Rows" SELECT carries qty + entry_fill_time; WHERE/ORDER/LIMIT untouched', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'docs', 'h4-ledger-sync-fix-20260806', 'get-open-ledger-rows-v2.sql'), 'utf8');
  const afterBlock = sql.slice(sql.indexOf('-- AFTER:'));
  assert.ok(/SELECT id, user_id, strategy, mode, symbol, side, qty, entry_order_id, entry_fill_price, entry_fill_time, intended_stop, intended_target FROM/.test(afterBlock), afterBlock);
  assert.ok(afterBlock.includes("WHERE status = 'open' AND mode = 'paper' AND entry_order_id IS NOT NULL ORDER BY created_at LIMIT 50"), 'guard clause unchanged');
});

check('GAP-04b', 'deployed "Fetch Closed Orders" after-window widened from 7 to 14 days, expression shape otherwise unchanged', () => {
  const txt = fs.readFileSync(path.join(__dirname, '..', 'docs', 'h4-ledger-sync-fix-20260806', 'fetch-closed-orders-after-v2.txt'), 'utf8');
  const afterBlock = txt.slice(txt.indexOf('AFTER:'));
  assert.ok(afterBlock.includes('Date.now() - 14*86400000'), afterBlock);
  assert.ok(!afterBlock.includes('7*86400000'), 'the stale 7-day literal must be gone from the AFTER block');
});

// ── GAP-05: completeness guard — every r.<field> the JS reads must be in the SELECT ────
// This is the guard that should have existed on 2026-08-04: it makes this exact class of
// regression (a field the Code node reads but the upstream query never selects) fail loudly
// for ANY field, not just qty, the next time either file changes.
check('GAP-05', 'every r.<field> referenced in Build Exit Updates is present in the fixed SELECT column list', () => {
  const jsFields = new Set([...CODE.matchAll(/\br\.([a-zA-Z_][a-zA-Z0-9_]*)\b/g)].map(m => m[1]));
  const sql = fs.readFileSync(path.join(__dirname, '..', 'docs', 'h4-ledger-sync-fix-20260806', 'get-open-ledger-rows-v2.sql'), 'utf8');
  const afterBlock = sql.slice(sql.indexOf('-- AFTER:'));
  const selectLine = afterBlock.split('\n').find(l => l.trim().toUpperCase().startsWith('SELECT'));
  const cols = new Set(
    selectLine.slice(selectLine.toUpperCase().indexOf('SELECT') + 6, selectLine.toUpperCase().indexOf(' FROM'))
      .split(',').map(c => c.trim())
  );
  const missing = [...jsFields].filter(f => !cols.has(f));
  assert.deepStrictEqual(missing, [], `Build Exit Updates reads r.${missing.join(', r.')} but the SELECT never fetches ${missing.length === 1 ? 'it' : 'them'}`);
});

console.log(`\n  ${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
