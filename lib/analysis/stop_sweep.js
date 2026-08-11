'use strict';
/**
 * Spec-mirror for the S1 stop-width replay (Conclave ruling 2026-08-11).
 *
 * The ruling asks for realized frozen-dollar-R expectancy, stop-out rate and TSM-harvest
 * survival at 0.41 ATR vs 1.13 ATR vs a candidate ATR-relative floor. This is the arithmetic.
 *
 * ── The model, and why it is exact in one direction only ────────────────────
 * Gate-K sizes by risk: `qty = riskDollars / (W × entry)` where W is the stop width. So for a
 * price move of m (as a fraction of entry):
 *
 *     P&L = m × entry × qty = m × entry × riskDollars/(W × entry) = (m/W) × riskDollars
 *     ⇒  **R = m / W**,  and a stop-out is exactly **R = −1**, at any width.
 *
 * That is the whole model. It needs only the maximum adverse excursion (does the stop fire?)
 * and the realized signed move (if it doesn't). Both are measured from 1-minute bars.
 *
 * **TIGHTENING is exactly replayable. WIDENING is not.** The minute-bar path is observed only
 * up to each trade's ACTUAL exit. For a width tighter than the stop that actually protected the
 * trade, everything needed is inside that window. For a width WIDER than the actual stop, the
 * trade would not have exited when it did, and what happened afterwards is outside the observed
 * path — replaying it would require inventing an exit rule that never ran. Any width above a
 * trade's actual stop is therefore reported as NOT REPLAYABLE rather than estimated.
 *
 * Conveniently the live configuration (1.2%) is tighter than every actual stop in the sample
 * (tightest was 1.70%), so the question the Conclave actually asked is exactly answerable.
 *
 * ── Frozen dollar-R ────────────────────────────────────────────────────────
 * R is normalised by a FIXED dollar risk unit, not by each trade's own `risk_amount`. The
 * ledger's per-trade risk basis spans 170× across this sample, which makes a naive average of
 * R meaningless. Freezing the unit is what makes expectancy comparable across widths — and it
 * is also why the sweep does NOT read `r_multiple`, which is corrupted on 30 of 42 rows
 * (governance 206).
 */

/** Signed realized move as a fraction of entry: positive = in the trade's favour. */
function realizedMove(trade) {
  const long = trade.side === 'buy' || trade.side === 'buy_call' || trade.side === 'sell_put';
  const e = Number(trade.entry), x = Number(trade.exit);
  if (!(e > 0) || !Number.isFinite(x)) return null;
  return (long ? (x - e) : (e - x)) / e;
}

/**
 * Replay one trade at stop width W (a fraction of entry, e.g. 0.012).
 * actualStopPct is the width that really protected it — beyond that we are blind.
 */
function replayTrade(trade, W, actualStopPct, overshoot = 1.0) {
  const maePct = Number(trade.mae_pct);
  if (!(W > 0) || !Number.isFinite(maePct)) return { outcome: 'UNKNOWN', R: null, replayable: false };
  // Widths above the stop that actually protected the trade need price action beyond the
  // observed window. Refuse rather than guess.
  if (actualStopPct != null && W > actualStopPct / 100 + 1e-12) {
    return { outcome: 'NOT_REPLAYABLE', R: null, replayable: false };
  }
  // STOP-OUT COST. The naive model says a stop-out is exactly -1R. The sample says otherwise:
  // the four trades that actually breached their own stop lost 1.351R, 1.579R, 1.697R and
  // 2.040R — a mean overshoot of 1.67x — because stops gap and slip rather than filling at
  // the stop price.
  // This matters asymmetrically and in a direction that is easy to get wrong: at a TIGHTER
  // stop the position is 2.69x larger, so the same dollar gap-through costs 2.69x more R. A
  // flat -1R therefore FLATTERS tight stops. `overshoot` is exposed so the sweep can be run
  // as a sensitivity rather than pretending one number is known.
  if (maePct / 100 >= W) return { outcome: 'STOPPED', R: -1 * overshoot, replayable: true };
  const m = realizedMove(trade);
  if (m == null) return { outcome: 'UNKNOWN', R: null, replayable: false };
  return { outcome: m > 0 ? 'WIN' : 'LOSS', R: m / W, replayable: true };
}

