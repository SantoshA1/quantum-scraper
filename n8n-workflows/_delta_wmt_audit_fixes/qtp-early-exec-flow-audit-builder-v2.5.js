// QTP-AUDIT v4.2.20 + backtest health + visibility patch + shadow_lt_value (v2.2)
// Drop-in replacement for the jsCode of node "QTP Early Exec Flow Audit Builder"
// id: qtp-early-audit-bf872da2 in workflow vaqfCaELhOEWnkdo
//
// v2.3 (2026-06-01 afternoon) changes vs v2.2:
//   - Captures AI MTF Judge v5.10 instrumentation: ai_mtf_pre_penalty_score,
//     ai_mtf_penalty_total, ai_mtf_dominant_veto_reason,
//     ai_mtf_dominant_veto_magnitude, mtf_ai_judge_v
//   - Pure observability: 5 new tokens added to gateDecisionParts
//   - No INSERT column changes, no SET changes
//   - audit_builder_version bumped to v2.3_AI_JUDGE_VETO_20260601
//
// v2.2 (2026-06-01) changes vs v2.1_SHADOW:
//   - Adds shadow_lt_value capture (raw pre-threshold long_term tier score)
//   - Sibling-read sourced from QTP MTF Shadow Engine v1.1
//   - INSERT column list extended by 1 (now 23 columns)
//   - SELECT clause extended by 1 numeric-guarded line
//   - audit_builder_version bumped to v2.2_SHADOW_LT_VALUE_20260601
//
// Pattern parity preserved with existing pickFirst() chains.
// Shadow Engine node name must be exactly: "QTP MTF Shadow Engine v1.1"

