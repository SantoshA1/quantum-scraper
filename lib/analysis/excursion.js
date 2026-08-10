'use strict';
/**
 * Spec-mirror for the excursion counterfactual (2026-08-10).
 *
 * This computes the two numbers the stop-width Conclave brief was missing, and it is worth
 * being explicit that ONE OF THEM IS A COUNTERFACTUAL — a claim about a thing that did not
 * happen. The live 1.2% entry stop did not exist for any of the 41 closed trades. Asking
 * "would it have fired" is answering a question the data cannot answer directly, so the
 * arithmetic has to be unusually careful about which way it errs.
 *
 * ── Q1: does the trail ever engage? ─────────────────────────────────────────
 * The TSM advances to tier 1 at `max(1.5 x dailyATR14 / entry, T1_FLOOR_PCT)`. Compare that
 * against maximum favourable excursion. If MFE rarely reaches T1, the trailing manager is
 * mostly decorative and the strategy's exits are really the stop and the take-profit.
 *
 * ── Q2: how many winners does the tight stop kill? ──────────────────────────
 * For a trade that ENDED PROFITABLE, if maximum adverse excursion reached 1.2% at any point
 * before the real exit, then under the live configuration that trade would have been stopped
 * out and booked as a loss instead. This is the decisive number, because for LOSERS the tight
 * stop is roughly neutral: sizing is risk-based, so a 2.69x tighter stop is a 2.69x larger
 * position and the dollar loss per stop-out is unchanged. The asymmetry lives entirely in
 * what it does to the winners.
 *
 * ── Bias, stated up front ───────────────────────────────────────────────────
 * Bars are taken from the entry timestamp forward, EXCLUDING the partial bar containing the
 * fill. That understates both excursions. It therefore UNDERCOUNTS killed winners — it biases
 * against the hypothesis this analysis exists to test. Deliberate: a number used to argue for
 * loosening a risk control should err toward not arguing for it.
 *
 * Pure functions. No I/O. The n8n probe
 * docs/execution-fix-20260810/probe-excursion-counterfactual.js runs exactly this logic
 * against live bars; tests/test-excursion-counterfactual.js pins it.
 */

const CLAMP_PCT = 1.2;      // the live entry stop, as % of entry
const T1_FLOOR_PCT = 0.7;   // QTP_TSM_T1_FLOOR_PCT default
const T1_ATR_MULT = 1.5;    // TSM tier-1 advance = 1.5 x ATR

const r3 = (n) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 1000) / 1000);
const isLongSide = (side) => side === 'buy' || side === 'buy_call' || side === 'sell_put';

/**
 * Walk the bars once and return the excursions.
 * bars: [{h, l}] over the holding window, in order.
 * Returns nulls — NOT zeros — when there are no bars, because "no data" and "never moved"
 * are different facts and collapsing them would silently manufacture a "no breach".
 */
function excursions(bars, entry, side) {
  if (!Array.isArray(bars) || bars.length === 0 || !(entry > 0)) {
    return { mfe: null, mae: null, mfePct: null, maePct: null, firstBreachIdx: null, bars: 0 };
  }
  const long = isLongSide(side);
  let mfe = 0, mae = 0, firstBreachIdx = null;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const h = Number(b.h), l = Number(b.l);
    if (!Number.isFinite(h) || !Number.isFinite(l)) continue;
    const fav = long ? (h - entry) : (entry - l);   // long profits on the HIGH, short on the LOW
    const adv = long ? (entry - l) : (h - entry);   // and the reverse for adverse
    if (fav > mfe) mfe = fav;
    if (adv > mae) mae = adv;
    // FIRST breach, not the deepest — the stop fires the first time price touches it
    if (firstBreachIdx === null && (adv / entry) * 100 >= CLAMP_PCT) firstBreachIdx = i;
  }
  return { mfe, mae, mfePct: mfe / entry * 100, maePct: mae / entry * 100, firstBreachIdx, bars: bars.length };
}

/** The TSM's tier-1 trigger, as a % of entry. Null when ATR is unknown — never a fake 0.7. */
function tier1ThresholdPct(atr14, entry) {
  if (!(atr14 > 0) || !(entry > 0)) return null;
  return Math.max(T1_ATR_MULT * atr14 / entry * 100, T1_FLOOR_PCT);
}

/**
 * The full per-trade verdict.
 * trade: {sym, side, entry, R, pnl} · bars: [{h,l}] · atr14: consolidated daily ATR-14 at entry
 */
function assess(trade, bars, atr14) {
  const e = Number(trade && trade.entry);
  const ex = excursions(bars, e, trade && trade.side);
  const t1Pct = tier1ThresholdPct(atr14, e);
  const isWinner = Number(trade && trade.R) > 0;
  // Unknown stays unknown. A missing bar set must never read as "did not breach", because
  // that would quietly convert an unmeasured trade into evidence FOR the tight stop.
  const wouldFire = ex.maePct == null ? null : ex.maePct >= CLAMP_PCT;
  return {
    sym: trade && trade.sym, side: trade && trade.side, R: trade && trade.R, pnl: trade && trade.pnl,
    is_winner: isWinner,
    bars: ex.bars,
    mfe_pct: r3(ex.mfePct), mae_pct: r3(ex.maePct),
    mfe_in_ATR: atr14 > 0 && ex.mfe != null ? r3(ex.mfe / atr14) : null,
    mae_in_ATR: atr14 > 0 && ex.mae != null ? r3(ex.mae / atr14) : null,
    t1_threshold_pct: r3(t1Pct),
    reached_t1: (t1Pct != null && ex.mfePct != null) ? ex.mfePct >= t1Pct : null,
    clamped_stop_would_fire: wouldFire,
    minutes_to_first_breach: ex.firstBreachIdx,
    // The counterfactual, stated narrowly: this trade WAS profitable and the live stop would
    // have closed it at -1.2% first. It only ever downgrades a winner; it can never promote
    // a loser, because an earlier exit cannot turn a losing trade into a winning one here.
    counterfactual_killed_winner: isWinner === true && wouldFire === true,
  };
}

/** Portfolio roll-up. Trades with no bars are excluded from every rate, never counted as no. */
function summarise(assessed) {
  const ok = assessed.filter((a) => a.bars > 0);
  const W = ok.filter((a) => a.is_winner);
  const L = ok.filter((a) => !a.is_winner);
  const killed = W.filter((a) => a.counterfactual_killed_winner);
  return {
    n_assessed: assessed.length,
    n_measurable: ok.length,
    n_unmeasurable: assessed.length - ok.length,
    reached_t1: ok.filter((a) => a.reached_t1 === true).length,
    winners: W.length,
    winners_killed_by_1p2_stop: killed.length,
    killed_syms: killed.map((a) => a.sym),
    winner_pnl_at_risk: r3(killed.reduce((s, a) => s + (Number(a.pnl) || 0), 0)),
    total_winner_pnl: r3(W.reduce((s, a) => s + (Number(a.pnl) || 0), 0)),
    losers_breaching: L.filter((a) => a.clamped_stop_would_fire === true).length,
    all_breaching: ok.filter((a) => a.clamped_stop_would_fire === true).length,
  };
}

module.exports = { CLAMP_PCT, T1_FLOOR_PCT, T1_ATR_MULT, isLongSide, excursions, tier1ThresholdPct, assess, summarise };
