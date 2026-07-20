
// Normalize Alpaca Events for Supabase
// QTP-BACKTEST-METADATA-PRESERVER v4.2.13
// Purpose: convert Alpaca order/close node outputs into explicit, idempotent
// Supabase logging events. Non-blocking. Trading logic untouched.
// Additive fix: preserve standardized backtest/enforcement fields in raw_payload
// so order_events/trade_log rows can be traced back to the same VC/audit decision.

function first(...vals) {
  for (const v of vals) {
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

function num(v, fallback = null) {
  if (v === undefined || v === null || v === '' || String(v).toUpperCase() === 'N/A') return fallback;
  const n = Number(String(v).replace('%', '').trim());
  return Number.isFinite(n) ? n : fallback;
}

function str(v, fallback = '') {
  const x = first(v, fallback);
  return x === undefined || x === null ? '' : String(x);
}

function upper(v, fallback = '') {
  return str(v, fallback).trim().toUpperCase();
}

function sideFromExecution(execution, statusSide) {
  const e = upper(execution || statusSide);
  if (['BUY', 'LONG'].includes(e)) return 'BUY';
  if (['SELL', 'SHORT'].includes(e)) return 'SELL';
  return e || 'UNKNOWN';
}

function isoNow() {
  return new Date().toISOString();
}

function stableHash(obj) {
  const s = JSON.stringify(obj || {});
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function backtestEnvelope(p) {
  const sample = num(first(
    p._backtest_sample_size,
    p.backtest_sample_size,
    p.backtest_sample,
    p.strat_total_trades,
    p.total_trades,
    p.bt_total_trades
  ), null);

  const pf = num(first(
    p._backtest_profit_factor,
    p.backtest_profit_factor,
    p.backtest_pf,
    p.strat_profit_factor,
    p.profit_factor,
    p.bt_profit_factor
  ), null);

  const win = num(first(
    p._backtest_win_rate,
    p.backtest_win_rate,
    p.strat_win_rate,
    p.win_rate,
    p.bt_win_rate
  ), null);

  const status = first(
    p._backtest_status,
    p.backtest_status,
    sample === null || pf === null ? 'NO_BACKTEST_DATA' :
      (sample >= 100 && pf >= 1.2 ? 'BACKTEST_DATA_OK' : 'WEAK_BACKTEST_DATA')
  );

  const validRaw = first(p._backtest_valid, p.backtest_valid);
  const valid = validRaw !== undefined
    ? (validRaw === true || String(validRaw).toLowerCase() === 'true')
    : (sample !== null && pf !== null && sample >= 100 && pf >= 1.2);

  const requiredRaw = first(p._backtest_required, p.backtest_required);
  const required = requiredRaw === true || String(requiredRaw).toLowerCase() === 'true';

  return {
    strat_total_trades: sample,
    strat_profit_factor: pf,
    strat_win_rate: win,
    _backtest_sample_size: sample,
    _backtest_profit_factor: pf,
    _backtest_win_rate: win,
    _backtest_status: status,
    _backtest_valid: valid,
    _backtest_required: required,
    _backtest_enforcement_action: first(p._backtest_enforcement_action, p.backtest_action, valid ? 'ALLOW' : 'BLOCK_OR_DOWNGRADE'),
    _backtest_enforcement_reason: first(p._backtest_enforcement_reason, p.backtest_reason, valid ? 'Backtest data passed minimum quality gate' : 'Missing or weak backtest data'),
    _backtest_entry_class: first(p._backtest_entry_class, p.backtest_entry_class, p.signal_type, p.momentum_type, 'UNKNOWN'),
    qtp_order_event_backtest_version: 'QTP_BACKTEST_METADATA_PRESERVER_v4.2.13_20260513'
  };
}

function baseRecord(p) {
  const symbol = upper(first(p.ticker, p.symbol, p.alpaca_close_ticker));
  const ts = first(p._signal_timestamp, p.timestamp, p.Timestamp, p.created_at, isoNow());
  const side = sideFromExecution(first(p.execution, p.side, p.alpaca_side, p.alpaca_signal_side));
  const status = upper(first(p.alpaca_status, p.alpaca_close_status, p.order_status, p.status), 'UNKNOWN');
  const qty = num(first(p.alpaca_close_qty, p.alpaca_qty, p.qty, p.quantity, p.order_qty, p.filled_qty, p.filled_quantity), null);
  const price = num(first(p.alpaca_fresh_price, p.alpaca_signal_price, p.price, p.avg_fill_price, p.alpaca_close_exit_price), null);
  const entryId = first(p.alpaca_entry_id, p.order_id, p.broker_order_id, p.id);
  const closeId = first(p.alpaca_close_order_id, p.alpaca_order_id, p.close_order_id);
  const orderId = first(entryId, closeId, `${symbol}_${ts}_${stableHash(p).slice(0, 8)}`);
  const bt = backtestEnvelope(p);

  return {
    source_system: 'n8n_alpaca',
    source_node: first(p.alpaca_close_status, p.alpaca_close_reason) !== undefined ? 'Alpaca Position Closer' : 'Alpaca Paper Trade',
    symbol,
    ticker: symbol,
    event_ts: ts,
    trade_ts: ts,
    snapshot_ts: ts,
    order_id: String(orderId),
    broker_order_id: String(orderId),
    account_id: str(first(p.account_id, p.alpaca_account_id), 'alpaca'),
    strategy_id: str(first(p.strategy_id, p.strategy, p.alert_type, p.momentum_type), 'quantum_pipeline'),
    strategy_name: str(first(p.strategy_name, p.momentum_type, p.alert_type), 'quantum_pipeline'),
    signal_id: str(first(p.signal_id, p.Shadow_ID, p.shadow_id), `${symbol}_${ts}`),
    side,
    order_type: str(first(p.order_type), 'market'),
    time_in_force: str(first(p.time_in_force), 'gtc'),
    order_status: status,
    trade_status: status,
    requested_quantity: qty,
    filled_quantity: num(first(p.filled_quantity, p.filled_qty), status === 'PENDING_NEW' || status === 'SUBMITTED' ? 0 : qty),
    quantity: qty,
    avg_fill_price: price,
    mark_price: price,
    notional: num(first(p.alpaca_notional, p.notional), qty !== null && price !== null ? Number((Math.abs(qty) * price).toFixed(6)) : null),
    stop_price: first(p.alpaca_stop_price, p.stop_price),
    limit_price: first(p.limit_price),
    rejection_reason: first(p.alpaca_reason, p.alpaca_error, p.alpaca_close_reason, p.alpaca_close_error),
    model_version: first(p._sm_version, p.model_version, p.parser_version),
    risk_check_status: first(p.risk_check_status, p._sm_quality_gate),
    raw_payload: { ...p, ...bt },
  };
}

function shouldWriteTrade(status) {
  const s = upper(status);
  return ['NEW', 'ACCEPTED', 'PENDING_NEW', 'SUBMITTED', 'FILLED', 'PARTIALLY_FILLED', 'CLOSED', 'DONE_FOR_DAY'].includes(s);
}

function shouldWriteSnapshot(status) {
  const s = upper(status);
  return ['PENDING_NEW', 'SUBMITTED', 'FILLED', 'PARTIALLY_FILLED', 'CLOSED'].includes(s);
}

const output = [];

for (const item of $input.all()) {
  const p = item.json || {};
  const base = baseRecord(p);
  if (!base.symbol) continue;

  const eventKind = first(p.alpaca_close_status, p.alpaca_close_reason) !== undefined ? 'close' : 'order';
  const status = upper(first(p.alpaca_status, p.alpaca_close_status), 'UNKNOWN');
  const hashSeed = `${base.symbol}|${base.event_ts}|${base.order_id}|${status}|${eventKind}`;

  output.push({
    json: {
      ...base,
      target_table: 'order_events',
      event_type: eventKind === 'close' ? 'position_close_event' : 'alpaca_order_event',
      order_status: status,
      remaining_quantity: null,
      idempotency_key: `alpaca:order_event:${hashSeed}:${stableHash(base.raw_payload)}`,
    },
  });

  if (shouldWriteTrade(status)) {
    output.push({
      json: {
        ...base,
        target_table: 'trade_log',
        event_type: eventKind === 'close' ? 'position_closed' : 'order_submitted',
        trade_id: `alpaca_trade_${base.order_id}`,
        trade_status: status,
        execution_venue: 'alpaca',
        liquidity_flag: 'unknown',
        gross_pnl: num(first(p.alpaca_close_unrealized_pl, p.gross_pnl, p.pnl), null),
        net_pnl: num(first(p.alpaca_close_unrealized_pl, p.net_pnl, p.pnl), null),
        realized_pnl: eventKind === 'close' ? num(first(p.alpaca_close_unrealized_pl, p.realized_pnl, p.pnl), null) : null,
        unrealized_pnl: eventKind === 'close' ? 0 : null,
        notes: first(p.alpaca_reason, p.alpaca_close_reason, p.comment),
        idempotency_key: `alpaca:trade_log:${hashSeed}:${stableHash(base.raw_payload)}`,
      },
    });
  }

  if (shouldWriteSnapshot(status)) {
    const qtyAfter = eventKind === 'close' && status === 'CLOSED' ? 0 : base.quantity;
    output.push({
      json: {
        ...base,
        target_table: 'portfolio_snapshot',
        event_type: eventKind === 'close' ? 'portfolio_snapshot_after_close' : 'portfolio_snapshot_after_order',
        snapshot_id: `alpaca_snapshot_${base.symbol}_${base.event_ts}_${stableHash(base.raw_payload).slice(0, 8)}`,
        quantity: qtyAfter,
        position_after: qtyAfter,
        avg_cost: num(first(p.alpaca_close_entry_price, p.avg_cost, p.avg_fill_price), null),
        mark_price: num(first(p.alpaca_close_exit_price, p.alpaca_fresh_price, p.price), null),
        market_value: num(first(p.alpaca_close_market_value), base.notional),
        unrealized_pnl: eventKind === 'close' ? 0 : num(first(p.unrealized_pnl), null),
        realized_pnl_today: eventKind === 'close' ? num(first(p.alpaca_close_unrealized_pl, p.realized_pnl, p.pnl), null) : null,
        data_status: status,
        idempotency_key: `alpaca:portfolio_snapshot:${hashSeed}:${stableHash(base.raw_payload)}`,
      },
    });
  }
}

return output;
