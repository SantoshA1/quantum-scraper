#!/usr/bin/env node
'use strict';
/**
 * Maya regression guard — TSM ATR telemetry (QTP_TSM_ATR_TELEMETRY_v1_20260806).
 *
 * Maya asks: "You told me my real-ATR switch has never done anything, and that you can't
 * even read whether it's ON without opening the n8n UI. You're now adding code to my LIVE
 * stop manager while the market is open. Prove it only WATCHES — that it never decides
 * anything, never throws into my risk path — and prove it answers the three questions I
 * actually have: is the bars fix feeding real ATR, what is the flag, and which of my
 * positions would get dropped if I flipped it."
 *
 * Deterministic + offline. Fixtures are the real 2026-08-05/06 book and the ATR values
 * pinned in quantum.v_tsm_atr_compare (AES 0.36% real, XPEV 4.29% real, engine 2.00% flat).
 */
const assert = require('assert');
const T = require('../lib/tsm/atr_telemetry');

let passed = 0, failed = 0;
function check(id, name, fn) {
  try { fn(); console.log(`  ✅ ${id}  ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${id}  ${name}  — ${e.message}`); failed++; }
}
// synth bars whose mean true range ≈ target pct of price
const bars = (n, price, trPct) => Array.from({ length: n }, (_, i) => ({
  h: price + price * trPct / 2, l: price - price * trPct / 2, c: price,
}));
const POS = [
  { symbol: 'AES', avg_entry_price: 14.66, qty: -731 },   // real ATR 0.36% -> below clamp floor
  { symbol: 'XPEV', avg_entry_price: 12.42, qty: -858 },  // real ATR 4.29%
  { symbol: 'WMT', avg_entry_price: 112.47, qty: -95 },   // real ATR 2.49%
];
const BARS = { AES: bars(30, 14.66, 0.0036), XPEV: bars(30, 12.42, 0.0429), WMT: bars(30, 112.47, 0.0249) };
const build = (o) => T.buildAtrTelemetry(Object.assign(
  { positions: POS, barsData: BARS, realBars: BARS, realAtrOn: false, t1FloorPct: 0.7 }, o));

// ── it only WATCHES ────────────────────────────────────────────────────────────
check('TEL-01', 'pure observer: identical inputs -> identical output, and inputs are never mutated', () => {
  const snapshot = JSON.stringify({ POS, BARS });
  const a = build({}), b = build({});
  assert.deepStrictEqual(a, b);
  assert.strictEqual(JSON.stringify({ POS, BARS }), snapshot, 'telemetry must not touch the engine inputs');
});
check('TEL-02', 'no position, no bars, garbage entries -> still returns a well-formed row, never throws', () => {
  assert.strictEqual(build({ positions: [] }).positions, 0);
  assert.strictEqual(build({ positions: null, barsData: null, realBars: null }).positions, 0);
  const junk = T.buildAtrTelemetry({ positions: [{ symbol: 'X', avg_entry_price: 'abc' }, {}, null],
    barsData: {}, realBars: {}, realAtrOn: true });
  assert.strictEqual(junk.positions, 1, 'nameless/null positions dropped, not fatal');
  assert.strictEqual(junk.symbols[0].model, 'SKIP_NO_BARS');
});

// ── question 1: is the 08-04 bars fix feeding real ATR? ────────────────────────
check('TEL-03', "30 bars per symbol -> model LEGACY_BARS and bars_fix_healthy=true (the fix is delivering)", () => {
  const t = build({});
  assert.ok(t.symbols.every((s) => s.model === 'LEGACY_BARS'));
  assert.strictEqual(t.legacy_bars_ok, 3);
  assert.strictEqual(t.bars_fix_healthy, true);
});
check('TEL-04', 'the pre-fix disease is still detectable: 1 bar/symbol -> PROXY_2PCT and bars_fix_healthy=false', () => {
  const t = build({ barsData: { AES: bars(1, 14.66, 0.0036), XPEV: bars(1, 12.42, 0.0429), WMT: bars(1, 112.47, 0.0249) } });
  assert.ok(t.symbols.every((s) => s.model === 'PROXY_2PCT'), 'silent 2% fallback is named, not hidden');
  assert.ok(t.symbols.every((s) => Math.abs(s.atr_used_pct - 2.0) < 0.001));
  assert.strictEqual(t.bars_fix_healthy, false);
});

