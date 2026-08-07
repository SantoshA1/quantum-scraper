'use strict';
/**
 * GATE_K_v2.8_R2_DIRECTION_SCOPED_20260807 — spec-mirror of public.compute_kelly_gate's
 * decision ladder as ruled by the Conclave on 2026-08-07 (R3 -> R1 -> R2).
 *
 * WHY THIS EXISTS. Gate-K halted ALL production trading with negative_measured_edge after
 * gov 193 booked four hidden closed trades and pushed the certified sample 38 -> 42, past
 * p_min_trades=40. The halt was self-locking: it blocked the very trades that would clear it.
 *
 * The Conclave's finding: the halt's SIGN was right, its PERMANENCE and CONFIDENCE were the
 * defect — and the real flaw was that Gate-K measured edge BLIND TO DIRECTION, so 25
 * catastrophic shorts vetoed 17 decent longs.
 *
 *   LONGS  n=17 wr 29.4% dollar PF 1.474  +$693.92   bootstrap P(PF>1) 70.9%
 *   SHORTS n=25 wr  8.0% dollar PF 0.280  -$2,279.73 bootstrap P(PF>1)  3.6%
 *
 * THE THREE CHANGES (dependency-ordered; R2 may not exist without R1):
 *   R3  provenance-clean the sample: drop 'RECERT_QUARANTINE%' lineage, bound the window on
 *       ENTRY as well as exit, quarantine rows with no reconstructable risk basis. Adds
 *       dollar PF, which is immune to the 170x risk-basis spread ($3.60 -> $623) that makes
 *       averaged R multiples meaningless. Ships FIRST and makes the number WORSE
 *       (kelly* -0.1102 -> -0.5072), which is what proves it is not self-serving.
 *   R1  escalate the ALREADY-RATIFIED v2.4 short rule from risk x0.5 to a BLOCK. Same
 *       thresholds (n>=20 AND certified dollar PF > 1.0), same release condition.
 *   R2  scope the edge measurement to direction at the ratified n>=20 bar.
 *
 * THE FAILURE MODE THIS FILE EXISTS TO PIN (Conclave: "the single most dangerous"):
 * direction-scoping ALONE sends both sides to probation (both n<40) and silently reopens the
 * short book. Sealed three independent ways — threshold 20 not 40; an explicit
 * short_side_probation_forbidden guard; and R1's rule-level block firing earlier and
 * independently. All three are asserted in tests/test-gatek-conclave.js.
 *
 * Live pins at time of writing (verified by calling the real function):
 *   LONG  -> approved true, probation_sizing_insufficient_sample, risk_pct 0.50, n=16, PF 1.4655
 *   SHORT -> approved false, short_side_blocked_pf_below_bar, n=24, PF 0.0101
 */

const GATE_VERSION = 'GATE_K_v2.8_R2_DIRECTION_SCOPED_20260807';
const SAMPLE_VERSION = 'R3_PROVENANCE_CLEANED_20260807';
const RATIFIED_DIRECTION_MIN_TRADES = 20;   // v2.4 bar, NOT a number invented in this ruling
const SHORT_PF_BAR = 1.0;

/** R3: the provenance filter. Never filters on outcome. */
function r3Keep(row) {
  if (row.r_multiple == null) return false;
  if (!row.exit_fill_time || !row.entry_fill_time) return false;
  if (row.days_since_exit > 90 || row.days_since_entry > 90) return false;
  if (String(row.lineage_source || '').startsWith('RECERT_QUARANTINE')) return false;   // (1)
  if (row.risk_amount == null || row.risk_amount <= 0) return false;                    // (3)
  if (row.intended_stop == null || row.entry_fill_price == null) return false;          // (3)
  return true;
}

const directionOf = (side) =>
  ['buy', 'buy_call', 'sell_put'].includes(side) ? 'bullish'
  : ['sell', 'sell_call', 'buy_put'].includes(side) ? 'bearish' : null;

/** Aggregate a sample the way the gate does, including dollar PF (the release metric). */
function measure(rows) {
  const n = rows.length;
  const wins = rows.filter((r) => r.net_pnl > 0).length;
  const pos = rows.filter((r) => r.r_multiple > 0).map((r) => r.r_multiple);
  const neg = rows.filter((r) => r.r_multiple <= 0).map((r) => r.r_multiple);
  const b = pos.length ? pos.reduce((s, v) => s + v, 0) / pos.length : null;
  const a = neg.length ? Math.abs(neg.reduce((s, v) => s + v, 0) / neg.length) : null;
  const gw = rows.filter((r) => r.net_pnl > 0).reduce((s, r) => s + r.net_pnl, 0);
  const gl = Math.abs(rows.filter((r) => r.net_pnl <= 0).reduce((s, r) => s + r.net_pnl, 0));
  const dollarPf = gl > 0 ? gw / gl : (gw > 0 ? 999.9999 : null);
  const kelly = (a > 0 && b > 0 && n > 0) ? (wins / n) / a - (1 - wins / n) / b : null;
  return { n, wins, b, a, gw, gl, dollarPf, kelly };
}

