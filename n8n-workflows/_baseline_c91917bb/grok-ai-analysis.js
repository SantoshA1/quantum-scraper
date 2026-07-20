
// QTP-xAI-EXEC: native xAI/Grok credential fallback and cost-optimized model.
const QTP_XAI_KEY = String((typeof $vars !== 'undefined' && ($vars.XAI_API_KEY || $vars.xai_api_key)) || ((($getWorkflowStaticData('global') || {})._credentials || {}).xai_api_key) || '').trim();
const QTP_XAI_MODEL = String((typeof $vars !== 'undefined' && ($vars.XAI_MODEL || $vars.XAI_VC_MODEL || $vars.XAI_DAILY_MODEL)) || 'grok-3-mini');
// Grok AI Analysis v1.0 — Replaces stub "return $input.all()"
// Purpose: Produce narrative analysis of the enriched signal for consumption
// by VC Agent Gatekeeper (reads choices[0].message.content as rawAnalysis).
// Failure mode: non-fatal — on any xAI error, pass through with a safe
// placeholder so the VC pipeline continues (VC downstream already handles
// 'AI analysis unavailable' gracefully).

const item = $input.first().json;

// Guard: if no ticker / no signal payload, bail through
if (!item || !item.ticker) {
  return [{ json: { ...item, choices: [{ message: { content: 'AI analysis unavailable (no signal payload)' } }], _grok_ai_called: false } }];
}

// Fetch credential from staticData (n8n Cloud: $env blocked)
const _creds = ($getWorkflowStaticData('global') || {})._credentials || {};
const API_KEY = QTP_XAI_KEY;
if (!API_KEY) {
  // Non-fatal: let the pipeline proceed without AI color
  console.error('[GROK AI ANALYSIS] xai_api_key missing — passing through without analysis');
  return [{
    json: {
      ...item,
      choices: [{ message: { content: 'AI analysis unavailable (xai_api_key missing)' } }],
      _grok_ai_called: false,
      _grok_ai_error: 'xai_api_key missing'
    }
  }];
}

// Build compact signal context for the prompt
const ticker = item.ticker || 'UNKNOWN';
const execution = item.execution || 'UNKNOWN';
const signalDir = item.signal || 'UNKNOWN';
const price = item.price || '0';
const tf = item.timeframe || '?';
const regime = item.regime || 'UNKNOWN';
const bullScore = item.bull_score || '0';
const bearScore = item.bear_score || '0';
const rsi = item.rsi || 'N/A';
const adx = item.adx || 'N/A';
const macd = item.macd_hist || 'N/A';
const vix = item.vix || 'N/A';
const spyStatus = item.spy_status || 'UNKNOWN';
const qqqStatus = item.qqq_status || 'UNKNOWN';
const caStatus = item.cross_asset_status || 'UNKNOWN';
const optRegime = item.opt_regime || item.options_regime || 'NO_DATA';
const dpRegime = item.dp_regime || 'UNKNOWN';
const caRegime = item.ca_regime || 'UNKNOWN';
const btNet = item.strat_net_pct || '0';
const btTrades = item.strat_total_trades || '0';
const btWr = item.strat_win_rate || '0';
const smRoute = item._sm_route || 'UNKNOWN';
const smAction = item._sm_action || 'UNKNOWN';
const smConf = item._sm_max_confidence || '?';
const smContra = item._sm_contradiction_details || 'none';

let grokResponse = null;
let grokError = null;
let content = '';

try {
  const requestBody = {
    model: QTP_XAI_MODEL,
    temperature: 0.1,
    max_tokens: 600,
    messages: [
      {
        role: 'system',
        content: 'You are a senior quantitative trading analyst. Given a signal snapshot, produce a concise 150-200 word analytical summary covering: (1) direction conviction and key contradictions, (2) market regime alignment, (3) options/dark-pool/cross-asset context, (4) notable risks. Write prose (not JSON). Be direct, evidence-based, and highlight red flags. End your analysis with one final line in exactly this format: AIJSON:{"action":"BUY"|"SELL"|"HOLD","confidence":<0-100>,"bull_score":<0-100>,"bear_score":<0-100>,"risk_note":"<max 12 words>"}'
      },
      {
        role: 'user',
        content: `Analyze this signal:
Ticker: ${ticker} | Timeframe: ${tf}
Direction: ${execution} (${signalDir}) @ $${price}
Scores: Bull ${bullScore}, Bear ${bearScore} | Regime: ${regime}
Indicators: RSI ${rsi}, ADX ${adx}, MACD ${macd}, VIX ${vix}
Market: SPY ${spyStatus}, QQQ ${qqqStatus}, Cross-Asset ${caStatus}
Options regime: ${optRegime} | Dark Pool: ${dpRegime} | CA regime: ${caRegime}
Backtest: ${btNet}% net, ${btTrades} trades, ${btWr}% WR
State Machine: route=${smRoute} action=${smAction} confidence=${smConf}/9
Contradictions flagged upstream: ${smContra}`
      }
    ]
  };

  grokResponse = await this.helpers.httpRequest({
    method: 'POST',
    url: 'https://api.x.ai/v1/chat/completions',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(requestBody),
    timeout: 12000
  });
} catch (e) {
  grokError = e.message || String(e);
  console.error('[GROK AI ANALYSIS] xAI call failed:', grokError);
}

if (grokResponse && grokResponse.choices && grokResponse.choices[0] && grokResponse.choices[0].message && grokResponse.choices[0].message.content) {
  content = String(grokResponse.choices[0].message.content).trim();
} else if (grokError) {
  content = `AI analysis unavailable (xAI error: ${grokError})`;
} else {
  content = 'AI analysis unavailable (no content returned)';
}

// Trim defensively to 2000 chars — VC Gatekeeper will substring(0,2000) anyway
if (content.length > 2000) content = content.substring(0, 2000);

// QTP_GROK_AI_STRUCT_v1.0_20260702 - advisory/observability only.
// Parses the AIJSON tail line into structured fields. NOT wired into any
// gate, decision, or Telegram formatting logic. Fail-soft: never throws.
const _aiStruct = { ai_json_parsed: false, ai_struct_version: 'QTP_GROK_AI_STRUCT_v1.0_20260702' };
try {
  const _aim = String(content || '').match(/AIJSON:\s*(\{[\s\S]*?\})\s*$/);
  if (_aim) {
    const _aij = JSON.parse(_aim[1]);
    Object.assign(_aiStruct, {
      ai_action: String(_aij.action || '').toUpperCase() || null,
      ai_confidence: Number.isFinite(Number(_aij.confidence)) ? Number(_aij.confidence) : null,
      ai_bull_score: Number.isFinite(Number(_aij.bull_score)) ? Number(_aij.bull_score) : null,
      ai_bear_score: Number.isFinite(Number(_aij.bear_score)) ? Number(_aij.bear_score) : null,
      ai_risk_note: String(_aij.risk_note || '').slice(0, 120),
      ai_json_parsed: true
    });
  }
} catch (_aie) { _aiStruct.ai_json_parse_error = String(_aie).slice(0, 200); }

return [{
  json: {
    ...item,
    // Pass-through in the shape VC Agent Gatekeeper expects: choices[0].message.content
    choices: [{ message: { content } }],
    _grok_ai_called: Boolean(grokResponse && !grokError),
    _grok_ai_error: grokError || null,
    _grok_ai_content_len: content.length,
    ..._aiStruct
  }
}];