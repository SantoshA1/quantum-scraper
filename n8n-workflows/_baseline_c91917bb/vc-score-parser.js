// QTP-EXEC-FLOW v4.2.1 — VC Score Parser with 1-cycle parity
// Purpose:
// - Extract final composite VC score from Grok/native VC response
// - Preserve legacy live_vc_score for parity
// - Add calibrated live_vc_score_v2 using SHADOW_A / SHADOW_B
// - Preserve downstream _vc_* fields for Telegram/rejection/audit compatibility
// - Do NOT change Risk Gate, Alpaca routing, pause guard, exits, or protective logic

const SHADOW_A = 1.18;
const SHADOW_B = 0.55;
const VC_THRESHOLD_LOCKED = 7;
const NL = String.fromCharCode(10);
const vcResponse = $input.first().json || {};
let prev = {};
try { prev = $('VC Agent Gatekeeper').first().json || {}; } catch (e) { prev = vcResponse || {}; }

function clampScore(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(10, n));
}
function round1(value) { return Math.round(Number(value) * 10) / 10; }
function toArray(v) {
  if (Array.isArray(v)) return v;
  if (v === undefined || v === null || v === '') return [];
  return [String(v)];
}
function verdictFromScore(score) {
  const s = Number(score || 0);
  if (s <= 3) return 'KILL';
  if (s < 7) return 'REJECT';
  if (s < 8) return 'WEAK';
  return 'PASS';
}
function extractScoreFromObject(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const candidateKeys = [
    'final_composite_score', 'composite_score', 'vc_composite_score',
    'vc_score', 'live_vc_score', '_vc_score', 'score', 'rating'
  ];
  for (const key of candidateKeys) {
    if (obj[key] !== undefined && obj[key] !== null && obj[key] !== '') {
      const n = Number(String(obj[key]).replace('/10', '').trim());
      if (Number.isFinite(n)) return clampScore(n);
    }
  }
  for (const key of ['verdict', 'analysis', 'result', 'data', 'body']) {
    if (obj[key] && typeof obj[key] === 'object') {
      const nested = extractScoreFromObject(obj[key]);
      if (nested !== null) return nested;
    }
  }
  return null;
}
function extractScoreFromText(text) {
  if (!text || typeof text !== 'string') return null;
  const patterns = [
    /final\s+composite\s+score\s*[:=]\s*(\d+(?:\.\d+)?)\s*\/?\s*10/i,
    /composite\s+score\s*[:=]\s*(\d+(?:\.\d+)?)\s*\/?\s*10/i,
    /vc\s+score\s*[:=]\s*(\d+(?:\.\d+)?)\s*\/?\s*10/i,
    /score\s*[:=]\s*(\d+(?:\.\d+)?)\s*\/?\s*10/i,
    /\[(\d+(?:\.\d+)?)\s*\/\s*10\]/i,
    /(\d+(?:\.\d+)?)\s*\/\s*10/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1] !== undefined) {
      const n = Number(match[1]);
      if (Number.isFinite(n)) return clampScore(n);
    }
  }
  return null;
}
function tryParseJson(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  try { return JSON.parse(trimmed); } catch (_) {}
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced && fenced[1]) { try { return JSON.parse(fenced[1].trim()); } catch (_) {} }
  const objectMatch = trimmed.match(/\{[\s\S]*\}/);
  if (objectMatch) { try { return JSON.parse(objectMatch[0]); } catch (_) {} }
  return null;
}
function extractPayloads(j) {
  const p = [];
  if (j.choices?.[0]?.message?.content) p.push(j.choices[0].message.content);
  if (j.data?.choices?.[0]?.message?.content) p.push(j.data.choices[0].message.content);
  if (j.body?.choices?.[0]?.message?.content) p.push(j.body.choices[0].message.content);
  p.push(j.vc_response, j.vc_result, j.grok_response, j.grok_result, j.ai_response, j.analysis, j.response, j.message, j.text, j.content, j.output, j.raw_vc_response);
  return p.filter(v => v !== undefined && v !== null && v !== '');
}
function extractDetails(obj, textFallback) {
  const parsedObj = obj && typeof obj === 'object' ? obj : {};
  const nested = parsedObj.verdict && typeof parsedObj.verdict === 'object' ? parsedObj.verdict : {};
  const analysis = parsedObj.analysis && typeof parsedObj.analysis === 'object' ? parsedObj.analysis : {};
  return {
    pass: parsedObj.pass === true || nested.pass === true || analysis.pass === true,
    feedback: String(parsedObj.brutal_feedback || parsedObj.feedback || parsedObj.reason || nested.brutal_feedback || nested.feedback || analysis.brutal_feedback || analysis.feedback || textFallback || 'No feedback'),
    red_flags: toArray(parsedObj.red_flags || nested.red_flags || analysis.red_flags),
    fixes: toArray(parsedObj.suggested_fixes || parsedObj.fixes || nested.suggested_fixes || analysis.suggested_fixes),
    verdict: String(parsedObj.final_verdict || parsedObj.verdict_text || parsedObj.verdict || nested.final_verdict || analysis.final_verdict || '').toUpperCase()
  };
}

