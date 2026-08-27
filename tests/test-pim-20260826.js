#!/usr/bin/env node
// gov 242 — Policy Invariant Monitor: executed-harness suite (2026-08-26)
// Executes docs/pim-20260826/pim-broker-checks.js (EXACT deploy bytes) against mock
// Alpaca + mock n8n API, and string-pins pim-query.sql's fail-safes.
// The monitor exists because gov 241c proved policies get repealed by code, not by
// decisions — so this suite's core is: every violation class FIRES, the heartbeat
// only reads green when every group ran, and blindness is never silence.
// Field lesson (gov 241c, ratcheted): grep semantics not literals; executed regions
// must cover every consumer — here the ENTIRE node executes, no region slicing.
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const CODE = fs.readFileSync(path.join(ROOT, 'docs/pim-20260826/pim-broker-checks.js'), 'utf8');
const SQL = fs.readFileSync(path.join(ROOT, 'docs/pim-20260826/pim-query.sql'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, name, extra) => { if (c) { pass++; console.log('  PASS ' + name); } else { fail++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')); } };
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const EXPECTED_GROUPS = 9;

const VARS = { ALPACA_BASE_URL: 'https://paper-api.alpaca.markets', ALPACA_API_KEY: 'k', ALPACA_SECRET_KEY: 's', N8N_API_KEY: 'n' };
const HEALTHY_INV = () => ({
  I1_bad_stop_widths: [], I4_epoch: { v: 1787692697, status: 'LIVE_PROVISIONAL' },
  I6_overdue_longs: [], I8_earnings_stale_days: 0.2, I9_short_entries_today: [],
  I10_cohort: { n: 3, pf: 1.4 },
  open_post_epoch: [{ sym: 'FLEX', qty: 93, entry: 111.7, stop: 108.91, sessions: 1 }],
  entries: [{ sym: 'FLEX', side: 'buy', qty: 93, entry: 111.7, risk: 259 }],
  entries_today_n: 1,
});
const HEALTHY_BROKER = () => ({
  account: { equity: '104000' },
  positions: [{ symbol: 'FLEX', qty: '93' }],
  orders: [{ symbol: 'FLEX', side: 'sell', type: 'stop', status: 'held', qty: '93', stop_price: '108.91', time_in_force: 'gtc', legs: [] }],
  n8nActive: { vaqfCaELhOEWnkdo: true, vFnPjyx8srnzcYgV: true, OZx8Lh15zzo7jrJp: true },
});
async function runPIM(inv, broker, vars) {
  const logs = [];
  const fakeConsole = { log: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push('E ' + a.join(' ')) };
  const httpRequest = async (opt) => {
    const u = opt.url;
    if (u.indexOf('tradenextgen.app.n8n.cloud') >= 0) {
      const id = u.split('/').pop();
      if (broker.n8nFail) throw new Error('n8n api down');
      return { id, active: broker.n8nActive[id] !== undefined ? broker.n8nActive[id] : true };
    }
    const p = u.replace(/^https?:\/\/[^/]+/, '');
    if (p === '/v2/account') { if (broker.failAccount) throw new Error('503'); return broker.account; }
    if (p === '/v2/positions') { if (broker.failPositions) throw new Error('boom <pos> 503'); return broker.positions; }
    if (p.startsWith('/v2/orders')) { if (broker.failOrders) throw new Error('503'); return broker.orders; }
    throw new Error('unexpected ' + p);
  };
  const $input = { first: () => ({ json: { inv } }) };
  const fn = new AsyncFunction('$vars', '$input', 'console', CODE);
  const out = await fn.call({ helpers: { httpRequest } }, vars || VARS, $input, fakeConsole);
  return { out: out[0].json, logs };
}
const codes = (r) => r.out.violations.map((v) => v.code);

(async () => {
  console.log('== SQL pins ==');
  ok(SQL.includes('exists (select 1 from epoch)') && SQL.includes("to_timestamp((select v from epoch)"), 'PIM-SQL-1 open_post_epoch is epoch-scoped (DGX excluded)');
  ok(SQL.includes('stop_pct < 1.8 or stop_pct > 3.2'), 'PIM-SQL-2 I1 sanity band 1.8/3.2 (v1.2 fill-basis calibration)');
  ok(SQL.includes('sessions >= 3'), 'PIM-SQL-3 I6 overdue = session 3+');
  ok(!/\b(insert|update|delete|truncate|alter|drop)\b/i.test(SQL.replace(/--[^\n]*/g, '')), 'PIM-SQL-4 READ-ONLY (no write verbs outside comments)');
  ok(SQL.includes("side not in ('buy','buy_call','sell_put')"), 'PIM-SQL-5 I9 short-leak predicate');
  ok(SQL.includes("not like 'RECERT_QUARANTINE%'"), 'PIM-SQL-6 adjudicated quarantines do not re-alarm');

  console.log('== executed node ==');
  { const r = await runPIM(HEALTHY_INV(), HEALTHY_BROKER());
    ok(r.out.green === true && r.out.violations.length === 0, 'PIM-01a healthy world -> green, zero violations', JSON.stringify(r.out.violations));
    ok(r.out.checks_run === EXPECTED_GROUPS, 'PIM-01b all ' + EXPECTED_GROUPS + ' invariant groups ran', String(r.out.checks_run));
    ok(r.out._tg_text.indexOf('PIM green') >= 0 && r.out._tg_text.indexOf('cohort n=3') >= 0, 'PIM-01c heartbeat text names counts'); }
  { const inv = HEALTHY_INV(); inv.I1_bad_stop_widths = [{ sym: 'XYZ', stop_pct: 1.148, reanchored: 'true' }];
    const r = await runPIM(inv, HEALTHY_BROKER());
    ok(!r.out.green && codes(r).includes('I1_STOP_WIDTH'), 'PIM-02 I1 fires on the gov241c width (1.148%)'); }
  { const inv = HEALTHY_INV(); inv.I4_epoch = { v: 1787692698, status: 'LIVE_PROVISIONAL' };
    const r = await runPIM(inv, HEALTHY_BROKER());
    ok(codes(r).includes('I4_EPOCH'), 'PIM-03 I4 fires on a 1-second epoch rewrite'); }
  { const b = HEALTHY_BROKER(); b.orders = [];
    const r = await runPIM(HEALTHY_INV(), b);
    ok(codes(r).includes('I2_UNPROTECTED'), 'PIM-04 I2 fires on zero stop coverage'); }
  { const b = HEALTHY_BROKER(); b.orders[0].stop_price = '110.42'; // 1.146% of entry — the incident geometry
    const r = await runPIM(HEALTHY_INV(), b);
    ok(codes(r).includes('I2_STOP_DRIFT'), 'PIM-05 WITNESS: yesterday-class 1.15% live stop = drift violation'); }
  { const b = HEALTHY_BROKER(); b.orders[0].stop_price = '109.47'; // 2.0% of entry — favorable-fill variance (UHS 08-27 class)
    const r = await runPIM(HEALTHY_INV(), b);
    ok(!codes(r).includes('I2_STOP_DRIFT'), 'PIM-05b v1.2: favorable-fill 2.0%-of-fill stop is NOT a violation'); }
  { const b = HEALTHY_BROKER(); b.orders[0].time_in_force = 'day';
    const r = await runPIM(HEALTHY_INV(), b);
    ok(codes(r).includes('I3_TIF'), 'PIM-06 I3 fires on day-TIF protective leg (gov211 class)'); }
  { const inv = HEALTHY_INV(); inv.entries[0].risk = 700; // > 0.55% of 104k = 572
    const r = await runPIM(inv, HEALTHY_BROKER());
    ok(codes(r).includes('I5_OVERSIZED'), 'PIM-07 I5 fires on oversized probation risk'); }
  { const inv = HEALTHY_INV(); inv.I6_overdue_longs = [{ sym: 'FLEX', sessions: 3 }];
    const r = await runPIM(inv, HEALTHY_BROKER());
    ok(codes(r).includes('I6_TIME_EXIT_DEAD'), 'PIM-08 I6 fires on session-3 survivor'); }
  { const inv = HEALTHY_INV(); inv.I9_short_entries_today = ['TSLA'];
    const r = await runPIM(inv, HEALTHY_BROKER());
    ok(codes(r).includes('I9_SHORT_LEAK'), 'PIM-09 I9 fires on a short past the halt'); }
  { const inv = HEALTHY_INV(); inv.I10_cohort = { n: 10, pf: 0.5 };
    const r = await runPIM(inv, HEALTHY_BROKER());
    ok(codes(r).includes('I10_INTERIM_LOOK_DUE'), 'PIM-10 I10 fires the pre-committed interim look'); }
  { const b = HEALTHY_BROKER(); b.failPositions = true;
    const r = await runPIM(HEALTHY_INV(), b);
    ok(!r.out.green && codes(r).some((c) => c.indexOf('MONITOR_BLIND') === 0), 'PIM-11a blindness is a violation, never silent green');
    ok(r.out._tg_text.indexOf('&lt;pos&gt;') >= 0, 'PIM-11b error text HTML-escaped'); }
  { const b = HEALTHY_BROKER(); b.n8nActive.OZx8Lh15zzo7jrJp = false;
    const r = await runPIM(HEALTHY_INV(), b);
    ok(codes(r).includes('I7_WORKFLOW_DOWN'), 'PIM-12 I7 fires when the time-exit workflow is unpublished'); }
  { let threw = null;
    try { await runPIM(HEALTHY_INV(), HEALTHY_BROKER(), { ...VARS, ALPACA_BASE_URL: 'https://api.alpaca.markets' }); } catch (e) { threw = e; }
    ok(threw && /paper/.test(String(threw.message)), 'PIM-13 non-paper base -> hard throw'); }
  { const inv = HEALTHY_INV(); inv.I8_earnings_stale_days = 4.5;
    const r = await runPIM(inv, HEALTHY_BROKER());
    ok(codes(r).includes('I8_EARNINGS_STALE'), 'PIM-14 I8 fires on a stale calendar'); }
  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
