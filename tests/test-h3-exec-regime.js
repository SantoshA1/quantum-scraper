#!/usr/bin/env node
'use strict';
/**
 * Maya regression guard — QET Ledger H3 SQL v2 (2026-08-10, shipped with APT v4.9).
 *
 * Maya asks: "You just taught the Alpaca node four new ways to say 'no trade happened'.
 * The node that writes my ledger has a hard-coded list of four old ones. Prove it doesn't
 * write me a row for a trade that never filled — and prove the one you say is dangerous
 * really was dangerous, using the OLD code, not your description of it."
 *
 * Deterministic, offline. Executes the ACTUAL deployed v2 bytes AND the previous v1 bytes,
 * side by side, so the regression claim is demonstrated rather than asserted.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function check(id, name, fn) {
  try { fn(); console.log(`  ✅ ${id}  ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${id}  ${name}\n        ${e.message}`); failed++; }
}

const DIR = path.join(__dirname, '..', 'docs', 'execution-fix-20260810');
const V2 = fs.readFileSync(path.join(DIR, 'qet-ledger-h3-v2.js'), 'utf8');
const V1 = fs.readFileSync(path.join(DIR, 'qet-ledger-h3-v1-LIVE.js'), 'utf8');

function run(json, code = V2) {
  const $input = { first: () => ({ json }) };
  return new Function('$input', code)($input)[0].json;
}
const metaOf = out => {
  const m = /\$qet\$(\{.*?\})\$qet\$/s.exec(out.sql);
  assert.ok(m, 'no $qet$-delimited sizing_meta found in the generated SQL');
  return JSON.parse(m[1]);
};

// a real filled entry, shaped exactly as APT v4.9 emits it
const FILLED = {
  ticker: 'WST', alpaca_status: 'pending_new', alpaca_side: 'buy', alpaca_qty: 30,
  alpaca_entry_id: 'E-1', alpaca_sl_id: 'SL-NEW', alpaca_tp_id: 'TP-1',
  alpaca_signal_price: 353.62, alpaca_fresh_price: 353.62,
  alpaca_stop_price: 355.86, alpaca_stop_price_initial: 349.38, alpaca_tp_price: 369.22,
  alpaca_fill_price: 360.00, alpaca_filled_qty: 30, alpaca_poll_outcome: 'FILLED',
  alpaca_partial_fill: false, alpaca_limit_price: 354.68,
  alpaca_stop_reanchor: { ok: true, from: 349.38, to: 355.86, fill: 360 },
  alpaca_exec_regime: 'EXEC_V49_LIMIT_CAP', alpaca_exec_cap_pct: 0.3,
  alpaca_anchor_used: 'signal_capped', alpaca_bracket_v: '4.9',
  alpaca_is_volatile: false, __qet_gate: { risk_pct: 0.5 }, __qet_conf: 76
};

console.log('\n═══ H3 v2 — the four new "no trade happened" statuses ═══\n');

check('H3-01', 'SKIPPED_NO_FILL_WITHIN_CAP writes no ledger row', () => {
  const out = run({ ...FILLED, alpaca_status: 'SKIPPED_NO_FILL_WITHIN_CAP', alpaca_qty: 0, alpaca_filled_qty: 0 });
  assert.strictEqual(out.h3, 'skipped');
  assert.ok(/h3_noop/.test(out.sql), 'must emit a no-op, not an INSERT');
});
check('H3-02', 'SKIPPED_NO_FILL_CANCEL_FAILED writes no ledger row', () => {
  const out = run({ ...FILLED, alpaca_status: 'SKIPPED_NO_FILL_CANCEL_FAILED', alpaca_qty: 0 });
  assert.strictEqual(out.h3, 'skipped');
});
check('H3-03', 'BLOCKED_EXEC_CAP writes no ledger row', () => {
  const out = run({ ...FILLED, alpaca_status: 'BLOCKED_EXEC_CAP', alpaca_entry_id: null });
  assert.strictEqual(out.h3, 'skipped');
});
// the one that actually mattered
check('H3-04', 'ERROR_FILL_STATE_UNKNOWN writes no ledger row — and the OLD code proves it would have', () => {
  const unknown = { ...FILLED, alpaca_status: 'ERROR_FILL_STATE_UNKNOWN', alpaca_needs_reconciliation: true,
                    alpaca_fill_price: null, alpaca_stop_price: 349.38 };
  const before = run(unknown, V1);
  assert.ok(/INSERT INTO public\.trade_ledger/.test(before.sql),
    'v1 was supposed to stage a phantom row here — if it did not, this test is not testing what it claims');
  assert.strictEqual(before.h3, 'staged', 'v1: a full-qty row for a fill we explicitly said we could not determine');
  const after = run(unknown, V2);
  assert.strictEqual(after.h3, 'skipped', 'v2 must refuse');
  assert.ok(!/INSERT/.test(after.sql));
});
check('H3-05', 'the family match is a prefix rule, so a future SKIPPED_* / ERROR_* is also caught', () => {
  for (const st of ['SKIPPED_SOMETHING_NEW', 'ERROR_ANYTHING', 'BLOCKED_WHATEVER', 'REJECTED_XYZ']) {
    assert.strictEqual(run({ ...FILLED, alpaca_status: st }).h3, 'skipped', `${st} slipped through`);
  }
});

console.log('\n═══ H3 v2 — E3 actually reaches the database ═══\n');

check('H3-06', 'a real entry still stages, and sizing_meta now carries the execution regime', () => {
  const out = run(FILLED);
  assert.strictEqual(out.h3, 'staged');
  const m = metaOf(out);
  assert.strictEqual(m.exec_regime, 'EXEC_V49_LIMIT_CAP', 'without this, E3 exists only in n8n and cannot be queried');
  assert.strictEqual(m.exec_cap_pct, 0.3);
  assert.strictEqual(m.limit_price, 354.68);
  assert.strictEqual(m.fill_price, 360);
  assert.strictEqual(m.poll_outcome, 'FILLED');
  assert.strictEqual(m.stop_reanchored, true);
  assert.strictEqual(m.stop_price_initial, 349.38);
});
check('H3-07', 'v1 could not carry the regime at all — this is the gap being closed', () => {
  const m = metaOf(run(FILLED, V1));
  assert.strictEqual(m.exec_regime, undefined, 'v1 sizing_meta has no regime key');
  assert.ok('anchor' in m, 'and the pre-existing keys are still there in v1');
});
check('H3-08', 'the pre-existing sizing_meta keys are preserved byte-for-byte alongside the new ones', () => {
  const a = metaOf(run(FILLED, V1)), b = metaOf(run(FILLED, V2));
  for (const k of Object.keys(a)) assert.deepStrictEqual(b[k], a[k], `key "${k}" changed: ${JSON.stringify(a[k])} -> ${JSON.stringify(b[k])}`);
});

console.log('\n═══ H3 v2 — what deliberately did NOT change ═══\n');

check('H3-09', 'risk_amount still uses intended_entry, NOT the fill — the Gate-K risk basis is unchanged mid-rebuild', () => {
  const out = run(FILLED);
  // |353.62 - 355.86| * 30 = 67.20   (signal basis, unchanged)
  // |360.00 - 355.86| * 30 = 124.20  (fill basis, recorded but not used)
  assert.ok(/, 67\.2,/.test(out.sql), `risk_amount is not the signal-basis 67.2:\n        ${out.sql.slice(0, 400)}`);
  assert.ok(!/, 124\.2,/.test(out.sql), 'the fill basis must NOT have been silently substituted');
  assert.strictEqual(metaOf(out).risk_amount_at_fill, 124.2, 'but it IS recorded, so the Conclave can rule on it');
});
check('H3-10', 'intended_entry is still the signal price, so it stays byte-comparable with the TradingView payload', () => {
  assert.ok(/, 353\.62,/.test(run(FILLED).sql));
});
check('H3-11', 'a PARTIAL fill stages a row for the shares actually held, not the shares requested', () => {
  const out = run({ ...FILLED, alpaca_status: 'pending_new', alpaca_qty: 12, alpaca_filled_qty: 12, alpaca_partial_fill: true, alpaca_poll_outcome: 'PARTIAL' });
  assert.strictEqual(out.h3, 'staged');
  assert.strictEqual(out.qty, 12);
  assert.strictEqual(metaOf(out).partial_fill, true);
});
check('H3-12', 'the volatile trailing path still stages with its 3% risk basis and exit_order_id', () => {
  const out = run({ ...FILLED, ticker: 'IONQ', alpaca_is_volatile: true, alpaca_stop_price: 'trail:3%',
                    alpaca_signal_price: 40, alpaca_qty: 25, alpaca_sl_id: 'TRAIL-1', alpaca_fill_price: 40.05 });
  assert.strictEqual(out.h3, 'staged');
  assert.ok(/exit_order_id/.test(out.sql), 'volatile path still records the trailing stop as the exit order');
  assert.ok(/, 30,/.test(out.sql), '40 * 0.03 * 25 = 30 risk basis unchanged');
});
check('H3-13', 'the $qet$ dollar-quote escape is still stripped from meta, so a crafted field cannot break out of the literal', () => {
  const out = run({ ...FILLED, __qet_gate: { risk_pct: 0.5, note: "x$qet$'); DROP TABLE public.trade_ledger; --" } });
  const between = /\$qet\$(.*?)\$qet\$/s.exec(out.sql)[1];
  assert.ok(!between.includes('$qet$'), 'a nested $qet$ would terminate the literal early');
  assert.ok(/DROP TABLE/.test(between), 'the text is still carried — it is neutralised, not silently dropped');
  assert.strictEqual((out.sql.match(/\$qet\$/g) || []).length, 2, 'exactly one balanced dollar-quoted literal');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
