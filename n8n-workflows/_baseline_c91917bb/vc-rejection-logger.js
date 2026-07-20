// QTP_TEST_MODE_TELEGRAM_SUPPRESS_v4.2.7 — synthetic tests must not notify subscribers.
if ($json.test_mode === true || $json.test_mode === 'true') {
  return [];
}

// QTP_TV_WEBHOOK_0930_ET_HARD_SILENCE_20260512 — hard silence pre-9:30 ET webhook/session-suppressed diagnostics before Telegram.
{
  const __d = $input.first().json || {};
  const __ticker = String(__d.ticker || __d.symbol || '').toUpperCase();
  const __execution = String(__d.execution || __d.signal || __d.action || __d.direction || '').toUpperCase();
  const __now = new Date();
  const __et = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(__now).reduce((a,p)=>(a[p.type]=p.value,a),{});
  const __h = Number(__et.hour), __m = Number(__et.minute);
  const __regular = !['Sat','Sun'].includes(__et.weekday) && ((__h > 9 || (__h === 9 && __m >= 30)) && __h < 16);
  const __sessionSuppressed = ['SESSION_TIME_FILTER','SESSION_OR_NEUTRAL_FILTER'].includes(String(__d.blocked_stage || '')) || ['SESSION_SUPPRESSED','NEUTRAL_SUPPRESSED'].includes(String(__d._vc_verdict || __d.vc_verdict || __d.gate_decision || '').toUpperCase());
  if (__ticker && __execution && !__regular && __sessionSuppressed) {
    return [];
  }
}

// QTP_CYCLE_007_17_NODE_HARDENED_20260511 — Patch 4: normalize rejection status before formatting.
{
  const output = $input.first().json || {};
  output.qtp_cycle_version = 'QTP_CYCLE_007_17_NODE_HARDENED_20260511';
  output.parser_version = output.parser_version || output._vc_score_parser_version || 'QTP_CYCLE_007_17_NODE_HARDENED_20260511';
  if (output.blocked_stage === 'SESSION_OR_NEUTRAL_FILTER' || output._vc_stand_aside_neutral || String(output._vc_verdict || output.vc_verdict || '').toUpperCase() === 'NEUTRAL_SUPPRESSED') {
    output.vc_gate_status = 'NEUTRAL_SUPPRESSED';
    output._vc_verdict = 'NEUTRAL_SUPPRESSED';
    output.vc_verdict = 'NEUTRAL_SUPPRESSED';
    output.gate_decision = 'NEUTRAL_SUPPRESSED';
    output.feedback = 'NEUTRAL_SUPPRESSED: After-hours / neutral refresh suppressed by Cycle 007 session filter. Audit only.';
    output.vc_feedback = output.feedback;
    output.ai_feedback = output.feedback;
    output.blocked_stage = 'SESSION_OR_NEUTRAL_FILTER';
  } else if (output.gate_decision === 'BLOCKED_BY_ENTRY_QUALITY' || output.blocked_stage === 'BIAS_FILTER' || output._bias_filter_pass === false) {
    output.vc_gate_status = 'BLOCKED_BY_ENTRY_QUALITY';
    output._vc_verdict = 'BLOCKED_BY_ENTRY_QUALITY';
    output.vc_verdict = 'BLOCKED_BY_ENTRY_QUALITY';
    output.gate_decision = 'BLOCKED_BY_ENTRY_QUALITY';
  } else {
    output.vc_gate_status = output.gate_decision === 'PASS' ? 'AUTO-PASS' : (output.gate_decision || output._vc_verdict || 'UNKNOWN');
  }
}

// VC Rejection Logger v3 — Detailed rejection / blocked-signal notification
// QTP-VC-FEEDBACK-RICH-RESTORE_20260507
// Notification formatting only. Does not affect VC Gate, Bias Filter, Risk Gate, pause guard, Alpaca, or exits.