// QTP_VC_NESTED_GROK_KILL_EXTRACT_20260520 — parse xAI choices[0].message.content before KILL guard.

function __qtpParseVcContentObject(value) {
  if (!value) return null;
  if (typeof value === 'object') {
    if (value.final_verdict !== undefined || value.vc_score !== undefined || value.rule_ids_fired !== undefined || value.red_flags !== undefined || value.brutal_feedback !== undefined) {
      return value;
    }
    const choiceContent = value.choices?.[0]?.message?.content || value.data?.choices?.[0]?.message?.content || value.body?.choices?.[0]?.message?.content;
    if (choiceContent) {
      const parsedChoice = __qtpParseVcContentObject(choiceContent);
      if (parsedChoice) return parsedChoice;
    }
    for (const key of ['vc_response', 'vc_result', 'grok_response', 'grok_result', 'ai_response', 'analysis', 'response', 'message', 'text', 'content', 'output', 'raw_vc_response']) {
      const parsedNested = __qtpParseVcContentObject(value[key]);
      if (parsedNested) return parsedNested;
    }
    return null;
  }
  if (typeof value === 'string') {
    const parsed = tryParseJson(value);
    if (parsed) return __qtpParseVcContentObject(parsed) || parsed;
  }
  return null;
}
function __qtpResolveRawVcObject(detailObject, vcResponse, textFallback) {
  return __qtpParseVcContentObject(detailObject) || __qtpParseVcContentObject(vcResponse) || __qtpParseVcContentObject(textFallback) || {};
}

let legacyScore = extractScoreFromObject(vcResponse);
let scoreSource = legacyScore !== null ? 'structured_payload' : null;
let detailSource = null;
let detailObject = null;
let textFallback = '';

if (legacyScore === null) {
  for (const payload of extractPayloads(vcResponse)) {
    if (typeof payload === 'object') {
      const s = extractScoreFromObject(payload);
      if (s !== null) { legacyScore = s; scoreSource = 'nested_object_payload'; detailObject = payload; break; }
    }
    if (typeof payload === 'string') {
      textFallback = payload;
      const parsed = tryParseJson(payload);
      if (parsed) {
        const s = extractScoreFromObject(parsed);
        if (s !== null) { legacyScore = s; scoreSource = 'json_text_payload'; detailObject = parsed; break; }
      }
      const s = extractScoreFromText(payload);
      if (s !== null) { legacyScore = s; scoreSource = 'text_payload'; detailObject = parsed || {}; break; }
    }
  }
}
if (legacyScore === null) {
  legacyScore = 0;
  scoreSource = 'score_missing_fail_closed';
}
legacyScore = round1(clampScore(legacyScore));
const calibratedScore = round1(clampScore((legacyScore * SHADOW_A) + SHADOW_B));

let details = extractDetails(detailObject || vcResponse, textFallback);
let legacyVerdict = details.verdict && ['KILL','REJECT','WEAK','PASS'].includes(details.verdict) ? details.verdict : verdictFromScore(legacyScore);
let v2Verdict = verdictFromScore(calibratedScore);
let v2Pass = calibratedScore >= VC_THRESHOLD_LOCKED;

