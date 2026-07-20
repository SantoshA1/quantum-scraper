// Merge Option B Flags v2.1 — wires Option B flags into the actual MTF gate decision.
//   v2.1 (2026-07-02): SCALP leg threshold 60 → SCALP_MIN 50, aligned with engine v7 retune (PO-auth).
//   (E2E sprint fc010fe2 Stage 3 enablement; supersedes v1.2 which only attached flags
//    as observability.) Backwards compatible: when flags are OFF / wrong value / not
//    paper, the original v6.2 final_mtf_confluence_decision is preserved byte-for-byte
//    (fail-closed). Original decision is always stamped to _optB_original_* for audit.
//
// Semantics (from experiment_flags notes):
//   mtf_profile_aware_composite_v1 (flag_value=ON_PAPER_PROFILE_AWARE_V1):
//     SCALP      -> scalp-tier-only PASS check (drop swing/long_term composite drag)
//     SWING      -> mean(scalp,swing) >= threshold AND neither scalp nor swing is BLOCK
//     LONG_TERM  -> unchanged (original v6.2 composite)
//   mtf_ai_advisory_paper_v1 (flag_value=ON_PAPER_ADVISORY_V1) AND paper_mode:
//     ai_mtf veto leg becomes advisory (logged in ai_mtf_advisory_engaged), NOT a hard
//     veto. Deterministic leg remains the gate.
//   Both legs fail-closed: disabled OR flag_value mismatch OR (advisory) not paper => no change.

const PROFILE_AWARE_VALUE = 'ON_PAPER_PROFILE_AWARE_V1';
const ADVISORY_VALUE = 'ON_PAPER_ADVISORY_V1';
const MTF_THRESHOLD = 60; // QTP_MTF_THRESHOLD_LOWER_v6.3_20260521 (Merge MTF AI Verdict uses 60)
const SCALP_MIN = 50; // QTP_MTF_REJECTBACKTEST_RETUNE_v7_20260702 (PO-auth): align Option B SCALP leg
                      // with engine v7 gate (scalp>=50). 28d reject-backtest: scalp tier is the only
                      // correctly-signed intraday predictor; the old scalp>=60 here re-blocked clean
                      // scalp 50-59 signals that passed the v7 engine gate (NVDA/TKO/GEV/ON 2026-07-02).

let sigItems = [];
let flagItems = [];
try { sigItems = $('QTP MTF Shadow Engine v1.1').all() || []; } catch (e) { sigItems = []; }
try { flagItems = $('QTP MTF Option B Flags').all() || []; } catch (e) { flagItems = []; }

if (!sigItems.length) {
  return [];
}

// Build flags map (fail-closed: missing = disabled)
const flagsMap = {
  mtf_profile_aware_composite_v1: { flag_value: null, enabled: false, source: 'default_missing' },
  mtf_ai_advisory_paper_v1:        { flag_value: null, enabled: false, source: 'default_missing' }
};
for (const fi of flagItems) {
  const j = fi.json || {};
  const name = j.flag_name;
  if (Object.prototype.hasOwnProperty.call(flagsMap, name)) {
    flagsMap[name] = {
      flag_value: j.flag_value != null ? j.flag_value : null,
      enabled:    j.enabled === true,
      source:     'db'
    };
  }
}

function num(v, d = 0) { const n = Number(String(v ?? '').replace('%', '').trim()); return Number.isFinite(n) ? n : d; }
function upper(v) { return String(v ?? '').trim().toUpperCase(); }

const pa = flagsMap.mtf_profile_aware_composite_v1;
const ai = flagsMap.mtf_ai_advisory_paper_v1;
const profileAwareEngaged = pa.enabled === true && upper(pa.flag_value) === PROFILE_AWARE_VALUE;
const aiAdvisoryFlagEngaged = ai.enabled === true && upper(ai.flag_value) === ADVISORY_VALUE;

