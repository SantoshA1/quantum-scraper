'use strict';
/**
 * QTP_VC_SCORE_SEMANTICS_v1_20260805 — spec-mirror of quantum.v_vc_score_semantics and the
 * decode rules behind the "VC inversion" investigation (2026-08-05).
 *
 * THE FINDING. The vc_live_v2 score field carries FOUR different meanings, and every
 * consumer (v_learning_summary, console bands, the planned Filter evidence run) was
 * reading them as one number:
 *
 *   STRUCTURED          v2 == legacy                the model's actual score, no transform
 *                       (bulk of all rows; 100% of executed trades; all of the Opus era
 *                        except sentinels)
 *   TEXT_CALIBRATED     v2 = clamp(1.18*legacy+.55) text-fallback extraction; the May-6
 *                       (grok era only, n=810)      calibration inflates: model-said 6.83
 *                                                   avg -> recorded 8.60 avg. A model "6"
 *                                                   records as 7.6 and PASSES the >=7 gate.
 *                                                   DEAD CODE under Opus (0 rows) but armed:
 *                                                   any non-JSON reply re-activates it.
 *   RULE_VETO_SENTINEL  v2 = 6.9 with legacy >= 7   a deterministic rule (bias<60 etc.)
 *                       (n=2,617)                   REJECTED the candidate and overwrote the
 *                                                   score with a just-below-threshold
 *                                                   sentinel. avg model_said on these: 10.0.
 *                                                   NOT a model score. The "6.9 wall".
 *   PARSE_FAIL          v2 = 0                      clampScore(non-numeric) -> 0. No score
 *                       (n=1,572, ~8%)              was ever extracted; the call was paid for
 *                                                   and the candidate silently rejected.
 *
 * THE INVERSION ITSELF: on the 35 executed VC-scored trades, score-9 BUYS are +$1,029
 * (PF 2.79) while score-9 SELLS are 0-for-12, -$2,218 (PF 0.01 side-wide). The "vc>=8
 * band loses" headline was a SIDE effect read through a band that mixed semantics.
 */

const SHADOW_A = 1.18;
const SHADOW_B = 0.55;
const VC_THRESHOLD = 7;

function clamp10(n) { return Math.max(0, Math.min(10, Number(n))); }
function r1(n) { return Math.round(Number(n) * 10) / 10; }

/** Classify one (v2, legacy) score pair. Mirrors quantum.v_vc_score_semantics. */
function classifyVcRow(v2, legacy) {
  const a = Number(v2), b = Number(legacy);
  if (!isFinite(a) || !isFinite(b)) return 'UNKNOWN';
  if (a === 0) return 'PARSE_FAIL';
  if (r1(a) === 6.9 && b >= VC_THRESHOLD) return 'RULE_VETO_SENTINEL';
  if (r1(a) === r1(b)) return 'STRUCTURED';
  if (Math.abs(a - clamp10(b * SHADOW_A + SHADOW_B)) < 0.06) return 'TEXT_CALIBRATED';
  return 'UNKNOWN';
}

/**
 * What did the MODEL actually say for this row? null when unknowable.
 * STRUCTURED -> v2 (== legacy). TEXT_CALIBRATED / RULE_VETO -> legacy. PARSE_FAIL -> null.
 */
function modelSaid(v2, legacy) {
  switch (classifyVcRow(v2, legacy)) {
    case 'STRUCTURED': return Number(v2);
    case 'TEXT_CALIBRATED': return Number(legacy);
    case 'RULE_VETO_SENTINEL': return Number(legacy);
    default: return null;
  }
}

/** Rows a score-band analysis may use. Sentinels and failures are NOT scores. */
function usableForScoreAnalytics(v2, legacy) {
  const c = classifyVcRow(v2, legacy);
  return c === 'STRUCTURED' || c === 'TEXT_CALIBRATED';
}

/**
 * The calibration inflation on the text path: what the gate saw vs what the model said.
 * Returns {recorded, said, inflated} — inflated=true when the transform pushed a sub-bar
 * score over the >=7 gate.
 */
function textPathEffect(rawModelScore) {
  const said = clamp10(rawModelScore);
  const recorded = r1(clamp10(said * SHADOW_A + SHADOW_B));
  return { said, recorded, inflated: said < VC_THRESHOLD && recorded >= VC_THRESHOLD };
}

/** Side x band aggregation used by v_learning_summary_v2 (pure mirror for the suite). */
function sideBandSummary(trades) {
  const key = (t) => {
    const b = t.vc_score >= 9 ? 'vc_9plus' : t.vc_score >= 8 ? 'vc_8' : t.vc_score >= 7 ? 'vc_7' : 'vc_lt7';
    return t.side + '|' + b;
  };
  const out = {};
  for (const t of trades || []) {
    const k = key(t);
    const o = (out[k] = out[k] || { n: 0, wins: 0, net: 0, grossWin: 0, grossLoss: 0 });
    o.n++; if (t.win) { o.wins++; o.grossWin += t.net_pnl; } else { o.grossLoss += Math.abs(t.net_pnl); }
    o.net += t.net_pnl;
  }
  for (const k of Object.keys(out)) {
    const o = out[k];
    o.pf = o.grossLoss > 0 ? Math.round((o.grossWin / o.grossLoss) * 100) / 100 : null;
  }
  return out;
}

module.exports = { SHADOW_A, SHADOW_B, VC_THRESHOLD, classifyVcRow, modelSaid, usableForScoreAnalytics, textPathEffect, sideBandSummary };
