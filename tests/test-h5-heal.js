#!/usr/bin/env node
'use strict';
/**
 * Maya regression guard — H5 certified heal (QTP_H5_CERTIFIED_HEAL_v3_20260805).
 *
 * Maya asks: "The nightly healer was the last writer allowed to invent labels — it stamped
 * 'stop' on my AKAM winner and 'time' on anything after dinner, and the Conclave froze my
 * Kelly activation over the mess it made. Prove the new healer NEVER writes a label it
 * didn't read from the order lifecycle, prove a row it can't reconstruct is quarantined
 * out of every sizing sample instead of guessed at, and prove the money math it was
 * always right about is untouched."
 *
 * Deterministic + offline. Pins the SQL-builder mirrored by the live node (lockstep rule:
 * change the node => change lib/h5/heal_sql.js => this suite must pass).
 */
const assert = require('assert');
const H = require('../lib/h5/heal_sql');

let passed = 0, failed = 0;
function check(id, name, fn) {
  try { fn(); console.log(`  ✅ ${id}  ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${id}  ${name}  — ${e.message}`); failed++; }
}
const ROW = { id: 'a1b2c3' };
const midday = H.buildHealUpdate(ROW, 101.2345, '2026-08-05T15:01:00.123Z', 'ord-123');
const eod = H.buildHealUpdate(ROW, 99.5, '2026-08-05T19:55:00.000Z', 'ord-456');

// ── the fabrication is dead ────────────────────────────────────────────────────
check('H5-01', "no hard-coded labels: the UPDATE never contains exit_reason='stop' or ='time' literals", () => {
  for (const sql of [midday, eod]) {
    assert.ok(!sql.includes("exit_reason='stop'"), 'v2 fabrication');
    assert.ok(!sql.includes("exit_reason='time'"), 'v2 fabrication');
    assert.ok(sql.includes('exit_reason=(SELECT CASE'), 'reason must come from order_events');
  }
});
check('H5-02', 'classification order matches H4 semantics: ratcheted stop (distinct stop_price>1) wins as trail, then stop family, then limit=target', () => {
  const i1 = midday.indexOf("THEN 'trail'");
  const i2 = midday.indexOf("THEN 'stop'");
  const i3 = midday.indexOf("THEN 'target'");
  assert.ok(i1 > 0 && i1 < i2 && i2 < i3, 'trail < stop < target precedence');
  assert.ok(midday.includes("count(DISTINCT oe.stop_price) FILTER (WHERE oe.stop_price IS NOT NULL) > 1"));
  assert.ok(midday.includes("oe.order_type IN ('stop','stop_limit','trailing_stop')"));
});
check('H5-03', "'time' is EARNED, not assumed: EOD builds include the market->time branch, midday builds do NOT", () => {
  assert.ok(eod.includes("THEN 'time'"));
  assert.ok(!midday.includes("THEN 'time'"), 'a 3pm market exit is manual, never time');
});
check('H5-04', 'no lifecycle events -> exit_reason NULL (never guessed): ELSE NULL closes the CASE', () => {
  assert.ok(midday.includes('ELSE NULL END'), 'unreconstructable label stays NULL');
});

// ── quarantine contract ────────────────────────────────────────────────────────
check('H5-05', 'lineage stamps the writer: certified H4_-family when events exist, H5_QUARANTINE when not', () => {
  assert.ok(midday.includes("'H4_H5HEAL_v3_20260805'"));
  assert.ok(midday.includes("'H5_QUARANTINE_v3_20260805'"));
  assert.ok(H.CERTIFIED_LINEAGE.startsWith('H4_'), 'certified family = starts_with H4_ (short-mult release + acceptance gate read this)');
  assert.ok(!H.QUARANTINE_LINEAGE.startsWith('H4_') && !H.QUARANTINE_LINEAGE.startsWith('RECERT_'), 'quarantine is NOT certified');
});
check('H5-06', 'quarantined rows can never size money: r_multiple is NULLed exactly when order_events has no exit order', () => {
  assert.ok(midday.includes('r_multiple = CASE WHEN EXISTS'), 'guarded');
  assert.ok(midday.includes('THEN r_multiple ELSE NULL END'), 'certified path preserves, quarantine path nulls');
});

// ── the money math the healer was always right about ───────────────────────────
check('H5-07', 'pnl/price/status arithmetic is byte-compatible with v2 (broker fills stay the money truth)', () => {
  assert.ok(midday.includes("gross_pnl=round(((CASE WHEN side='sell' THEN entry_fill_price - 101.2345 ELSE 101.2345 - entry_fill_price END) * qty)::numeric, 2)"));
  assert.ok(midday.includes("status='closed', updated_at=now() WHERE id='a1b2c3' AND status='open'"), 'idempotent open-row guard preserved');
});
check('H5-08', 'writer identity is auditable: sizing_meta carries H5_CERTIFIED_HEAL_v3', () => {
  assert.ok(midday.includes('H5_CERTIFIED_HEAL_v3'));
});

// ── hygiene ────────────────────────────────────────────────────────────────────
check('H5-09', 'quotes in ids cannot break out of the statement', () => {
  const sql = H.buildHealUpdate({ id: "x'y" }, 10, '2026-08-05T15:00:00Z', "o'id");
  assert.ok(sql.includes("WHERE id='x''y'"));
  assert.ok(sql.includes("broker_order_id = 'o''id'"));
});
check('H5-10', 'EOD boundary matches v2 exactly (19:29Z), so no behavior drift on the time-vs-manual line', () => {
  const justBefore = H.buildHealUpdate(ROW, 10, '2026-08-05T19:28:59Z', 'o1');
  const atBoundary = H.buildHealUpdate(ROW, 10, '2026-08-05T19:29:00Z', 'o2');
  assert.ok(!justBefore.includes("THEN 'time'"));
  assert.ok(atBoundary.includes("THEN 'time'"));
});

console.log(`\n  ${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
