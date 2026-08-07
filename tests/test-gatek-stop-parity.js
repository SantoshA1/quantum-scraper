#!/usr/bin/env node
'use strict';
/**
 * Maya regression guard — Gate-K / entry-clamp stop parity (gov 194).
 *
 * Maya asks: "You capped my entry stops at 1.2% yesterday. Today my risk gate threw away a
 * perfectly good ARE short because it thought the stop was 6.6% wide — a stop you were never
 * going to place. Prove the gate now judges the SAME number that reaches my broker, prove
 * ARE would survive, prove you didn't quietly loosen the safety limit, and prove the signals
 * the gate is supposed to refuse still get refused."
 *
 * Deterministic + offline. Executes the ACTUAL deployed v2 node bytes in an n8n-shimmed
 * sandbox and compares them, case for case, against the ACTUAL deployed Alpaca Paper Trade
 * clamp arithmetic. Fixtures are today's REAL rejections pulled from
 * quantum.candidate_path_trace_10fc (ARE 48.48/2.12, AMAT 537.27/17.37).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const G = require('../lib/entry/gatek_stop');
const { entryStop } = require('../lib/entry/stop_clamp');

let passed = 0, failed = 0;
function check(id, name, fn) {
  try { fn(); console.log(`  ✅ ${id}  ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${id}  ${name}  — ${e.message}`); failed++; }
}

const NODE = fs.readFileSync(path.join(__dirname, '..', 'docs', 'gatek-stop-parity-20260807', 'qet-gatek-prep-v2.js'), 'utf8');
const LIVE_V1 = fs.readFileSync(path.join(__dirname, '..', 'docs', 'gatek-stop-parity-20260807', 'qet-gatek-prep-v1-live.js'), 'utf8');

/** Run the real node code with an n8n $input shim. */
function runNode(signal, code = NODE) {
  const $input = { first: () => ({ json: signal }) };
  const fn = new Function('$input', 'console', code);
  const logs = [];
  fn($input, { log: (m) => logs.push(String(m)) });
  const out = new Function('$input', 'console', code)($input, { log: () => {} });
  return { json: out[0].json, logs };
}

// ── today's REAL signals, exactly as they hit the pipeline ────────────────────
const ARE  = { ticker: 'ARE',  price: '48.48',  atr: '2.12',  signal: 'BEARISH', execution: 'SELL', bias_score: '76' };
const AMAT = { ticker: 'AMAT', price: '537.27', atr: '17.37', signal: 'BULLISH', execution: 'BUY',  bias_score: '76' };

// ── PAR-01/02: reproduce today's real damage, then prove the fix ─────────────
check('PAR-01', 'ARE replay (48.48 / atr 2.12): the OLD prep handed Gate-K a 6.559% stop → stop_width_exceeds_sanity', () => {
  const legacy = G.gatekStopLegacy({ ticker: 'ARE', price: 48.48, atr: 2.12, side: 'sell' });
  assert.strictEqual(legacy.stop, 51.66, 'byte-matches 48.48 + 1.5×2.12');
  assert.strictEqual(legacy.widthPct, 6.559, `got ${legacy.widthPct}%`);
  assert.ok(G.rejectsForWidth(48.48, legacy.stop), 'this is the live 13:35:51Z rejection');
});
check('PAR-02', 'ARE replay through the DEPLOYED v2 node: 1.2% stop, comfortably legal, no longer rejected', () => {
  const { json } = runNode(ARE);
  assert.strictEqual(json.__qet_stop, 49.06, `48.48 + min(3.18, 0.582) = 49.06, got ${json.__qet_stop}`);
  // 1.196 not 1.200: the stop is rounded to whole cents, so the realised width lands a hair
  // under the cap. Pinned exactly — a drift here means the rounding contract moved.
  assert.strictEqual(G.stopWidthPct(48.48, json.__qet_stop), 1.196);
  assert.ok(Math.abs(G.stopWidthPct(48.48, json.__qet_stop) - 1.2) < 0.01, 'within a cent of the 1.2% cap');
  assert.ok(!G.rejectsForWidth(48.48, json.__qet_stop), 'survives the 5% sanity line it died on today');
  assert.strictEqual(json.__qet_stop_clamped, true);
  assert.strictEqual(json.__qet_stop_raw_pct, 6.56, 'the fiction it used to judge is recorded for the audit trail');
});