/** Would the trade still have reached the TSM's tier-1 trail before being stopped at W? */
function harvestSurvives(trade, W) {
  const maePct = Number(trade.mae_pct), mfePct = Number(trade.mfe_pct), t1 = Number(trade.t1_pct);
  if (!Number.isFinite(maePct) || !Number.isFinite(mfePct) || !Number.isFinite(t1)) return null;
  if (maePct / 100 >= W) return false;          // stopped out first
  return mfePct >= t1;                           // and did it get far enough to trail
}

/** Sweep one width across the whole sample. */
function sweepWidth(trades, W, opts = {}) {
  const rows = trades.map((t) => {
    const actual = opts.actualStopPct ? opts.actualStopPct(t) : null;
    const r = replayTrade(t, W, actual, opts.overshoot);
    return { sym: t.sym, wasWinner: Number(t.R) > 0, ...r, harvest: harvestSurvives(t, W) };
  });
  const ok = rows.filter((r) => r.replayable);
  const Rs = ok.map((r) => r.R);
  const wins = ok.filter((r) => r.R > 0);
  const winnersNow = rows.filter((r) => r.wasWinner);
  return {
    width_pct: Math.round(W * 100 * 10000) / 10000,
    n_replayable: ok.length,
    n_not_replayable: rows.filter((r) => r.outcome === 'NOT_REPLAYABLE').length,
    stopped: ok.filter((r) => r.outcome === 'STOPPED').length,
    stop_out_rate_pct: ok.length ? Math.round(ok.filter((r) => r.outcome === 'STOPPED').length / ok.length * 1000) / 10 : null,
    win_rate_pct: ok.length ? Math.round(wins.length / ok.length * 1000) / 10 : null,
    total_R: Math.round(Rs.reduce((a, b) => a + b, 0) * 1000) / 1000,
    expectancy_R: ok.length ? Math.round(Rs.reduce((a, b) => a + b, 0) / ok.length * 10000) / 10000 : null,
    // the ruling's kill metric: exits at or beyond +3R in frozen dollar-R
    exits_ge_3R: ok.filter((r) => r.R >= 3).length,
    best_R: Rs.length ? Math.round(Math.max(...Rs) * 1000) / 1000 : null,
    // the decisive read: of the trades that actually won, how many does this width kill?
    original_winners: winnersNow.length,
    original_winners_stopped: winnersNow.filter((r) => r.outcome === 'STOPPED').length,
    harvest_survivors: ok.filter((r) => r.harvest === true).length,
  };
}

/** ATR-relative candidate floor: max(basePct, k × ATR14%). */
function floorWidth(trade, basePct, k) {
  const atrPct = Number(trade.atr14_pct);
  if (!Number.isFinite(atrPct)) return basePct / 100;
  return Math.max(basePct, k * atrPct) / 100;
}

/** Sweep a per-trade width function (used for the ATR floor, where W varies by trade). */
function sweepVariable(trades, widthFn, label, opts = {}) {
  const rows = trades.map((t) => {
    const W = widthFn(t);
    const actual = opts.actualStopPct ? opts.actualStopPct(t) : null;
    const r = replayTrade(t, W, actual, opts.overshoot);
    return { sym: t.sym, W, wasWinner: Number(t.R) > 0, ...r, harvest: harvestSurvives(t, W) };
  });
  const ok = rows.filter((r) => r.replayable);
  const Rs = ok.map((r) => r.R);
  const winnersNow = rows.filter((r) => r.wasWinner);
  return {
    label,
    median_width_pct: median(rows.map((r) => r.W * 100)),
    n_replayable: ok.length,
    n_not_replayable: rows.filter((r) => r.outcome === 'NOT_REPLAYABLE').length,
    stop_out_rate_pct: ok.length ? Math.round(ok.filter((r) => r.outcome === 'STOPPED').length / ok.length * 1000) / 10 : null,
    expectancy_R: ok.length ? Math.round(Rs.reduce((a, b) => a + b, 0) / ok.length * 10000) / 10000 : null,
    exits_ge_3R: ok.filter((r) => r.R >= 3).length,
    original_winners_stopped: winnersNow.filter((r) => r.outcome === 'STOPPED').length,
    harvest_survivors: ok.filter((r) => r.harvest === true).length,
  };
}

function median(a) {
  const x = a.filter(Number.isFinite).sort((p, q) => p - q), n = x.length;
  if (!n) return null;
  return Math.round((n % 2 ? x[(n - 1) / 2] : (x[n / 2 - 1] + x[n / 2]) / 2) * 10000) / 10000;
}

module.exports = { realizedMove, replayTrade, harvestSurvives, sweepWidth, sweepVariable, floorWidth, median };
