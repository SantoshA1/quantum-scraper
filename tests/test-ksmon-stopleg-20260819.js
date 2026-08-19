#!/usr/bin/env node
'use strict';
/**
 * Maya regression guard — the kill-switch stop leg counts real fills (gov 231, 2026-08-19).
 *
 * Maya asks: "gate_config says killswitch_consec_stopouts=4. On 08-18 I took FOUR stop-outs
 * in one session and the monitor ran every 2 minutes all day and never blinked. You now tell
 * me the reader compares order_status to 'filled' while the writer stamps 'FILLED', so the
 * leg has counted zero since the day it was born. Prove FROM THE BYTES that (a) the broken
 * predicate is really in the deployed SQL — show me the corpse; (b) the patch swaps exactly
 * the stops CTE and nothing else — not the INSERT, not the dedup guard, not the n8n
 * templates; (c) the new count is per ORDER, not per event — 08-18 wrote 8 FILLED events
 * for 4 orders, and I will not accept a switch that trips at 2 real stop-outs; and (d) the
 * recorded verification matrix was measured with the SAME predicate you deployed."
 *
 * Deterministic + offline. Fixtures (docs/ksmon-20260819/):
 *   evaluate-trip-deployed.sql — live node SQL, version 66d8471b (sha 6006f34f…)
 *   evaluate-trip-patched.sql  — gov 231 candidate (sha 38f99c58…)
 *   verify-matrix-20260819.json — read-only DB matrix + live witness execution 600258
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FIX = path.join(__dirname, '..', 'docs', 'ksmon-20260819');
const OLD = fs.readFileSync(path.join(FIX, 'evaluate-trip-deployed.sql'), 'utf8');
const NEW = fs.readFileSync(path.join(FIX, 'evaluate-trip-patched.sql'), 'utf8');
const MX = JSON.parse(fs.readFileSync(path.join(FIX, 'verify-matrix-20260819.json'), 'utf8'));
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const count = (h, n) => h.split(n).length - 1;

const OLD_CTE = `), stops AS (
  SELECT count(*) AS stop_fills_today
  FROM quantum.order_events
  WHERE event_date = (now() AT TIME ZONE 'America/New_York')::date
    AND order_status = 'filled'
    AND order_type IN ('trailing_stop','stop','stop_limit')
)`;

let passed = 0, failed = 0;
async function check(id, name, fn) {
  try { await fn(); console.log(`  ✅ ${id}  ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${id}  ${name}\n        ${e.message}`); failed++; }
}

(async () => {
  console.log('\n═══ the bytes are the bytes being deployed ═══\n');

  await check('KS-01', 'fixtures match the artifacts handed to the deploy step', () => {
    assert.strictEqual(sha(OLD), '6006f34fcd3252f9d466dcd61a0a93b594bc52c87ecd5d7ebfce1a21a183f3bf');
    assert.strictEqual(sha(NEW), '38f99c58762dc146d809d83dd46a23c8c77282b692611a48cf28c2b38411062a');
  });

  console.log('\n═══ (a) the corpse: the leg that could never count ═══\n');

  await check('KS-02', "REGRESSION WITNESS: deployed SQL compares to lowercase 'filled'", () => {
    assert.strictEqual(count(OLD, "order_status = 'filled'"), 1,
      'the dead predicate must exist in the old bytes, or this suite guards nothing');
    assert.strictEqual(count(OLD, 'count(*) AS stop_fills_today'), 1, 'and counts raw events');
    assert.ok(!OLD.includes('upper(order_status)'), 'old bytes must NOT already be case-proof');
    // the table has never once held a lowercase status (recorded inventory)
    assert.strictEqual(MX.results.status_case_inventory_alltime_has_lowercase_filled, false);
    // and the live monitor, 19 min after the 4th stop-out, read zero
    assert.strictEqual(MX.live_witness_execution.output.stop_fills_today, '0');
    assert.strictEqual(MX.live_witness_execution.output.stop_trip, false);
  });

  console.log('\n═══ (b) surgical scope: exactly the stops CTE, nothing else ═══\n');

  await check('KS-03', 'patched SQL: case-proof status + distinct-order count, exactly once', () => {
    assert.strictEqual(count(NEW, "upper(order_status) = 'FILLED'"), 1);
    assert.strictEqual(count(NEW, 'count(DISTINCT coalesce(broker_order_id, order_event_id::text))'), 1);
    assert.strictEqual(count(NEW, "order_status = 'filled'"), 0, 'dead predicate survived');
    assert.strictEqual(count(NEW, 'QTP_KS_STOPLEG_v5_gov231_20260819'), 1, 'fix must be documented in-band');
  });

  await check('KS-04', 'region swap only: removing both CTEs leaves byte-identical remainders', () => {
    assert.ok(OLD.indexOf(OLD_CTE) !== -1, 'old CTE block not found verbatim');
    const NEW_CTE = `), stops AS (
  -- QTP_KS_STOPLEG_v5_gov231_20260819: the writer stamps Alpaca-style 'FILLED'; the old
  -- order_status='filled' matched ZERO rows in the table's entire history (witness: 08-18,
  -- four stop-outs standing, execution 600258 read stop_fills_today=0). DISTINCT orders
  -- because each fill emits ~2 events (8 events / 4 orders on 08-18); a raw count would
  -- trip the >=4 threshold at just 2 real stop-outs. coalesce covers NULL broker ids
  -- (0 such rows to date; defensive only).
  SELECT count(DISTINCT coalesce(broker_order_id, order_event_id::text)) AS stop_fills_today
  FROM quantum.order_events
  WHERE event_date = (now() AT TIME ZONE 'America/New_York')::date
    AND upper(order_status) = 'FILLED'
    AND order_type IN ('trailing_stop','stop','stop_limit')
)`;
    assert.ok(NEW.indexOf(NEW_CTE) !== -1, 'new CTE block not found verbatim in patched bytes');
    assert.strictEqual(OLD.replace(OLD_CTE, '\x00'), NEW.replace(NEW_CTE, '\x00'),
      'the patch touched bytes outside the stops CTE');
  });

  await check('KS-05', 'the untouchables are untouched: templates, INSERT, dedup guard, threshold compare', () => {
    for (const tpl of ["{{ $json.account_ok && $json.day_pnl !== null ? $json.day_pnl : 'NULL' }}",
                       "{{ $json.account_ok && $json.equity ? $json.equity : 'NULL' }}",
                       "{{ $json.account_ok ? 'true' : 'false' }}"]) {
      assert.strictEqual(count(OLD, tpl), 1); assert.strictEqual(count(NEW, tpl), 1);
    }
    for (const s of ['INSERT INTO quantum.entry_pause_control', 'NOT EXISTS', 'RETURNING control_id',
                     "killswitch_consec_stopouts'))", 'gov215: checked_at = expires_at']) {
      assert.strictEqual(count(OLD, s), count(NEW, s), `occurrence drift for: ${s.slice(0, 40)}`);
    }
    assert.ok(NEW.startsWith('=WITH cfg AS ('), "n8n expression marker '=' lost");
  });

  console.log('\n═══ (c)+(d) per-order semantics, measured with the deployed predicate ═══\n');

  await check('KS-06', '08-18 truth: 8 events, 4 orders — old reads 0, new reads 4, today 0', () => {
    assert.strictEqual(MX.results.old_pred_2026_08_18, 0);
    assert.strictEqual(MX.results.new_pred_2026_08_18, 4, 'must equal DISTINCT ORDERS, not the 8 events');
    assert.strictEqual(MX.results.filled_stop_events_2026_08_18, 8);
    assert.strictEqual(MX.results.distinct_stop_orders_2026_08_18, 4);
    assert.strictEqual(MX.results.new_pred_2026_08_19_intraday, 0, 'deploy-day false-trip risk must be zero');
    assert.strictEqual(MX.results.null_broker_id_filled_stops_alltime, 0);
    assert.deepStrictEqual(MX.results.orders_2026_08_18.map(o => o.sym), ['AES','DDOG','DUK','DASH']);
    // (d) the matrix's predicate strings are literally the deployed ones
    assert.ok(NEW.includes("upper(order_status) = 'FILLED'") && MX.new_predicate.includes("upper(order_status) = 'FILLED'"));
    assert.ok(NEW.includes(MX.new_count_expr), 'matrix count expression differs from deployed bytes');
    assert.ok(OLD.includes("order_status = 'filled'") && MX.old_predicate.includes("order_status = 'filled'"));
  });

  await check('KS-07', 'rarity check: fixed leg would have tripped on exactly 5 days ever', () => {
    const days = MX.results.historical_trip_days_new_pred;
    assert.strictEqual(days.length, 5);
    assert.ok(days.every(d => d.stops >= 4));
    assert.strictEqual(days[days.length - 1].day, '2026-08-18', 'the witness day must be a trip day');
  });

  await check('KS-08', 'NEGATIVE CONTROL: the old bytes fail the fix checks', () => {
    assert.notStrictEqual(count(OLD, "upper(order_status) = 'FILLED'"), 1);
    assert.notStrictEqual(count(OLD, 'count(DISTINCT coalesce(broker_order_id, order_event_id::text))'), 1);
  });

  console.log(`\n  ${passed}/${passed + failed} checks passed\n`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('HARNESS FAILURE:', e); process.exit(1); });
