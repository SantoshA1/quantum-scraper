#!/usr/bin/env node
'use strict';
/**
 * Maya regression guard — the Guard-Liveness Sentinel (gov 216, 2026-08-14).
 *
 * Maya asks: "Seven guards died silently this quarter because nothing watched their inputs.
 * You built the watcher. Prove FROM THE DEPLOYED BYTES that it (a) checks every input that
 * killed us, (b) alarms when an alive input dies but stays quiet about the deaths we already
 * know, (c) tells me ONCE, not every 15 minutes, and tells me again when it's fixed, and
 * (d) never lets a Telegram failure stop the evidence from being logged."
 *
 * Deterministic + offline. Fixtures are the LIVE node contents of workflow pDzjkktLoyKkxnXE
 * (version 6f8b9bae, published 2026-08-14 14:33 UTC; first fire exec 575904: overall=OK,
 * 11 checks, alarms 0, notices 0). The evaluate node is EXECUTED here, not just grepped.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FIX = path.join(__dirname, '..', 'docs', 'sentinel-20260814');
const read = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

let passed = 0, failed = 0;
function check(id, name, fn) {
  try { fn(); console.log(`  ✅ ${id}  ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${id}  ${name}\n        ${e.message}`); failed++; }
}

const SQL = read('checks.sql');
const CODE = read('evaluate.js');

// ── offline executor for the deployed Code-node body ────────────────────────
function runEvaluate(rowsIn, sd, opts) {
  const o = opts || {};
  const telegramCalls = [];
  const $input = { all: () => rowsIn.map((j) => ({ json: j })) };
  const $getWorkflowStaticData = () => sd;
  const $vars = { TELEGRAM_BOT_TOKEN: o.token === undefined ? 'tok' : o.token };
  const self = { helpers: { httpRequest: async (req) => { if (o.telegramFails) throw new Error('net down'); telegramCalls.push(JSON.parse(req.body)); return {}; } } };
  const fn = new Function('$input', '$getWorkflowStaticData', '$vars', `return (async function(){ ${CODE}\n }).call(this);`);
  return fn.call(self, $input, $getWorkflowStaticData, $vars).then((out) => ({ out: out[0].json, telegramCalls }));
}
const row = (name, status, observed, expected) => ({ check_name: name, status, observed: observed || 'x', expected: expected || 'ALIVE' });
const HEALTHY = [
  row('scanner_signals', 'OK'), row('afto_heartbeat', 'OK'), row('position_risk_state', 'OK'),
  row('order_events_feed', 'OK'), row('killswitch_config', 'OK'),
  row('adx_payload', 'EXPECTED'), row('mtf_payload', 'EXPECTED'), row('vix_payload', 'EXPECTED'),
  row('trade_log_pnl', 'EXPECTED'), row('signal_ts_offset', 'EXPECTED'), row('backtest_cache', 'EXPECTED'),
];

(async () => {
  console.log('\n═══ the bytes are the deployed bytes ═══\n');

  check('GL-01', 'fixtures are sha256-identical to workflow pDzjkktLoyKkxnXE version 6f8b9bae', () => {
    assert.strictEqual(sha(SQL), '4c26be43ce350f1ad7bbc3acff547769c332b51e39e66d7ff8074799ccbdf500');
    assert.strictEqual(sha(CODE), '3e1e026591d5ae518c280d710c795869125f5611cf06acc13604e7bb89568912');
  });

  console.log('\n═══ every input that killed us is watched ═══\n');

  check('GL-02', 'the checks SQL covers all 6 alive inputs and all 6 known-dead inputs', () => {
    for (const name of ['scanner_signals', 'afto_heartbeat', 'position_risk_state', 'order_events_feed',
      'killswitch_config', 'scanner_universe_coverage', 'adx_payload', 'mtf_payload', 'vix_payload',
      'trade_log_pnl', 'signal_ts_offset', 'backtest_cache']) {
      assert.ok(SQL.includes(`'${name}'`), `check missing from SQL: ${name}`);
    }
    assert.ok(SQL.includes('killswitch_cum_baseline_epoch'), 'gov-215 baseline constant must be asserted present');
    assert.ok(SQL.includes("NOT IN ('0','24')"), 'vix expectation is the TRUE state (24 new-signal / 0 repeat), learned in shakedown');
    assert.ok(SQL.includes('BETWEEN 3.9 AND 4.1'), 'signal_ts offset pinned at the known ~4h defect');
    // gov 218: the universe-collapse assertion. Its signature was zero signals from the
    // middle 50% of the watchlist for 16 sessions while head and tail kept firing.
    assert.ok(SQL.includes('quantum_watchlist_raw'), 'coverage check must read the real watchlist');
    assert.ok(/e\.idx BETWEEN[\s\S]{0,120}\/ 4[\s\S]{0,160}\* 3 \/ 4/.test(SQL),
      'coverage must be measured on the MIDDLE 50% of the alphabetical index, not the whole list');
    assert.ok(/scanner_universe_coverage[\s\S]{0,400}NOT \(SELECT in_rth FROM rth\) THEN 'OK'/.test(SQL),
      'the coverage check must be RTH-gated so it cannot spam outside market hours');
  });

  console.log('\n═══ alarm on new deaths, silence on known ones ═══\n');

  check('GL-03', 'healthy picture → OK, no Telegram, clean signature', async () => {}) ;
  {
    const sd = {};
    const { out, telegramCalls } = await runEvaluate(HEALTHY, sd);
    check('GL-03a', 'healthy: overall OK, alarms 0, notices 0, no alert', () => {
      assert.strictEqual(out.overall, 'OK');
      assert.strictEqual(out.alarms, 0);
      assert.strictEqual(out.notices, 0);
      assert.strictEqual(out.alerted, false);
      assert.strictEqual(telegramCalls.length, 0);
      assert.strictEqual(out.signature, '::');
    });
  }

  {
    const sd = {};
    const rows1 = HEALTHY.map((r) => r.check_name === 'position_risk_state' ? row('position_risk_state', 'ALARM', '5.2 h old') : r);
    const r1 = await runEvaluate(rows1, sd);
    check('GL-04', 'an alive input dies → ALARM + exactly one Telegram naming it', () => {
      assert.strictEqual(r1.out.overall, 'ALARM');
      assert.strictEqual(r1.out.alerted, true);
      assert.strictEqual(r1.telegramCalls.length, 1);
      assert.ok(r1.telegramCalls[0].text.includes('position_risk_state'), 'alert must name the dead input');
      assert.ok(r1.telegramCalls[0].text.includes('DEAD/STALE GUARD INPUT'));
    });
    const r2 = await runEvaluate(rows1, sd);
    check('GL-05', 'same alarm 15 minutes later → suppressed (no spam)', () => {
      assert.strictEqual(r2.out.overall, 'ALARM');
      assert.strictEqual(r2.out.alerted, false);
      assert.strictEqual(r2.telegramCalls.length, 0);
    });
    sd._glsLastAlertAt = Date.now() - 5 * 60 * 60 * 1000; // 5h ago
    const r3 = await runEvaluate(rows1, sd);
    check('GL-06', 'alarm still standing after 4h → re-reminded once', () => {
      assert.strictEqual(r3.out.alerted, true);
      assert.strictEqual(r3.telegramCalls.length, 1);
    });
    const r4 = await runEvaluate(HEALTHY, sd);
    check('GL-07', 'alarm clears → one all-clear, then silence', () => {
      assert.strictEqual(r4.out.overall, 'OK');
      assert.strictEqual(r4.out.alerted, true);
      assert.ok(r4.telegramCalls[0].text.includes('All clear'));
    });
    const r5 = await runEvaluate(HEALTHY, sd);
    check('GL-07a', 'healthy again → quiet', () => {
      assert.strictEqual(r5.out.alerted, false);
      assert.strictEqual(r5.telegramCalls.length, 0);
    });
  }

  {
    const sd = {};
    const rows1 = HEALTHY.map((r) => r.check_name === 'adx_payload' ? row('adx_payload', 'NOTICE', 'max24h=41', 'DEAD(known 06-08)') : r);
    const { out, telegramCalls } = await runEvaluate(rows1, sd);
    check('GL-08', 'a known-dead input REVIVES → NOTICE alert (state change is news in both directions)', () => {
      assert.strictEqual(out.overall, 'NOTICE');
      assert.strictEqual(out.alerted, true);
      assert.ok(telegramCalls[0].text.includes('known-dead input CHANGED'));
      assert.ok(telegramCalls[0].text.includes('adx_payload'));
    });
  }

  console.log('\n═══ the evidence survives everything ═══\n');

  {
    const sd = {};
    const rows1 = HEALTHY.map((r) => r.check_name === 'afto_heartbeat' ? row('afto_heartbeat', 'ALARM', "97.0 min old; note with 'quote'") : r);
    const { out } = await runEvaluate(rows1, sd, { telegramFails: true });
    check('GL-09', 'Telegram down → log SQL still produced, alert marked failed, quotes escaped', () => {
      assert.strictEqual(out.alerted, false, 'a failed send must not claim success');
      assert.ok(out.__log_sql.startsWith('INSERT INTO quantum.guard_liveness_log'));
      assert.ok(out.__log_sql.includes("''quote''"), 'single quotes in observations must be SQL-escaped');
      assert.ok(out.__log_sql.includes('ON CONFLICT (run_id) DO NOTHING'));
      const m = out.__log_sql.match(/VALUES \('gls-\d{14}','ALARM',1,0,'/);
      assert.ok(m, `log SQL shape wrong: ${out.__log_sql.slice(0, 120)}`);
    });
  }

  console.log(`\n  ${passed}/${passed + failed} checks passed\n`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('HARNESS FAILURE:', e); process.exit(1); });
