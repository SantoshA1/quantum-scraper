'use strict';

const { sha256 } = require('./sql-format');

function nowIso(clock = Date) {
  return new clock().toISOString();
}

function normalizeItem(item, opts = {}) {
  const clock = opts.clock || Date;
  const p = (item && item.json) || item || {};
  const eventType = p.event_type || p.worksheet || p.table || 'trade_log';
  const accountId = p.account_id || p.accountId || 'unknown_account';
  const strategyId = p.strategy_id || p.strategyId || 'unknown_strategy';
  const symbol = p.symbol || p.ticker || null;
  const tradeId = p.trade_id || p.tradeId || null;
  const orderId = p.order_id || p.orderId || null;
  const ts = p.trade_ts || p.timestamp || p.event_ts || p.snapshot_ts || p.metric_ts || nowIso(clock);
  const baseKey = [
    eventType,
    accountId,
    strategyId,
    tradeId,
    orderId,
    symbol,
    ts,
    p.side || '',
    p.quantity || '',
    p.avg_fill_price || p.price || '',
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
    n8n_received_at: nowIso(clock),
    raw_payload: p.raw_payload || p,
  };
}

function normalizeItems(items, opts = {}) {
  return (items || []).map((it) => ({ json: normalizeItem(it, opts) }));
}

module.exports = {
  nowIso,
  normalizeItem,
  normalizeItems,
};