// ── PAR-03: the silent half of the bug — sizing distortion without rejection ──
check('PAR-03', 'AMAT (537.27 / atr 17.37) was NOT rejected but Gate-K still sized off a 4.85% stop — now 1.2%', () => {
  const legacy = G.gatekStopLegacy({ ticker: 'AMAT', price: 537.27, atr: 17.37, side: 'buy' });
  assert.strictEqual(legacy.widthPct, 4.849, `slipped under the 5% line by 0.15pp, got ${legacy.widthPct}`);
  assert.ok(!G.rejectsForWidth(537.27, legacy.stop), 'passed on luck, not correctness');
  const { json } = runNode(AMAT);
  assert.strictEqual(json.__qet_stop, 530.82, '537.27 - min(26.055, 6.447) = 530.82');
  assert.strictEqual(G.stopWidthPct(537.27, json.__qet_stop), 1.201, 'cent-rounded, judged on the real order now');
  assert.ok(legacy.widthPct / 1.201 > 4, 'the gate had been sizing off a stop 4x too wide');
});

// ── PAR-04: THE contract — gate stop === the stop the broker will actually get ─
check('PAR-04', 'parity sweep: for 240 signals the gate stop is byte-identical to the Alpaca node stop', () => {
  let clampedSeen = 0, unclampedSeen = 0;
  for (let i = 1; i <= 240; i++) {
    const ticker = ['ARE', 'AMAT', 'IONQ', 'SOXL', 'WMT', 'XPEV'][i % 6];
    const price = 5 + (i * 3.77) % 800;
    const atr = ((i * 0.31) % 9) * (i % 7 === 0 ? 0 : 1); // every 7th has NO atr -> fallback leg
    const isLong = i % 2 === 0;
    const sig = { ticker, price: String(price), atr: String(atr), execution: isLong ? 'BUY' : 'SELL' };

    const gate = runNode(sig).json.__qet_stop;
    // what "Alpaca Paper Trade" will place, from the independently-maintained clamp mirror
    const placed = entryStop({ isLong, price, atr, vol: G.isVolatileTicker(ticker) }).stopPrice;

    assert.strictEqual(gate, placed,
      `case ${i} ${ticker} ${isLong ? 'LONG' : 'SHORT'} px=${price} atr=${atr}: gate ${gate} vs placed ${placed}`);
    if (G.stopWidthPct(price, gate) < 1.2 - 1e-9) unclampedSeen++; else clampedSeen++;
  }
  assert.ok(clampedSeen > 0 && unclampedSeen > 0, `sweep must exercise both clamped (${clampedSeen}) and untouched (${unclampedSeen}) paths`);
});

check('PAR-05', 'no signal can ever again be rejected for stop width: every clamped stop is 1.2% ≤ 5%', () => {
  for (let i = 1; i <= 240; i++) {
    const ticker = ['ARE', 'IONQ', 'SMCI', 'DGX'][i % 4];
    const price = 3 + (i * 11.3) % 950;
    const sig = { ticker, price: String(price), atr: String((i % 13) * 4.4), execution: i % 2 ? 'BUY' : 'SELL' };
    const stop = runNode(sig).json.__qet_stop;
    assert.ok(!G.rejectsForWidth(price, stop), `case ${i}: ${G.stopWidthPct(price, stop)}% would still be rejected`);
  }
});

// ── PAR-06/07: prove nothing was loosened, and the fail-open path is untouched ─
check('PAR-06', 'the 5% sanity limit itself is UNTOUCHED — the fix changed the input, not the safety line', () => {
  assert.strictEqual(G.GATEK_MAX_STOP_WIDTH_PCT, 5.0, 'still compute_kelly_gate p_max_stop_width_pct default');
  // strip comments first: the header legitimately *names* compute_kelly_gate when explaining
  // the bug. What must not exist is executable code touching the gate or its threshold.
  const EXEC = NODE.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.ok(!/p_max_stop_width_pct|max_stop_width/.test(EXEC), 'the node must not touch the gate threshold at all');
  assert.ok(!/compute_kelly_gate/.test(EXEC), 'the node must not reach into the gate function');
  assert.ok(!/min_trades|kelly|probation/i.test(EXEC), 'and must not touch any other gate parameter');
  // a genuinely absurd stop still gets refused by the gate's own rule
  assert.ok(G.rejectsForWidth(100, 88), '12% wide stop is still rejected');
});
check('PAR-07', 'unmappable signals still emit stop 0 → gate SQL fail-open path is byte-for-byte preserved', () => {
  assert.strictEqual(runNode({ ticker: 'ARE', price: '0',     atr: '2.12', execution: 'SELL' }).json.__qet_stop, 0, 'no price');
  assert.strictEqual(runNode({ ticker: 'ARE', price: '48.48', atr: '2.12', execution: 'HOLD' }).json.__qet_stop, 0, 'unmappable side');
  assert.strictEqual(runNode({ ticker: 'ARE', price: '48.48', atr: '2.12', execution: 'HOLD' }).json.__qet_side, '', 'side stays blank as before');
  // and v1 agreed on exactly these two cases — no behaviour drift on the skip path
  assert.strictEqual(G.gatekStopLegacy({ ticker: 'ARE', price: 0, atr: 2.12, side: 'sell' }).stop, 0);
});

