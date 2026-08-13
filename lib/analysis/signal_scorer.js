'use strict';
/**
 * QTP_SIGNAL_SCORER_v1_20260813 — does a QTP signal predict anything?
 *
 * WHY THIS EXISTS. For four months QTP judged itself on 46 executed trades, a sample so small
 * that the per-trade Sharpe (0.031) would need 4,206 trades — 32 years at the live rate — to
 * separate from luck. Meanwhile `quantum.strategy_signals` had been recording every signal the
 * pipeline emitted since April: 8,820 directional, priced, timestamped predictions, written
 * live, BEFORE their outcomes existed. This module scores those predictions.
 *
 * THE MEASURE. For each signal:
 *   entry     = the OPEN of the first daily bar STRICTLY AFTER signal_date
 *               (a price nobody could know when the signal was written — no look-ahead)
 *   raw_h     = close(h bars later) / entry - 1
 *   mkt_h     = the same quantity averaged over the WHOLE bar universe that entry day
 *   excess_h  = dir_sign * (raw_h - mkt_h)        dir_sign = +1 LONG, -1 SHORT
 *
 * Subtracting the universe mean is not optional. Without it a long book in a rising market
 * looks skilled; QTP's universe returned +0.0176%/day over the window, which is exactly the
 * order of magnitude of the effects being tested.
 *
 * THE STATISTIC. ~106 signals land the same morning and are heavily cross-correlated, so a
 * naive t over 8,289 rows overstates significance several-fold. `famaMacBeth` collapses each
 * day to one observation and t-tests across days (78 clusters). Both are exposed; the
 * clustered one governs. This is the difference between an honest result and a flattering one.
 *
 * CONTROLS. A measurement that cannot detect a known edge cannot be trusted to report its
 * absence. Every run carries:
 *   oracle  — direction set by the sign of the realised 1-day excess. MUST be hugely positive.
 *   random  — direction from md5(symbol+date) parity. MUST be ~0.
 * Live values: oracle +1.51%/day clustered t=26.9; random +0.004% t=0.2. The instrument works.
 *
 * Deterministic and offline. No network, no clock, no randomness.
 */

/** Sample mean; null-safe (nulls are dropped, not zeroed — a missing forward bar is not a 0% return). */
function mean(xs) {
  const v = xs.filter((x) => x != null && Number.isFinite(x));
  if (!v.length) return null;
  return v.reduce((s, x) => s + x, 0) / v.length;
}

/** Sample standard deviation (n-1). */
function sd(xs) {
  const v = xs.filter((x) => x != null && Number.isFinite(x));
  if (v.length < 2) return null;
  const m = mean(v);
  return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length - 1));
}

/**
 * Fama-MacBeth / day-clustered test: one observation per day, t across days.
 * `daily` = array of per-day means. Returns {n, mean, se, t}.
 * n is the number of DAYS, not the number of signals — that is the whole point.
 */
function famaMacBeth(daily) {
  const v = daily.filter((x) => x != null && Number.isFinite(x));
  if (v.length < 2) return { n: v.length, mean: null, se: null, t: null };
  const m = mean(v), s = sd(v);
  const se = s / Math.sqrt(v.length);
  return { n: v.length, mean: m, se, t: se > 0 ? m / se : null };
}

/**
 * Naive pooled test, for contrast only. `perSignal` = every signal's excess return.
 * Reported so the inflation from ignoring day-clustering is visible rather than hidden.
 */
function pooled(perSignal) {
  const v = perSignal.filter((x) => x != null && Number.isFinite(x));
  if (v.length < 2) return { n: v.length, mean: null, se: null, t: null };
  const m = mean(v), s = sd(v);
  const se = s / Math.sqrt(v.length);
  return { n: v.length, mean: m, se, t: se > 0 ? m / se : null };
}

/**
 * Score a day-level series. `rows` = [entry_d, n, e1, e3, e5, oracle1, rand1].
 * Returns the clustered result per horizon plus both controls.
 */
function scoreDaily(rows) {
  const col = (i) => rows.map((r) => r[i]);
  return {
    days: rows.length,
    signals: rows.reduce((s, r) => s + r[1], 0),
    h1: famaMacBeth(col(2)),
    h3: famaMacBeth(col(3)),
    h5: famaMacBeth(col(4)),
    control_oracle: famaMacBeth(col(5)),
    control_random: famaMacBeth(col(6)),
  };
}

/**
 * The precommitted verdict (roadmap 2026-08-13, fixed BEFORE any number was computed).
 * `slices` = [{name, t1, t3, t5}] of CLUSTERED t-stats. `nTests` = how many were examined,
 * so a lucky single t cannot be cherry-picked out of a family of tests.
 */
function verdict(slices, nTests) {
  const BAR = 2.0;
  // Bonferroni-style family correction: with k tests the 5% two-sided bar rises.
  const adjusted = nTests > 1 ? Math.max(BAR, 2.0 + 0.6 * Math.log10(nTests)) : BAR;
  const winners = [];
  for (const s of slices) {
    for (const [h, t] of [['1d', s.t1], ['3d', s.t3], ['5d', s.t5]]) {
      if (t != null && t >= adjusted) winners.push({ slice: s.name, horizon: h, t });
    }
  }
  return {
    bar: BAR,
    adjusted_bar: adjusted,
    n_tests: nTests,
    survivors: winners,
    verdict: winners.length ? 'EDGE_FOUND' : 'KILL',
  };
}

module.exports = { mean, sd, famaMacBeth, pooled, scoreDaily, verdict };
