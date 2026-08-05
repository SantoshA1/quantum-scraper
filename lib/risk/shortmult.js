'use strict';
/**
 * QTP_SHORT_RISK_MULT_v1_20260805 — spec-mirror of Gate-K v2.4's governed short-side
 * risk multiplier (Conclave ruling 2026-08-05, agenda item 2, option (i)).
 *
 * THE EVIDENCE (robust beyond the uncertified r_multiple column — dollar P&L, not R):
 *   platform-wide sells 1-for-22, PF 0.01; score-9 sells -$2,218 vs score-9 buys +$1,029;
 *   within qtp-main-pipeline's 37-trade sample: shorts 23 trades -$2,033, longs 14 +$1,010.
 *   One blended Kelly number for a strategy whose majority side is its losing side is
 *   mis-specified.
 *
 * THE RULE (deployed in compute_kelly_gate v2.4):
 *   - bearish entries carry short_risk_mult = 0.5x, applied to risk_pct AFTER probation/
 *     Kelly sizing and AFTER the drawdown de-lever, BEFORE dollars/qty.
 *     (probation: longs 0.50% -> shorts 0.25%.)
 *   - applied after K1 eligibility: K1 decides IF a bearish entry may trade at all
 *     (counter-regime block); this multiplier decides HOW MUCH when it may.
 *   - SELF-RETIRING: releases to 1.0x when the CERTIFIED rolling short-side record earns
 *     it back — PF > 1.0 over >= 20 certified-lineage closed short trades (90d window).
 *     Certified lineage = the fill-recomputed / H4-classify family, never
 *     backfill_symbol_time_v1 or null (the convicted writers).
 *   - visible in verdict JSON as short_risk_mult (+ short_side_record echo), so every
 *     halved order is attributable.
 *   - bullish entries and unknown directions are NEVER multiplied.
 *
 * Trigger calibration note (per ruling): the release threshold reads ONLY certified rows —
 * calibrating the release on the fabricated column would repeat the error being fixed.
 * Until certification produces >= 20 certified short closes, the multiplier simply stays
 * at 0.5x (n_certified < 20 -> not eligible for release).
 */

const SHORT_RISK_MULT = 0.5;
const RELEASE_MIN_TRADES = 20;
const RELEASE_MIN_PF = 1.0;
const CERTIFIED_LINEAGE_PREFIXES = ['H4_', 'RECERT_'];

function isCertifiedLineage(lineage) {
  const s = String(lineage || '');
  return CERTIFIED_LINEAGE_PREFIXES.some((p) => s.startsWith(p));
}

function direction(side) {
  const s = String(side || '').toLowerCase();
  if (['buy', 'buy_call', 'sell_put'].includes(s)) return 'bullish';
  if (['sell', 'sell_call', 'buy_put'].includes(s)) return 'bearish';
  return null;
}

/**
 * Certified short-side record from ledger rows (mirror of the live SQL).
 * rows: trade_ledger-shaped {side, status, net_pnl, lineage_source, exit_fill_time}.
 * Returns {n, grossWin, grossLoss, pf, released}.
 */
function shortSideRecord(rows, nowIso, lookbackDays) {
  const cutoff = new Date(nowIso).getTime() - (lookbackDays || 90) * 86400000;
  let n = 0, grossWin = 0, grossLoss = 0;
  for (const r of rows || []) {
    if (r.status !== 'closed') continue;
    if (direction(r.side) !== 'bearish') continue;
    if (!isCertifiedLineage(r.lineage_source)) continue;
    if (!r.exit_fill_time || new Date(r.exit_fill_time).getTime() < cutoff) continue;
    n++;
    const pnl = Number(r.net_pnl) || 0;
    if (pnl > 0) grossWin += pnl; else grossLoss += Math.abs(pnl);
  }
  const pf = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);
  return { n, grossWin, grossLoss, pf, released: n >= RELEASE_MIN_TRADES && pf > RELEASE_MIN_PF };
}

/**
 * The multiplier decision. directionStr: 'bullish'|'bearish'|null.
 * record: output of shortSideRecord. Returns {mult, applied, why}.
 */
function shortRiskMult(directionStr, record) {
  if (directionStr !== 'bearish') return { mult: 1.0, applied: false, why: 'not_bearish' };
  if (record && record.released) return { mult: 1.0, applied: false, why: 'released_certified_pf' };
  return {
    mult: SHORT_RISK_MULT, applied: true,
    why: record && record.n > 0
      ? 'certified_short_pf_not_earned (' + record.n + ' certified, pf ' + (record.pf === Infinity ? 'inf' : record.pf.toFixed(2)) + ')'
      : 'no_certified_short_record',
  };
}

module.exports = { SHORT_RISK_MULT, RELEASE_MIN_TRADES, RELEASE_MIN_PF,
  CERTIFIED_LINEAGE_PREFIXES, isCertifiedLineage, direction, shortSideRecord, shortRiskMult };

/*
 * v2.4.1 DEPLOY NOTE (2026-08-05, governance 183): the first live deployment of this rule
 * (v2.4) crashed every BULLISH/unknown-direction gate call in a fresh session — the verdict
 * JSON referenced a field of a plpgsql RECORD (v_short_rec) that is only assigned on the
 * bearish path; a CASE guard does NOT protect field access on a never-assigned record.
 * Caught by the Maya live matrix probing bullish FIRST in a fresh session (the v2.4 flip
 * proof had masked it by probing bearish first, which cached the record structure for the
 * session). Fixed by always-initialized scalars (v_short_n/gw/gl := 0).
 * STANDING RULE for this mirror's live twin: the gate matrix must always open with a
 * bullish fresh-session probe, and verdict JSON must never touch optionally-assigned
 * record fields.
 */