// === v6.1 KILL-PRESERVATION GUARD (QTP_VC_PARSER_KILL_GUARD_20260520) ===
// When the raw VC Agent verdict is KILL (or score=0, or R3.2 fired), the
// signal is structurally broken — the calibration formula pushes raw 0 to 0.6
// and downstream relabel logic (e.g. backtest enforcement) can rewrite the
// canonical verdict to REJECT. Preserve KILL verbatim across all output
// fields. No effect on non-KILL signals: when _raw_is_kill is false every
// existing code path runs unchanged.
const _raw_kg_parsed = __qtpResolveRawVcObject(detailObject, vcResponse, textFallback);
const _raw_verdict_kg = _raw_kg_parsed && _raw_kg_parsed.final_verdict ? String(_raw_kg_parsed.final_verdict).toUpperCase() : (details && details.verdict ? String(details.verdict).toUpperCase() : '');
const _raw_score_kg = (_raw_kg_parsed && _raw_kg_parsed.vc_score !== undefined && _raw_kg_parsed.vc_score !== null && String(_raw_kg_parsed.vc_score).trim() !== '') ? Number(_raw_kg_parsed.vc_score) : (typeof legacyScore === 'number' ? legacyScore : null);
const _raw_rules_kg = (_raw_kg_parsed && Array.isArray(_raw_kg_parsed.rule_ids_fired)) ? _raw_kg_parsed.rule_ids_fired : toArray(_raw_kg_parsed && (_raw_kg_parsed.rule_ids_fired || _raw_kg_parsed.rules_fired || _raw_kg_parsed.rule_ids));
const _raw_rules_text_kg = _raw_rules_kg.map(v => String(v).toUpperCase()).join('|');
const _raw_redflags_text_kg = toArray(_raw_kg_parsed && _raw_kg_parsed.red_flags).map(v => String(v).toUpperCase()).join('|');
const _raw_feedback_text_kg = String((_raw_kg_parsed && (_raw_kg_parsed.brutal_feedback || _raw_kg_parsed.feedback || _raw_kg_parsed.reason)) || '').toUpperCase();
const _raw_is_kill = (_raw_verdict_kg === 'KILL') || (_raw_score_kg === 0) || _raw_rules_text_kg.includes('R3.2') || _raw_redflags_text_kg.includes('R3.2') || _raw_feedback_text_kg.includes('R3.2');
const _raw_kill_reason = _raw_is_kill ? (_raw_rules_kg.length ? _raw_rules_kg.join(',') : ((_raw_redflags_text_kg.includes('R3.2') || _raw_feedback_text_kg.includes('R3.2')) ? 'R3.2' : (_raw_verdict_kg === 'KILL' ? 'final_verdict=KILL' : 'vc_score=0'))) : '';
if (_raw_is_kill && _raw_kg_parsed && (_raw_kg_parsed.brutal_feedback || _raw_kg_parsed.feedback)) {
  details.feedback = String(_raw_kg_parsed.brutal_feedback || _raw_kg_parsed.feedback);
  details.red_flags = toArray(_raw_kg_parsed.red_flags);
  details.fixes = toArray(_raw_kg_parsed.suggested_fixes || _raw_kg_parsed.fixes);
}
if (_raw_is_kill) {
  legacyVerdict = 'KILL';
  v2Verdict = 'KILL';
  v2Pass = false;
}
// === END v6.1 KILL-PRESERVATION GUARD ===

// QTP_CYCLE_007_17_NODE_HARDENED_20260511 — STAND ASIDE must not be auto-promoted.
// Neutral/after-hours refreshes are suppressed audit-only; no fake 8.8 PASS.
const __cycle007Execution = String(prev.execution || prev.signal || vcResponse.execution || vcResponse.signal || '').toUpperCase();
const __cycle007StandAsideNeutral = (__cycle007Execution === 'STAND ASIDE');
if (__cycle007StandAsideNeutral) {
  legacyVerdict = 'NEUTRAL_SUPPRESSED';
  v2Verdict = 'NEUTRAL_SUPPRESSED';
  v2Pass = false;
  details.feedback = 'NEUTRAL_SUPPRESSED: After-hours / neutral refresh suppressed by Cycle 007 session filter. Audit only.';
  details.red_flags = Array.isArray(details.red_flags) ? details.red_flags : [];
  details.red_flags.unshift('Cycle 007 neutral/session filter suppressed STAND ASIDE; no subscriber delivery and no execution route.');
}

const output = {
  ...prev,
  live_vc_score: legacyScore,
  live_vc_score_v2: calibratedScore,
  _vc_score: calibratedScore,
  _vc_score_legacy: legacyScore,
  _vc_pass: v2Pass,
  _vc_pass_legacy: legacyScore >= VC_THRESHOLD_LOCKED,
  _vc_feedback: details.feedback,
  _vc_red_flags: details.red_flags,
  _vc_fixes: details.fixes,
  _vc_verdict: v2Verdict,
  _vc_verdict_legacy: legacyVerdict,
  _vc_raw_response: vcResponse,
  _vc_score_parser_version: 'QTP_CYCLE_007_17_NODE_HARDENED_20260511',
  _vc_score_source: scoreSource,
  _vc_gate_threshold_locked: VC_THRESHOLD_LOCKED,
  _vc_gate_candidate_v2_pass: calibratedScore >= VC_THRESHOLD_LOCKED,
  _vc_gate_candidate_legacy_pass: legacyScore >= VC_THRESHOLD_LOCKED,
  _vc_parity_delta: round1(calibratedScore - legacyScore),
  _vc_shadow_calibration: {
    enabled: true,
    mode: 'parity_cycle',
    shadow_a: SHADOW_A,
    shadow_b: SHADOW_B,
    legacy_live_vc_score: legacyScore,
    live_vc_score_v2: calibratedScore,
    threshold_locked: VC_THRESHOLD_LOCKED
  },
  _vc_shadow_execution_effect: 'NONE_SCORE_CALIBRATION_ONLY_GATE_STILL_7'
};

