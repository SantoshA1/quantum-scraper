
// ── QTP_LLM_SELF_METERING_v1_20260722: exact token/cost log per Anthropic call (fail-open). ──
const QTP_SB_METER_URL = 'https://vdmtwmwpxvohodyrdlon.supabase.co/rest/v1/llm_usage_log';
const QTP_SB_METER_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZkbXR3bXdweHZvaG9keXJkbG9uIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg4NjA1MTIsImV4cCI6MjA5NDQzNjUxMn0.L25mbxslurVlh20LIb_QFYLELiKIWJd6YKJp6FsVVz4'; // anon key: publishable by design; table is INSERT-only under RLS
async function qtpMeterLLM(helpers, site, tkr, model, resp) {
  try {
    let u = resp;
    if (typeof u === 'string') { try { u = JSON.parse(u); } catch (pe) { u = null; } }
    u = u && u.usage;
    if (!u) return;
    const inT = Number(u.input_tokens || 0), outT = Number(u.output_tokens || 0);
    if (!(inT + outT > 0)) return;
    const pin = Number((typeof $vars !== 'undefined' && $vars.ANTHROPIC_PRICE_IN_PER_MTOK) || 15);
    const pout = Number((typeof $vars !== 'undefined' && $vars.ANTHROPIC_PRICE_OUT_PER_MTOK) || 75);
    const cost = (inT * pin + outT * pout) / 1e6;
    await helpers.httpRequest({ method: 'POST', url: QTP_SB_METER_URL, headers: { apikey: QTP_SB_METER_KEY, Authorization: 'Bearer ' + QTP_SB_METER_KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify({ call_site: site, model: String(model || ''), ticker: String(tkr || '').slice(0, 12), input_tokens: inT, output_tokens: outT, cost_usd: cost }), timeout: 4000 });
  } catch (me) {}
}

// QTP_ANTHROPIC_MIGRATION_v1.1_20260720 (temperature REMOVED: claude-opus-4-8 400s on explicit temperature; bisected exec 421425): xAI/Grok -> Anthropic Claude Opus 4.8 (PO-authorized).
// v5.1 (was Grok Signal Analyzer v4.3). Contracts preserved: STAND-ASIDE/FAST_ONLY guards,
// fail-closed on missing key, retry + latency telemetry, SE-C3 fail-closed schema validation, WEAK/HOLD fallback.
const QTP_ANTHROPIC_KEY = String((typeof $vars !== 'undefined' && ($vars.ANTHROPIC_API_KEY || $vars.anthropic_api_key)) || ((($getWorkflowStaticData('global') || {})._credentials || {}).anthropic_api_key) || '').trim();
const QTP_ANTHROPIC_MODEL = String((typeof $vars !== 'undefined' && ($vars.ANTHROPIC_MODEL || $vars.anthropic_model)) || 'claude-opus-4-8').trim();
function qtpAnthropicKeyLooksReal(k) { return typeof k === 'string' && k.startsWith('sk-ant-') && k.length >= 40 && !/PLACEHOLDER|CHANGEME|YOUR[_-]?KEY|EXAMPLE|XXXX/i.test(k); }
function qtpAnthropicText(resp) { if (!resp || !Array.isArray(resp.content)) return ''; let t = ''; for (const b of resp.content) { if (b && b.type === 'text' && b.text) t += b.text; } return t.trim(); }
const item = $input.first().json;

// === GUARD: Only proceed for BUY/SELL executions ===
const _exec = (item.execution || '').toString().toUpperCase().trim();
const _smAction = (item._sm_action || '').toUpperCase();
const _smRoute = (item._sm_route || '').toUpperCase();

if (_exec === 'STAND ASIDE' || _exec === '' || _exec === 'N/A' || _exec === '0') {
  console.log('[GROK SIG] Blocking STAND ASIDE/neutral — no trade, no Telegram:', item.ticker, _exec);
  return [];
}
if (_smRoute === 'FAST_ONLY' || _smRoute === 'SKIP') {
  console.log('[GROK SIG] Blocking FAST_ONLY/SKIP route at Grok Signal Analyzer:', item.ticker, _smRoute);
  return [];
}
const API_KEY = QTP_ANTHROPIC_KEY;
if (!qtpAnthropicKeyLooksReal(API_KEY)) {
  throw new Error('Anthropic credential missing/placeholder: $vars.ANTHROPIC_API_KEY — failing closed, no analyzer call.');
}

let grokResponse = null;
let grokError = null;
let _grokLatencyMs = null;
let _grokAttempts = 0;

const GROK_TIMEOUT_MS = 20000; // per-attempt (Opus 4.8 latency headroom)
const GROK_MAX_ATTEMPTS = 2;
const GROK_RETRY_BACKOFF_MS = 2000;

const requestBody = {
  model: QTP_ANTHROPIC_MODEL,
  max_tokens: 512,
  system: "You are the Quantum Trading VC Gatekeeper. Analyze the incoming TradingView alert and return ONLY a valid JSON object (no markdown fences, no prose) with keys: spy_correlation, sentiment, sweep_verdict, strategy_performance, options_flow, cross_asset, signal_verdict, confidence, trade_action, regime_tags. Be ruthless and data-driven.",
  messages: [
    {
      role: "user",
      content: `Analyze this signal: ticker=${item.ticker || 'UNKNOWN'} execution=${item.execution || 'UNKNOWN'} signal=${item.signal || 'NEUTRAL'} price=${item.price || '0'} regime=${item.regime || 'UNKNOWN'} bias_score=${item.bias_score || '0'} timeframe=${item.timeframe || '5'} sm_action=${item._sm_action || 'PASS'}`
    }
  ]
};

const _grokT0 = Date.now();
for (let _a = 1; _a <= GROK_MAX_ATTEMPTS; _a++) {
  _grokAttempts = _a;
  try {
    grokResponse = await this.helpers.httpRequest({
      method: 'POST',
      url: 'https://api.anthropic.com/v1/messages',
      headers: {
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody),
      timeout: GROK_TIMEOUT_MS
    });
    grokError = null;
    break;
  } catch (e) {
    grokError = e.message || String(e);
    console.error('[GROK] API call failed (attempt ' + _a + '/' + GROK_MAX_ATTEMPTS + '):', grokError);
    if (_a < GROK_MAX_ATTEMPTS) {
      await new Promise(r => setTimeout(r, GROK_RETRY_BACKOFF_MS));
    }
  }
}
_grokLatencyMs = Date.now() - _grokT0;
if (grokResponse) { await qtpMeterLLM(this.helpers, 'signal_analyzer', (item.ticker || 'UNKNOWN'), QTP_ANTHROPIC_MODEL, grokResponse); }

let choicesContent;
if (grokResponse) {
  const _t = qtpAnthropicText(typeof grokResponse === 'string' ? (() => { try { return JSON.parse(grokResponse); } catch (e) { return null; } })() : grokResponse);
  choicesContent = _t ? _t.replace(/```json|```/g, '').trim() : JSON.stringify(grokResponse);
} else {
  choicesContent = JSON.stringify({ signal_verdict: "WEAK", confidence: 5, trade_action: "HOLD", error: grokError || "API unavailable" });
}

// === SE-C3 SCHEMA VALIDATION (fail-closed, minimal-regression) ===
function buildFallback(reason) {
  return JSON.stringify({
    signal_verdict: 'WEAK',
    confidence: 5,
    trade_action: 'HOLD',
    error: 'schema_validation_failed: ' + reason
  });
}

let _grokSchemaError = null;
let _grokSchemaErrorDetail = null;

if (!grokError) {
  try {
    let parsed;
    try {
      parsed = JSON.parse(choicesContent);
    } catch (pe) {
      throw new Error('not_json: ' + (pe.message || 'parse error'));
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not_object');
    }
    const missing = [];
    if (typeof parsed.signal_verdict !== 'string' || !parsed.signal_verdict.trim()) missing.push('signal_verdict');
    if (parsed.confidence === undefined || parsed.confidence === null) missing.push('confidence');
    if (typeof parsed.trade_action !== 'string' || !parsed.trade_action.trim()) missing.push('trade_action');
    if (missing.length) throw new Error('missing_fields: ' + missing.join(','));
    const confNum = Number(parsed.confidence);
    if (!Number.isFinite(confNum)) {
      throw new Error('invalid_confidence: ' + parsed.confidence);
    }
    parsed.confidence = confNum;
    choicesContent = JSON.stringify(parsed);
    console.log('[GROK SCHEMA] OK verdict=' + parsed.signal_verdict + ' action=' + parsed.trade_action + ' conf=' + confNum + ' ticker=' + (item.ticker || 'UNKNOWN'));
  } catch (ve) {
    _grokSchemaError = true;
    _grokSchemaErrorDetail = ve.message;
    console.error('[GROK SCHEMA] FAIL-CLOSED: ' + ve.message + ' ticker=' + (item.ticker || 'UNKNOWN'));
    choicesContent = buildFallback(ve.message);
  }
}

return [{
  json: {
    ...item,
    choices: [{ message: { content: choicesContent } }],
    _grok_called: true,
    _grok_error: grokError || null,
    _grok_schema_error: _grokSchemaError || false,
    _grok_schema_error_detail: _grokSchemaErrorDetail || null,
    _grok_latency_ms: _grokLatencyMs,
    _grok_attempts: _grokAttempts,
    _ai_provider: 'anthropic', _ai_model: QTP_ANTHROPIC_MODEL
  }
}];
