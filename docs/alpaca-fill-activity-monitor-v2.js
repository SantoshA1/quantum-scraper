// Quantum Alpaca Fill Activity Monitor — read-only notification patch, 2026-05-01
// Purpose: send Telegram execution alerts for real Alpaca fills even when fills
// originate from old stop/risk-recovery orders rather than Main Trading/VC Gate.
// Safety: read-only against Alpaca. Does not place, cancel, or modify orders.

const PATCH_STARTED_AT = "2026-05-01T17:26:51.627819Z";
const QTP_TG_PROXY_URL = 'https://tradenextgen.app.n8n.cloud/webhook/qtp-telegram-proxy-k4p8w'; // v2.1: bot token removed — Telegram credential lives in QTP Telegram Proxy
const CHAT = "6648680513";
const CHANNEL_ID = "-1003889511940";

// QTP_TSM_CREDENTIAL_MIGRATION_v2.0_20260710 — reads go through the QTP Alpaca Paper
// Broker Proxy (named credential Alpaca-PAPER). No embedded keys, no $vars.
const QTP_PROXY_URL = 'https://tradenextgen.app.n8n.cloud/webhook/qtp-alpaca-paper-proxy-x9v27';
const QTP_PROXY_TOKEN = '2679400ed5f501a97697e39257b1ea7904b6c5884f915d25';

const state = $getWorkflowStaticData('global');
if (!state._fillActivityMonitorStartedAt) state._fillActivityMonitorStartedAt = PATCH_STARTED_AT;
if (!state._processedAlpacaActivityFills) state._processedAlpacaActivityFills = {};
if (!state._processedFills) state._processedFills = {};

const startedMs = Date.parse(state._fillActivityMonitorStartedAt || PATCH_STARTED_AT);
const nowMs = Date.now();
for (const key of Object.keys(state._processedAlpacaActivityFills)) {
  if (nowMs - state._processedAlpacaActivityFills[key] > 7 * 24 * 60 * 60 * 1000) {
    delete state._processedAlpacaActivityFills[key];
  }
}

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function money(value) {
  const n = Number(value);
  return Number.isFinite(n) ? '$' + n.toFixed(2) : '?';
}

function qtyFmt(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value ?? '?');
  return Number.isInteger(n) ? String(n) : String(n);
}

function timeET(value) {
  try {
    return new Date(value).toLocaleString('en-US', {
      timeZone: 'America/New_York',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    });
  } catch (_) {
    return String(value || '?');
  }
}

async function alp(path) {
  const resp = await this.helpers.httpRequest({
    method: 'POST', url: QTP_PROXY_URL,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: QTP_PROXY_TOKEN, host: 'paper', method: 'GET', path, body: null }),
    json: true, timeout: 45000,
  });
  if (resp && resp.__qtp_proxy_error) {
    const pe = resp.__qtp_proxy_error;
    throw new Error('Request failed with status code ' + (pe.status || 'unknown') + (pe.body ? ' - ' + String(pe.body).slice(0, 300) : ''));
  }
  if (resp && resp.__qtp_proxy_ok) return resp.data;
  throw new Error('QTP_PROXY_BAD_RESPONSE: ' + JSON.stringify(resp || {}).slice(0, 200));
}

async function tg(chatId, text) {
  return await this.helpers.httpRequest({
    method: 'POST',
    url: QTP_TG_PROXY_URL,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: QTP_PROXY_TOKEN, chat_id: chatId, text }),
    json: true,
  });
}

// v2.0: key guard removed — proxy owns authentication via the Alpaca-PAPER credential.

let fills = [];
try {
  fills = await alp.call(this, '/v2/account/activities/FILL?direction=desc&page_size=100');
} catch (error) {
  return [{ json: { type: 'FILL_ACTIVITY_MONITOR_ERROR', error: error.message || String(error) } }];
}

if (!Array.isArray(fills)) fills = [];
fills = fills
  .filter(f => Date.parse(f.transaction_time || f.date || '') >= startedMs)
  .sort((a, b) => Date.parse(a.transaction_time || a.date || '') - Date.parse(b.transaction_time || b.date || ''));

const alerts = [];
const errors = [];

