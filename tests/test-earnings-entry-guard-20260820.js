#!/usr/bin/env node
'use strict';
/**
 * Maya regression guard — EARNINGS_WINDOW entry guard in the Kelly wrapper (gov 235).
 *
 * Maya asks: "WMT held long through its own earnings print because nothing in the entry
 * path knew earnings existed. You are adding ONE new block to the wrapper that composes
 * my Gate-K SQL. Prove by EXECUTING both versions of the real node: (a) the old bytes
 * never mention earnings — the witness; (b) the new SQL blocks with reason
 * EARNINGS_WINDOW, checked BEFORE the Kelly gate call, and only when BOTH the config
 * switch is on AND a calendar row matches — an empty calendar or a missing config row
 * must change NOTHING (fail-open, because a dead calendar feed must not freeze trading);
 * (c) my symbol lands in the SQL properly quoted — a symbol with a quote in it must not
 * break out of the string; and (d) every EXPANSION check and the Gate-K call itself are
 * byte-identical around the insertion."
 *
 * Deterministic + offline. Executes the REAL wrapper jsCode (deployed + patched fixtures)
 * with stubbed $()/$json.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FIX = path.join(__dirname, '..', 'docs', 'earnings-guard-20260820');
const OLD = fs.readFileSync(path.join(FIX, 'kelly-sql-build-deployed.js'), 'utf8');
const NEW = fs.readFileSync(path.join(FIX, 'kelly-sql-build-patched.js'), 'utf8');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const count = (h, n) => h.split(n).length - 1;

function runWrapper(src, prep, json) {
  const fn = new Function('$', '$json', src);
  const out = fn((name) => {
    assert.strictEqual(name, 'QET Gate-K Prep', 'wrapper must only reference the Prep node');
    return { first: () => ({ json: prep }) };
  }, json);
  return out[0].json.__kelly_sql;
}
const PREP = { __qet_conf: 82, __qet_entry: 100.5, __qet_stop: 98.2, __qet_side: 'BUY', __qet_symbol: 'WMT' };
const JSN = { equity: 105000 };

let passed = 0, failed = 0;
async function check(id, name, fn) {
  try { await fn(); console.log(`  ✅ ${id}  ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${id}  ${name}\n        ${e.message}`); failed++; }
}

(async () => {
  console.log('\n═══ the bytes are the bytes being deployed ═══\n');

  await check('EW-01', 'fixtures match the artifacts handed to the deploy step', () => {
    assert.strictEqual(sha(OLD), '773b65bf0dd6cef514497e437d1f6f569461ade970b8505181d1f00a716eaeca');
    assert.strictEqual(sha(NEW), '0552eef687b50231415dbeeaa433287495115e67b3438e6063143357252b2131');
  });

  await check('EW-02', 'REGRESSION WITNESS: the live wrapper is earnings-blind', () => {
    const sql = runWrapper(OLD, PREP, JSN);
    assert.ok(!/earnings/i.test(sql), 'old SQL must not mention earnings — or this guard already exists');
    assert.ok(sql.includes("ELSE public.compute_kelly_gate("), 'Gate-K call present');
  });

  console.log('\n═══ the new SQL: blocked BEFORE the gate, only on switch+match ═══\n');

  await check('EW-03', 'patched SQL: EARNINGS_WINDOW WHEN precedes the Gate-K ELSE; fields wired', () => {
    const sql = runWrapper(NEW, PREP, JSN);
    assert.strictEqual(count(sql, "'EARNINGS_WINDOW'"), 1);
    assert.ok(sql.indexOf('exp.earn_on AND exp.earn_hit') < sql.indexOf('ELSE public.compute_kelly_gate'));
    assert.strictEqual(count(sql, "gate_id = 'EARNINGS'"), 1, 'cfge CTE present once');
    assert.ok(sql.includes("ec.symbol = 'WMT'"), 'symbol substituted into the EXISTS');
    assert.ok(sql.includes("constant_name = 'earnings_entry_block_days'"), 'window from config, not hardcoded');
  });

  await check('EW-04', 'FAIL-OPEN literals: switch defaults 0 when config row missing; block needs EXISTS match', () => {
    const sql = runWrapper(NEW, PREP, JSN);
    assert.ok(sql.includes("coalesce((SELECT live_value FROM cfge WHERE constant_name = 'earnings_guard_active'), 0) = 1 AS earn_on"),
      'missing config row must resolve earn_on=false, never block');
    assert.ok(sql.includes('EXISTS (SELECT 1 FROM quantum.earnings_calendar'),
      'positive-match only: an EMPTY calendar can never block');
    assert.ok(!sql.includes('NOT EXISTS (SELECT 1 FROM quantum.earnings_calendar'),
      'a NOT EXISTS here would be fail-CLOSED — the exact freeze this design forbids');
  });

  await check('EW-05', 'quote-in-symbol cannot break out of the SQL string', () => {
    const sql = runWrapper(NEW, { ...PREP, __qet_symbol: "A'B" }, JSN);
    assert.ok(sql.includes("ec.symbol = 'A''B'"), 'qt() doubling must apply inside the EXISTS too');
  });

  console.log('\n═══ scope: everything around the insertion is byte-identical ═══\n');

  await check('EW-06', 'all EXPANSION checks + Gate-K args byte-identical old vs new', () => {
    const a = runWrapper(OLD, PREP, JSN), b = runWrapper(NEW, PREP, JSN);
    for (const s of ['EXPANSION_PRS_STALE', 'EXPANSION_DAILY_CAP', 'EXPANSION_CONCURRENT_CAP',
                     'EXPANSION_SELL_CAP', 'EXPANSION_BUY_SLOT_RESERVED', 'gate_skipped_insufficient_fields']) {
      assert.strictEqual(count(a, s), count(b, s), `drift: ${s}`);
    }
    const gk = /public\.compute_kelly_gate\([^)]*\)/;
    assert.strictEqual(a.match(gk)[0], b.match(gk)[0], 'the Gate-K call must be untouched');
  });

  await check('EW-07', 'NEGATIVE CONTROL: old bytes fail the fix assertions', () => {
    const sql = runWrapper(OLD, PREP, JSN);
    assert.strictEqual(count(sql, "'EARNINGS_WINDOW'"), 0);
    assert.strictEqual(count(OLD, 'earn_on'), 0);
  });

  console.log(`\n  ${passed}/${passed + failed} checks passed\n`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('HARNESS FAILURE:', e); process.exit(1); });