// ── question 2: what is the flag? ──────────────────────────────────────────────
check('TEL-05', 'the flag itself is recorded — the only SQL-readable evidence of $vars state', () => {
  assert.strictEqual(build({ realAtrOn: false }).real_atr_flag, false);
  assert.strictEqual(build({ realAtrOn: true }).real_atr_flag, true);
});

// ── question 3: who gets dropped if I flip it? ─────────────────────────────────
check('TEL-06', "AES (real ATR 0.36%) is named as BELOW_FLOOR — the flip would silently stop managing it", () => {
  const t = build({});
  const aes = t.symbols.find((s) => s.sym === 'AES');
  assert.ok(Math.abs(aes.atr_real_pct - 0.36) < 0.02, String(aes.atr_real_pct));
  assert.strictEqual(aes.real_clamp, 'BELOW_FLOOR');
  assert.ok(t.would_skip_if_flag_on.includes('AES:BELOW_FLOOR'), JSON.stringify(t.would_skip_if_flag_on));
});
check('TEL-07', 'flag OFF still pre-computes the flip consequence — the decision is made on data, before the switch', () => {
  const off = build({ realAtrOn: false });
  assert.strictEqual(off.real_atr_flag, false);
  assert.strictEqual(off.would_skip_if_flag_on.length, 1, 'AES only');
  assert.ok(off.symbols.every((s) => s.atr_real_pct > 0), 'real ATR measured even while unused');
});
check('TEL-08', 'flag ON: PASS symbols get model REAL, failures get SKIP_<reason> (never a silent proxy)', () => {
  const t = build({ realAtrOn: true });
  const by = Object.fromEntries(t.symbols.map((s) => [s.sym, s]));
  assert.strictEqual(by.XPEV.model, 'REAL');
  assert.strictEqual(by.WMT.model, 'REAL');
  assert.strictEqual(by.AES.model, 'SKIP_BELOW_FLOOR');
  assert.strictEqual(by.AES.atr_used, null, 'skipped symbols carry NO atr — no proxy leakage');
});
check('TEL-09', 'clamp cap is enforced too: a 7% ATR reads ABOVE_CAP', () => {
  const t = build({ realBars: { AES: bars(30, 14.66, 0.07), XPEV: BARS.XPEV, WMT: BARS.WMT } });
  assert.strictEqual(t.symbols.find((s) => s.sym === 'AES').real_clamp, 'ABOVE_CAP');
});

// ── the T1 consequence, quantified before the flip ─────────────────────────────
check('TEL-10', 'T1 shift is pre-computed: XPEV 6.44% under REAL vs 6.44% legacy-ATR now; AES floors at 0.7%', () => {
  const t = build({});
  const by = Object.fromEntries(t.symbols.map((s) => [s.sym, s]));
  assert.ok(Math.abs(by.XPEV.t1_pct_if_real - 6.44) < 0.05, String(by.XPEV.t1_pct_if_real));
  assert.strictEqual(by.AES.t1_pct_if_real, 0.7, 'floor wins for quiet names');
  assert.ok(by.XPEV.t1_pct_now > 0, 'current-model T1 also recorded for comparison');
});
check('TEL-11', 'proxy-era T1 is the 3.00% signature — so a regression back to proxy is visible at a glance', () => {
  const t = build({ barsData: { XPEV: bars(1, 12.42, 0.0429) }, positions: [POS[1]] });
  assert.strictEqual(t.symbols[0].model, 'PROXY_2PCT');
  assert.ok(Math.abs(t.symbols[0].t1_pct_now - 3.0) < 0.01, String(t.symbols[0].t1_pct_now));
});
check('TEL-12', 'payload is audit-shaped: type + sym present so the existing audit builder keys it without change', () => {
  const t = build({});
  assert.strictEqual(t.type, 'ATR_TELEMETRY');
  assert.strictEqual(t.sym, 'PORTFOLIO');
  assert.strictEqual(t.version, 'QTP_TSM_ATR_TELEMETRY_v1_20260806');
  assert.ok(JSON.stringify(t).length < 8000, 'stays small enough for one audit row');
});

console.log(`\n  ${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