// === v6.1 KILL SHORT-CIRCUIT BEFORE FEEDBACK/BACKTEST (QTP_VC_KILL_FEEDBACK_CLEAN_20260520) ===
// If the VC Agent already declared a structural KILL, stop before backtest enforcement
// and the generic VC feedback ladder. This prevents operator-facing Telegram/audit text
// from showing REJECT-flavored backtest messaging for hard-opposite KILL cases.
if (_raw_is_kill) {
  const __killTicker = String(output.ticker || output.symbol || prev.ticker || prev.symbol || 'UNKNOWN').toUpperCase();
  const __killDirection = String(output.execution || output.side || output.signal || prev.execution || prev.side || prev.signal || 'UNKNOWN').toUpperCase();
  output.live_vc_score = 0;
  output.live_vc_score_v2 = 0;
  output.vc_live_v2 = 0;
  output.vc_score = 0;
  output._vc_score = 0;
  output._vc_pass = false;
  output._vc_verdict = 'KILL';
  output._vc_verdict_legacy = 'KILL';
  output.vc_verdict = 'KILL';
  output.final_verdict = 'KILL';
  output.parser_decision = 'KILL';
  output.live_eligible = false;
  output.backtest_eligible = false;
  output.eligible = false;
  output._vc_kill_preserved = true;
  output._vc_kill_reason = _raw_kill_reason || 'R3.2';
  output.rule_ids_fired = Array.isArray(output.rule_ids_fired) ? output.rule_ids_fired : [];
  if (!output.rule_ids_fired.includes('R3.2')) output.rule_ids_fired.push('R3.2');
  output.parser_rejection_reasons = [output._vc_kill_reason];
  output.rejection_reasons = [output._vc_kill_reason];
  output.red_flags = Array.isArray(details.red_flags) ? details.red_flags : [];
  output.red_flags.unshift(output._vc_kill_reason);
  output.blocked_stage = 'VC_HARD_KILL';
  output._backtest_required = false;
  output._backtest_valid = false;
  output._backtest_enforcement_action = 'SKIPPED_HARD_KILL';
  output._vc_backtest_cap_applied = false;
  output._backtest_failure_reason = '';
  output._backtest_enforcement_reason = 'SKIPPED_HARD_KILL';
  output.feedback = `VC KILL: ${__killTicker} ${__killDirection} was killed before backtest enforcement. Reason: ${output._vc_kill_reason}. No live execution, no subscriber delivery, and no risk-engine route.`;
  output.vc_feedback = `VC KILL: hard-opposite conflict detected. ${output._vc_kill_reason}. This signal is structurally invalid and was stopped before REJECT/backtest feedback generation.`;
  output.ai_feedback = output.vc_feedback;
  output._parser_log = `QTP PARSER KILL → hard-opposite short-circuit → ${output._vc_kill_reason}`;
  console.log(output._parser_log);
  return [{ json: output }];
}
// === END v6.1 KILL SHORT-CIRCUIT BEFORE FEEDBACK/BACKTEST ===




// QTP_CYCLE_007_17_NODE_HARDENED_20260511 — final neutral suppression and version stamp.
output.parser_version = 'QTP_CYCLE_007_17_NODE_HARDENED_20260511';
output._vc_score_parser_version = 'QTP_CYCLE_007_17_NODE_HARDENED_20260511';
output.qtp_cycle_version = 'QTP_CYCLE_007_17_NODE_HARDENED_20260511';
if (String(output.execution || output.signal || '').toUpperCase() === 'STAND ASIDE') {
  output._vc_stand_aside_neutral = true;
  output._vc_pass = false;
  output._vc_verdict = 'NEUTRAL_SUPPRESSED';
  output.vc_verdict = 'NEUTRAL_SUPPRESSED';
  output.blocked_stage = 'SESSION_OR_NEUTRAL_FILTER';
  output.gate_decision = 'NEUTRAL_SUPPRESSED';
  output.feedback = 'NEUTRAL_SUPPRESSED: After-hours / neutral refresh suppressed by Cycle 007 session filter. Audit only.';
  output.vc_feedback = output.feedback;
  output.ai_feedback = output.feedback;
}