// ── PAR-08: the missing-ATR leg, measured at 0 rows/21d but now correct ───────
check('PAR-08', 'missing ATR: v1 emitted 0 (gate skipped entirely); v2 emits the real 1.2% stop the order will carry', () => {
  const noAtr = { ticker: 'DGX', price: '200', atr: '0', execution: 'BUY' };
  assert.strictEqual(G.gatekStopLegacy({ ticker: 'DGX', price: 200, atr: 0, side: 'buy' }).stop, 0, 'v1: gate silently skipped');
  const { json } = runNode(noAtr);
  assert.strictEqual(json.__qet_stop, 197.6, 'v2: fallback atr=price*1.5% -> raw 2.25% -> clamped 1.2% -> 197.60');
  assert.strictEqual(json.__qet_stop, entryStop({ isLong: true, price: 200, atr: 0, vol: false }).stopPrice, 'still parity with what gets placed');
});

// ── PAR-09: volatile-name divergence closed ──────────────────────────────────
check('PAR-09', 'volatile names: v1 used a flat 3% and did not even know IONQ; v2 matches the Alpaca node exactly', () => {
  const legacyIonq = G.gatekStopLegacy({ ticker: 'IONQ', price: 100, atr: 5, side: 'buy' });
  assert.strictEqual(legacyIonq.stop, 92.5, 'v1 treated IONQ as NON-volatile: 100 - 1.5*5');
  const legacySoxl = G.gatekStopLegacy({ ticker: 'SOXL', price: 100, atr: 5, side: 'buy' });
  assert.strictEqual(legacySoxl.stop, 97, 'v1 gave listed volatiles a flat 3%');
  for (const t of ['IONQ', 'SOXL', 'SMCI', 'UVXY']) {
    const gate = runNode({ ticker: t, price: '100', atr: '5', execution: 'BUY' }).json.__qet_stop;
    assert.strictEqual(gate, entryStop({ isLong: true, price: 100, atr: 5, vol: true }).stopPrice, `${t} parity`);
    assert.strictEqual(gate, 98.8, `${t}: min(5*1.0, 1.2) -> 1.2% -> 98.80`);
  }
  assert.ok(G.VOLATILE_TICKERS.includes('IONQ'), 'IONQ now present, matching the deployed Alpaca set');
});

// ── PAR-10: lockstep pins ────────────────────────────────────────────────────
check('PAR-10', 'lockstep: deployed v2 node carries the clamp arithmetic verbatim and is stamped', () => {
  assert.ok(NODE.includes('const MAX_ENTRY_STOP_PCT = 0.012;'), 'same constant as the Alpaca node');
  assert.ok(NODE.includes('const _stopDist = Math.min(_rawStopDist, price * MAX_ENTRY_STOP_PCT);'), 'same clamp line');
  assert.ok(NODE.includes("const _slMult = isVol ? 1.0 : 1.5;"), 'same SL_MULT rule');
  assert.ok(NODE.includes('const _atrEff = atr > 0 ? atr : price * 0.015;'), 'same missing-ATR fallback');
  assert.ok(NODE.includes('QTP_GATEK_STOP_PARITY_v1_20260807'), 'version stamp present');
  assert.ok(!NODE.includes('stopEst = side === \'sell\' ? price + 1.5 * atr'), 'the uncapped v1 stop line is gone');
});
check('PAR-11', 'the archived v1 file really is the code that was live (so PAR-01 is a replay, not a story)', () => {
  assert.ok(LIVE_V1.includes('QET Gate-K Filter shim v1.0 (2026-07-10)'), 'archived header');
  assert.ok(LIVE_V1.includes('else if (atr > 0) stopEst = side === \'sell\' ? price + 1.5 * atr : price - 1.5 * atr;'),
    'the exact uncapped line that produced ARE 51.66');
  assert.ok(!LIVE_V1.includes('MAX_ENTRY_STOP_PCT'), 'v1 provably had no clamp');
});

console.log(`\n  ${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