for (const fill of fills) {
  const fillTime = fill.transaction_time || fill.date || '';
  const fillId = fill.id || '';
  const dedupKey = fillId || [fill.order_id, fill.symbol, fill.side, fill.qty, fill.price, fillTime].join('|');
  if (!dedupKey || state._processedAlpacaActivityFills[dedupKey]) continue;

  // Mark every observed fill as processed before notification logic.
  // This prevents duplicate subscriber alerts for fills already announced by
  // Trailing Stop Manager's normal scale-out/full-exit logic.
  state._processedAlpacaActivityFills[dedupKey] = Date.now();
  if (fill.symbol && fillId) state._processedFills[fill.symbol + '_' + fillId] = Date.now();

  let order = null;
  if (fill.order_id) {
    try {
      order = await alp.call(this, '/v2/orders/' + encodeURIComponent(fill.order_id));
    } catch (_) {
      order = null;
    }
  }

  const symbol = esc(fill.symbol || order?.symbol || '?');
  const side = String(fill.side || order?.side || '?').toUpperCase();
  const status = String(fill.order_status || order?.status || 'fill').toUpperCase();
  const title = status.includes('PARTIAL') ? 'PARTIAL FILL' : 'ORDER FILLED';
  const clientOrderId = order?.client_order_id || '';
  const orderType = order?.type || '';
  const orderClass = String(order?.order_class || '').toLowerCase();
  const intent = order?.position_intent || '';
  let source = 'Alpaca execution';
  if (clientOrderId.startsWith('risk_recovery_stop_')) source = 'Risk recovery stop';
  else if (String(intent).toLowerCase().includes('_to_close') && (orderClass === 'oco' || orderClass === 'bracket')) source = 'Protective OCO / bracket close';
  else if (clientOrderId) source = clientOrderId;
  else if (orderType) source = orderType + ' order';

  // QTP_PROTECTIVE_CLOSE_FILL_ALERT_v4.2.5.8
  // Read-only alert expansion: notify final close fills from protective OCO/bracket
  // legs, not just risk_recovery_stop_* client orders. Partial fills are audited
  // but not sent to subscribers; the final FILLED event sends one cumulative alert.
  const isPartialFill = status.includes('PARTIAL');
  const isFinalFill = ['FILLED', 'DONE_FOR_DAY', 'CLOSED'].includes(status) || (!isPartialFill && Number(order?.filled_qty || 0) > 0);
  const isRiskRecoveryFill = clientOrderId.startsWith('risk_recovery_stop_');
  const isClosingIntent = String(intent).toLowerCase().includes('_to_close');
  const isProtectiveOrderClass = orderClass === 'oco' || orderClass === 'bracket' || clientOrderId.startsWith('qtp-');
  const shouldAlertFill = isRiskRecoveryFill || (isFinalFill && isClosingIntent && isProtectiveOrderClass);
  if (!shouldAlertFill) {
    alerts.push({
      type: 'FILL_ACTIVITY_SEEN_NO_ALERT',
      reason: isPartialFill ? 'partial_fill_waiting_for_final' : 'not_close_fill_alert_eligible',
      symbol: fill.symbol || order?.symbol,
      side: fill.side || order?.side,
      qty: fill.qty,
      price: fill.price,
      status,
      order_id: fill.order_id,
      broker_order_id: fill.order_id,
      client_order_id: clientOrderId,
      order_class: orderClass,
      order_type: orderType,
      intent,
      source,
      filled_qty: order?.filled_qty || fill.cum_qty || fill.qty,
      filled_avg_price: order?.filled_avg_price || fill.price,
      fill_id: fillId,
      transaction_time: fillTime,
      target_table: 'order_events',
      supabase_fill_logging_version: 'QTP_ALPACA_FILL_TO_SUPABASE_v4.2.8_20260518',
      version: 'QTP_PROTECTIVE_CLOSE_FILL_ALERT_v4.2.5.8',
    });
    continue;
  }

  const alertQty = isFinalFill ? (order?.filled_qty || fill.cum_qty || fill.qty) : fill.qty;
  const alertPrice = order?.filled_avg_price || fill.price;
  const lineIntent = intent ? '\nIntent: ' + esc(intent) : '';
  const lineSource = source ? '\nSource: ' + esc(source) : '';
  const message =
    `✅ <b>${symbol} — ${title}</b>
` +
    `${esc(side)} ${qtyFmt(alertQty)} @ ${money(alertPrice)}
` +
    `Status: ${esc(status)}${lineIntent}${lineSource}
` +
    `Time: ${esc(timeET(fillTime))}

` +
    `Quantum Trading System`;

  try {
    await tg.call(this, CHANNEL_ID, message);
    await tg.call(this, CHAT, message);
    alerts.push({
      type: 'FILL_ACTIVITY_NOTIFIED',
      symbol: fill.symbol || order?.symbol,
      side: fill.side || order?.side,
      qty: fill.qty,
      price: fill.price,
      status,
      order_id: fill.order_id,
      broker_order_id: fill.order_id,
      client_order_id: clientOrderId,
      order_class: orderClass,
      order_type: orderType,
      intent,
      source,
      filled_qty: alertQty,
      filled_avg_price: alertPrice,
      fill_id: fillId,
      transaction_time: fillTime,
      target_table: 'order_events',
      supabase_fill_logging_version: 'QTP_ALPACA_FILL_TO_SUPABASE_v4.2.8_20260518',
    });
  } catch (error) {
    errors.push({
      type: 'FILL_ACTIVITY_TELEGRAM_ERROR',
      symbol: fill.symbol || order?.symbol,
      fill_id: fillId,
      error: error.message || String(error),
    });
  }
}

if (alerts.length || errors.length) {
  return [...alerts, ...errors].map(json => ({ json }));
}

return [{
  json: {
    type: 'FILL_ACTIVITY_MONITOR_OK',
    message: 'No new Alpaca fills since monitor start',
    checked_fills: fills.length,
    started_at: state._fillActivityMonitorStartedAt,
  }
}];