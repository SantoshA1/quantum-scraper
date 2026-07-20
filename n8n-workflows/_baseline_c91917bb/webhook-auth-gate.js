
// Weekend Market Guard v1 — blocks all main trading webhook/internal payloads
// on Saturday/Sunday in America/New_York before signal/order processing.
// Health-check workflows remain separate and are not blocked here.
const nyNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
const nyDay = nyNow.getDay(); // 0=Sun, 6=Sat
if (nyDay === 0 || nyDay === 6) {
  return [{
    json: {
      market_open: false,
      blocked: true,
      reason: 'Weekend - US equities market closed',
      action: 'blocked_before_signal_or_order_execution',
      checked_at: new Date().toISOString(),
      checked_timezone: 'America/New_York',
      original_alert_type: $json.alert_type || $json.Alert_Type || null,
      original_ticker: $json.ticker || $json.symbol || $json.Ticker || null,
    }
  }];
}

// Webhook Auth Gate v1 — fail closed on TradingView inputs
// Validates body._secret matches expected webhook secret.
// Internal alert_types (HEARTBEAT, BROAD_SCANNER, REALTIME_AGENT_HYBRID, POLYGON_NEWS)
// bypass the _secret check because they are internal sub-workflow invocations, not TV alerts.
// Throws explicit AUTH_FAILED error on rejection.

const INTERNAL = new Set(['HEARTBEAT','BROAD_SCANNER','REALTIME_AGENT_HYBRID','POLYGON_NEWS']);

// Pull expected secret from workflow staticData; fall back to known documented value so
// a missing staticData entry does not fail-open.
const s = $getWorkflowStaticData('global');
const creds = (s && s._credentials) || {};
const FALLBACK = '<WEBHOOK_SECRET_LIVE_REDACTED>';
const expected = creds.webhook_secret || FALLBACK;

const items = $input.all();
const out = [];

// QTP_AUTH_GATE_PROMOTE_ALERT_TYPE_20260507
// After auth succeeds, promote TradingView body fields to top level so downstream
// monitors see alert_type/ticker/execution instead of UNKNOWN. Secrets are removed.
function sanitizeHeaders(h) {
  const out = {...(h || {})};
  for (const k of Object.keys(out)) {
    if (String(k).toLowerCase().includes('secret') || String(k).toLowerCase().includes('authorization')) delete out[k];
  }
  return out;
}
function sanitizeQuery(q) {
  const out = {...(q || {})};
  delete out._secret;
  delete out.secret;
  delete out.passphrase;
  return out;
}
function sanitizeBody(b) {
  const out = {...(b || {})};
  delete out._secret;
  delete out.secret;
  delete out.passphrase;
  return out;
}
function promoteAuthenticatedPayload(item, body, query, headers, alertType, ingressSource) {
  const cleanBody = sanitizeBody(body);
  const cleanQuery = sanitizeQuery(query);
  const cleanHeaders = sanitizeHeaders(headers);
  return {
    json: {
      ...(item.json || {}),
      ...cleanBody,
      body: cleanBody,
      query: cleanQuery,
      headers: cleanHeaders,
      alert_type: alertType,
      _alert_type: alertType,
      _auth_status: 'AUTH_OK',
      _auth_checked_at: new Date().toISOString(),
      _ingress_source: ingressSource,
      source: ingressSource,
      _tv_payload_shape: cleanBody._tv_payload_shape || ((cleanBody.ticker || cleanBody.symbol) ? 'ticker+market_fields' : 'control_or_unknown'),
      _original_alert_type: cleanBody._original_alert_type || alertType
    }
  };
}
for (const item of items) {
  const j = item.json || {};
  // Webhook node exposes body/query/headers. Some internal paths may pass json directly.
  const body = (j.body && typeof j.body === 'object') ? j.body : j;
  const query = (j.query && typeof j.query === 'object') ? j.query : {};
  const headers = (j.headers && typeof j.headers === 'object') ? j.headers : {};
  const headerSecret = headers['x-qtp-signal-secret'] || headers['X-QTP-Signal-Secret'] || headers['x-webhook-secret'] || headers['X-Webhook-Secret'] || headers['X-WEBHOOK-SECRET']; // QTP_HEADER_SIGNAL_SECRET_v4.2.7
  const alertType = String(body.alert_type || j.alert_type || 'UNKNOWN').toUpperCase();

  // TV_INGRESS_CLASSIFICATION_PATCH_20260505:
  // Some TradingView bar-close alerts intentionally use alert_type=HEARTBEAT to
  // keep the pipe warm, but they still carry market payload fields. Classify by
  // payload shape so monitors do not count real TV posts as internal-only pings.
  const _hasTicker = !!(body.ticker || body.symbol || body.sym || j.ticker || j.symbol || j.sym);
  const _hasMarketIntent = !!(
    body.execution || body.trade_action || body.direction || body.signal ||
    body.price || body.close || body.bias_score || body.bull_score || body.bear_score ||
    body.timeframe || body.interval || j.execution || j.trade_action || j.direction
  );
  const _isTvMarketPayload = _hasTicker && _hasMarketIntent;
  const _ingressSource = _isTvMarketPayload
    ? 'TRADINGVIEW_MARKET_ALERT'
    : (INTERNAL.has(alertType) ? 'INTERNAL_CONTROL' : 'EXTERNAL_WEBHOOK');
  body._ingress_source = _ingressSource;
  body._tv_payload_shape = _isTvMarketPayload ? 'ticker+market_fields' : 'control_or_unknown';
  body._original_alert_type = alertType;
  item.json._ingress_source = _ingressSource;
  item.json._tv_payload_shape = body._tv_payload_shape;

  // Internal invocations bypass auth (preserve existing behavior; classification
  // above lets monitors distinguish TV-like HEARTBEAT payloads without risking
  // signal loss from a sudden auth policy change).
  if (INTERNAL.has(alertType)) {
    out.push(promoteAuthenticatedPayload(item, body, query, headers, alertType, _ingressSource));
    continue;
  }

  // TV_AUTH_QUERY_SECRET_PATCH_20260504:
  // Accept the same expected secret from JSON body, flattened payload, query string, or header.
  // This supports TradingView setups where the passphrase is placed in the webhook URL:
  //   /webhook/tradingview-signal?_secret=<secret>
  // while still fail-closing when the secret is absent or wrong.
  const supplied = String(body._secret || j._secret || query._secret || headerSecret || '');
  if (!supplied || supplied !== expected) {
    // Throwing produces a node error visible to cron AUTH_FAILED detector and kills downstream execution.
    const detail = {
      reason: 'AUTH_FAILED',
      has_secret: !!supplied,
      secret_source: body._secret ? 'body' : (j._secret ? 'top_level' : (query._secret ? 'query' : (headerSecret ? 'header' : 'missing'))),
      alert_type: alertType,
      ticker: body.ticker || j.ticker || null
    };
    throw new Error('AUTH_FAILED: ' + JSON.stringify(detail));
  }
  out.push(promoteAuthenticatedPayload(item, body, query, headers, alertType, _ingressSource));
}
return out;
