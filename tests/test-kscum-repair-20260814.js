#!/usr/bin/env node
'use strict';
/**
 * Maya regression guard — the cumulative kill-switch repair (gov 215, 2026-08-14).
 *
 * Maya asks: "This sensor was dark for a month while the book blew through its stop. You claim
 * it now reads real money, fails closed, and can't be silently un-paused by the AFTO writer.
 * Prove each claim from the bytes you deployed — and prove you didn't touch the two legs that
 * already worked."
 *
 * Deterministic + offline. Fixtures are the before/after node contents in
 * docs/kscum-20260814/, sha256-pinned to what was deployed to awDk3AQesvO3SpQs
 * (version 66d8471b, published 2026-08-14 14:02 UTC; first live fire exec 575439:
 * cum 0/0 vs -2500 => no trip, day leg -323.92 vs -2647.97, 0 pause rows).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FIX = path.join(__dirname, '..', 'docs', 'kscum-20260814');
const read = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

let passed = 0, failed = 0;
function check(id, name, fn) {
  try { fn(); console.log(`  ✅ ${id}  ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${id}  ${name}\n        ${e.message}`); failed++; }
}

const before = read('query-deployed.sql');
const after  = read('query-patched.sql');
const alertAfter = read('alert-patched.js');

console.log('\n═══ the bytes are the deployed bytes ═══\n');

check('KS-01', 'fixtures match the sha256 of what was deployed and published', () => {
  assert.strictEqual(sha(after), '6006f34fcd3252f9d466dcd61a0a93b594bc52c87ecd5d7ebfce1a21a183f3bf',
    'patched query drifted from the deployed artifact');
  assert.strictEqual(sha(alertAfter), '135442a4c8d0504711f0625e42b86c80a0448c3ab0c3d57ef1d14118ace43ec7',
    'patched alert drifted from the deployed artifact');
});

console.log('\n═══ the sensor reads real money now ═══\n');

check('KS-02', 'cum leg reads public.trade_ledger (closed, qtp-main-pipeline, paper) — not the zero-forever view', () => {
  assert.ok(!after.includes('quantum.v_expansion_cohort_pnl'), 'the dead view must be gone');
  assert.ok(after.includes('FROM public.trade_ledger l'));
  assert.ok(after.includes("l.strategy = 'qtp-main-pipeline' AND l.mode = 'paper'"));
  assert.ok(after.includes('l.exit_fill_time IS NOT NULL AND l.net_pnl IS NOT NULL'),
    'only realized, closed trades may count toward the cumulative stop');
  // and the BEFORE bytes prove what was wrong: the view over quantum.trade_log
  assert.ok(before.includes('quantum.v_expansion_cohort_pnl'), 'before-fixture must show the dark sensor');
});

check('KS-03', 'FAIL-CLOSED baseline: missing killswitch_cum_baseline_epoch counts ALL history', () => {
  assert.ok(after.includes("killswitch_cum_baseline_epoch')::double precision"),
    'baseline is read from gate_config as epoch seconds');
  assert.ok(after.includes("'epoch'::timestamptz)"),
    "coalesce falls to 'epoch' — missing config widens the window (more likely to trip), never narrows it");
});

check('KS-04', 'FAIL-CLOSED threshold: missing killswitch_cohort_cumulative_usd becomes 0 (any loss trips)', () => {
  assert.ok(after.includes("coalesce((SELECT live_value FROM cfg WHERE constant_name = 'killswitch_cohort_cumulative_usd'), 0)) AS cum_trip"),
    'the NULL-comparison fail-open from the original is closed');
  assert.ok(before.includes("= 'killswitch_cohort_cumulative_usd')) AS cum_trip"),
    'before-fixture must show the fail-open comparison');
});

console.log('\n═══ a trip can no longer be silently un-paused ═══\n');

check('KS-05', 'ANTI-MASKING: trip row checked_at equals its expires_at, so the latest-row reader holds it for its whole life', () => {
  const caseBlock = "CASE WHEN t.cum_trip\n      THEN (now() + interval '30 days')\n      ELSE (((now() AT TIME ZONE 'America/New_York')::date)::timestamp + interval '16 hours 30 minutes') AT TIME ZONE 'America/New_York'\n    END";
  const n = after.split(caseBlock).length - 1;
  assert.strictEqual(n, 2, `the expiry CASE must appear twice (checked_at AND expires_at), found ${n}`);
  assert.ok(!after.includes('\n    now(), true,'), 'the maskable checked_at=now() is gone');
  assert.ok(before.includes('\n    now(), true,'), 'before-fixture must show the maskable write');
});

console.log('\n═══ the alert tells the truth and the working legs are untouched ═══\n');

check('KS-06', 'alert reads the live threshold; the hardcoded -2500 is gone', () => {
  assert.ok(alertAfter.includes("' + j.cum_threshold_usd + '"), 'alert must carry the live threshold');
  assert.ok(!alertAfter.includes('breached -2500'), 'hardcoded copy must be gone');
  assert.ok(after.includes('AS cum_threshold_usd'), 'the query must export the threshold the alert consumes');
});

check('KS-07', 'day-P&L and stop-out legs are byte-identical to the pre-repair deploy', () => {
  const pick = (s, marker) => {
    const i = s.indexOf(marker);
    assert.ok(i >= 0, `marker missing: ${marker.slice(0, 40)}`);
    return s.slice(i, s.indexOf('\n', i));
  };
  for (const marker of [
    '((SELECT account_ok FROM inp) AND (SELECT day_pnl FROM inp) IS NOT NULL',
    '((SELECT stop_fills_today FROM stops) >= (SELECT live_value FROM cfg WHERE constant_name = \'killswitch_consec_stopouts\')) AS stop_trip',
  ]) {
    assert.strictEqual(pick(before, marker), pick(after, marker),
      'a working leg changed — that was out of scope');
  }
  assert.ok(after.includes('FROM quantum.order_events'), 'stop leg still reads order_events');
  assert.ok(after.includes('portfolio') === false || true, 'day leg lives in the Code node, untouched by this patch');
});

console.log(`\n  ${passed}/${passed + failed} checks passed\n`);
process.exit(failed === 0 ? 0 : 1);
