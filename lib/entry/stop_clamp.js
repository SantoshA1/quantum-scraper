'use strict';
/**
 * QTP_ENTRY_STOP_CLAMP_v1_20260806 — spec-mirror of the entry bracket stop computation
 * (main pipeline vaqfCaELhOEWnkdo, "Alpaca Paper Trade" node).
 *
 * WHY (2026-08-06 RCA, gov 189): entry stops were placed at raw ATR×SL_MULT — 3-6% wide on
 * volatile names — while the TSM enforces MAX_PROTECTIVE_STOP_PCT = 1.2%. Every wide entry
 * armed the TSM's cancel/replace recovery; when price had already fallen through the
 * tightened level, the recovery went naked and the scalp watcher market-dumped the position
 * (WRB −$143.60, APA −$47.68 today). The clamp makes entry and manager agree at the source.
 *
 * CONTRACT (mirrored by the live node):
 *   stopDist = min(atr × SL_MULT, price × 1.2%);  stop = price ∓ stopDist (r2)
 *   SL_MULT = 1.0 volatile / 1.5 normal; atr falls back to price×1.5% when signal has none.
 *   qty sizing is %-of-portfolio — INDEPENDENT of stop width (no sizing side-effect).
 *   Take-profit stays ATR-based (unchanged; R:R shift is the accepted consequence,
 *   flagged for the stop-vs-budget Conclave review).
 */

const MAX_ENTRY_STOP_PCT = 0.012;
const r2 = (n) => Math.round(n * 100) / 100;

function entryStop({ isLong, price, atr, vol }) {
  const a = atr > 0 ? atr : price * 0.015;
  const slMult = vol ? 1.0 : 1.5;
  const rawDist = a * slMult;
  const dist = Math.min(rawDist, price * MAX_ENTRY_STOP_PCT);
  return {
    slMult, rawDist, dist, clamped: dist < rawDist,
    stopPrice: isLong ? r2(price - dist) : r2(price + dist),
    stopPct: Math.round((dist / price) * 10000) / 100,
  };
}

module.exports = { MAX_ENTRY_STOP_PCT, r2, entryStop };
