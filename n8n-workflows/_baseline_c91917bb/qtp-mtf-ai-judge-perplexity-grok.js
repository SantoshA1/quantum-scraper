// QTP MTF AI Judge v5.10 (2026-06-01)
// Deterministic Grok/Perplexity-compatible confluence judge.
// This node creates the final AI-style verdict without broker/order side effects.
//
// v5.10 changes vs v5.9 (Council P0.2 mandate, observability-only):
//   - Track each penalty as a structured object (reason + magnitude)
//   - Emit ai_mtf_pre_penalty_score (starting deterministic score)
//   - Emit ai_mtf_penalty_total (sum of all deductions)
//   - Emit ai_mtf_dominant_veto (largest single penalty that pushed score)
//   - Emit ai_mtf_penalty_breakdown (array of {reason, magnitude})
// NO threshold changes. NO scoring logic changes. NO direction-bias corrections.
// Preserves exact behavior of v5.9. Backward-compatible: ai_mtf_conflicts
// (legacy string array) is still emitted.

const inputItems = (typeof items !== 'undefined') ? items : $input.all();

function num(v, d = 0) {
  const n = Number(String(v ?? '').replace('%', '').trim());
  return Number.isFinite(n) ? n : d;
}
function upper(v) { return String(v ?? '').trim().toUpperCase(); }
function hasAny(text, terms) {
  const s = upper(text);
  return terms.some(t => s.includes(t));
}
function isBuy(side) { return ['BUY','LONG','BULLISH'].includes(upper(side)); }
function isSell(side) { return ['SELL','SHORT','BEARISH'].includes(upper(side)); }

