'use strict';
/**
 * QTP_K1_REGIME_LABELS_v1_20260805 — spec-mirror of Gate-K K1 (regime filter),
 * extracted from public.compute_kelly_gate v2.2 (GATE_K_v2.2_K3_LOSS_ONLY_20260805),
 * FIX 1 block.
 *
 * RCA (2026-08-05). K1 IS STRUCTURALLY DEAD AND HAS NEVER FIRED:
 *
 *   The gate compares  upper(trend_regime) = 'UP'  /  = 'DOWN'.
 *   quantum.regime_state has only ever stored THREE values in its entire life
 *   (counts pinned 2026-08-05 15:45 UTC):  CHOP 175, RISK_ON 48, RISK_OFF 28.
 *   'UP' and 'DOWN' have never existed in that table, so neither branch can
 *   match and the counter-regime block — justified by the -$485 realized loss
 *   on counter-regime shorts in the week of 2026-07-06 — is protection that
 *   exists only on paper. Compounding: the Regime Service writes its first row
 *   ~10:00 ET, so pre-10:00 the filter also fails open on staleness (catalogued
 *   separately as C4; NOT fixed here).
 *
 * THE FIX — PO-authorized 2026-08-05 ("Go with [the mapping] inside the gate"),
 * deployed as GATE_K_v2.3_K1_REGIME_LABELS_20260805:
 *   map the labels the Regime Service actually emits, inside the gate:
 *     RISK_ON  ⇒ uptrend-equivalent   → blocks BEARISH entries
 *     RISK_OFF ⇒ downtrend-equivalent → blocks BULLISH entries
 *     CHOP     ⇒ no directional block (matches neither)
 *   'UP'/'DOWN' remain honored (forward-compat if the emitter ever changes).
 *   Reason strings are UNCHANGED from v2.2 — K1 never fired, so no downstream
 *   row has ever carried them; keeping them means zero consumer impact.
 *
 * Variant naming (kept stable so the suite pins the DELTA):
 *   'live'     = the v2.2 predicate (UP/DOWN only — the dead filter)
 *   'proposed' = the v2.3 predicate (+RISK_ON/RISK_OFF) — THE DEPLOYED GATE.
 */

const REGIME_MAX_AGE_MIN = 90;

const BLOCKS_BEARISH = { live: ['UP'], proposed: ['UP', 'RISK_ON'] };
const BLOCKS_BULLISH = { live: ['DOWN'], proposed: ['DOWN', 'RISK_OFF'] };

function direction(side) {
  const s = String(side || '').toLowerCase();
  if (['buy', 'buy_call', 'sell_put'].includes(s)) return 'bullish';
  if (['sell', 'sell_call', 'buy_put'].includes(s)) return 'bearish';
  return null;
}

/**
 * Mirror of the live FIX-1 block.
 * candidate = {side, now, regimeMode ('enforce'|'shadow'|'off'), maxAgeMin?}
 * regimeRow = {trend_regime, volatility_regime, observed_at} | null
 * variant   = 'live' | 'proposed'
 * Returns {blocked, reason, degraded, shadowViolation, regimeInfo} matching the
 * live jsonb shapes: enforce+violation → blocked with the violation as reason;
 * shadow+violation → NOT blocked, violation surfaced in shadowViolation;
 * stale/missing row → fail-open with 'regime_stale_or_missing_filter_skipped'.
 */
function regimeDecision(candidate, regimeRow, variant) {
  const v = variant || 'live';
  const mode = candidate.regimeMode || 'enforce';
  const dir = direction(candidate.side);
  const out = { blocked: false, reason: null, degraded: null, shadowViolation: null, regimeInfo: null };

  if (mode === 'off' || !dir) {
    if (!dir) out.degraded = 'side_missing_direction_checks_skipped';
    return out;
  }

  const maxAge = candidate.maxAgeMin || REGIME_MAX_AGE_MIN;
  const fresh = regimeRow && regimeRow.observed_at &&
    new Date(regimeRow.observed_at).getTime() >= new Date(candidate.now).getTime() - maxAge * 60000;
  if (!fresh || !regimeRow.trend_regime) {
    out.degraded = 'regime_stale_or_missing_filter_skipped';
    return out;
  }

  out.regimeInfo = { trend: regimeRow.trend_regime, volatility: regimeRow.volatility_regime,
    observed_at: regimeRow.observed_at, mode };

  const trend = String(regimeRow.trend_regime).toUpperCase();
  let violation = null;
  if (BLOCKS_BEARISH[v].includes(trend) && dir === 'bearish') {
    violation = 'counter_regime_bearish_in_uptrend';
  } else if (BLOCKS_BULLISH[v].includes(trend) && dir === 'bullish') {
    violation = 'counter_regime_bullish_in_downtrend';
  }

  if (violation && mode === 'enforce') { out.blocked = true; out.reason = violation; }
  else if (violation && mode === 'shadow') { out.shadowViolation = violation; }
  return out;
}

module.exports = { REGIME_MAX_AGE_MIN, BLOCKS_BEARISH, BLOCKS_BULLISH, direction, regimeDecision };
