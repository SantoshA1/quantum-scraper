
// QTP_ANTHROPIC_MIGRATION_v1.1_20260720 (temperature REMOVED: claude-opus-4-8 400s on explicit temperature; bisected exec 421425): xAI/Grok -> Anthropic Claude Opus 4.8 (PO-authorized).
// Contract preserved: output shape choices[0].message.content + AIJSON tail + _grok_ai_* telemetry
// field NAMES kept (downstream parsers/audit reference them); _ai_provider/_ai_model added.
const QTP_ANTHROPIC_KEY = String((typeof $vars !== 'undefined' && ($vars.ANTHROPIC_API_KEY || $vars.anthropic_api_key)) || ((($getWorkflowStaticData('global') || {})._credentials || {}).anthropic_api_key) || '').trim();
const QTP_ANTHROPIC_MODEL = String((typeof $vars !== 'undefined' && ($vars.ANTHROPIC_MODEL || $vars.anthropic_model)) || 'claude-opus-4-8').trim();
// Seed-then-publish doctrine (07-08 Telegram incident): reject placeholder-shaped keys, not just missing.
function qtpAnthropicKeyLooksReal(k) { return typeof k === 'string' && k.startsWith('sk-ant-') && k.length >= 40 && !/PLACEHOLDER|CHANGEME|YOUR[_-]?KEY|EXAMPLE|XXXX/i.test(k); }
function qtpAnthropicText(resp) { if (!resp || !Array.isArray(resp.content)) return ''; let t = ''; for (const b of resp.content) { if (b && b.type === 'text' && b.text) t += b.text; } return t.trim(); }
// Claude AI Analysis v2.0 (was Grok AI Analysis v1.0) — Replaces stub "return $input.all()"
// Purpose: Produce narrative analysis of the enriched signal for consumption
// by VC Agent Gatekeeper (reads choices[0].message.content as rawAnalysis).
// Failure mode: non-fatal — on any Anthropic error, pass through with a safe
// placeholder so the VC pipeline continues (VC downstream already handles
// 'AI analysis unavailable' gracefully).

const item = $input.first().json;

// Guard: if no ticker / no signal payload, bail through
if (!item || !item.ticker) {
  return [{ json: { ...item, choices: [{ message: { content: 'AI analysis unavailable (no signal payload)' } }], _grok_ai_called: false } }];
}

// Fetch credential from staticData (n8n Cloud: $env blocked)
const API_KEY = QTP_ANTHROPIC_KEY;
if (!qtpAnthropicKeyLooksReal(API_KEY)) {
  // Non-fatal: let the pipeline proceed without AI color (same degradation as pre-migration)
  console.error('[CLAUDE AI ANALYSIS] ANTHROPIC_API_KEY missing/placeholder — passing through without analysis');
  return [{
    json: {
      ...item,
      choices: [{ message: { content: 'AI analysis unavailable (anthropic_api_key missing or placeholder)' } }],
      _grok_ai_called: false,
      _grok_ai_error: 'anthropic_api_key missing or placeholder',
      _ai_provider: 'anthropic', _ai_model: QTP_ANTHROPIC_MODEL
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
  const systemPrompt = 'You are a senior quantitative trading analyst. Given a signal snapshot, produce a concise 150-200 word analytical summary covering: (1) direction conviction and key contradictions, (2) market regime alignment, (3) options/dark-pool/cross-asset context, (4) notable risks. Write prose (not JSON). Be direct, evidence-based, and highlight red flags. End your analysis with one final line in exactly this format: AIJSON:{"action":"BUY"|"SELL"|"HOLD","confidence":<0-100>,"bull_score":<0-100>,"bear_score":<0-100>,"risk_note":"<max 12 words>"}';
  const requestBody = {
    model: QTP_ANTHROPIC_MODEL,
    max_tokens: 600,
    system: systemPrompt,
    messages: [
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
    url: 'https://api.anthropic.com/v1/messages',
    headers: {
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(requestBody),
    timeout: 25000
  });
} catch (e) {
  grokError = e.message || String(e);
  console.error('[CLAUDE AI ANALYSIS] Anthropic call failed:', grokError);
}

const _claudeText = qtpAnthropicText(grokResponse);
if (_claudeText) {
  content = _claudeText;
} else if (grokError) {
  content = `AI analysis unavailable (anthropic error: ${grokError})`;
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
    _ai_provider: 'anthropic', _ai_model: QTP_ANTHROPIC_MODEL,
    ..._aiStruct
  }
}];