return inputItems.map(item => {
  const j = { ...(item.json || {}) };
  const side = j.side || j.action || j.execution || j.signal;
  const conflicts = [];        // legacy string array (preserved for backward compat)
  const penalties = [];        // v5.10: structured {reason, magnitude}
  const aiAction = upper(j.ai_action ?? j.grok_action ?? j.pplx_action);
  const aiVerdict = upper(j.ai_verdict ?? j.grok_verdict ?? j.pplx_verdict);
  const aiConfidence = num(j.ai_confidence ?? j.grok_confidence ?? j.pplx_confidence, 0);
  const options = upper(j.options_regime ?? j.options_flow_regime ?? j.options_signal);
  const darkPool = upper(j.dark_pool_regime ?? j.darkpool_regime ?? j.dark_pool);
  const crossAsset = upper(j.cross_asset ?? j.cross_asset_regime);
  const sample = num(j.strat_total_trades ?? j.backtest_sample ?? j.backtest_trades, 0);
  const pf = num(j.strat_profit_factor ?? j.backtest_pf ?? j.profit_factor, 0);
  const deterministicScore = num(j.mtf_confluence_score, 0);
  let aiScore = deterministicScore;

  // v5.10: helper to apply a penalty AND record it structurally
  const penalize = (reason, magnitude) => {
    conflicts.push(reason);
    penalties.push({ reason, magnitude });
    aiScore -= magnitude;
  };

  if (sample < 30) {
    penalize('tiny backtest sample', 30);
  }
  // QTP_MTF_AI_JUDGE_v5.11_PF_ADVISORY_20260707: pf<1.2 penalty is now ADVISORY-ONLY.
  // Phase-0 reject-backtest (2026-07-02) found the PF threshold anti-predictive; the -20
  // deduction was the dominant SELL killer. Recorded for observability, NOT scored.
  const pfAdvisory = pf < 1.2;
  if (pfAdvisory) {
    penalize('profit factor below threshold', 20);
  }
  if (['WEAK','UNCONFIRMED','LOW CONV','LOW-CONVICTION'].some(x => aiVerdict.includes(x))) {
    penalize(`weak AI verdict: ${aiVerdict || 'UNKNOWN'}`, 10);
  }
  if (['MONITOR','HOLD','WAIT','STAND ASIDE'].includes(aiAction)) {
    penalize(`non-action AI action: ${aiAction}`, 10);
  }
  if (aiConfidence > 0 && aiConfidence < 60) {
    penalize(`AI confidence below 60: ${aiConfidence}`, 8);
  }
  if (isBuy(side) && hasAny(options, ['CONTRARIAN_SHORT','GAMMA_SQUEEZE_DOWN','BEARISH','PUT_HEAVY'])) {
    penalize(`options oppose BUY: ${options}`, 14);
  }
  if (isSell(side) && hasAny(options, ['CONTRARIAN_LONG','GAMMA_SQUEEZE_UP','BULLISH','CALL_HEAVY'])) {
    penalize(`options oppose SELL: ${options}`, 14);
  }
  if (isBuy(side) && hasAny(darkPool, ['DISTRIBUTION','BEARISH','EXTREME_SHORT'])) {
    penalize(`dark pool opposes BUY: ${darkPool}`, 14);
  }
  if (isSell(side) && hasAny(darkPool, ['ACCUMULATION','BULLISH','LOW_SHORT'])) {
    penalize(`dark pool opposes SELL: ${darkPool}`, 14);
  }
  if (hasAny(crossAsset, ['MIXED','LOW','CAUTIOUS','LAGGING','DIVERGENT','DECOUPLED'])) {
    penalize(`cross-asset not aligned: ${crossAsset}`, 10);
  }
  // Hard opposites zero out the score; recorded with magnitude = full deterministic score lost
  if (isBuy(side) && aiAction.includes('SELL')) {
    const lost = Math.max(0, aiScore);
    conflicts.push('hard opposite AI action');
    penalties.push({ reason: 'hard opposite AI action (BUY signal, AI says SELL)', magnitude: lost });
    aiScore = 0;
  }
  if (isSell(side) && aiAction.includes('BUY')) {
    const lost = Math.max(0, aiScore);
    conflicts.push('hard opposite AI action');
    penalties.push({ reason: 'hard opposite AI action (SELL signal, AI says BUY)', magnitude: lost });
    aiScore = 0;
  }

  aiScore = Math.max(0, Math.min(100, Math.round(aiScore * 100) / 100));

  // v5.10: derive observability metadata BEFORE writing to payload
  const penaltyTotal = penalties.reduce((a, p) => a + p.magnitude, 0);
  const dominantVeto = penalties.length === 0
    ? null
    : penalties.reduce((best, p) => p.magnitude > best.magnitude ? p : best, penalties[0]);

  // Standard v5.9 fields (unchanged behavior)
  j.ai_mtf_confluence_score = aiScore;
  // QTP_MTF_AI_THRESHOLD_PARITY_v6.5_20260522: AI Judge internal threshold
  // lowered from 65 -> 60 to match P12 deterministic + merge thresholds.
  // Hard-opposite zero-out logic is preserved. Does not affect penalty stack.
  j.ai_mtf_decision = aiScore >= 60 && conflicts.filter(c => c.includes('hard opposite')).length === 0 ? 'PASS' : 'BLOCK';
  j.ai_mtf_reason = j.ai_mtf_decision === 'PASS'
    ? 'multi-timeframe deterministic score and AI-style conflict checks passed'
    : `blocked by MTF deterministic conflict judge (no LLM ran): ${conflicts.join('; ') || 'score below threshold'}`;
  j.ai_mtf_conflicts = conflicts;
  j.ai_mtf_required_profile = j.timeframe_profile || 'SCALP';

  // v5.10 NEW observability fields
  j.ai_mtf_pre_penalty_score = deterministicScore;
  j.ai_mtf_penalty_total = penaltyTotal;
  j.ai_mtf_penalty_breakdown = penalties;
  j.ai_mtf_dominant_veto = dominantVeto;  // {reason, magnitude} or null if no penalties fired
  j.ai_mtf_dominant_veto_reason = dominantVeto ? dominantVeto.reason : null;
  j.ai_mtf_dominant_veto_magnitude = dominantVeto ? dominantVeto.magnitude : 0;
  j.ai_mtf_pf_advisory = pfAdvisory;
  j.ai_mtf_pf_advisory_value = pf;

  j.mtf_ai_judge_v = 'QTP_MTF_AI_JUDGE_v5.12_PF_REVERT_20260708';
  return { json: j };
});