// n8n Code node: Normalize Logging Payload
// Mode: Run Once for All Items
// Language: JavaScript
//
// This is the paste-ready n8n Code node. It mirrors
// /databricks/normalize-payload.js in the repo (which is unit-tested).

const crypto = require('crypto');

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeItem(item) {
  const p = item.json || {};
  const eventType = p.event_type || p.worksheet || p.table || 'trade_log';
  const accountId = p.account_id || p.accountId || 'unknown_account';
  const strategyId = p.strategy_id || p.strategyId || 'unknown_strategy';
  const symbol = p.symbol || p.ticker || null;
  const tradeId = p.trade_id || p.tradeId || null;
  const orderId = p.order_id || p.orderId || null;
  const ts = p.trade_ts || p.timestamp || p.event_ts || p.snapshot_ts || p.metric_ts || nowIso();

  const baseKey = [
    eventType, accountId, strategyId, tradeId, orderId, symbol, ts,
    p.side || '', p.quantity || '', p.avg_fill_price || p.price || ''
  ].join('|');

  const idempotencyKey = p.idempotency_key || sha256(baseKey);

  return {
    ...p,
    event_type: eventType,
    account_id: accountId,
    strategy_id: strategyId,
    symbol,
    trade_id: tradeId,
    order_id: orderId,
    idempotency_key: idempotencyKey,
    n8n_received_at: nowIso(),
    raw_payload: p.raw_payload || p,
  };
}

return items.map((item) => ({ json: normalizeItem(item) }));
