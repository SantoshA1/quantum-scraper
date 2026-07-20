// Alert Logger v1.1 — Formats every signal for Supabase audit logging
// Runs on ALL FULL-route signals (PASS and REJECT) for complete tracking
const NL = String.fromCharCode(10);
const prev = $input.first().json;

// Use the signal's original webhook timestamp as the stable row key.
// This ensures appendOrUpdate finds the same row whether we are writing
// the initial SM data or enriching with VC/Grok scores later.
const _signalTs = prev._signal_timestamp || prev.signal_timestamp || null;
const now = _signalTs ? new Date(_signalTs) : new Date();
const timestamp = now.toLocaleString('en-US', { timeZone: 'America/New_York' });
const dateStr = now.toLocaleDateString('en-US', { timeZone: 'America/New_York' });

const ticker = prev.ticker || 'UNKNOWN';
const tf = prev.timeframe || '?';
const isScalp = (tf === '5' || tf === '15');
const stratLabel = isScalp ? 'Scalp' : 'Swing';
const execution = prev.execution || '?';
const signal = prev.signal || '?';
const price = prev.price || '0';

// Scores
const bullScore = prev.bull_score || '0';
const bearScore = prev.bear_score || '0';
const rsi = prev.rsi || '0';
const adx = prev.adx || '0';
const vix = prev.vix || '0';
const regime = prev.regime || '?';
const dailyTrend = prev.daily_trend || '?';

// Backtest
const stratNet = prev.strat_net_pct || '0';
const stratWR = prev.strat_win_rate || '0';
const stratPF = prev.strat_profit_factor || '0';
const stratDD = prev.strat_max_dd || '0';
const stratTrades = prev.strat_total_trades || '0';

// Market
const spyStatus = prev.spy_status || '?';
const qqqStatus = prev.qqq_status || '?';

// Options / Dark Pool / Cross-Asset
const optRegime = prev.opt_regime || 'N/A';
const dpRegime = prev.dp_regime || 'N/A';
const caRegime = prev.ca_regime || 'N/A';
const caScore = prev.ca_composite_score || '50';

// VC Agent
const vcScore = prev._vc_score || 0;
const vcVerdict = prev._vc_verdict || '?';
const vcFeedback = prev._vc_feedback || '';
const vcRedFlags = (prev._vc_red_flags || []).join('; ');

// Grok Signal Analyzer fields
const grokAnalysis = prev.grok_signal_analysis || '';
const grokRecommendation = prev.grok_recommendation || '';
const grokTimestamp = prev.grok_analyzer_timestamp || '';
const grokError = prev.grok_analyzer_error || '';const vcPass = prev._vc_pass === true ? 'YES' : 'NO';

// SM fields
const smConfidence = prev._sm_confidence || '?';

// Risk fields
const ddHalt = prev.daily_dd_halt || 'false';
const vixSizeMult = prev.vix_size_mult || '1.0';
const effSize = prev.eff_position_size || '10';

// Sanitise: strip webhook noise keys + convert nested objects to strings
// SKIP_KEYS: fields injected by n8n webhook that have no sheet column → cause "Bad request"
const SKIP_KEYS = new Set([
  // Webhook noise — n8n injected, no sheet column
  'headers','params','query','body','webhookUrl','executionMode',
  // Event fields — no sheet column
  '_event_type','_event_direction','_event_confidence','_event_description','_event_override',
  // SM internal fields not in sheet
  '_signal_timestamp','_sm_heartbeat_promoted','_sm_promotion_reason',
  '_sm_active_tickers', // QTP_WRO_METADATA_NORMALIZATION_20260506 preserves _sm_raw_score
  
  // Duplicate / computed / raw API fields
  'symbol','action','source','_enriched','_enriched_fields',
  'choices',          // raw Grok API response array — causes Bad request
  '_vc_grok_error','Trade_Status'
]);
const sanitised = {};
for (const [k, v] of Object.entries(prev)) {
  if (SKIP_KEYS.has(k)) continue;          // drop webhook/noise keys — no sheet column for these
  if (v === null || v === undefined) {
    sanitised[k] = '';
  } else if (typeof v === 'object') {
    // Stringify nested objects/arrays — prevents "Bad request" from Sheets API
    sanitised[k] = JSON.stringify(v).substring(0, 500);
  } else {
    sanitised[k] = v;
  }
}

return [{
  json: {
    ...sanitised,
    // Also include the clean formatted columns for the visible columns in the sheet
    'Timestamp':   timestamp,
    'Date':        dateStr,
    'Ticker':      ticker,
    'Strategy':    stratLabel,
    'TF':          tf,
    'Execution':   execution,
    'Signal':      signal,
    'Price':       price,
    'Bull':        bullScore,
    'Bear':        bearScore,
    'Net%':        stratNet,
    'WR%':         stratWR,
    'PF':          stratPF,
    'MaxDD':       stratDD,
    'Trades':      stratTrades,
    'VC Score':    vcScore,
    'VC Verdict':  vcVerdict,
    'VC Pass':     vcPass,
    'WRO Shadow Stale Neutral': prev._wro_shadow_stale_neutral_refresh_candidate === true ? 'YES' : 'NO',
    'WRO Shadow Reason': prev._wro_shadow_stale_neutral_reason || '',
    'WRO Metadata Complete': prev._wro_shadow_metadata_complete === true ? 'YES' : 'NO',
    'Shadow Scanner Score': prev._vc_shadow_scanner_score ?? '',
    'Shadow Scanner Verdict': prev._vc_shadow_scanner_verdict ?? '',
    'Shadow Scanner Delta': prev._vc_shadow_scanner_delta ?? '',
    'trade_status': 'PENDING',   // lowercase matches sheet column
  }
}];