return sigItems.map(si => {
  const j = { ...(si.json || {}) };

  // --- paper-mode detection (mirror of Bias Filter isPaperGated) ---
  const qtpMode = upper(j.qtp_deployment_mode);
  const qtpTradingEnv = upper(j.qtp_trading_env || j.trading_env);
  const alpacaEnv = upper(j.alpaca_env || j.alpaca_mode);
  const liveTradingAllowed = j.qtp_live_trading_allowed === true || String(j.qtp_live_trading_allowed || '').toLowerCase() === 'true';
  const isPaperGated =
    (qtpMode === 'PRODUCTION_PAPER_GATED' || qtpTradingEnv === 'PAPER' || alpacaEnv === 'PAPER') &&
    liveTradingAllowed === false;

  // --- always-attach flags map + observability ---
  j.optB_flags = flagsMap;
  j._optB_merge_ts = new Date().toISOString();
  j._optB_merge_version = 'v2.1';
  j._optB_merge_sig_count = sigItems.length;
  j._optB_merge_flag_count = flagItems.length;
  j._optB_profile_aware_engaged = profileAwareEngaged;
  j._optB_ai_advisory_flag_engaged = aiAdvisoryFlagEngaged;
  j._optB_paper_mode = isPaperGated;

  // Preserve the original v6.2 decision for audit/rollback comparison.
  const origFinalDecision = String(j.final_mtf_confluence_decision || '');
  const origFinalPass = j.final_mtf_confluence_pass === true;
  j._optB_original_final_mtf_decision = origFinalDecision || 'N/A';
  j._optB_original_final_mtf_pass = origFinalPass;

  // If neither leg engages, leave decision EXACTLY as upstream set it (fail-closed).
  const advisoryActive = aiAdvisoryFlagEngaged && isPaperGated;
  if (!profileAwareEngaged && !advisoryActive) {
    j._optB_decision_source = 'ORIGINAL_V6_2_FAILCLOSED';
    j.ai_mtf_advisory_engaged = false;
    return { json: j };
  }

  // --- recompute deterministic leg ---
  const profile = upper(j.mtf_target_profile || j.target_profile || j.profile || j.timeframe_profile || 'SCALP');
  const scalp = num(j.scalp_confluence_score);
  const swing = num(j.swing_confluence_score);
  const longTerm = num(j.long_term_confluence_score);
  const detScore = num(j.mtf_confluence_score);
  const detDecisionText = upper(j.mtf_confluence_decision);
  const origDetPass = detDecisionText === 'MTF_CONFLUENCE_PASS' && detScore >= MTF_THRESHOLD;

  let detPass = origDetPass;
  let detSource = 'ORIGINAL_COMPOSITE';
  if (profileAwareEngaged) {
    if (profile === 'SCALP') {
      // scalp-tier-only PASS: scalp tier alone must clear SCALP_MIN (v7); swing/long_term drag removed.
      detPass = scalp >= SCALP_MIN;
      detSource = 'PROFILE_AWARE_SCALP_TIER_ONLY_V7_50';
    } else if (profile === 'SWING') {
      // mean(scalp,swing) >= threshold AND no tier BLOCK on scalp/swing.
      const mean = (scalp + swing) / 2;
      const noBlock = scalp >= MTF_THRESHOLD && swing >= MTF_THRESHOLD;
      detPass = mean >= MTF_THRESHOLD && noBlock;
      detSource = 'PROFILE_AWARE_SWING_MEAN_NOBLOCK';
    } else {
      // LONG_TERM unchanged
      detPass = origDetPass;
      detSource = 'PROFILE_AWARE_LONG_TERM_UNCHANGED';
    }
  }

  // --- recompute AI leg (advisory demotion) ---
  const aiDecisionText = upper(j.ai_mtf_decision);
  const aiScore = num(j.ai_mtf_confluence_score);
  const origAiPass = aiDecisionText === 'PASS' && aiScore >= MTF_THRESHOLD;
  let aiLegGates = true;       // does AI leg still act as a hard gate?
  let aiAdvisoryEngaged = false;
  if (advisoryActive) {
    aiLegGates = false;        // AI veto demoted to advisory
    aiAdvisoryEngaged = true;
  }

  // --- final composite ---
  // Deterministic leg always gates. AI leg gates only when not demoted to advisory.
  const finalPass = aiLegGates ? (detPass && origAiPass) : detPass;

  j.ai_mtf_advisory_engaged = aiAdvisoryEngaged;
  j._optB_det_pass = detPass;
  j._optB_det_source = detSource;
  j._optB_ai_orig_pass = origAiPass;
  j._optB_ai_leg_gates = aiLegGates;
  j._optB_decision_source = 'OPTION_B_v2.1';

  j.final_mtf_confluence_pass = finalPass;
  j.final_mtf_confluence_decision = finalPass ? 'FINAL_MTF_CONFLUENCE_PASS' : 'FINAL_MTF_CONFLUENCE_BLOCK';

  // Keep blocked_stage / summary coherent with the recomputed decision.
  if (finalPass) {
    // If Option B newly passes a previously-blocked signal, clear the MTF block stamp
    // (only if it was the MTF stage that set it).
    if (upper(j.blocked_stage) === 'MTF_CONFLUENCE_BLOCK') {
      j.blocked_stage = 'NONE';
      j._optB_cleared_mtf_block = true;
    }
  } else if (!j.blocked_stage || upper(j.blocked_stage) === '' || upper(j.blocked_stage) === 'NONE') {
    j.blocked_stage = 'MTF_CONFLUENCE_BLOCK';
  }
  j.final_mtf_confluence_summary =
    `${j.final_mtf_confluence_decision} | optB=${j._optB_decision_source} | det_src=${detSource} | ` +
    `det_pass=${detPass} ai_gates=${aiLegGates} ai_orig_pass=${origAiPass} | ` +
    `profile=${profile} scalp=${scalp} swing=${swing} long_term=${longTerm} det=${detScore} ai=${aiScore} | ` +
    `was=${origFinalDecision || 'N/A'}`;

  return { json: j };
});
