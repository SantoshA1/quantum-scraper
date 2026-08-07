'use strict';
/**
 * QTP_GATEK_STOP_PARITY_v1_20260807 — spec-mirror of the stop Gate-K is asked to judge.
 *
 * THE GAP (found 2026-08-07 during the "no orders today" RCA).
 * The main pipeline evaluates risk in this order (proven from the live connection graph):
 *
 *   Format Supabase Alpaca Risk Gate Context
 *     -> QET Gate-K Prep          <- derives __qet_stop  (THIS node)
 *     -> QET Equity Fetch (Paper)
 *     -> QET Kelly SQL Build      <- passes __qet_stop as compute_kelly_gate(p_stop)
 *     -> QET Kelly Gate Check
 *     -> QET Gate-K Approved?
 *     -> QET Gate-K Restore Context
 *     -> Alpaca Paper Trade       <- QTP_ENTRY_STOP_CLAMP_v1 lives HERE, downstream
 *
 * So the 1.2% entry clamp shipped 2026-08-06 (gov 190) never reaches Gate-K. Gate-K judged a
 * raw, uncapped 1.5xATR stop that the pipeline would never actually place, and
 * compute_kelly_gate rejects anything wider than p_max_stop_width_pct = 5.0 with
 * 'stop_width_exceeds_sanity'. Those signals had already cleared VC, bias, MTF and AI —
 * the expensive gates — and then died on a number that was pure fiction.
 *
 * Live proof (2026-08-07 13:35:51Z): ARE SELL, price 48.48, atr 2.12.
 *   Gate-K saw   48.48 + 1.5x2.12 = 51.66  ->  6.559% wide  -> REJECTED
 *   Order needed 48.48 + min(3.18, 0.582)  ->  1.200% wide  -> comfortably legal
 * Cost: 18 such rejections in the last 21 trading days, 1-3 on almost every day.
 *
 * Near-miss on the same day (AMAT BUY 537.27 / atr 17.37): Gate-K saw 4.849% and passed it
 * only because it happened to sit under the 5% line — while sizing off a stop 4x wider than
 * the one that would be placed. The gap silently distorts sizing even when it does not reject.
 *
 * THE FIX: Gate-K Prep computes the stop with the SAME arithmetic the Alpaca node uses, so
 * the gate judges the order that will actually exist. Contract is lib/entry/stop_clamp.js
 * (already the mirror of the deployed clamp) plus the ticker->volatile resolution below.
 *
 * PRESERVED DELIBERATELY: when price <= 0 or the side is unmappable, the stop stays 0 and the
 * gate SQL still short-circuits to 'gate_skipped_insufficient_fields' (fail-open). That is the
 * genuine "cannot map this signal" path from the v1.0 shim and this change does not touch it.
 * Measured blast radius of the ATR-fallback leg: 0 rows in 21 days carry a missing ATR
 * (gate_skipped = 0 across 2026-07-17..2026-08-07), so it is a latent-hole close, not a
 * behaviour change in production.
 */

const { entryStop, MAX_ENTRY_STOP_PCT, r2 } = require('./stop_clamp');

/** Byte-identical to the VOLATILE set in the deployed "Alpaca Paper Trade" node. */
const VOLATILE_TICKERS = ['SQQQ', 'TQQQ', 'SPXS', 'SPXL', 'SOXS', 'SOXL', 'UVXY', 'SVXY', 'SMCI', 'IONQ'];

/** compute_kelly_gate's p_max_stop_width_pct default — the line ARE fell foul of. */
const GATEK_MAX_STOP_WIDTH_PCT = 5.0;

function isVolatileTicker(ticker) {
  return VOLATILE_TICKERS.indexOf(String(ticker || '').toUpperCase()) >= 0;
}

/** Gate-K's own width check, mirrored: round(abs(entry-stop)/entry*100, 3). */
function stopWidthPct(entry, stop) {
  return Math.round((Math.abs(entry - stop) / entry) * 100 * 1000) / 1000;
}

/**
 * THE FIX — the stop Gate-K should judge: exactly the one Alpaca Paper Trade will place.
 * Returns 0 for unmappable signals so the existing fail-open path is untouched.
 */
function gatekStop({ ticker, price, atr, side }) {
  const p = parseFloat(price || 0);
  const s = String(side || '').toLowerCase();
  if (!(p > 0) || (s !== 'buy' && s !== 'sell')) return { stop: 0, skipped: true };
  const e = entryStop({
    isLong: s === 'buy',
    price: p,
    atr: parseFloat(atr || 0),
    vol: isVolatileTicker(ticker),
  });
  return {
    stop: e.stopPrice,
    skipped: false,
    clamped: e.clamped,
    widthPct: stopWidthPct(p, e.stopPrice),
  };
}

/**
 * THE OLD (broken) Gate-K Prep arithmetic — preserved verbatim so the suite can reproduce
 * the real rejections rather than asserting against a story. Flat 3% for volatile names,
 * uncapped 1.5xATR for everything else, no clamp, and no IONQ in its volatile list.
 */
const LEGACY_VOL = ['SQQQ', 'TQQQ', 'SPXS', 'SPXL', 'SOXS', 'SOXL', 'UVXY', 'SVXY', 'SMCI'];
function gatekStopLegacy({ ticker, price, atr, side }) {
  const p = parseFloat(price || 0);
  const a = parseFloat(atr || 0);
  const s = String(side || '').toLowerCase();
  const isVol = LEGACY_VOL.indexOf(String(ticker || '').toUpperCase()) >= 0;
  let stopEst = 0;
  if (p > 0 && s) {
    if (isVol) stopEst = s === 'sell' ? p * 1.03 : p * 0.97;
    else if (a > 0) stopEst = s === 'sell' ? p + 1.5 * a : p - 1.5 * a;
  }
  const stop = Math.round(stopEst * 100) / 100;
  return { stop, skipped: stop <= 0, widthPct: stop > 0 ? stopWidthPct(p, stop) : 0 };
}

/** Would compute_kelly_gate reject this stop for width? (its FIX-2b leg) */
function rejectsForWidth(entry, stop) {
  return stopWidthPct(entry, stop) > GATEK_MAX_STOP_WIDTH_PCT;
}

module.exports = {
  VOLATILE_TICKERS, GATEK_MAX_STOP_WIDTH_PCT, MAX_ENTRY_STOP_PCT, r2,
  isVolatileTicker, stopWidthPct, gatekStop, gatekStopLegacy, rejectsForWidth,
};
