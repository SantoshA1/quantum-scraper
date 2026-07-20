// QTP_MTF_SHADOW_v1.1_20260601
// QTP_MTF_SHADOW_LT_VALUE_POSTHOC_SWEEP_v1_20260601
// Sibling node: writes a candidate MTF score (0.65·scalp + 0.35·swing) plus a
// LT-veto check alongside the legacy MTF decision. Pure observability — does
// NOT alter routing, scoring, broker behavior, or any downstream field.
//
// v1.1 changes (council mandate 2026-05-31, see qtp_reject_backtest_prereg v1.4-REVERTED):
// - Capture raw pre-threshold long_term tier score as shadow_lt_value (numeric|null)
//   to enable post-hoc 30/70 threshold sweeps without re-instrumenting.
// - LT veto and shadow_lt_value share _ltRaw — single source, cannot disagree.
// - Catch-path also writes shadow_lt_value: null. NULL distinguishes uncomputed
//   from genuine zero-signal.
//
// Output (appended to item.json, never replaces existing fields):
//   shadow_mtf_score        numeric|null      candidate score (0.65·scalp + 0.35·swing)
//   shadow_mtf_decision     string            SHADOW_PASS | SHADOW_BLOCK_SCORE | SHADOW_BLOCK_LT_VETO | SHADOW_ERROR
//   shadow_size_multiplier  numeric|null      clamp01((score - 55) / 45); logged only, never applied
//   shadow_lt_veto          boolean|null      true iff LT triggered the veto
//   shadow_lt_value         numeric|null      raw pre-threshold long_term tier score (v1.1 NEW)
//   shadow_engine_v         string            'QTP_MTF_SHADOW_v1.1_20260601'

const SHADOW_ENGINE_V = 'QTP_MTF_SHADOW_v1.1_20260601';
const SCORE_THRESHOLD = 55;
const SCALP_WEIGHT = 0.65;
const SWING_WEIGHT = 0.35;
const LT_VETO_LONG  = 30;  // LONG blocked if long_term < 30
const LT_VETO_SHORT = 70;  // SHORT blocked if long_term > 70

const results = [];

for (const item of items) {
  const d = item.json || {};
  try {
    // Parse mtf_tiers — may arrive as JSON string or object
    let tiers = d.mtf_tiers;
    if (typeof tiers === 'string') {
      try { tiers = JSON.parse(tiers); } catch (e) { tiers = {}; }
    }
    if (!tiers || typeof tiers !== 'object') tiers = {};

    // Tier scores
    const scalp  = Number(tiers && tiers.scalp     ? tiers.scalp.score     : NaN);
    const swing  = Number(tiers && tiers.swing     ? tiers.swing.score     : NaN);
    const _ltRaw = Number(tiers && tiers.long_term ? tiers.long_term.score : NaN);

    // v1.1: raw LT capture for post-hoc threshold sweeps.
    // Pre-threshold, NOT veto-clamped. Single source with the veto comparison below.
    const shadow_lt_value = Number.isFinite(_ltRaw) ? _ltRaw : null;

    // Side normalization
    const sideRaw = String(d.side || d.execution || d.signal || d.action || d.direction || '').toUpperCase();
    const isLong  = ['BUY', 'BULLISH', 'LONG'].indexOf(sideRaw) !== -1;
    const isShort = ['SELL', 'BEARISH', 'SHORT'].indexOf(sideRaw) !== -1;

    // Weighted score — requires both scalp + swing finite
    const haveScores = Number.isFinite(scalp) && Number.isFinite(swing);
    const shadow_mtf_score = haveScores ? (SCALP_WEIGHT * scalp + SWING_WEIGHT * swing) : null;

    // LT veto — shares _ltRaw with shadow_lt_value
    let shadow_lt_veto = false;
    if (Number.isFinite(_ltRaw)) {
      if (isLong  && _ltRaw < LT_VETO_LONG)  shadow_lt_veto = true;
      if (isShort && _ltRaw > LT_VETO_SHORT) shadow_lt_veto = true;
    }

    // Decision
    let shadow_mtf_decision;
    if (!haveScores) {
      shadow_mtf_decision = 'SHADOW_ERROR';
    } else if (shadow_lt_veto) {
      shadow_mtf_decision = 'SHADOW_BLOCK_LT_VETO';
    } else if (shadow_mtf_score >= SCORE_THRESHOLD) {
      shadow_mtf_decision = 'SHADOW_PASS';
    } else {
      shadow_mtf_decision = 'SHADOW_BLOCK_SCORE';
    }

    // Size multiplier — logged only, never applied
    let shadow_size_multiplier;
    if (!Number.isFinite(shadow_mtf_score)) {
      shadow_size_multiplier = null;
    } else {
      const raw = (shadow_mtf_score - SCORE_THRESHOLD) / 45;
      shadow_size_multiplier = Math.max(0, Math.min(1, raw));
    }

    // Append shadow fields. Never replace existing payload.
    results.push({
      json: Object.assign({}, d, {
        shadow_mtf_score: shadow_mtf_score,
        shadow_mtf_decision: shadow_mtf_decision,
        shadow_size_multiplier: shadow_size_multiplier,
        shadow_lt_veto: shadow_lt_veto,
        shadow_lt_value: shadow_lt_value,
        shadow_engine_v: SHADOW_ENGINE_V,
      }),
    });
  } catch (err) {
    // Pass-through on error — write SHADOW_ERROR sentinel, never break pipeline.
    // v1.1: catch path also writes shadow_lt_value: null.
    results.push({
      json: Object.assign({}, d, {
        shadow_mtf_score: null,
        shadow_mtf_decision: 'SHADOW_ERROR',
        shadow_size_multiplier: null,
        shadow_lt_veto: null,
        shadow_lt_value: null,
        shadow_engine_v: SHADOW_ENGINE_V,
        _shadow_engine_error: String((err && err.message) || err).slice(0, 240),
      }),
    });
  }
}

return results;

