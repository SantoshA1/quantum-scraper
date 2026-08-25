
// QTP_ALPACA_FILL_TO_SUPABASE_v4.2.8_20260518
// Converts read-only Alpaca fill activity monitor output into Supabase order_events/trade_log rows.
// Safety: no Alpaca calls, no order placement, no cancellation, no routing changes.
function upper(v){ return String(v ?? '').toUpperCase(); }
function num(v, d=null){ const n = Number(v); return Number.isFinite(n) ? n : d; }
function first(...vals){ for (const v of vals) if (v !== undefined && v !== null && String(v) !== '') return v; return null; }
function stableHash(s){ let h=2166136261; s=String(s ?? ''); for(let i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=Math.imul(h,16777619); } return (h>>>0).toString(16); }
const out=[];
for (const item of items) {
  const j = item.json || {};
  const type = String(j.type || '');
  if (!['FILL_ACTIVITY_NOTIFIED','FILL_ACTIVITY_SEEN_NO_ALERT','FILL_ACTIVITY_TELEGRAM_ERROR'].includes(type)) continue;
  const symbol = upper(first(j.symbol, j.ticker));
  const orderId = String(first(j.order_id, j.broker_order_id, '') || '');
  const fillId = String(first(j.fill_id, '') || '');
  if (!symbol || (!orderId && !fillId)) continue;
  const ts = first(j.transaction_time, j.event_ts, new Date().toISOString());
  const side = upper(first(j.side, 'UNKNOWN'));
  const status = upper(first(j.status, j.order_status, type === 'FILL_ACTIVITY_TELEGRAM_ERROR' ? 'TELEGRAM_ERROR' : 'FILLED'));
  const qty = num(first(j.filled_qty, j.qty, j.quantity), 0);
  const px = num(first(j.filled_avg_price, j.price, j.avg_fill_price), 0);
  const orderType = String(first(j.order_type, 'market')).toLowerCase();
  const orderClass = String(first(j.order_class, '')).toLowerCase();
  const source = first(j.source, 'Alpaca fill activity monitor');
  const base = `alpaca_fill_activity:${fillId || orderId}:${symbol}:${side}:${status}:${ts}`;
  const common = {
    source_workflow: $workflow.id,
    workflow_id: $workflow.id,
    workflow_name: $workflow.name,
    source_node: 'Alpaca Fill Activity Monitor',
    account_id: 'alpaca_paper',
    strategy_id: 'quantum',
    symbol,
    ticker: symbol,
    side,
    order_id: orderId || fillId,
    broker_order_id: orderId || fillId,
    client_order_id: j.client_order_id || null,
    fill_id: fillId || null,
    event_ts: ts,
    trade_ts: ts,
    order_type: orderType,
    time_in_force: j.time_in_force || null,
    order_class: orderClass || null,
    position_intent: j.intent || null,
    source,
    quantity: qty,
    qty,
    requested_quantity: qty,
    filled_quantity: qty,
    avg_fill_price: px,
    fill_price: px,
    raw_alpaca_fill_activity: j,
    qtp_trading_env: 'paper',
    qtp_live_trading_allowed: false,
    supabase_fill_logging_version: 'QTP_ALPACA_FILL_TO_SUPABASE_v4.2.8_20260518'
  };
  out.push({ json: {
    ...common,
    target_table: 'order_events',
    event_type: type === 'FILL_ACTIVITY_NOTIFIED' ? 'alpaca_protective_oco_fill' : 'alpaca_fill_activity_seen',
    order_status: status,
    rejection_reason: j.error || j.reason || null,
    idempotency_key: `alpaca_fill_order_event:${stableHash(base)}`
  }});
  if (['FILLED','CLOSED','DONE_FOR_DAY','PARTIALLY_FILLED'].includes(status)) {
    out.push({ json: {
      ...common,
      target_table: 'trade_log',
      event_type: type === 'FILL_ACTIVITY_NOTIFIED' ? 'position_closed' : 'alpaca_fill_trade_log',
      trade_status: status,
      notes: source,
      execution_venue: 'alpaca_paper',
      idempotency_key: `alpaca_fill_trade_log:${stableHash(base)}`
    }});
  }
}
return out;
