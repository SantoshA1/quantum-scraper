'use strict';
/**
 * QTP gate logic — VC Score Parser (calibrated v2).
 *
 * A2 extraction (Conclave-ratified build plan, Workstream A2). Single source of
 * truth for the VC v2 scoring contract, extracted VERBATIM from the live n8n node
 * "VC Score Parser" at baseline versionId c91917bb
 * (n8n-workflows/_baseline_c91917bb/vc-score-parser.js).
 *
 * Pins the exact contract the Conclave named: SHADOW_A=1.18, SHADOW_B=0.55,
 * threshold >= 7. Pure + dependency-free so it (a) unit-tests in isolation and
 * (b) is "vendored-inline" — CI stamps this text into the n8n Code node (n8n Cloud
 * restricts external `require`, so we do NOT `require` at runtime; the node keeps
 * an inlined copy that CI verifies matches this file). Do NOT edit behavior here
 * without re-verifying against the live node + updating its inlined copy.
 */

const VC = Object.freeze({
  SHADOW_A: 1.18,          // calibration slope  (live_vc_score_v2)
  SHADOW_B: 0.55,          // calibration intercept
  VC_THRESHOLD_LOCKED: 7,  // v2 pass threshold
});

// clamp to [0,10]; non-numeric -> 0 (matches live clampScore)
function clampScore(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(10, n));
}

function round1(value) { return Math.round(Number(value) * 10) / 10; }

// score band -> verdict (matches live verdictFromScore)
function verdictFromScore(score) {
  const s = Number(score || 0);
  if (s <= 3) return 'KILL';
  if (s < 7) return 'REJECT';
  if (s < 8) return 'WEAK';
  return 'PASS';
}

/**
 * Compute the legacy + calibrated v2 score, verdict, and pass flag.
 * opts.isKill      -> hard KILL override (live v6.1 KILL-preservation guard)
 * opts.standAside  -> STAND ASIDE suppression (live Cycle-007 session filter)
 * Both are applied sequentially (standAside wins the verdict label if both set),
 * exactly as the live node orders them.
 */
function vcScoreV2(rawScore, opts) {
  opts = opts || {};
  const legacyScore = round1(clampScore(rawScore));
  const calibratedScore = round1(clampScore(legacyScore * VC.SHADOW_A + VC.SHADOW_B));
  let v2Verdict = verdictFromScore(calibratedScore);
  let v2Pass = calibratedScore >= VC.VC_THRESHOLD_LOCKED;
  if (opts.isKill) { v2Verdict = 'KILL'; v2Pass = false; }
  if (opts.standAside) { v2Verdict = 'NEUTRAL_SUPPRESSED'; v2Pass = false; }
  return { legacyScore, calibratedScore, v2Verdict, v2Pass };
}

module.exports = { VC, clampScore, round1, verdictFromScore, vcScoreV2 };