function escHtml(text) {
  if (text === undefined || text === null) return '';
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function asArray(v) {
  if (Array.isArray(v)) return v.filter(x => String(x || '').trim());
  if (v === undefined || v === null || v === '') return [];
  return String(v).split(/\n|\||;|•|-/).map(s => s.trim()).filter(Boolean);
}
function firstNonEmpty(...vals) {
  for (const v of vals) {
    if (v !== undefined && v !== null && String(v).trim() && String(v).trim().toLowerCase() !== 'no feedback') return v;
  }
  return '';
}
function scoreText(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '0';
  return String(Math.round(n * 10) / 10).replace(/\.0$/, '');
}

const NL = String.fromCharCode(10);
const prev = $input.first().json || {};

const _vcScoreRaw = prev._vc_score ?? prev.live_vc_score_v2 ?? prev.live_vc_score ?? prev.vc_score;
const _vcScore = Number(_vcScoreRaw ?? 0);
let vcVerdict = String(prev._vc_verdict || prev.vc_verdict || (_vcScore >= 7 ? 'PASS' : (_vcScore <= 3 ? 'KILL' : 'REJECT'))).toUpperCase();
const _isPreVcKill = String(prev._sm_action || '').toUpperCase() === 'KILLED' && prev._vc_score === undefined;
let _isSafetyBlocked = String(prev.alpaca_status || prev.order_status || prev.trade_status || '').toUpperCase().startsWith('BLOCKED') || !!prev._bias_filter_blocked;
const _hasVcDecision = prev._vc_score !== undefined || prev.live_vc_score_v2 !== undefined || prev._vc_verdict !== undefined || prev._vc_feedback !== undefined || prev.vc_feedback !== undefined;
// QTP_VC_REJECTION_BIAS_BLOCK_NOTIFY_20260507
// Items arriving on the VC Gate fallback can still carry _vc_verdict=PASS when VC score passed
// but the additive Bias >=65 condition failed. Treat this as a notification-only block.
const _biasScoreForBlock = Number(prev.bias_score ?? prev.ai_super_score ?? prev.composite_score ?? prev.bull_score ?? prev.bear_score ?? prev.score ?? 0);
const _vcGateBiasBlocked = _hasVcDecision && vcVerdict === 'PASS' && Number.isFinite(_biasScoreForBlock) && _biasScoreForBlock < 68;
const _vcGateScoreRejected = _hasVcDecision && Number.isFinite(_vcScore) && _vcScore < 7;
if (_vcGateBiasBlocked) {
  _isSafetyBlocked = true;
  vcVerdict = 'BLOCKED_BY_ENTRY_QUALITY';
  prev._bias_filter_blocked = true;
  prev.blocked_stage = 'VC_GATE_BIAS_FILTER';
  prev.blocked_reason = `Bias ${_biasScoreForBlock}% is below required 68% even though VC score passed. No subscriber order routed.`;
}
if (_vcGateScoreRejected && vcVerdict === 'PASS') vcVerdict = 'REJECT';

// Do not send PASS through rejection formatter unless a later safety gate explicitly blocked it.
if (!_isPreVcKill && !_isSafetyBlocked && vcVerdict === 'PASS') return [];
if (!_isPreVcKill && !_hasVcDecision && !_isSafetyBlocked) return [];
if (_isPreVcKill) vcVerdict = 'REJECT';
if (_isSafetyBlocked && vcVerdict === 'PASS') vcVerdict = 'BLOCKED';

const ticker = prev.ticker || prev.symbol || prev.sym || 'UNKNOWN';
const execution = prev.execution || prev.trade_action || prev.signal || prev.direction || prev.side || '?';
const price = prev.price || prev.close || prev.entry_price || prev.last_price || '?';
const tf = prev.timeframe || prev.tf || '?';
const isScalp = (String(tf) === '5' || String(tf) === '15');
const stratLabel = isScalp ? 'Scalp' : 'Swing';

// Dedup rejection/block notices per ticker every 15 minutes, but keep safety block visibility by ticker+stage.
const _rejState = $getWorkflowStaticData('global');
if (!_rejState._vcRejectLog) _rejState._vcRejectLog = {};
const _now = Date.now();
const _stage = prev._bias_filter_blocked ? 'BIAS' : (prev.blocked_stage || prev.alpaca_status || vcVerdict || 'REJECT');
const _dedupKey = ticker + '|' + _stage;
const _lastRej = _rejState._vcRejectLog[_dedupKey] || 0;
const _REJECT_COOLDOWN = 15 * 60 * 1000;
if (_now - _lastRej < _REJECT_COOLDOWN) {
  console.log('[VC REJECT] Suppressed duplicate for', _dedupKey, 'sent', Math.round((_now - _lastRej) / 1000), 's ago');
  return [];
}
_rejState._vcRejectLog[_dedupKey] = _now;
Object.keys(_rejState._vcRejectLog).forEach(k => {
  if (_now - _rejState._vcRejectLog[k] > 3600000) delete _rejState._vcRejectLog[k];
});

let vcScore = _isPreVcKill ? 0 : (_vcScoreRaw ?? 0);
let vcFeedback = firstNonEmpty(
  prev._vc_feedback,
  prev.vc_feedback,
  prev.feedback,
  prev.ai_feedback,
  prev.grok_feedback,
  prev.reasoning,
  prev.analysis,
  prev.brutal_feedback,
  prev.alpaca_reason,
  prev.blocked_reason
);
let redFlags = asArray(prev._vc_red_flags || prev.red_flags || prev.vc_red_flags || prev.grok_red_flags || prev.risk_flags);

if (_isPreVcKill) {
  vcScore = 0;
  const hard = String(prev._sm_contradiction_details || prev._sm_hard_contradictions || '').trim();
  const soft = String(prev._sm_soft_contradictions || '').trim();
  vcFeedback =
    'Blocked before VC Gate by Signal State Machine fail-closed logic. ' +
    String(prev._sm_reason || 'KILL gate triggered') +
    (hard ? ' Hard contradictions: ' + hard : '') +
    (soft && soft.toLowerCase() !== 'none' ? ' Soft contradictions: ' + soft : '');
  redFlags = hard ? asArray(hard) : [String(prev._sm_reason || 'Signal State Machine KILL')];
}

if (!String(vcFeedback || '').trim()) {
  const bias = prev.bias_score ?? prev.ai_super_score ?? prev.composite_score ?? prev.score ?? 'N/A';
  const regime = prev.regime ?? prev.ca_regime ?? prev.cross_asset_status ?? 'N/A';
  const rsi = prev.rsi ?? 'N/A';
  const options = prev.options_regime ?? prev.opt_regime ?? 'N/A';
  const darkPool = prev.dp_regime ?? 'N/A';
  const volume = prev.volume_ratio ?? 'N/A';
  vcFeedback = `${ticker} ${execution} was blocked by ${vcVerdict}. Context: score ${scoreText(vcScore)}/10, bias ${bias}, regime ${regime}, RSI ${rsi}, options regime ${options}, dark-pool regime ${darkPool}, volume ratio ${volume}.`;
}

let msg = '<b>VC GATE: ' + escHtml(vcVerdict) + ' [' + scoreText(vcScore) + '/10]</b>' + NL;
if (_isPreVcKill) msg += '<i>Pre-VC Signal State Machine block — no subscriber delivery, no Alpaca order.</i>' + NL;
if (_isSafetyBlocked && !_isPreVcKill) msg += '<i>Downstream safety block — no subscriber delivery unless Alpaca execution is confirmed separately.</i>' + NL;
msg += escHtml(ticker) + ' | ' + stratLabel + ' | ' + escHtml(execution) + ' @ $' + escHtml(price) + NL;

if (prev._vc_shadow_scanner_score !== undefined && prev._vc_shadow_scanner_score !== null) {
  const delta = Number(prev._vc_shadow_scanner_delta || 0);
  const deltaTxt = (delta >= 0 ? '+' : '') + delta;
  msg += 'Shadow scanner score: ' + escHtml(prev._vc_shadow_scanner_score) + '/10 (' + escHtml(prev._vc_shadow_scanner_verdict || '?') + ', delta ' + deltaTxt + ') — diagnostic only' + NL;
}

const _ts = prev._dq_data_timestamp || prev.data_timestamp || '';
const _mkt = prev._dq_market_status || prev.market_status || '';
if (_ts) msg += '<i>Data: ' + escHtml(_ts) + (_mkt ? ' | ' + escHtml(_mkt) : '') + '</i>' + NL;

msg += NL + '<b>Feedback:</b>' + NL;
msg += escHtml(vcFeedback).substring(0, 900) + NL;

if (redFlags.length > 0) {
  msg += NL + '<b>Red Flags:</b>' + NL;
  for (const flag of redFlags.slice(0, 7)) msg += '- ' + escHtml(flag).substring(0, 250) + NL;
}

const fixes = asArray(prev._vc_fixes || prev.suggested_fixes || prev.fixes);
if (fixes.length > 0) {
  msg += NL + '<b>Suggested Fixes:</b>' + NL;
  for (const fix of fixes.slice(0, 3)) msg += '- ' + escHtml(fix).substring(0, 250) + NL;
}

msg += NL + '<i>Signal blocked from subscribers. Review and improve.</i>';

return [{ json: { ...prev, message: msg, _vc_rejection_logger_version: 'QTP_VC_REJECTION_RICH_RESTORE_20260507' } }];
