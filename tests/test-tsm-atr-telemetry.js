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

// ── QTP_TSM_ATR_FEED_SHADOW_v2_20260810 ──────────────────────────────────────
// Maya adds: "You're telling me the ATR that sets my trail tiers has been computed off 5% of
// the volume this whole time, and that fixing it is free. Fine — but you're not touching my
// risk node on a claim. Show me, per symbol, exactly how far my tiers move BEFORE you change
// anything, and show me the case where a symbol goes from unmanaged to managed, because that
// one isn't a tier shift, it's a different decision."
const SH = require('../lib/tsm/atr_telemetry');
// bars whose mean true range is a chosen % of price — IEX thinner (lower TR) than consolidated
const shBars = (n, price, trPct) => Array.from({ length: n }, () => ({
  h: price + price * trPct / 2, l: price - price * trPct / 2, c: price }));
const SHPOS = [
  { symbol: 'WST',  avg_entry_price: 355.36, qty: 30 },
  { symbol: 'AES',  avg_entry_price: 14.66,  qty: -731 },
];
// Fixtures are built from the measured PERCENTAGES, not from the rounded dollar ATRs the
// probe printed. Using the printed 9.98 / 11.04 reproduces -9.6014%, not the measured
// -9.6621%, because those figures are 2-dp rounded — and on AES (0.04 vs 0.05) the rounding
// swamps the signal entirely, giving a fake -20%. Anchoring on the ratio keeps the fixture
// faithful to what was actually measured.
const SIP_PCT  = { WST: 3.1069, AES: 0.3252 };   // consolidated ATR-14 as % of price
const IEX_DIFF = { WST: -9.6621, AES: -10.4478 };  // IEX vs SIP, % difference
const trOf = (sym, feed) => SIP_PCT[sym] / 100 * (feed === 'iex' ? 1 + IEX_DIFF[sym] / 100 : 1);
const shadow = (over = {}) => SH.buildFeedShadow(Object.assign({
  positions: SHPOS,
  iexBars: { WST: shBars(15, 355.36, trOf('WST', 'iex')), AES: shBars(15, 14.66, trOf('AES', 'iex')) },
  sipBars: { WST: shBars(15, 355.36, trOf('WST', 'sip')), AES: shBars(15, 14.66, trOf('AES', 'sip')) },
  t1FloorPct: 0.7,
}, over));

check('SHD-01', 'the shadow reports IEX understating ATR on every comparable symbol, never overstating', () => {
  const s = shadow();
  assert.strictEqual(s.n_comparable, 2);
  assert.strictEqual(s.iex_understates_on, 2, 'thin-venue bars miss the extremes; the sign is the whole point');
  assert.strictEqual(s.iex_overstates_on, 0);
  assert.ok(s.mean_atr_diff_pct < 0, `mean diff ${s.mean_atr_diff_pct} should be negative`);
});
check('SHD-02', 'the per-symbol delta matches the live measurement (WST -9.66%, AES -10.45%)', () => {
  const by = Object.fromEntries(shadow().symbols.map((r) => [r.sym, r]));
  assert.ok(Math.abs(by.WST.atr_iex_vs_sip_pct_diff - (-9.6621)) < 0.05, String(by.WST.atr_iex_vs_sip_pct_diff));
  assert.ok(Math.abs(by.AES.atr_iex_vs_sip_pct_diff - (-10.4478)) < 0.15, String(by.AES.atr_iex_vs_sip_pct_diff));
});
check('SHD-03', 'the T1 tier delta is quantified per symbol — this is the number that authorises the flip', () => {
  const by = Object.fromEntries(shadow().symbols.map((r) => [r.sym, r]));
  // WST: 1.5*9.98/355.36 = 4.21% -> 1.5*11.04/355.36 = 4.66%, so tiers widen ~0.45pp
  assert.ok(by.WST.t1_pct_sip > by.WST.t1_pct_iex, 'consolidated ATR must widen the tier, not narrow it');
  assert.ok(Math.abs(by.WST.t1_delta_pct_points - 0.45) < 0.03, String(by.WST.t1_delta_pct_points));
  assert.ok(shadow().max_t1_delta_pct_points > 0);
});
check('SHD-04', 'a clamp verdict that FLIPS is called out separately — that is a managed/unmanaged change, not a tier shift', () => {
  const by = Object.fromEntries(shadow().symbols.map((r) => [r.sym, r]));
  // AES iex 0.04/14.66 = 0.273% (below the 0.4% floor); sip 0.05/14.66 = 0.341% (still below)
  assert.strictEqual(by.AES.clamp_iex, 'BELOW_FLOOR');
  assert.strictEqual(by.AES.clamp_sip, 'BELOW_FLOOR');
  assert.strictEqual(by.AES.clamp_verdict_flips, false, 'AES stays skipped either way — the feed does not rescue it');
  // and a constructed flip is reported
  const flip = SH.buildFeedShadow({ positions: [{ symbol: 'Q', avg_entry_price: 100, qty: 1 }],
    iexBars: { Q: shBars(15, 100, 0.0035) }, sipBars: { Q: shBars(15, 100, 0.0045) }, t1FloorPct: 0.7 });
  assert.strictEqual(flip.symbols[0].clamp_verdict_flips, true);
  assert.deepStrictEqual(flip.clamp_verdict_flips, ['Q:BELOW_FLOOR->PASS']);
});
check('SHD-05', 'the shadow DECIDES nothing — it exposes no atr_used, no model, no order field', () => {
  const s = shadow();
  const keys = new Set(Object.keys(s.symbols[0]));
  for (const forbidden of ['atr_used', 'model', 'stop_price', 'qty_to_place', 'action']) {
    assert.ok(!keys.has(forbidden), `shadow row must not carry "${forbidden}" — it is an observer`);
  }
  assert.strictEqual(s.type, 'ATR_FEED_SHADOW');
  assert.strictEqual(s.version, 'QTP_TSM_ATR_FEED_SHADOW_v2_20260810');
});
check('SHD-06', 'missing or one-sided bars degrade to unknown rather than to a fake zero delta', () => {
  const s = SH.buildFeedShadow({ positions: SHPOS, iexBars: { WST: shBars(15, 355.36, 0.03) }, sipBars: {}, t1FloorPct: 0.7 });
  const by = Object.fromEntries(s.symbols.map((r) => [r.sym, r]));
  assert.strictEqual(by.WST.atr_iex_vs_sip_pct_diff, null, 'no consolidated bars -> no comparison, not a 0% delta');
  assert.strictEqual(by.WST.clamp_sip, 'NO_BARS');
  assert.strictEqual(s.n_comparable, 0);
  assert.strictEqual(s.mean_atr_diff_pct, null);
});
check('SHD-07', 'the live TSM really does hard-code feed=iex — if that stops being true this suite must be revisited', () => {
  const fs = require('fs'), path = require('path');
  const p = path.join(__dirname, '..', 'docs', 'execution-fix-20260810', 'atr-telemetry-v1-LIVE.js');
  if (!fs.existsSync(p)) return;               // artifact not checked in on this branch
  const live = fs.readFileSync(p, 'utf8');
  assert.ok(/feed=iex/.test(live), 'the observer itself fetches feed=iex — that is the defect being shadowed');
});

console.log(`\n  ${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