// QTP-BACKTEST-ENFORCEMENT v4.2.12 — fail-closed for scalp/high-risk entries with weak/missing backtest evidence.
// Additive/reversible. Does not lower VC>=7. It caps VC below pass only when required backtest proof is missing or invalid.
function __qtpBtNum(v) {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const n = Number(String(v).replace('%', '').trim());
  return Number.isFinite(n) ? n : null;
}
function __qtpBtTxt(...vals) {
  for (const v of vals) {
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}
// QTP_BACKTEST_RELAXATION_v6.1_20260526
// Smart backtest thresholds: STRICT 100/1.20, RELAXED 40/1.05, HIGH_VOL_RELAXED 30/0.95.
// Additive and auditable only. R3.2 KILL and BROAD_SCANNER bias path remain untouched.
function __qtpBtBool(v) {
  if (v === true) return true;
  if (v === false) return false;
  const s = String(v ?? '').trim().toLowerCase();
  return ['true','1','yes','y','on'].includes(s);
}
const __qtpBtRelaxationConfig = {
  strict: { minTrades: 100, minPf: 1.20, action: 'STRICT', relaxed: false },
  relaxed: { minTrades: 40, minPf: 1.05, action: 'RELAXED', relaxed: true },
  highVol: { minTrades: 30, minPf: 0.95, action: 'HIGH_VOL_RELAXED', relaxed: true },
  highVolSymbols: new Set(['VFS','USO'])
};
function __qtpSelectBacktestThresholds(j) {
  const ticker = String(j.ticker || j.symbol || '').trim().toUpperCase();
  const marketText = String(j.market_status || j._dq_market_status || j.session || j.session_status || '').toUpperCase();
  const isPreMarket = __qtpBtBool(j.pre_market_mode) || __qtpBtBool(j.preMarketMode) || marketText.includes('PRE') || marketText.includes('PREMARKET');
  const isRelaxed = __qtpBtBool(j.relaxed_mode) || __qtpBtBool(j.relaxedMode) || isPreMarket;
  const isHighVol = __qtpBtRelaxationConfig.highVolSymbols.has(ticker) || __qtpBtBool(j.high_vol) || __qtpBtBool(j.highVol) || __qtpBtBool(j._high_vol);
  const t = isHighVol ? __qtpBtRelaxationConfig.highVol : (isRelaxed ? __qtpBtRelaxationConfig.relaxed : __qtpBtRelaxationConfig.strict);
  return { ...t, ticker, isPreMarket, isHighVol };
}
const __btExecution = __qtpBtTxt(output.execution, output.side, output.signal).toUpperCase();
const __btTimeframe = __qtpBtNum(output.timeframe ?? output.tf ?? output.interval);
const __btAlertType = __qtpBtTxt(output.alert_type, output.source, output.strategy_id, output.signal_type, output.scanner_type, output.module).toUpperCase();
const __btSignalText = __qtpBtTxt(output.signal_name, output.strategy, output.setup_type, output.trade_type, output.style, output.intent).toUpperCase();
const __btBias = __qtpBtNum(output._bias_filter_score ?? output.bias_score ?? output.bias ?? output.bias_pct ?? output.ai_super_score ?? output.composite_score ?? output.score);
const __btAdx = __qtpBtNum(output.adx);
const __btVix = __qtpBtNum(output.vix);
const __btSample = __qtpBtNum(output.backtest_sample_size ?? output.strat_total_trades ?? output.backtest_total_trades ?? output.total_trades);
const __btPf = __qtpBtNum(output.backtest_profit_factor ?? output.strat_profit_factor ?? output.profit_factor);
const __btWin = __qtpBtNum(output.backtest_win_rate ?? output.strat_win_rate ?? output.win_rate);
const __btThresholds = __qtpSelectBacktestThresholds(output);
const __isEntry = ['BUY','SELL','LONG','SHORT','BULLISH','BEARISH'].includes(__btExecution);
// QTP v6.1 BROAD_SCANNER parser fix — BROAD_SCANNER is NOT SCALP.
// Scanner alerts use the v6.1 bias-ladder path and do not require symbol-level PF/sample data.
const __scannerFamilyText = `${__btAlertType} ${__btSignalText}`;
const __isBroadScanner = __scannerFamilyText.includes('BROAD_SCANNER') || __scannerFamilyText.includes('BROAD SCANNER');
const __isRawKillVerdict = String(output._vc_verdict || output.vc_verdict || output.final_verdict || '').toUpperCase() === 'KILL' || output._vc_kill_preserved === true;
const __broadScannerBiasScore = (__btBias !== null && __btBias >= 75) ? 9 : ((__btBias !== null && __btBias >= 68) ? 8 : ((__btBias !== null && __btBias >= 60) ? 7 : 0));
const __broadScannerEligible = __isEntry && __isBroadScanner && !__isRawKillVerdict && __broadScannerBiasScore >= 7;
const __broadScannerRejectReason = __isEntry && __isBroadScanner && !__isRawKillVerdict && __broadScannerBiasScore < 7 ? `BROAD_SCANNER_BIAS_TOO_LOW: bias=${__btBias ?? 'N/A'}<60` : '';
const __isScalp = !__isBroadScanner && (__btSignalText.includes('SCALP') || __btAlertType.includes('SCALP') || (__btTimeframe !== null && __btTimeframe <= 5));
const __isHighRisk = __isEntry && !__isBroadScanner && (__isScalp || (__btBias !== null && __btBias < 75) || (__btAdx !== null && __btAdx < 20) || (__btVix !== null && __btVix >= 24));
const __backtestRequired = __isEntry && !__isBroadScanner && __isHighRisk;
// F2 EXPANSION_20260714 (Conclave Ruling 2, Q2-A): stage-1 BACKTEST_ENFORCEMENT likewise shadowed when cohort active
// (same config surface proven: same thresholds emit blocked_stage='BACKTEST_ENFORCEMENT').
const __pfWouldBlockRaw1 = !(__isBroadScanner ? true : (!__backtestRequired || (__btSample !== null && __btSample >= __btThresholds.minTrades && __btPf !== null && __btPf >= __btThresholds.minPf)));
const __pfShadowOn1 = Number(((($getWorkflowStaticData('global') || {})._gateConfig) || {}).expansion_cohort_active || 0) === 1;
output._pf_stage1_shadow_mode = __pfShadowOn1;
output._pf_stage1_would_block = __pfWouldBlockRaw1;
output._pf_stage1_verdict = (__btPf === null || __btSample === null) ? (__isBroadScanner ? 'PASS' : 'UNKNOWN') : (__pfWouldBlockRaw1 ? 'WOULD_BLOCK' : 'PASS');
const __backtestValid = __pfShadowOn1 ? true : !__pfWouldBlockRaw1;
const __btReasons = [];
if (__isBroadScanner && __broadScannerRejectReason) __btReasons.push(__broadScannerRejectReason);
if (__backtestRequired && (__btSample === null || __btSample < __btThresholds.minTrades)) __btReasons.push(`sample=${__btSample ?? 'N/A'}<${__btThresholds.minTrades}`);
if (__backtestRequired && (__btPf === null || __btPf < __btThresholds.minPf)) __btReasons.push(`pf=${__btPf ?? 'N/A'}<${__btThresholds.minPf}`);

output._backtest_enforcement_version = 'QTP_BACKTEST_ENFORCEMENT_v4.2.12_20260513';
output._broad_scanner_parser_fix_version = 'QTP_BROAD_SCANNER_PARSER_FIX_v6.1_20260520';
output._signal_family = __isBroadScanner ? 'BROAD_SCANNER' : (__isScalp ? 'SCALP' : (__isHighRisk ? 'HIGH_RISK' : 'NORMAL'));
output._broad_scanner_bias_path = __isBroadScanner;
output._broad_scanner_bias_score = __broadScannerBiasScore;
output._backtest_required = __backtestRequired;
output._backtest_valid = __backtestValid;
output._backtest_enforcement_action = __isBroadScanner ? output._backtest_enforcement_action : __btThresholds.action;
output._backtest_threshold_action = __isBroadScanner ? 'BROAD_SCANNER_BIAS_PATH' : __btThresholds.action;
output._backtest_relaxed_thresholds = __isBroadScanner ? false : __btThresholds.relaxed;
output._used_min_trades = __isBroadScanner ? 0 : __btThresholds.minTrades;
output._used_min_pf = __isBroadScanner ? 0 : __btThresholds.minPf;
if (!__isBroadScanner && __btThresholds.relaxed) console.log(`BACKTEST RELAXED for ${output.ticker || output.symbol || 'UNKNOWN'} → trades=${__btSample ?? 'N/A'} pf=${__btPf ?? 'N/A'} (${__btThresholds.isHighVol ? 'high-vol' : 'pre-market'})`);
output._backtest_sample_size = __btSample;
output._backtest_profit_factor = __btPf;
output._backtest_win_rate = __btWin;
output._backtest_entry_class = __isBroadScanner ? 'BROAD_SCANNER' : (__isScalp ? 'SCALP' : (__isHighRisk ? 'HIGH_RISK' : 'NORMAL'));
output._backtest_enforcement_reason = __btReasons.join('; ') || 'OK';
output.backtest_sample_size = __btSample !== null ? String(__btSample) : (output.backtest_sample_size || '0');
output.backtest_profit_factor = __btPf !== null ? String(__btPf) : (output.backtest_profit_factor || '0');
output.backtest_win_rate = __btWin !== null ? String(__btWin) : (output.backtest_win_rate || '0');
output._backtest_status = __isBroadScanner ? 'BROAD_SCANNER_BIAS_PATH' : (__backtestValid ? 'BACKTEST_DATA_OK' : 'NO_BACKTEST_DATA');
output._backtest_available = __isBroadScanner ? false : (__btSample !== null && __btSample > 0 && __btPf !== null);
output._pf_required = !__isBroadScanner && __backtestRequired;
output._symbol_backtest_required = !__isBroadScanner && __backtestRequired;
output._risk_profile = __isBroadScanner ? 'BROAD_SCANNER_REDUCED_SIZE' : (output._risk_profile || 'DEFAULT');
output._risk_base_size_mult = __isBroadScanner ? 0.35 : (output._risk_base_size_mult ?? 1.0);
output._risk_stop_mult = __isBroadScanner ? 1.60 : (output._risk_stop_mult ?? 1.0);
output._risk_slippage_bps = __isBroadScanner ? 18 : (output._risk_slippage_bps ?? 8);
output._backtest_failure_reason = __backtestValid ? '' : `BACKTEST_ENFORCEMENT_FAILED: ${output._backtest_enforcement_reason}`;

if (__isBroadScanner && __broadScannerEligible) {
  const __oldV2 = Number(output.live_vc_score_v2 ?? output.vc_live_v2 ?? output._vc_score ?? 0);
  output._vc_score_before_broad_scanner_bias_path = Number.isFinite(__oldV2) ? __oldV2 : null;
  output.live_vc_score_v2 = __broadScannerBiasScore;
  output.vc_live_v2 = __broadScannerBiasScore;
  output.live_vc_score = __broadScannerBiasScore;
  output._vc_score = __broadScannerBiasScore;
  output.vc_score = __broadScannerBiasScore;
  output.vc_verdict = 'PASS';
  output._vc_verdict = 'PASS';
  output._vc_backtest_cap_applied = false;
  output._backtest_enforcement_action = 'BROAD_SCANNER_BIAS_PATH_ALLOW';
  output._broad_scanner_live_eligible = true;
  output.live_eligible = true;
  output.parser_decision = 'PASS';
  output.parser_rejection_reasons = [];
  output._parser_log = `BROAD_SCANNER signal passed parser → bias score ${__btBias ?? 'N/A'} → LIVE ELIGIBLE`;
  console.log(output._parser_log);
} else if (__isBroadScanner && __broadScannerRejectReason) {
  output._vc_score_before_broad_scanner_reject = Number(output.live_vc_score_v2 ?? output.vc_live_v2 ?? output._vc_score ?? 0);
  output.live_vc_score_v2 = Math.min(Number.isFinite(output._vc_score_before_broad_scanner_reject) ? output._vc_score_before_broad_scanner_reject : 0, 6.9);
  output.vc_live_v2 = output.live_vc_score_v2;
  output._vc_score = output.live_vc_score_v2;
  output.vc_verdict = 'REJECT';
  output._vc_verdict = 'REJECT';
  output._vc_backtest_cap_applied = false;
  output._backtest_enforcement_action = 'BROAD_SCANNER_BIAS_PATH_REJECT';
  output._broad_scanner_live_eligible = false;
  output.live_eligible = false;
  output.parser_decision = 'REJECT';
  output.parser_rejection_reasons = [__broadScannerRejectReason];
  output.blocked_stage = output.blocked_stage || 'BROAD_SCANNER_BIAS_PATH';
  output._parser_log = `BROAD_SCANNER signal rejected by parser → bias score ${__btBias ?? 'N/A'} → reasons=${__broadScannerRejectReason}`;
  console.log(output._parser_log);
} else if (__backtestRequired && !__backtestValid) {
  const __oldV2 = Number(output.live_vc_score_v2 ?? output.vc_live_v2 ?? output._vc_score ?? 0);
  const __capped = Math.min(Number.isFinite(__oldV2) ? __oldV2 : 0, 6.9);
  output._vc_score_before_backtest_cap = Number.isFinite(__oldV2) ? __oldV2 : null;
  output.live_vc_score_v2 = __capped;
  output.vc_live_v2 = __capped;
  output._vc_score = __capped;
  output.vc_verdict = 'REJECT';
  output._vc_verdict = 'REJECT';
  output._vc_backtest_cap_applied = true;
  output._backtest_enforcement_result = 'VC_SCORE_CAPPED_BELOW_7';
  output._backtest_enforcement_action = __btThresholds.action;
  output.parser_rejection_reasons = __btReasons;
  output.blocked_stage = output.blocked_stage || 'BACKTEST_ENFORCEMENT';
  output.feedback = `${output.feedback || output.vc_feedback || ''}

BACKTEST ENFORCEMENT: ${__btExecution} ${output.ticker || output.symbol || 'UNKNOWN'} is ${output._backtest_entry_class}; missing/weak backtest proof (${output._backtest_enforcement_reason}). VC score capped below 7. No paper order should route.`.trim();
  output._parser_log = `QTP parser rejected ${output._backtest_entry_class} → reasons=${output._backtest_enforcement_reason}`;
  console.log(output._parser_log);
} else {
  output._vc_backtest_cap_applied = false;
  output._backtest_enforcement_result = __backtestRequired ? 'BACKTEST_VALID_ALLOW_CONTINUE' : (__isBroadScanner ? 'BROAD_SCANNER_BIAS_PATH_NOT_REQUIRED' : 'BACKTEST_NOT_REQUIRED');
  output._backtest_enforcement_action = __backtestRequired ? __btThresholds.action : (__isBroadScanner ? 'BROAD_SCANNER_BIAS_PATH_NOT_REQUIRED' : 'BACKTEST_NOT_REQUIRED');
  output.parser_rejection_reasons = [];
}


// === v6.1 KILL-PRESERVATION GUARD — final override ===
// Runs after backtest enforcement and neutral suppression, BEFORE the feedback ladder. If the raw
// VC Agent verdict was KILL, force the canonical output fields back to KILL semantics so
// downstream consumers (audit log, Telegram, dashboards) see KILL rather than a REJECT
// produced by the calibration formula or the backtest cap block.
if (_raw_is_kill) {
  output.live_vc_score = 0;
  output.live_vc_score_v2 = 0;
  output.vc_live_v2 = 0;
  output._vc_score = 0;
  output._vc_score_legacy = 0;
  output._vc_verdict = 'KILL';
  output._vc_verdict_legacy = 'KILL';
  output.vc_verdict = 'KILL';
  output._vc_pass = false;
  output._vc_pass_legacy = false;
  output._vc_gate_candidate_v2_pass = false;
  output._vc_gate_candidate_legacy_pass = false;
  output._vc_parity_delta = 0;
  output._vc_kill_reason = _raw_kill_reason;
  output._vc_kill_preserved = true;
  if (output._vc_shadow_calibration && typeof output._vc_shadow_calibration === 'object') {
    output._vc_shadow_calibration.legacy_live_vc_score = 0;
    output._vc_shadow_calibration.live_vc_score_v2 = 0;
  }
}
// === END v6.1 KILL-PRESERVATION GUARD final override ===

// QTP-VC-FEEDBACK v4.2.1 — force meaningful feedback text for every VC decision.
const __ticker = String(output.ticker || output.symbol || $json.ticker || $json.symbol || 'UNKNOWN').toUpperCase();
const __direction = String(output.execution || output.signal || $json.execution || $json.signal || 'UNKNOWN').toUpperCase();
const __score = Number(output.live_vc_score_v2 ?? output.live_vc_score ?? output._vc_score ?? 0);
const __verdict = String(output._vc_verdict || output.vc_verdict || (__score >= 7 ? 'PASS' : 'REJECT')).toUpperCase();

let __feedback = output.vc_feedback || output.feedback || output.ai_feedback || output.grok_feedback || output.reasoning || output.analysis || output.final_feedback || output._vc_feedback || '';
let __redFlags = output.red_flags || output.vc_red_flags || output.grok_red_flags || output.risk_flags || output._vc_red_flags || '';
if (Array.isArray(__redFlags)) { __redFlags = __redFlags.join('\n- '); }

if (!String(__feedback).trim() || String(__feedback).trim().toLowerCase() === 'no feedback') {
  const bias = output.bias_score ?? output.ai_super_score ?? output.composite_score ?? output.score ?? 'N/A';
  const regime = output.regime ?? output.ca_regime ?? output.cross_asset_status ?? 'N/A';
  const rsi = output.rsi ?? 'N/A';
  const options = output.options_regime ?? output.opt_regime ?? 'N/A';
  const darkPool = output.dp_regime ?? 'N/A';
  const volume = output.volume_ratio ?? 'N/A';

  if (__verdict === 'PASS') {
    __feedback = `VC PASS: ${__ticker} ${__direction} scored ${__score}/10. ` +
                 `Signal passed the VC quality gate with bias ${bias}, regime ${regime}, RSI ${rsi}, ` +
                 `options regime ${options}, dark-pool regime ${darkPool}, and volume ratio ${volume}. ` +
                 `Bias Filter, Risk Gate, pause guard, and Alpaca checks still apply before any subscriber execution alert.`;
  } else {
    __feedback = `VC REJECT: ${__ticker} ${__direction} scored ${__score}/10. ` +
                 `Signal did not meet the VC quality gate. Key context: bias ${bias}, regime ${regime}, RSI ${rsi}, ` +
                 `options regime ${options}, dark-pool regime ${darkPool}, and volume ratio ${volume}.`;
  }
}

output.vc_feedback = String(__feedback).trim();
output.feedback = output.vc_feedback;
output.ai_feedback = output.vc_feedback;
output._vc_feedback = output.vc_feedback;
output.red_flags = String(__redFlags || '').trim();
output._vc_feedback_version = 'QTP_VC_FEEDBACK_20260506';


return [{ json: output }];