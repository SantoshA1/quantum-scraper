#!/usr/bin/env node
// gov 241 — QTP Policy Time Exit: executed-harness suite (2026-08-25)
// Executes docs/timeexit-20260825/timeexit-close.js (the EXACT bytes deployed to the
// "Close Due Positions" Code node) against a mock Alpaca recording every HTTP call,
// and string-pins the fail-safes of timeexit-query.sql (whose semantics were proven
// live: epoch absent -> 0 rows with DGX open; 08-21 entry -> 2 sessions incl. today).
// Field lesson (gov 241): executed-region harnesses inject the region's INPUTS
// ($vars, $input, this.helpers, setTimeout), never its intermediates.
// Sabotage matrix (each must BITE):
//   S1 close-before-cancel reorder        -> ordering assert fails
//   S2 epoch fail-safe dropped from SQL   -> SQL pin fails
//   S3 failure->Telegram loop muted       -> loud-failure assert fails
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const CODE = fs.readFileSync(path.join(ROOT, 'docs/timeexit-20260825/timeexit-close.js'), 'utf8');
const SQL = fs.readFileSync(path.join(ROOT, 'docs/timeexit-20260825/timeexit-query.sql'), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, name, extra) => { if (cond) { pass++; console.log('  PASS ' + name); } else { fail++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')); } };
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// ---- harness: run the node bytes with mocked inputs ----
function makeAlpaca(state) {
  // state: { positions: [...], open: {SYM: [orders...]}, cancelRefuses: {SYM: n}, failList: bool }
  const calls = [];
  const httpRequest = async (opt) => {
    const u = opt.url.replace(/^https?:\/\/[^/]+/, '');
    calls.push({ method: opt.method, path: u, body: opt.body });
    if (opt.method === 'GET' && u === '/v2/positions') { if (state.failList) throw new Error('boom 503 <svc>'); return state.positions; }
    if (opt.method === 'GET' && u.startsWith('/v2/orders?status=open&limit')) { return Object.values(state.open).flat(); }
    if (opt.method === 'GET' && u.startsWith('/v2/orders?status=open&symbols=')) { const s = u.split('symbols=')[1]; return (state.open[s] || []); }
    if (opt.method === 'DELETE') { const id = u.split('/').pop(); for (const s of Object.keys(state.open)) { if ((state.cancelRefuses[s] || 0) > 0) { state.cancelRefuses[s]--; continue; } state.open[s] = state.open[s].filter((o) => o.id !== id); } return {}; }
    if (opt.method === 'POST' && u === '/v2/orders') { return { id: 'ord_' + opt.body.symbol }; }
    throw new Error('unexpected call ' + opt.method + ' ' + u);
  };
  return { calls, helpers: { httpRequest } };
}
async function runNode(code, { vars, items, alpaca }) {
  const logs = [];
  const fakeConsole = { log: (...a) => logs.push(a.join(' ')) };
  const fakeSetTimeout = (fn) => fn(); // instant sleeps
  const $input = { all: () => items.map((j) => ({ json: j })) };
  const fn = new AsyncFunction('$vars', '$input', 'setTimeout', 'console', code);
  const out = await fn.call({ helpers: alpaca.helpers }, vars, $input, fakeSetTimeout, fakeConsole);
  return { out: out[0].json, logs, calls: alpaca.calls };
}
const VARS = { ALPACA_BASE_URL: 'https://paper-api.alpaca.markets', ALPACA_API_KEY: 'k', ALPACA_SECRET_KEY: 's' };
const DUE = (sym) => ({ symbol: sym, ledger_qty: '100', sessions_incl_today: 2, entered_et: '2026-08-21 09:35' });
function orderingViolation(calls) {
  // for each symbol: no POST /v2/orders before every DELETE for that symbol has happened
  const posted = new Set();
  for (const c of calls) {
    if (c.method === 'POST' && c.path === '/v2/orders') posted.add(c.body.symbol);
    if (c.method === 'DELETE' && posted.size) return true; // a DELETE after any close = reorder
  }
  return false;
}

(async () => {
  console.log('== SQL fail-safe pins ==');
  ok(SQL.includes('exists (select 1 from epoch)'), 'TX-SQL-1 epoch-required fail-safe present');
  ok(SQL.includes("constant_name = 'edge_baseline_epoch'") && SQL.includes("gate_id = 'GATE_K'"), 'TX-SQL-2 epoch sourced from GATE_K config');
  ok(SQL.includes('entry_fill_time >= to_timestamp((select v from epoch)'), 'TX-SQL-3 cohort scoped to post-epoch entries (protects DGX)');
  ok(SQL.includes('generate_series') && SQL.includes('extract(isodow from g.d) < 6') && SQL.includes('nyse_holidays'), 'TX-SQL-4 v2 deterministic weekday session clock minus NYSE holidays (gov244: no feed can starve it)');
  ok(!SQL.replace(/--[^\n]*/g, '').includes('scorer_bars_daily'), 'TX-SQL-4b the dead bars calendar is out of the CODE (history comment allowed)');
  ok(SQL.includes("date '2026-09-07'") && SQL.includes("date '2026-12-25'"), 'TX-SQL-4c 2026 holiday list present (renew each December)');
  ok(SQL.includes('limit 10'), 'TX-SQL-5 blast-radius LIMIT 10');
  ok(SQL.includes("t.side in ('buy', 'buy_call', 'sell_put')") && SQL.includes("t.status = 'open'"), 'TX-SQL-6 longs-only, open-only');
  ok(SQL.includes('sessions_incl_today >= 2'), 'TX-SQL-7 2-session threshold (E1 time_2d)');

  console.log('== Close node: executed ==');
  { // TX-01 happy path: 2 protective legs then close
    const a = makeAlpaca({ positions: [{ symbol: 'ABC', qty: '100' }], open: { ABC: [{ id: 'o1', symbol: 'ABC', side: 'sell' }, { id: 'o2', symbol: 'ABC', side: 'sell' }] }, cancelRefuses: {} });
    const r = await runNode(CODE, { vars: VARS, items: [DUE('ABC')], alpaca: a });
    const post = a.calls.find((c) => c.method === 'POST');
    ok(r.out.closed_n === 1 && r.out.failed_n === 0, 'TX-01a closes the due long, zero failures', JSON.stringify(r.out.failed));
    ok(post && post.body.qty === '100' && post.body.side === 'sell' && post.body.type === 'market' && post.body.time_in_force === 'day', 'TX-01b market sell, tif day, live qty');
    ok(post && /^qtp_timeexit_ABC_\d{8}$/.test(post.body.client_order_id), 'TX-01c client_order_id qtp_timeexit_ABC_YYYYMMDD', post && post.body.client_order_id);
    ok(a.calls.filter((c) => c.method === 'DELETE').length === 2 && !orderingViolation(a.calls), 'TX-01d BOTH legs canceled BEFORE the close (ordering)');
    ok(r.out._tg_text.includes('<b>ABC</b>') && r.out._tg_text.includes('2 protective leg(s) canceled'), 'TX-01e Telegram names the close');
  }
  { // TX-02 already flat
    const a = makeAlpaca({ positions: [], open: {}, cancelRefuses: {} });
    const r = await runNode(CODE, { vars: VARS, items: [DUE('GONE')], alpaca: a });
    ok(r.out.skipped_n === 1 && r.out.closed_n === 0 && !a.calls.some((c) => c.method !== 'GET'), 'TX-02 flat symbol skipped, nothing touched');
  }
  { // TX-03 cancel refuses -> NO close, loud failure
    const a = makeAlpaca({ positions: [{ symbol: 'STK', qty: '50' }], open: { STK: [{ id: 'o9', symbol: 'STK', side: 'sell' }] }, cancelRefuses: { STK: 99 } });
    const r = await runNode(CODE, { vars: VARS, items: [DUE('STK')], alpaca: a });
    ok(r.out.failed_n === 1 && r.out.closed_n === 0, 'TX-03a refused cancel -> symbol fails, not closed');
    ok(!a.calls.some((c) => c.method === 'POST'), 'TX-03b NO market order while shares reserved');
    ok(r.out._tg_text.includes('FAILED') && r.out._tg_text.includes('⚠️'), 'TX-03c failure is LOUD in Telegram text');
  }
  { // TX-04 paper guard
    let threw = null; const a = makeAlpaca({ positions: [], open: {}, cancelRefuses: {} });
    try { await runNode(CODE, { vars: { ...VARS, ALPACA_BASE_URL: 'https://api.alpaca.markets' }, items: [DUE('ABC')], alpaca: a }); } catch (e) { threw = e; }
    ok(threw && /paper/.test(String(threw.message)) && a.calls.length === 0, 'TX-04 non-paper base -> throws before ANY http call');
  }
  { // TX-05 snapshot failure -> abort all, no writes
    const a = makeAlpaca({ positions: [], open: {}, cancelRefuses: {}, failList: true });
    const r = await runNode(CODE, { vars: VARS, items: [DUE('ABC'), DUE('XYZ')], alpaca: a });
    ok(r.out.failed_n >= 3 && !a.calls.some((c) => c.method === 'POST' || c.method === 'DELETE'), 'TX-05 blind account -> every symbol aborted, zero writes');
    ok(r.out._tg_text.includes('&lt;svc&gt;'), 'TX-05b error text HTML-escaped');
  }
  { // TX-06 live short -> skip loud
    const a = makeAlpaca({ positions: [{ symbol: 'SHT', qty: '-5' }], open: {}, cancelRefuses: {} });
    const r = await runNode(CODE, { vars: VARS, items: [DUE('SHT')], alpaca: a });
    ok(r.out.skipped_n === 1 && !a.calls.some((c) => c.method === 'POST'), 'TX-06 live short skipped (longs only)');
  }
  { // TX-07 blast radius alarm at 10 due
    const syms = Array.from({ length: 10 }, (_, i) => 'S' + i);
    const a = makeAlpaca({ positions: syms.map((s) => ({ symbol: s, qty: '1' })), open: {}, cancelRefuses: {} });
    const r = await runNode(CODE, { vars: VARS, items: syms.map(DUE), alpaca: a });
    ok(r.out._tg_text.includes('blast_radius') && r.out._tg_text.includes('LIMIT 10'), 'TX-07 10 due -> blast-radius alarm line');
  }
  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  if (process.env.SABOTAGE) {
    console.log('(sabotage run — a FAILURE above means the suite BIT, which is the point)');
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