/**
 * The post-Conclave decision ladder, from the short-side block onward. Earlier legs
 * (input guards, stop side, stop width, cooldown, regime) are unchanged by this ruling
 * and are deliberately NOT re-implemented here — this mirror covers exactly what changed.
 *
 * @param ledger  rows for this user/strategy/mode (raw; R3 filtering applied inside)
 * @param cfg     {shortBlockActive, directionScopedActive, directionMinTrades} — each may be
 *                undefined to simulate a missing/unreadable gate_config row (fail-closed).
 */
function gateDecision({ side, ledger, cfg = {}, probationRiskPct = 0.5, gate1Cap = 1.0, kellyFraction = 0.25 }) {
  const dir = directionOf(side);
  const clean = (ledger || []).filter(r3Keep);

  // ── fail-closed config resolution: a missing row reads as ACTIVE, never as off ──
  const shortBlockOn = (cfg.shortBlockActive === undefined ? 1 : cfg.shortBlockActive) === 1;
  const dirScoped = (cfg.directionScopedActive === undefined ? 1 : cfg.directionScopedActive) === 1;
  const dirMin = cfg.directionMinTrades === undefined ? RATIFIED_DIRECTION_MIN_TRADES : cfg.directionMinTrades;

  // ── R1: short-side block, before any edge measurement ──
  let shortRec = null;
  if (dir === 'bearish') {
    const shorts = clean.filter((r) => directionOf(r.side) === 'bearish' &&
      (String(r.lineage_source || '').startsWith('H4_') || String(r.lineage_source || '').startsWith('RECERT_')));
    const s = measure(shorts);
    shortRec = { n_certified: s.n, dollar_pf: s.dollarPf, meets_sample_bar: s.n >= RATIFIED_DIRECTION_MIN_TRADES,
                 meets_pf_bar: s.dollarPf != null && s.dollarPf > SHORT_PF_BAR };
    const passes = shortRec.meets_sample_bar && shortRec.meets_pf_bar;
    if (shortBlockOn && !passes) {
      return { approved: false, reason: 'short_side_blocked_pf_below_bar', risk_pct: 0,
               direction: dir, short_side_record: shortRec, gate_version: GATE_VERSION };
    }
  }

  // ── R2: direction-scoped edge measurement ──
  const scoped = (dirScoped && dir) ? clean.filter((r) => directionOf(r.side) === dir) : clean;
  const sampleScope = (dirScoped && dir) ? `direction:${dir}` : 'pooled';
  const minTrades = (dirScoped && dir) ? dirMin : 40;
  const m = measure(scoped);

  let probation = false, riskPct, kelly = null;
  const degraded = [];

  if (m.n < minTrades) {
    probation = true;
    riskPct = Math.min(probationRiskPct, gate1Cap);
  } else if (m.dollarPf == null || m.dollarPf <= 1.0) {
    return { approved: false, reason: 'negative_measured_edge', risk_pct: 0, direction: dir,
             metrics: { n_trades: m.n, dollar_pf: m.dollarPf, kelly_star: m.kelly,
                        sample_scope: sampleScope, min_trades: minTrades, sample_version: SAMPLE_VERSION },
             gate_version: GATE_VERSION };
  } else if (m.a == null || m.b == null || m.a <= 0 || m.b <= 0) {
    probation = true;
    riskPct = Math.min(probationRiskPct, gate1Cap);
  } else {
    kelly = m.kelly;
    if (kelly <= 0) {
      // dollar PF clears but distorted-R kelly does not -> trade SMALL, never size on kelly
      probation = true;
      riskPct = Math.min(probationRiskPct, gate1Cap);
      degraded.push('dollar_pf_positive_but_kelly_negative_probation_sized');
    } else {
      riskPct = Math.min(kellyFraction * kelly * 100, gate1Cap);
    }
  }

  // ── THE SEAL: a bearish direction may NEVER resume via probation sizing ──
  if (dir === 'bearish' && probation) {
    return { approved: false, reason: 'short_side_probation_forbidden', risk_pct: 0, direction: dir,
             metrics: { n_trades: m.n, dollar_pf: m.dollarPf, sample_scope: sampleScope, min_trades: minTrades },
             gate_version: GATE_VERSION };
  }

  return { approved: true,
           reason: probation ? 'probation_sizing_insufficient_sample' : 'fractional_kelly',
           risk_pct: riskPct, probation, direction: dir,
           degraded: degraded.length ? degraded : null,
           metrics: { n_trades: m.n, wins: m.wins, dollar_pf: m.dollarPf, kelly_star: kelly,
                      avg_win_r: m.b, avg_loss_r: m.a, gross_win: m.gw, gross_loss: m.gl,
                      sample_scope: sampleScope, min_trades: minTrades, sample_version: SAMPLE_VERSION },
           short_side_record: shortRec, gate_version: GATE_VERSION };
}

module.exports = {
  GATE_VERSION, SAMPLE_VERSION, RATIFIED_DIRECTION_MIN_TRADES, SHORT_PF_BAR,
  r3Keep, directionOf, measure, gateDecision,
};
