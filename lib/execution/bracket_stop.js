'use strict';
/**
 * Pure spec-mirror of the QTP protective-stop construction after QTP_PLAIN_STOP_20260730
 * (main SM vaqfCaELhOEWnkdo "Alpaca Paper Trade" v1a5c5ee9) + the TSM sl_recovery stop.
 *
 * Root cause fixed: the bracket stop_loss used {stop_price, limit_price} — a STOP-LIMIT, which
 * does NOT fill if price gaps past the limit, leaving the position naked. On 07-30 BA's 219.80
 * stop-limit failed, price ran to ~221.3, the position went briefly naked, and the sl_recovery
 * re-stopped at the tightest LEGAL price (221.47 = current+0.5%, since a buy-stop can't sit below
 * market) — a 3% stop. Now the bracket stop is a plain STOP (market-on-trigger): guaranteed fill,
 * so it exits at the intended level and the wide recovery never triggers.
 */
const r2 = (n) => Math.round(n * 100) / 100;

/** Bracket protective stop leg — plain STOP, no limit_price. */
function bracketStopLoss(isLong, price, atr, slMult) {
  const stopPrice = isLong ? r2(price - atr * slMult) : r2(price + atr * slMult);
  return { stop_price: String(stopPrice) }; // NO limit_price -> plain stop
}

/** A stop order fills on trigger iff it is a plain stop (a limit_price can block the fill). */
function fillsOnTrigger(stopLeg) {
  return !!stopLeg && stopLeg.stop_price !== undefined && stopLeg.limit_price === undefined;
}

/** TSM sl_recovery: tightest LEGAL plain stop (a buy-stop can't be below market; sell-stop can't be above). */
function recoveryStop(isLong, missStop, current) {
  const safeStop = isLong ? Math.min(missStop, r2(current * 0.995)) : Math.max(missStop, r2(current * 1.005));
  return { type: 'stop', stop_price: safeStop };
}

/**
 * QTP_NAKED_FLATTEN_20260730 (flag-gated, default off): mirror of the TSM sl_recovery decision.
 * When price has already blown PAST the intended stop by more than the overshoot cap, the position
 * is naked past its stop — flatten at market instead of chasing a wide stop. Default off (PO arms
 * via $vars.QTP_NAKED_FLATTEN_ON=on; cap via QTP_NAKED_FLATTEN_OVERSHOOT_PCT, default 0.5%).
 */
function nakedFlattenDecision({ isLong, missStop, current, flagOn, capPct = 0.5 }) {
  const overshootPct = missStop > 0 ? (isLong ? (missStop - current) / missStop : (current - missStop) / missStop) : 0;
  const doFlatten = !!flagOn && overshootPct > (capPct / 100);
  return { doFlatten, overshootPct: Math.round(overshootPct * 10000) / 100, orderType: doFlatten ? 'market' : 'stop' };
}

module.exports = { bracketStopLoss, fillsOnTrigger, recoveryStop, nakedFlattenDecision };
