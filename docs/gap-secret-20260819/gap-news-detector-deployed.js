const raw = $input.first().json;
const d = raw.body && raw.body.ticker ? raw.body : raw;
const state = $getWorkflowStaticData('global');

if (!state.gapDetector) {
  state.gapDetector = {
    overridesToday: {},
    lastResetDate: '',
    previousCloses: {},
    lastVix: 0,
  };
}

const gd = state.gapDetector;
const now = new Date();
const todayET = now.toLocaleDateString('en-US', { timeZone: 'America/New_York' });
if (gd.lastResetDate !== todayET) {
  gd.overridesToday = {};
  gd.lastResetDate = todayET;
}

const ticker = (d.ticker || '').toString().toUpperCase();
const price = parseFloat(d.price) || 0;
const execution = (d.execution || 'STAND ASIDE').toString().toUpperCase();
const signal = (d.signal || 'NEUTRAL').toString().toUpperCase();
const vix = parseFloat(d.vix) || 0;
const volRatio = parseFloat(d.volume_ratio) || 0;
const spyChangePct = parseFloat(d.spy_change_pct) || 0;
const qqqChangePct = parseFloat(d.qqq_change_pct) || 0;
const dailyDdHalt = (d.daily_dd_halt || '').toString().toLowerCase() === 'true';
const gapPct = parseFloat(d.gap_pct) || 0;

const hourET = parseInt(now.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit' }));
const minET = parseInt(now.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false, minute: '2-digit' }));
const inSession = (hourET > 9 || (hourET === 9 && minET >= 30)) && hourET < 16;

if (ticker && price > 0) gd.previousCloses[ticker] = price;

let eventType = 'NONE';
let eventDirection = 'NEUTRAL';
let eventConfidence = 0;
let eventDescription = '';
let shouldOverride = false;

const absGap = Math.abs(gapPct);
if (absGap >= 1.5) {
  eventType = 'GAP';
  eventDirection = gapPct < 0 ? 'BEARISH' : 'BULLISH';
  eventConfidence = Math.min(100, Math.round(absGap * 20));
  eventDescription = (gapPct > 0 ? 'Gap UP ' : 'Gap DOWN ') + Math.abs(gapPct).toFixed(1) + '%';
}

const spyAbsChange = Math.abs(spyChangePct);
const qqqAbsChange = Math.abs(qqqChangePct);
if ((spyAbsChange > 2.0 || qqqAbsChange > 2.0) && volRatio >= 1.5) {
  if (eventType === 'NONE' || eventConfidence < 50) {
    eventType = 'MOMENTUM_SURGE';
    eventDirection = spyChangePct > 0 ? 'BULLISH' : 'BEARISH';
    eventConfidence = Math.min(100, Math.round(Math.max(spyAbsChange, qqqAbsChange) * 25));
    eventDescription = 'Market surge: SPY ' + (spyChangePct > 0 ? '+' : '') + spyChangePct.toFixed(1) + '%, QQQ ' + (qqqChangePct > 0 ? '+' : '') + qqqChangePct.toFixed(1) + '%, vol ' + volRatio.toFixed(1) + 'x';
  }
}

if (vix > 30 && gd.lastVix > 0 && gd.lastVix < 28) {
  if (eventType === 'NONE') {
    eventType = 'VIX_SPIKE';
    eventDirection = 'BEARISH';
    eventConfidence = Math.min(100, Math.round((vix - 25) * 10));
    eventDescription = 'VIX spiked to ' + vix.toFixed(1) + ' (was ' + gd.lastVix.toFixed(1) + ')';
  }
} else if (vix < 20 && gd.lastVix > 25) {
  if (eventType === 'NONE') {
    eventType = 'VIX_COLLAPSE';
    eventDirection = 'BULLISH';
    eventConfidence = 60;
    eventDescription = 'VIX collapsed to ' + vix.toFixed(1) + ' (was ' + gd.lastVix.toFixed(1) + ')';
  }
}

if (vix > 0) gd.lastVix = vix;

const isStandAside = execution.includes('STAND ASIDE') || signal === 'NEUTRAL';
const overridesUsed = gd.overridesToday[ticker] || 0;
const canOverride = overridesUsed < 1;

if (eventType !== 'NONE' && isStandAside && canOverride && inSession && !dailyDdHalt && eventConfidence >= 40) {
  shouldOverride = true;
  gd.overridesToday[ticker] = overridesUsed + 1;
}

const output = { ...d };
// QTP_GAP_NEWS_SESSION_PASSTHROUGH_v1_20260528
// Fix: upstream Session Regime Classifier + Extended Hours Mode Gate write
// session fields at the top level of the input item. The `d = raw.body` ladder
// above pulls from the original webhook body, which strips them. Re-attach the
// session flags so the SSM session gate v2 can see them downstream.
const _sessionFields = ['market_session','is_extended_hours','session_tradable_clock',
  'extended_hours_execution_allowed','extended_hours_mode','session_transition_reason',
  'session_clock_v','extended_hours_mode_gate_v','qtp_full_extended_hours_mode',
  'qtp_extended_hours_live_allowed','qtp_extended_hours_paper_only'];
for (const _f of _sessionFields) {
  if (raw[_f] !== undefined && output[_f] === undefined) output[_f] = raw[_f];
}

output._event_type = eventType;
output._event_direction = eventDirection;
output._event_confidence = eventConfidence;
output._event_description = eventDescription;
output._event_override = shouldOverride;

if (shouldOverride) {
  output.execution = eventDirection === 'BULLISH' ? 'BUY' : 'SELL';
  output.signal = eventDirection;
  output.alert_type = 'EVENT_OVERRIDE';
  output.comment = 'EVENT OVERRIDE [' + eventType + ']: ' + eventDescription + ' | Confidence: ' + eventConfidence + '% | Original: ' + execution + '/' + signal;
  output._event_size_mult = 0.5;
  output._event_override_reason = eventType + ' detected with ' + eventConfidence + '% confidence. ' + eventDescription + '. Override #' + (overridesUsed + 1) + ' for ' + ticker + ' today.';
}

// ── Permanent fix: propagate auth fields through flattening ──────────────
// Upstream webhook provides _secret in body and/or x-webhook-secret in headers.
// Preserve both so the Signal State Machine can authenticate without bypass hacks.
if (raw.body && raw.body._secret) output._secret = raw.body._secret;
else if (raw._secret) output._secret = raw._secret;
// Also propagate header secret as fallback (for server-to-server calls)
const _gndHeaders = raw.headers || {};
if (_gndHeaders['x-webhook-secret']) output._header_webhook_secret = _gndHeaders['x-webhook-secret'];
// Propagate user-agent for TradingView fingerprinting
if (_gndHeaders['user-agent']) output._source_ua = _gndHeaders['user-agent'];


return [{ json: output }];