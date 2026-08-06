'use strict';
/**
 * QTP_TSM_STOPWIDTH_v4_3_1_20260806 — spec-mirror of the wide-stop recovery DECISION
 * (workflow vFnPjyx8srnzcYgV, "Trail Stops" node, UNPROTECTED_STOP_TOO_WIDE branch).
 *
 * WHY (2026-08-06 RCA, gov 189): v4.3.0 computed the tightened stop off ENTRY
 * (entry × (1 ∓ min(0.9%, 1.5×ATR%))) and then CANCELLED the working wide stop BEFORE
 * placing the replacement. When price had already fallen through the tightened level,
 * Alpaca 422'd the replacement ("stop price must be less than current price") and the
 * position went NAKED — the scalp watcher then market-dumped it:
 *   WRB 13:45Z: tight 72.40 vs market 71.99 → naked → closed −$143.60
 *   APA 14:15Z: tight 35.58 vs market 35.53 → naked → closed −$47.68
 *
 * v4.3.1 CONTRACT (mirrored by the live node):
 *   1. VALIDITY GUARD before any cancel: long needs tightStop < current×0.999,
 *      short needs tightStop > current×1.001. Invalid → KEEP_EXISTING (wide stop stays,
 *      review flagged, nothing cancelled). Both of today's casualties land here.
 *   2. Valid → cancel-and-replace as before, but a placement failure AFTER the cancel
 *      triggers a RE-PROTECT FALLBACK stop just inside market (current × 0.995 long /
 *      1.005 short) — the position is never left naked once its old stop is gone.
 */

const TIGHT_PCT_CAP = 0.009;      // min(0.9%, 1.5×ATR/entry)
const VALID_BUFFER = 0.001;       // placement needs 0.1% clearance from market
const FALLBACK_PCT = 0.005;       // re-protect stop 0.5% inside market

const r2 = (n) => Math.round(n * 100) / 100;

/** The full v4.3.1 decision for one wide-stopped position. Pure. */
function recoveryDecision({ isLong, entry, current, atrMiss }) {
  const tightPct = Math.min(TIGHT_PCT_CAP, atrMiss && entry > 0 ? (1.5 * atrMiss) / entry : TIGHT_PCT_CAP);
  const tightStop = isLong ? r2(entry * (1 - tightPct)) : r2(entry * (1 + tightPct));
  const valid = isLong ? tightStop < current * (1 - VALID_BUFFER) : tightStop > current * (1 + VALID_BUFFER);
  const fallbackStop = isLong ? r2(current * (1 - FALLBACK_PCT)) : r2(current * (1 + FALLBACK_PCT));
  return {
    tightPct, tightStop, fallbackStop,
    action: valid ? 'CANCEL_AND_REPLACE' : 'KEEP_EXISTING',
    resultTypeIfInvalid: 'STOP_TOO_WIDE_KEPT_EXISTING_UNRECOVERABLE',
    resultTypeIfFallback: 'STOP_TOO_WIDE_REPLACED_WITH_FALLBACK_STOP',
  };
}

module.exports = { TIGHT_PCT_CAP, VALID_BUFFER, FALLBACK_PCT, r2, recoveryDecision };
