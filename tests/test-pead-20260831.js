#!/usr/bin/env node
// A'2 PEAD backfill — executed mini-suite (parser, whitelist, fail-soft, SQL safety)
'use strict';
const fs = require('fs'); const path = require('path');
const CODE = fs.readFileSync(path.join(__dirname, '../docs/pead-20260831/pead-fetch.js'), 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log('  PASS ' + n); } else { fail++; console.log('  FAIL ' + n + (x ? ' — ' + x : '')); } };
async function run(batch, responses, key) {
  const calls = [];
  const httpRequest = async (opt) => { calls.push(opt.url); const sym = opt.url.match(/symbol=([A-Z0-9.\-]+)/)[1];
    const r = responses[sym]; if (r instanceof Error) throw r; return r; };
  const $input = { first: () => ({ json: { batch, remaining_before: batch.length } }) };
  const fn = new AsyncFunction('$vars', '$input', 'setTimeout', 'console', CODE);
  const out = await fn.call({ helpers: { httpRequest } },
    { ALPHAVANTAGE_API_KEY: key === undefined ? 'k' : key }, $input, (f) => f(), console);
  return { out: out.map((o) => o.json), calls };
}
(async () => {
  { const SQL = fs.readFileSync(path.join(__dirname, '../docs/pead-20260831/pead-pick-batch.sql'), 'utf8');
    ok(SQL.includes('limit 4'), 'PD-00 batch cap 4 (60s node-runner budget)'); }
  const good = { quarterlyEarnings: [
    { fiscalDateEnding: '2026-06-30', reportedDate: '2026-07-25', reportedEPS: '2.10', estimatedEPS: '1.95', surprise: '0.15', surprisePercentage: '7.69' },
    { fiscalDateEnding: '2025-03-31', reportedDate: '2025-04-20', reportedEPS: '1', estimatedEPS: '1', surprise: '0', surprisePercentage: '0' }] };
  { const r = await run(['AAPL'], { AAPL: good });
    const a = r.out[0];
    ok(a.ok && a.quarters === 1, 'PD-01 parses quarters, drops pre-2025-06 history', JSON.stringify(a));
    ok(a.sql.includes("('AAPL','2026-06-30','2026-07-25',2.1,1.95,0.15,7.69)") && a.sql.includes('do nothing'), 'PD-02 upsert SQL exact + idempotent');
    ok(a.sql.includes("pead_backfill_progress (symbol) values ('AAPL')"), 'PD-03 progress marked only on success'); }
  { const r = await run(['MSFT'], { MSFT: { Note: 'rate limited' } });
    ok(r.out[0].ok === false && r.out[0].sql === 'SELECT 1', 'PD-04 rate-limit stub -> fail-soft, NOT marked done'); }
  { const r = await run(['BAD;DROP'], {});
    ok(r.out[0].ok === false && r.calls.length === 0, 'PD-05 whitelist blocks bad symbol before any HTTP'); }
  { const r = await run(['NVDA'], { NVDA: new Error('ETIMEDOUT') });
    ok(r.out[0].ok === false && r.out[0].sql === 'SELECT 1', 'PD-06 network error -> fail-soft'); }
  { const r = await run(['AAPL'], { AAPL: good }, '');
    ok(r.out[0].error && r.calls.length === 0, 'PD-07 missing key -> loud item, zero HTTP'); }
  { const r = await run(['AAPL', 'MSFT'], { AAPL: good, MSFT: good });
    const s = r.out.find((x) => x.summary);
    ok(s && s.fetched_ok === 2 && s.remaining_after === 0, 'PD-08 summary math'); }
  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS', e); process.exit(2); });