const d = $json || {};
function esc(v) {
  if (v === undefined || v === null) return 'NULL';
  return "'" + String(v).replace(/'/g, "''").slice(0, 20000) + "'";
}
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : 'NULL';
}
function bool(v) {
  if (v === true) return 'TRUE';
  if (v === false) return 'FALSE';
  return 'NULL';
}
function clean(v, fallback = 'N/A') {
  if (v === undefined || v === null || v === '') return fallback;
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, 240) : fallback;
}
function upper(v, fallback = 'N/A') {
  return clean(v, fallback).toUpperCase();
}
function boolish(v) {
  if (v === true) return true;
  if (v === false) return false;
  const s = String(v ?? '').trim().toLowerCase();
  if (['true', '1', 'yes', 'pass', 'allowed', 'allow', 'go'].includes(s)) return true;
  if (['false', '0', 'no', 'block', 'blocked', 'deny', 'kill'].includes(s)) return false;
  return null;
}
function score(v) {
  const n = Number(String(v ?? '').replace('%', '').trim());
  return Number.isFinite(n) ? n : null;
}
function jsonClean(v, fallback = {}) {
  try {
    if (v === undefined || v === null || v === '') return fallback;
    if (typeof v === 'object') return v;
    return JSON.parse(String(v));
  } catch (e) {
    return fallback;
  }
}
function firstJsonFromNode(nodeName) {
  try {
    const ref = $(nodeName);
    if (ref && ref.first && ref.first().json) return ref.first().json || {};
  } catch (e) {}
  return {};
}
const pauseGuardNode = firstJsonFromNode('QTP-10FC New Entry Pause Guard');
const pauseContextNode = firstJsonFromNode('Format Supabase Pause Guard Context');
const inputFirst = (() => { try { return ($input.first() && $input.first().json) || {}; } catch (e) { return {}; } })();
function pickFirst(...vals) {
  for (const v of vals) {
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return '';
}
function auditText(v, fallback = 'N/A') {
  if (v === undefined || v === null || v === '') return fallback;
  try {
    if (Array.isArray(v)) return clean(v.map(x => String(x)).join('; '), fallback);
    if (typeof v === 'object') return clean(JSON.stringify(v), fallback);
  } catch (e) {}
  return clean(v, fallback);
}
const _pgAction = String(pickFirst(
  d._pause_guard_action, d.pause_guard_action, d.entry_pause_action, d.pause_action,
  inputFirst._pause_guard_action, inputFirst.pause_guard_action,
  pauseGuardNode._pause_guard_action, pauseGuardNode.pause_guard_action,
  pauseGuardNode.entry_pause_action, pauseGuardNode.pause_action,
  pauseContextNode._pause_guard_action, pauseContextNode.pause_guard_action
)).toUpperCase();
const _pgChecked = boolish(pickFirst(d._pause_guard_checked, inputFirst._pause_guard_checked, pauseGuardNode._pause_guard_checked));
const _pgAllowed = boolish(pickFirst(d._pause_guard_live_order_allowed, d.pause_guard_live_order_allowed, inputFirst._pause_guard_live_order_allowed, pauseGuardNode._pause_guard_live_order_allowed));
let pause_guard_decision = 'PAUSE_UNKNOWN';
let pause_status = 'UNKNOWN';
if (_pgAction === 'ALLOW_NEW_ENTRY')                   { pause_guard_decision = 'PAUSE_ALLOW';  pause_status = 'NOMINAL'; }
else if (_pgAction === 'BLOCK_NEW_ENTRY_ONLY')         { pause_guard_decision = 'PAUSE_BLOCK';  pause_status = 'PAUSED'; }
else if (_pgAction === 'BYPASS_PROTECTIVE_OR_CLOSING') { pause_guard_decision = 'PAUSE_BYPASS'; pause_status = 'BYPASS'; }
else if (_pgChecked === true && _pgAllowed === true)   { pause_guard_decision = 'PAUSE_ALLOW';  pause_status = 'NOMINAL'; }
else if (_pgChecked === true && _pgAllowed === false)  { pause_guard_decision = 'PAUSE_BLOCK';  pause_status = 'PAUSED'; }
// PUT3 (Story 1.1): no longer hardcode RISK_UNKNOWN at INSERT; leave NULL so audit_status default PENDING applies and the Late Audit Patcher fills the verdict.
const risk_gate_decision = null;
const risk_status_struct = null;
const symbol = String(d.symbol || d.ticker || d.sym || d.asset || 'UNKNOWN').toUpperCase();
const side = String(d.side || d.execution || d.signal || d.action || d.direction || 'UNKNOWN').toUpperCase();
const vcLiveLegacy = d.vc_live_legacy ?? d.live_vc_score ?? d._vc_score_legacy ?? d._vc_score ?? null;
const vcLiveV2 = d.vc_live_v2 ?? d.live_vc_score_v2 ?? d._vc_score ?? null;
const vcShadow = d.vc_shadow ?? d._vc_shadow_scanner_score ?? d.shadow_vc_score ?? null;
const vcDelta = d.vc_delta ?? d._vc_parity_delta ?? d._vc_shadow_scanner_delta ?? null;
const biasScore = score(d._bias_filter_score ?? d.bias_score ?? d.ai_super_score ?? d.composite_score ?? d.bull_score ?? d.bear_score ?? d.score);
const vcScoreForVerdict = score(vcLiveV2 ?? vcLiveLegacy ?? d._vc_score ?? d.vc_score);
const vcVerdict = upper(d.vc_verdict || d._vc_verdict || d.vc_gate_status || (vcScoreForVerdict !== null ? (vcScoreForVerdict >= 7 ? 'PASS' : (vcScoreForVerdict <= 3 ? 'KILL' : 'REJECT')) : 'UNKNOWN'));
const biasPassRaw = boolish(d._bias_filter_pass ?? d.bias_filter_pass ?? d.bias_pass);
const isEntry = ['BUY', 'SELL', 'BULLISH', 'BEARISH', 'LONG', 'SHORT'].includes(side);
const biasPass = biasPassRaw !== null ? biasPassRaw : (!isEntry || (biasScore !== null && biasScore >= 65));
const biasStatus = biasPass ? 'BIAS_PASS' : 'BIAS_BLOCK';
const pauseAction = upper(d.pause_guard_action || d._pause_guard_action || d.entry_pause_action || d.pause_action || d.new_entry_status || d.entry_pause_control, 'UNKNOWN');
const riskStatus = upper(d.risk_gate_status || d._risk_gate_status || d.risk_status || d.risk_gate_decision || d.risk_decision || d.alpaca_status, 'UNKNOWN');
const riskGateStatus = ['BLOCK','BLOCKED','NO_GO','DENY','REJECT'].some(x => riskStatus.includes(x))
    ? 'RISK_BLOCK'
    : ['ALLOW','GO','PASS','PLACED','PENDING_NEW','ACCEPTED','NEW','FILLED'].some(x => riskStatus.includes(x))
      ? 'RISK_PASS'
      : 'RISK_UNKNOWN';
let blockedStage = upper(d.blocked_stage || d._blocked_stage || d.rejection_stage || d.kill_stage, '');
if (!blockedStage) {
  if (!biasPass) blockedStage = 'BIAS_FILTER';
  else if (riskGateStatus === 'RISK_BLOCK') blockedStage = 'RISK_GATE';
  else if (pause_guard_decision === 'PAUSE_BLOCK') blockedStage = 'PAUSE_GUARD';
  else if (['REJECT','KILL'].includes(vcVerdict)) blockedStage = 'VC_GATE';
  else blockedStage = 'NONE';
}
const ssmAction = upper(d._sm_action || d.ssm_action || d.signal_state_action || 'UNKNOWN');
const ssmReason = clean(d._sm_reason || d.ssm_reason || d.signal_state_reason || d.reason || 'N/A', 'N/A');
const alpacaStatus = upper(d.alpaca_status || d.order_status || d.broker_status || 'N/A');
const alpacaReason = clean(d.alpaca_reason || d.order_reason || d.broker_reason || 'N/A', 'N/A');
const execId = ($execution && $execution.id) ? String($execution.id).slice(0, 12) : 'no-exec-id';
const inputKeys = Object.keys(d).slice(0, 18).join(',');
const auditBuilderVersion = 'QTP_EXEC_FLOW_AUDIT_BUILDER_v2.4_NO_RISK_UNKNOWN_INSERT_20260602';
const vcScoreParserVersion = clean(d._vc_score_parser_version || d.vc_score_parser_version || d.parser_version || d._vc_parser_version || 'N/A', 'N/A');
const vcKillGuardVersion = clean(d._vc_kill_guard_version || d.vc_kill_guard_version || (d._vc_kill_preserved !== undefined || d._vc_kill_reason !== undefined ? 'QTP_VC_PARSER_KILL_GUARD_20260520' : 'QTP_VC_PARSER_KILL_GUARD_20260520'), 'QTP_VC_PARSER_KILL_GUARD_20260520');
const auditBuilderKillReasonVersion = 'QTP_EXEC_FLOW_AUDIT_BUILDER_KILL_REASON_v3_20260521';
const vcKillReason = auditText(pickFirst(d._vc_kill_reason, inputFirst._vc_kill_reason, d.vc_kill_reason, inputFirst.vc_kill_reason, d.kill_reason, inputFirst.kill_reason, d.final_kill_reason, inputFirst.final_kill_reason), 'N/A');
const vcKillPreserved = clean(pickFirst(d._vc_kill_preserved, inputFirst._vc_kill_preserved, d.vc_kill_preserved, inputFirst.vc_kill_preserved), 'N/A');
const parserRejectionReasons = auditText(pickFirst(d.parser_rejection_reasons, inputFirst.parser_rejection_reasons, d.rejection_reasons, inputFirst.rejection_reasons, d._vc_rejection_reasons, inputFirst._vc_rejection_reasons), 'N/A');
const vcRedFlags = auditText(pickFirst(d._vc_red_flags, inputFirst._vc_red_flags, d.vc_red_flags, inputFirst.vc_red_flags), 'N/A');
// ANALYST_HITRATE_TELEMETRY v1 (20260721): persist the advisory Claude analyst verdict into
// gate_decision so v_analyst_hitrate can measure verdict-vs-outcome before any gating decision.
const aiActionAudit = clean(pickFirst(d.ai_action, inputFirst.ai_action), 'N/A');
const aiConfidenceAudit = clean(pickFirst(d.ai_confidence, inputFirst.ai_confidence), 'N/A');
const backtestStatus = upper(d._backtest_status || d.backtest_status || d.backtest_data_quality || 'NO_BACKTEST_MARKER');
const backtestAvailable = d._backtest_available === true || String(d._backtest_available ?? '').toLowerCase() === 'true';
const backtestSample = clean(d.backtest_sample || d._backtest_sample || d.backtest_sample_size || d.backtest_total_trades || d.strat_total_trades || d.strat_trades || d._btSample || '0', '0');
const backtestPf = clean(d.backtest_pf || d._backtest_pf || d.backtest_profit_factor || d.strat_profit_factor || d.profit_factor || d._btPf || '0', '0');
const backtestWin = clean(d.backtest_win_rate || d.strat_win_rate || '0', '0');
const backtestReason = clean(d._backtest_failure_reason || '', '');
const backtestRequired = d._backtest_required === true || String(d._backtest_required ?? '').toLowerCase() === 'true';
const backtestValid = d._backtest_valid === true || String(d._backtest_valid ?? '').toLowerCase() === 'true';
const marketSession = clean(d.market_session || 'N/A', 'N/A');
const isExtendedHours = (d.is_extended_hours === true || String(d.is_extended_hours ?? '').toLowerCase() === 'true') ? 'true' : 'false';
const extendedHoursMode = clean(d.extended_hours_mode || 'N/A', 'N/A');
const sessionTransitionReason = clean(d.session_transition_reason || 'N/A', 'N/A');
const extendedHoursRiskProfile = clean(d.extended_hours_risk_profile || 'N/A', 'N/A');
const extendedHoursMaxNotional = clean(d.extended_hours_max_notional || 'N/A', 'N/A');
const alpacaExtendedHours = (d.alpaca_extended_hours === true || String(d.alpaca_extended_hours ?? '').toLowerCase() === 'true') ? 'true' : 'false';
const extendedHoursRiskV = clean(d.extended_hours_risk_v || 'N/A', 'N/A');
const backtestAction = clean(d._backtest_enforcement_action || 'N/A', 'N/A');
const backtestRelaxedThresholds = (d._backtest_relaxed_thresholds === true || String(d._backtest_relaxed_thresholds ?? '').toLowerCase() === 'true') ? 'true' : 'false';
const usedMinTrades = clean(d._used_min_trades || 'N/A', 'N/A');
const usedMinPf = clean(d._used_min_pf || 'N/A', 'N/A');
const backtestResult = clean(d._backtest_enforcement_result || 'N/A', 'N/A');
const backtestEntryClass = clean(d._backtest_entry_class || 'N/A', 'N/A');
const backtestDataSource = clean(d.backtest_data_source || d._backtest_data_source || 'N/A', 'N/A');
const backtestDataQuality = clean(d.backtest_data_quality || d._backtest_status || d.backtest_status || 'N/A', 'N/A');
const mtfEngineNode = firstJsonFromNode('QTP Multi-Timeframe Confluence Engine');
const mtfJudgeNode = firstJsonFromNode('QTP MTF AI Judge (Perplexity/Grok)');
const mtfMergeNode = firstJsonFromNode('Merge MTF AI Verdict');
const timeframeHorizon = clean(pickFirst(d.timeframe_horizon, inputFirst.timeframe_horizon, mtfMergeNode.timeframe_horizon, mtfJudgeNode.timeframe_horizon, mtfEngineNode.timeframe_horizon, d.timeframe_profile, inputFirst.timeframe_profile, mtfMergeNode.timeframe_profile, mtfJudgeNode.timeframe_profile, mtfEngineNode.timeframe_profile), 'N/A');
const mtfTiers = jsonClean(pickFirst(d.mtf_tiers, inputFirst.mtf_tiers, mtfMergeNode.mtf_tiers, mtfJudgeNode.mtf_tiers, mtfEngineNode.mtf_tiers), {});
const mtfScore = score(pickFirst(d.mtf_confluence_score, inputFirst.mtf_confluence_score, mtfMergeNode.mtf_confluence_score, mtfJudgeNode.mtf_confluence_score, mtfEngineNode.mtf_confluence_score));
const mtfAiScore = score(pickFirst(d.ai_mtf_confluence_score, inputFirst.ai_mtf_confluence_score, mtfMergeNode.ai_mtf_confluence_score, mtfJudgeNode.ai_mtf_confluence_score));
const mtfDecision = clean(pickFirst(d.final_mtf_confluence_decision, inputFirst.final_mtf_confluence_decision, mtfMergeNode.final_mtf_confluence_decision, mtfJudgeNode.final_mtf_confluence_decision, mtfEngineNode.final_mtf_confluence_decision, d.mtf_confluence_decision, inputFirst.mtf_confluence_decision, mtfMergeNode.mtf_confluence_decision, mtfJudgeNode.mtf_confluence_decision, mtfEngineNode.mtf_confluence_decision), 'N/A');
const mtfSummary = clean(pickFirst(d.final_mtf_confluence_summary, inputFirst.final_mtf_confluence_summary, mtfMergeNode.final_mtf_confluence_summary, mtfJudgeNode.final_mtf_confluence_summary, mtfEngineNode.final_mtf_confluence_summary, d.mtf_confluence_summary, inputFirst.mtf_confluence_summary, mtfMergeNode.mtf_confluence_summary, mtfJudgeNode.mtf_confluence_summary, mtfEngineNode.mtf_confluence_summary), 'N/A');
const mtfEngineVersion = clean(pickFirst(d._mtf_engine_version, inputFirst._mtf_engine_version, mtfMergeNode._mtf_engine_version, mtfJudgeNode._mtf_engine_version, mtfEngineNode._mtf_engine_version, d.mtf_confluence_engine_v, inputFirst.mtf_confluence_engine_v, mtfMergeNode.mtf_confluence_engine_v, mtfJudgeNode.mtf_confluence_engine_v, mtfEngineNode.mtf_confluence_engine_v, d.mtf_engine_version, inputFirst.mtf_engine_version, 'QTP_MTF_CONFLUENCE_v6.2_20260521'), 'QTP_MTF_CONFLUENCE_v6.2_20260521');
const mtfAuditVisibilityVersion = clean(pickFirst(d._mtf_block_version, inputFirst._mtf_block_version, mtfMergeNode._mtf_block_version, d.mtf_audit_visibility_version, inputFirst.mtf_audit_visibility_version, mtfMergeNode.mtf_audit_visibility_version, (mtfDecision !== 'N/A' || mtfScore !== null || mtfAiScore !== null ? 'QTP_MTF_AUDIT_VISIBILITY_20260521' : 'N/A')), 'N/A');
// QTP_MTF_SHADOW_AUDIT_SIBLING_READ_v2_20260601 (v2.2: + shadow_lt_value)
const shadowNode = firstJsonFromNode('QTP MTF Shadow Engine v1.1');
const shadowScore    = pickFirst(d.shadow_mtf_score,       inputFirst.shadow_mtf_score,       shadowNode.shadow_mtf_score);
const shadowDecision = pickFirst(d.shadow_mtf_decision,    inputFirst.shadow_mtf_decision,    shadowNode.shadow_mtf_decision);
const shadowSizeMult = pickFirst(d.shadow_size_multiplier, inputFirst.shadow_size_multiplier, shadowNode.shadow_size_multiplier);
const shadowLtVeto   = (d.shadow_lt_veto ?? inputFirst.shadow_lt_veto ?? shadowNode.shadow_lt_veto);
const shadowEngineV  = pickFirst(d.shadow_engine_v,        inputFirst.shadow_engine_v,        shadowNode.shadow_engine_v);
const shadowLtValue  = pickFirst(d.shadow_lt_value,        inputFirst.shadow_lt_value,        shadowNode.shadow_lt_value);
const strategyBody = (d.body && typeof d.body === 'object') ? d.body : {};
const strategyId = clean(pickFirst(d.strategy_id, d.strategy, d.strategy_name, d.strategyName, inputFirst.strategy_id, inputFirst.strategy, inputFirst.strategy_name, inputFirst.strategyName, strategyBody.strategy_id, strategyBody.strategy, strategyBody.strategy_name, strategyBody.strategyName), 'N/A');
const strategyName = clean(pickFirst(d.strategy_name, d.strategyName, d.strategy, inputFirst.strategy_name, inputFirst.strategyName, inputFirst.strategy, strategyBody.strategy_name, strategyBody.strategyName, strategyBody.strategy), 'N/A');
const setupType = clean(pickFirst(d.setup_type, d.setupType, d.signal_type, d.module, inputFirst.setup_type, inputFirst.setupType, inputFirst.signal_type, inputFirst.module, strategyBody.setup_type, strategyBody.setupType, strategyBody.signal_type, strategyBody.module), 'N/A');
const alertName = clean(pickFirst(d.alert_name, d.alertName, d.signal_name, d.source, d.alert_type, inputFirst.alert_name, inputFirst.alertName, inputFirst.signal_name, inputFirst.source, inputFirst.alert_type, strategyBody.alert_name, strategyBody.alertName, strategyBody.signal_name, strategyBody.source, strategyBody.alert_type), 'N/A');
const gateDecisionParts = [
  `vc=${vcVerdict}`, `vc_v2=${vcLiveV2 ?? 'N/A'}`, `vc_legacy=${vcLiveLegacy ?? 'N/A'}`,
  `vc_shadow=${vcShadow ?? 'N/A'}`, `vc_delta=${vcDelta ?? 'N/A'}`,
  `bias_score=${biasScore ?? 'N/A'}`, `bias=${biasStatus}`,
  `ai_action=${aiActionAudit}`, `ai_confidence=${aiConfidenceAudit}`,
  `blocked_stage=${blockedStage}`, `ssm_action=${ssmAction}`, `ssm_reason=${ssmReason}`,
  `risk_gate=${risk_gate_decision}`, `risk_status=${risk_status_struct}`,
  `pause_guard=${pause_guard_decision}`, `pause_action=${pauseAction}`,
  `alpaca_status=${alpacaStatus}`, `alpaca_reason=${alpacaReason}`,
  `audit_v=4.2.22`, `audit_builder_v=${auditBuilderVersion}`,
  `vc_score_parser_v=${vcScoreParserVersion}`, `vc_kill_guard_v=${vcKillGuardVersion}`,
  `audit_builder_kill_reason_v=${auditBuilderKillReasonVersion}`,
  `vc_kill_preserved=${vcKillPreserved}`, `vc_kill_reason=${vcKillReason}`,
  `parser_rejection_reasons=${parserRejectionReasons}`, `vc_red_flags=${vcRedFlags}`,
  `mtf_engine_v=${mtfEngineVersion}`, `mtf_audit_visibility_v=${mtfAuditVisibilityVersion}`,
  `backtest_status=${backtestStatus}`, `backtest_data_source=${backtestDataSource}`,
  `backtest_data_quality=${backtestDataQuality}`, `backtest_available=${backtestAvailable ? 'true' : 'false'}`,
  `backtest_sample=${backtestSample}`, `backtest_pf=${backtestPf}`, `backtest_win=${backtestWin}`,
  `backtest_required=${backtestRequired ? 'true' : 'false'}`, `backtest_valid=${backtestValid ? 'true' : 'false'}`,
  `extended_hours_v=QTP_EXTENDED_HOURS_AUDIT_v1_20260527`, `extended_hours_risk_profile=${extendedHoursRiskProfile}`,
  `extended_hours_max_notional=${extendedHoursMaxNotional}`, `alpaca_extended_hours=${alpacaExtendedHours}`,
  `extended_hours_risk_v=${extendedHoursRiskV}`, `market_session=${marketSession}`,
  `is_extended_hours=${isExtendedHours}`, `extended_hours_mode=${extendedHoursMode}`,
  `session_transition=${sessionTransitionReason}`, `backtest_action=${backtestAction}`,
  `backtest_result=${backtestResult}`, `backtest_class=${backtestEntryClass}`,
  `backtest_relaxed_thresholds=${backtestRelaxedThresholds}`, `used_min_trades=${usedMinTrades}`,
  `used_min_pf=${usedMinPf}`, `backtest_relaxation_v=QTP_BACKTEST_RELAXATION_v6.1_20260526`,
  backtestReason ? `backtest_reason=${backtestReason}` : '',
  `timeframe_horizon=${timeframeHorizon}`,
  `mtf_confluence_score=${mtfScore ?? 'N/A'}`, `ai_mtf_confluence_score=${mtfAiScore ?? 'N/A'}`,
  // v2.3: AI MTF Judge v5.10 observability fields (Council P0 mandate 2026-06-01)
  `ai_mtf_pre_penalty_score=${clean(d.ai_mtf_pre_penalty_score ?? inputFirst.ai_mtf_pre_penalty_score ?? 'N/A')}`,
  `ai_mtf_penalty_total=${clean(d.ai_mtf_penalty_total ?? inputFirst.ai_mtf_penalty_total ?? 'N/A')}`,
  `ai_mtf_dominant_veto_reason=${clean(d.ai_mtf_dominant_veto_reason ?? inputFirst.ai_mtf_dominant_veto_reason ?? 'N/A')}`,
  `ai_mtf_dominant_veto_magnitude=${clean(d.ai_mtf_dominant_veto_magnitude ?? inputFirst.ai_mtf_dominant_veto_magnitude ?? 'N/A')}`,
  `mtf_ai_judge_v=${clean(d.mtf_ai_judge_v ?? inputFirst.mtf_ai_judge_v ?? 'N/A')}`,
  `final_mtf_confluence_decision=${mtfDecision}`, `mtf_tiers=${clean(JSON.stringify(mtfTiers), '{}')}`,
  `mtf_summary=${mtfSummary}`,
  `chart_url_v=${clean(d.chart_url_version || 'N/A')}`, `chart_symbol=${clean(d.chart_symbol || 'N/A')}`,
  `chart_vision_status=${clean(d.chart_vision_status || 'N/A')}`, `chart_vision_score=${clean(d.chart_vision_score ?? 'N/A')}`,
  `chart_vision_confidence=${clean(d.chart_vision_confidence ?? 'N/A')}`, `chart_vision_trend=${clean(d.chart_vision_trend || 'N/A')}`,
  `chart_vision_pattern=${clean(d.chart_vision_pattern || 'N/A')}`, `chart_vision_v=${clean(d.chart_vision_version || 'N/A')}`,
  `strategy_id=${strategyId}`, `strategy_name=${strategyName}`, `setup_type=${setupType}`, `alert_name=${alertName}`,
  `strategy_attribution_v=QTP_STRATEGY_ATTRIBUTION_v1_20260522`,
  `exec_id=${execId}`, `keys=${inputKeys}`
];
const gateDecision = gateDecisionParts.filter(Boolean).join(' | ').slice(0, 20000);
const parserVersion = d.parser_version || d.vc_score_parser_version || d._vc_score_parser_version || d._vc_parser_version || d._vc_feedback_version || 'QTP-AUDIT_v4.2.22_AI_JUDGE_VETO_20260601';
// QTP_H1_CORRELATION_KEY_AUDIT_20260617: stamp SSM-minted signal_id/idempotency_key/gate_lineage.
// Values flow from Signal State Machine [a6dd58c2] through the FULL branch.
const _h1SignalId = d._sm_signal_id || d.signal_id || null;
const _h1IdempotencyKey = d._sm_idempotency_key || d._sm_signal_id || d.idempotency_key || null;
const _h1GateLineage = (() => {
  const gl = d._sm_gate_lineage;
  if (gl === undefined || gl === null) return null;
  try { return (typeof gl === 'string') ? gl : JSON.stringify(gl); } catch (e) { return null; }
})();
const _h1KillStage = d._sm_kill_stage_attribution || null;
d._early_exec_flow_audit_sql = `INSERT INTO quantum.exec_flow_audit
(ts, symbol, side, vc_live_legacy, vc_live_v2, vc_shadow, vc_delta, gate_decision, parser_version,
 risk_gate_decision, risk_status, pause_guard_decision, pause_status,
 timeframe_horizon, mtf_tiers, mtf_confluence_score, final_mtf_confluence_decision,
 shadow_mtf_score, shadow_mtf_decision, shadow_size_multiplier, shadow_lt_veto, shadow_engine_v, shadow_lt_value,
 signal_id, idempotency_key, gate_lineage, kill_stage_attribution)
SELECT
  CURRENT_TIMESTAMP,
  ${esc(symbol)},
  ${esc(side)},
  ${num(vcLiveLegacy)},
  ${num(vcLiveV2)},
  ${num(vcShadow)},
  ${num(vcDelta)},
  ${esc(gateDecision)},
  ${esc(parserVersion)},
  ${esc(risk_gate_decision)},
  ${esc(risk_status_struct)},
  ${esc(pause_guard_decision)},
  ${esc(pause_status)},
  ${esc(timeframeHorizon)},
  ${esc(JSON.stringify(mtfTiers))}::jsonb,
  ${num(mtfScore)},
  ${esc(mtfDecision)},
  ${shadowScore === '' || shadowScore == null ? 'NULL' : num(shadowScore)},
  ${esc(shadowDecision || 'SHADOW_ERROR')},
  ${shadowSizeMult === '' || shadowSizeMult == null ? 'NULL' : num(shadowSizeMult)},
  ${bool(shadowLtVeto === '' ? null : shadowLtVeto)},
  ${esc(shadowEngineV || null)},
  ${shadowLtValue === '' || shadowLtValue == null ? 'NULL' : num(shadowLtValue)},
  ${esc(_h1SignalId)},
  ${esc(_h1IdempotencyKey)},
  ${_h1GateLineage == null ? 'NULL' : esc(_h1GateLineage) + '::jsonb'},
  ${esc(_h1KillStage)}`;
d._early_exec_flow_audit_gate_decision_preview = gateDecision;
d._exec_flow_audit_builder_version = auditBuilderVersion;
d._exec_flow_audit_builder_kill_reason_version = 'QTP_EXEC_FLOW_AUDIT_BUILDER_KILL_REASON_v3_20260521';
d._audit_marker_vc_score_parser_version = vcScoreParserVersion;
d._audit_marker_vc_kill_guard_version = vcKillGuardVersion;
d._audit_marker_mtf_engine_version = mtfEngineVersion;
d._audit_marker_mtf_visibility_version = mtfAuditVisibilityVersion;
d._early_exec_flow_audit_version = 'QTP-AUDIT_v4.2.22_AI_JUDGE_VETO_20260601';
d._pause_guard_decision = pause_guard_decision;
d._pause_status_struct = pause_status;
d._risk_gate_decision_pending = risk_gate_decision;
d._risk_status_pending = risk_status_struct;
return [{ json: d }];
