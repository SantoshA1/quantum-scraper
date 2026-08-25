// QET Gate-K Filter shim v2.0 (2026-08-07) — Phase 1: FILTER ONLY, sizing untouched.
// Derives gate inputs from pipeline fields; unmappable signals FAIL OPEN (skip flag).
// Evidence: week 2026-07-06 counter-regime shorts -485 USD; WDAY/F/ASML protection defects.
//
// QTP_GATEK_STOP_PARITY_v1_20260807 (gov 194) — v1.0 handed compute_kelly_gate a RAW,
// UNCLAMPED 1.5*ATR stop while the order actually placed downstream in "Alpaca Paper Trade"
// carries QTP_ENTRY_STOP_CLAMP_v1's 1.2% cap (gov 190). Gate-K therefore judged a stop the
// pipeline would never place and rejected anything over its 5% sanity line —
// 18 signals in 21 days, all of which had already cleared VC, bias, MTF and AI.
//   Live proof 2026-08-07 13:35:51Z: ARE SELL 48.48 / atr 2.12
//     v1.0 -> 48.48 + 1.5*2.12 = 51.66  = 6.559% -> gatek_reject=stop_width_exceeds_sanity
//     v2.0 -> 48.48 + min(3.18, 0.582)  = 1.200% -> legal, judged on the real order
// v2.0 mirrors the Alpaca node's arithmetic exactly (SL_MULT 1.0 volatile / 1.5 normal,
// atr falls back to price*1.5%, then min(raw, price*1.2%)) so the gate sizes and screens
// the order that will actually exist. Mirror: lib/entry/gatek_stop.js + lib/entry/stop_clamp.js
// Guard:  tests/test-gatek-stop-parity.js
// UNCHANGED ON PURPOSE: price<=0 or unmappable side still emits stop 0, so the gate SQL's
// 'gate_skipped_insufficient_fields' fail-open path behaves exactly as before.
const j = $input.first().json;
const price = parseFloat(j.price || 0);
const atr = parseFloat(j.atr || j.atr_est || 0);
const sigTxt = String(j.signal || j.execution || j._sm_route || '').toUpperCase();
let side = '';
if (/SELL|SHORT|BEAR/.test(sigTxt)) side = 'sell';
else if (/BUY|LONG|BULL/.test(sigTxt)) side = 'buy';
// v2.0: volatile set is byte-identical to the Alpaca Paper Trade node (v1.0 was missing IONQ).
const VOL = ['SQQQ','TQQQ','SPXS','SPXL','SOXS','SOXL','UVXY','SVXY','SMCI','IONQ'];
const isVol = VOL.includes(String(j.ticker || '').toUpperCase());
const MAX_ENTRY_STOP_PCT = 0.012;
const r2 = (n) => Math.round(n * 100) / 100;
let stopEst = 0;
let _clamped = false;
let _rawPct = null;
if (price > 0 && side) {
  // QTP_EXIT_POLICY_v1_gov241_20260825: exact mirror of Alpaca Paper Trade post-gov241 —
  // the executor places a FIXED 2.5% stop (Conclave Decision 1), so the gate judges the
  // 2.5% stop the order will carry. Raw ATR distance retained for telemetry parity.
  const POLICY_STOP_PCT = 0.025;
  const _slMult = isVol ? 1.0 : 1.5;
  const _atrEff = atr > 0 ? atr : price * 0.015;
  const _rawStopDist = _atrEff * _slMult;
  const _stopDist = price * POLICY_STOP_PCT;
  _clamped = false; // fixed policy width: nothing is clamped any more
  _rawPct = Math.round((_rawStopDist / price) * 10000) / 100;
  stopEst = side === 'sell' ? r2(price + _stopDist) : r2(price - _stopDist);
}
const confRaw = parseFloat(j.ai_confidence || j.confidence || j.bias_score || 50);
const conf = Math.min(1, Math.max(0, confRaw > 1 ? confRaw / 100 : confRaw));
return [{ json: { ...j, __qet_symbol: String(j.ticker || '').toUpperCase(), __qet_side: side, __qet_entry: price, __qet_stop: r2(stopEst), __qet_conf: conf, __qet_stop_clamped: _clamped, __qet_stop_raw_pct: _rawPct, __qet_stop_parity_v: 'QTP_GATEK_STOP_PARITY_v1_20260807' } }];
