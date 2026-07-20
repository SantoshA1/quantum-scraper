
// QTP_ANTHROPIC_MIGRATION_v1_20260720: xAI/Grok -> Anthropic Claude Opus 4.8 (PO-authorized).
// v5.0 (was Grok Signal Analyzer v4.3). Contracts preserved: STAND-ASIDE/FAST_ONLY guards,
// fail-closed on missing key, retry + latency telemetry (_grok_latency_ms/_grok_attempts names
// kept for bake-off continuity), SE-C3 fail-closed schema validation, WEAK/HOLD fallback.
const QTP_ANTHROPIC_KEY = String((typeof $vars !== 'undefined' && ($vars.ANTHROPIC_API_KEY || $vars.anthropic_api_key)) || ((($getWorkflowStaticData('global') || {})._credentials || {}).anthropic_api_key) || '').trim();
const QTP_ANTHROPIC_MODEL = String((typeof $vars !== 'undefined' && ($vars.ANTHROPIC_MODEL || $vars.anthropic_model)) || 'claude-opus-4-8').trim();
function qtpAnthropicKeyLooksReal(k) { return typeof k === 'string' && k.startsWith('sk-ant-') && k.length >= 40 && !/PLACEHOLDER|CHANGEME|YOUR[_-]?KEY|EXAMPLE|XXXX/i.test(k); }
function qtpAnthropicText(resp) { if (!resp || !Array.isArray(resp.content)) return ''; let t = ''; for (const b of resp.content) { if (b && b.type === 'text' && b.text) t += b.text; } return t.trim(); }
// Grok Signal Analyzer v4.3 — Adds retry + latency telemetry (2026-07-13): 2 attempts × 15s timeout
//       with 2s backoff (worst case ~32s, inside 240s workflow budget). A single transient xAI blip
//       no longer silently downgrades a passer to the WEAK/HOLD fallback. Emits _grok_latency_ms and
//       _grok_attempts for 30d bake-off telemetry.
// Grok Signal Analyzer v4.2 — Adds 20s httpRequest timeout (2026-07-13): timeout-less xAI call
//       + 120s workflow executionTimeout killed passer runs at this node before the catch/fail-soft
//       path could fire (exec 386623/386386 canceled at exactly +120s). On timeout the existing
//       WEAK/HOLD fallback advances the signal instead of stalling the whole execution.
// Grok Signal Analyzer v4.1 — Adds fail-closed schema validation (Fix #13 / SE-C3)
// v4.1: signal_verdict/trade_action are kept as free-form strings (downstream display-only via fmt()).
//       Only hard requirements are: content must be JSON object, all 3 keys present and non-empty,
//       confidence must be a finite number. Enum whitelisting was too strict and rewrote legit Grok
//       outputs like "confirmed" / "execute_buy". See session notes.
const item = $input.first().json;

// === GUARD: Only proceed for BUY/SELL executions ===
// STAND ASIDE, N/A, or neutral signals should NOT fire Alpaca or Telegram
const _exec = (item.execution || '').toString().toUpperCase().trim();
const _smAction = (item._sm_action || '').toUpperCase();
const _smRoute = (item._sm_route || '').toUpperCase();

if (_exec === 'STAND ASIDE' || _exec === '' || _exec === 'N/A' || _exec === '0') {
  console.log('[GROK SIG] Blocking STAND ASIDE/neutral — no trade, no Telegram:', item.ticker, _exec);
  return [];  // Stops Format Telegram + Alpaca Paper Trade from firing
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

// v4.3: per-attempt timeout + one retry. Constants named per No-Naked-Constant doctrine.
const GROK_TIMEOUT_MS = 20000; // per-attempt (Opus 4.8 latency headroom)
const GROK_MAX_ATTEMPTS = 2;
const GROK_RETRY_BACKOFF_MS = 2000;

const requestBody = {
  model: QTP_ANTHROPIC_MODEL,
  max_tokens: 512,
  temperature: 0,
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

// Extract ONLY the inner analysis content — not the whole API response object
// sanitizeMD in Format Telegram converts [ → ( and _ → space, so never pass raw JSON blobs
let choicesContent;
if (grokResponse) {
  const _t = qtpAnthropicText(typeof grokResponse === 'string' ? (() => { try { return JSON.parse(grokResponse); } catch (e) { return null; } })() : grokResponse);
  // Defensive: strip markdown fences if the model fenced despite instructions (SE-C3 validates after)
  choicesContent = _t ? _t.replace(/```json|```/g, '').trim() : JSON.stringify(grokResponse);
} else {
  choicesContent = JSON.stringify({ signal_verdict: "WEAK", confidence: 5, trade_action: "HOLD", error: grokError || "API unavailable" });
}

// === SE-C3 SCHEMA VALIDATION (fail-closed, minimal-regression) ===
// Minimum contract: content parses as a JSON object with non-empty string
// signal_verdict, non-empty string trade_action, and a finite numeric confidence.
// NO enum whitelisting — Grok vocabulary ("confirmed","execute_buy") is preserved
// because downstream Format Telegram displays these verbatim via fmt() helpers and
// APT does not branch on Grok fields.
// On any violation: replace content with a safe WEAK/HOLD fallback (identical shape
// to existing error-path fallback at L67) and flag _grok_schema_error for observability.

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

// Skip validation if we already used the error-path fallback (grokError is set)
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
    // Required fields (presence + type only)
    const missing = [];
    if (typeof parsed.signal_verdict !== 'string' || !parsed.signal_verdict.trim()) missing.push('signal_verdict');
    if (parsed.confidence === undefined || parsed.confidence === null) missing.push('confidence');
    if (typeof parsed.trade_action !== 'string' || !parsed.trade_action.trim()) missing.push('trade_action');
    if (missing.length) throw new Error('missing_fields: ' + missing.join(','));

    // confidence must be finite numeric (accept string that coerces cleanly)
    const confNum = Number(parsed.confidence);
    if (!Number.isFinite(confNum)) {
      throw new Error('invalid_confidence: ' + parsed.confidence);
    }
    // Keep signal_verdict/trade_action exactly as Grok produced them (downstream display-only)
    // Re-serialize with normalized numeric confidence so downstream sees a clean number.
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
