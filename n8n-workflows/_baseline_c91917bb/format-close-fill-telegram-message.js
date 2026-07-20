
// QTP close/recovery fill Telegram formatter.
// Observes normalized Alpaca close/fill log rows only. It never places, cancels,
// changes, or routes orders. It also ignores regular order submissions to avoid
// duplicate subscriber alerts from the normal entry notification path.
function esc(v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? '$' + n.toFixed(2) : 'N/A';
}
function qty(v) {
  const n = Number(v);
  return Number.isFinite(n) ? String(Math.abs(n)) : String(v ?? '?');
}
function upper(v) { return String(v ?? '').trim().toUpperCase(); }

const out = [];
for (const item of $input.all()) {
  const d = item.json || {};
  const status = upper(d.trade_status || d.order_status || d.status);
  const eventType = String(d.event_type || '');
  const targetTable = String(d.target_table || '');
  const sourceNode = String(d.source_node || '');
  const isClose = eventType === 'position_closed' || sourceNode === 'Alpaca Position Closer';
  const isTradeLog = targetTable === 'trade_log';
  if (!isClose || !isTradeLog) continue;
  if (!['FILLED','CLOSED','DONE_FOR_DAY'].includes(status)) continue;

  const symbol = upper(d.ticker || d.symbol);
  if (!symbol) continue;
  const side = upper(d.side);
  const actionLabel = side === 'BUY' ? 'SHORT COVER / BUY CLOSE' : side === 'SELL' ? 'SELL CLOSE / STOP EXIT' : 'POSITION CLOSE';
  const fillQty = qty(d.filled_quantity ?? d.quantity ?? d.requested_quantity);
  const price = money(d.avg_fill_price ?? d.mark_price);
  const pnlRaw = d.realized_pnl ?? d.net_pnl ?? d.gross_pnl;
  const pnl = Number(pnlRaw);
  const pnlLine = Number.isFinite(pnl) ? `\nP&L: ${pnl >= 0 ? '+' : ''}${money(pnl)}` : '';
  const reason = esc(d.notes || d.rejection_reason || 'protective close/recovery fill');
  const orderId = esc(d.broker_order_id || d.order_id || '');
  const ts = esc(d.trade_ts || d.event_ts || new Date().toISOString());

  const message = [
    `<b>${esc(symbol)} — ${actionLabel}</b>`,
    `Filled ${esc(fillQty)} share${fillQty === '1' ? '' : 's'} at ~${esc(price)}${pnlLine}`,
    `Reason: ${reason}`,
    `Status: ${esc(status)} | Time: ${ts}`,
    orderId ? `Order: ${orderId}` : '',
    ``,
    `Protective/closing fill alert. No new entry was forced by this notification.`
  ].filter(Boolean).join('\n');

  out.push({
    json: {
      ticker: symbol,
      message,
      test_mode: false,
      close_fill_order_id: orderId,
      close_fill_status: status,
      close_fill_side: side,
      close_fill_qty: fillQty,
      close_fill_price: d.avg_fill_price ?? d.mark_price,
      notification_type: 'POSITION_CLOSE_FILL',
    }
  });
}
return out;
