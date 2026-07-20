// Merge MTF AI Verdict v6.0
// Finalizes deterministic + AI-style confluence verdict before Bias Filter.
// v6.0 (2026-07-02, PO-auth QTP_MTF_REJECTBACKTEST_RETUNE_v7): deterministic leg is now
// profile-aware for SCALP — honors the engine v7 gate (scalp>=50) instead of re-applying
// the blended>=60 check (swing/long tiers are wrong-signed intraday per 28d reject-backtest).
// This is the FALLBACK path; when Option B flags are engaged, Merge Option B Flags v2.1 governs.
const inputItems = (typeof items !== 'undefined') ? items : $input.all();
function num(v, d = 0) { const n = Number(String(v ?? '').replace('%', '').trim()); return Number.isFinite(n) ? n : d; }
return inputItems.map(item => {
  const j = { ...(item.json || {}) };
  // QTP_MTF_THRESHOLD_LOWER_v6.3_20260521: lowered from 65 → 60 after P12 evidence
  // Distribution showed 48 rows clustering at 60-64 (just below threshold), 0 above.
  // SCALP reweight (P8) shifted scores 5-7 points lower than v5.9; threshold update aligns.
  const _mtfProfile = String(j.mtf_target_profile || j.target_profile || j.profile || j.timeframe_profile || 'SCALP').toUpperCase();
  const _enginePass = String(j.mtf_confluence_decision || '').toUpperCase() === 'MTF_CONFLUENCE_PASS';
  const deterministicPass = _mtfProfile === 'SCALP' ? _enginePass : (_enginePass && num(j.mtf_confluence_score) >= 60);
  const aiPass = String(j.ai_mtf_decision || '').toUpperCase() === 'PASS' && num(j.ai_mtf_confluence_score) >= 60;
  
  j.final_mtf_confluence_pass = deterministicPass && aiPass;
  j.final_mtf_confluence_decision = j.final_mtf_confluence_pass ? 'FINAL_MTF_CONFLUENCE_PASS' : 'FINAL_MTF_CONFLUENCE_BLOCK';

  // === QTP_MTF_AUDIT_VISIBILITY_20260521 ===
  // When MTF blocks, tag blocked_stage so audit log shows MTF as the gate that
  // killed the signal. Without this, MTF-blocked rows look like blocked_stage=NONE,
  // hiding the real bottleneck. Preserve per-tier scores for triage.
  // SAFETY: do NOT overwrite an already-set blocked_stage (e.g., R3.2 KILL or
  // BROAD_SCANNER_BIAS_PATH must survive). Only set when no upstream gate did.
  if (!j.final_mtf_confluence_pass) {
    if (!j.blocked_stage || String(j.blocked_stage).trim() === '' || String(j.blocked_stage).toUpperCase() === 'NONE') {
      j.blocked_stage = 'MTF_CONFLUENCE_BLOCK';
    }
    j._mtf_block_reason = String(
      (Array.isArray(j.mtf_confluence_reasons) && j.mtf_confluence_reasons.length ? j.mtf_confluence_reasons.join('; ') : '') ||
      (Array.isArray(j.ai_mtf_reasons) && j.ai_mtf_reasons.length ? j.ai_mtf_reasons.join('; ') : '') ||
      `mtf_confluence_score=${num(j.mtf_confluence_score)}<65 OR ai_mtf_confluence_score=${num(j.ai_mtf_confluence_score)}<65`
    );
    // Surface per-tier scores so audit triage can see which tier failed
    j._mtf_scalp_score = num(j.scalp_confluence_score);
    j._mtf_swing_score = num(j.swing_confluence_score);
    j._mtf_long_term_score = num(j.long_term_confluence_score);
    j._mtf_deterministic_score = num(j.mtf_confluence_score);
    j._mtf_ai_score = num(j.ai_mtf_confluence_score);
    j._mtf_profile = String(j.mtf_target_profile || j.target_profile || j.profile || 'SCALP').toUpperCase();
    j._mtf_block_version = 'QTP_MTF_AUDIT_VISIBILITY_20260521';
  }
  // === END QTP_MTF_AUDIT_VISIBILITY_20260521 ===
  j.final_mtf_confluence_summary = `${j.final_mtf_confluence_decision} | deterministic=${j.mtf_confluence_score} | ai=${j.ai_mtf_confluence_score} | profile=${j.timeframe_profile} | reason=${j.ai_mtf_reason || 'N/A'}`;
  return { json: j };
});