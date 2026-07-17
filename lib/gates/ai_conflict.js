'use strict';
/**
 * QTP gate logic — AI-CONFLICT guard + bias-threshold + secondary-confirmation
 * (entry-quality composite, part 2/2).
 *
 * A2 extraction. Pulled verbatim from the live "QTP Bias Filter" node at baseline
 * versionId c91917bb (n8n-workflows/_baseline_c91917bb/qtp-bias-filter.js,
 * ~L120-160 and ~L291-352). Pure + dependency-free (n8n Cloud restricts require).
 *
 * WHAT IT IS: the entry-quality veto that reconciles the intended direction with
 * the AI's read and the price trend. Conflicts are split HARD vs SOFT:
 *   HARD  = AI is explicitly opposite, or sentiment directly contradicts. Never waived.
 *   SOFT  = AI says hold/wait, low-confidence, or weak-verdict. May be waived in
 *           paper by a strict "soft-allow" that demands high conviction elsewhere.
 * A TREND conflict (price fighting SMA50 & EMA200) is handled separately and can
 * be waived by its own paper trend-allow.
 *
 * PINS (do not regress):
 *  - BIAS_THRESHOLD = 55; the soft-allow demands a higher bias >= 60.
 *  - Paper soft-allows ALL require: isPaperGated, vcScore >= 10, backtestValid,
 *    secondaryConfirmation. VC bar reverted to >= 10 per Conclave verdict 20260708
 *    (VC9 lives in gate_config as shadow, not here).
 *  - A HARD conflict is NEVER waived: effectiveNonTrend = hard || (soft && !allow).
 *  - Final aiConflict = effectiveNonTrend || (trend && !paperTrendAllow).
 */

const BIAS = Object.freeze({
  BIAS_THRESHOLD: 55,                     // baseline entry-quality bar
  PAPER_AI_SOFT_ALLOW_BIAS_THRESHOLD: 60, // higher bar required to waive a SOFT conflict
  PAPER_OBSERVATION_THRESHOLD: 50,        // log-only observation band floor
  VC_PAPER_SECONDARY_BAR: 10,             // Conclave 20260708: reverted to >= 10
});

function biasThresholdPass(biasScore, threshold) {
  const s = Number(biasScore);
  return Number.isFinite(s) && s >= threshold;
}

// --- conflict primitives (composed from upstream booleans) ---
function hardNonTrendAiConflict({ explicitOppositeConflict, sentimentConflict } = {}) {
  return explicitOppositeConflict === true || sentimentConflict === true;
}
function softNonTrendAiConflict({ explicitHoldConflict, lowAIConfidence, weakAIVerdict } = {}) {
  return explicitHoldConflict === true || lowAIConfidence === true || weakAIVerdict === true;
}

// --- secondary confirmation (strict OR paper-relaxed) ---
function strictSecondaryConfirmation({ volume_ratio, cross_asset } = {}) {
  const v = Number(volume_ratio);
  const ca = String(cross_asset || '').toUpperCase();
  return (Number.isFinite(v) && v > 1.25) ||
    ca === 'STRONG' || ca === 'ALIGNED' ||
    ca.includes('STRONG') || ca.includes('ALIGNED') || ca.includes('CONFIRMED');
}
function paperRelaxedSecondaryVolume(volume_ratio) {
  const v = Number(volume_ratio);
  return Number.isFinite(v) && v > 0.95;
}
function paperRelaxedSecondaryCrossAsset(cross_asset) {
  const ca = String(cross_asset || '').toUpperCase();
  return ca === '' || ca === 'UNKNOWN' || ca === 'N/A' || ca === 'NEUTRAL' ||
    ca.includes('NEUTRAL') || ca.includes('ALIGNED') || ca.includes('CONFIRMED') || ca.includes('STRONG');
}
// isPaperGated && vc>=10 && bias>=55 && backtestValid && (relaxedVol || relaxedCA)
function paperSecondaryConfirmation(ctx = {}) {
  return ctx.isPaperGated === true &&
    Number(ctx.vcScore) >= BIAS.VC_PAPER_SECONDARY_BAR &&
    biasThresholdPass(ctx.bias_score, BIAS.BIAS_THRESHOLD) &&
    ctx.backtestValid === true &&
    (paperRelaxedSecondaryVolume(ctx.volume_ratio) || paperRelaxedSecondaryCrossAsset(ctx.cross_asset));
}
function secondaryConfirmation(strict, paper) {
  return strict === true || paper === true;
}

// --- paper soft-allow (waives a SOFT non-trend conflict only) ---
// Requires the higher bias bar (60), cross-asset confirmation, a live SOFT conflict,
// and NO hard conflict. A hard conflict can never reach here.
function paperSoftNonTrendAllow(ctx = {}) {
  return ctx.isPaperGated === true &&
    Number(ctx.vcScore) >= BIAS.VC_PAPER_SECONDARY_BAR &&
    biasThresholdPass(ctx.bias_score, BIAS.PAPER_AI_SOFT_ALLOW_BIAS_THRESHOLD) &&
    ctx.backtestValid === true &&
    ctx.secondaryConfirmation === true &&
    ctx.crossAssetConfirmed === true &&
    ctx.soft === true &&
    ctx.hard === false;
}
// hard is absolute; soft only survives if NOT waived.
function effectiveNonTrendAiConflict(hard, soft, paperSoftAllow) {
  return hard === true || (soft === true && paperSoftAllow !== true);
}

// --- paper trend-allow (waives a TREND conflict only) ---
// Uses the baseline bias bar (55) and demands the non-trend side already clean.
function paperSoftTrendAllow(ctx = {}) {
  return ctx.isPaperGated === true &&
    Number(ctx.vcScore) >= BIAS.VC_PAPER_SECONDARY_BAR &&
    biasThresholdPass(ctx.bias_score, BIAS.BIAS_THRESHOLD) &&
    ctx.backtestValid === true &&
    ctx.secondaryConfirmation === true &&
    ctx.trendConflict === true &&
    ctx.effectiveNonTrend === false;
}

// Final entry-quality AI conflict: effective non-trend OR an unwaived trend conflict.
function resolveAiConflict(effectiveNonTrend, trendConflict, paperTrendAllow) {
  return effectiveNonTrend === true || (trendConflict === true && paperTrendAllow !== true);
}

module.exports = {
  BIAS,
  biasThresholdPass,
  hardNonTrendAiConflict,
  softNonTrendAiConflict,
  strictSecondaryConfirmation,
  paperRelaxedSecondaryVolume,
  paperRelaxedSecondaryCrossAsset,
  paperSecondaryConfirmation,
  secondaryConfirmation,
  paperSoftNonTrendAllow,
  effectiveNonTrendAiConflict,
  paperSoftTrendAllow,
  resolveAiConflict,
};
