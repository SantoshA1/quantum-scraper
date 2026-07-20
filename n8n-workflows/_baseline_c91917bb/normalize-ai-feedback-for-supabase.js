
// Safe, non-blocking AI Feedback normalizer for Supabase mirror ingestion.
// Live trading path is untouched. This node only prepares a logging payload.
function first(...vals) {
  for (const v of vals) {
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return null;
}

function num(v) {
  if (v === undefined || v === null || v === '' || String(v).toUpperCase() === 'N/A') return null;
  const n = Number(String(v).replace(/[$,%]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function str(v, fallback = '') {
  const x = first(v, fallback);
  return x === undefined || x === null ? fallback : String(x);
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

function toIsoTimestamp(v) {
  const d = new Date(v || Date.now());
  if (!Number.isNaN(d.getTime())) return d.toISOString();
  return new Date().toISOString();
}

function toDateOnly(v) {
  const d = new Date(v || Date.now());
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

const p = $json || {};
const rawTs = first(p.timestamp, p.Timestamp, p.signal_ts, p.event_ts, p._signal_timestamp, p.created_at, p.createdAt);
const parsedTs = toIsoTimestamp(rawTs);
const parsedDate = toDateOnly(rawTs);

const ticker = str(first(p.ticker, p.symbol, p.Ticker, p.Symbol, p.alert_ticker), 'UNKNOWN').toUpperCase();
const strategy = str(first(p.strategy, p.strategy_id, p.Strategy, p.momentum_type, p.alert_type), 'quantum_pipeline');
const timeframe = str(first(p.timeframe, p.tf, p.TF, p.interval), 'unknown');
const execution = first(p.execution, p.Execution, p.side, p.signal_direction, p.action);
const signal = first(p.signal, p.Signal, p.signal_type, p.alert_type);
const sourceId = first(p.Shadow_ID, p.shadow_id, p['Shadow ID'], p.signal_id, p.order_id, p.id, stableHash(p));
const idempotencyKey = str(first(p.idempotency_key, p.Idempotency_Key), ['ai_feedback', ticker, strategy, timeframe, parsedTs, sourceId].join(':'));

const headers = Object.keys(p);
const rawValues = headers.map(k => {
  const v = p[k];
  if (v === undefined || v === null) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
});

return {
  json: {
    ...p,
    __supabase_table: 'google_sheets_ai_feedback_raw',
    __migration_id: 'live_ai_feedback_mirror',
    __spreadsheet_id: 'supabase_primary_no_google_sheet',
    __spreadsheet_title: 'AI Feedback',
    __worksheet_name: 'AI Feedback',
    __sheet_row_number: 0,
    __source_range: 'live_n8n_ai_feedback',
    __source_workflow: $workflow.name || 'TradingView AI Super Score → Perplexity → Telegram',
    __source_node: 'Normalize AI Feedback for Supabase',

    source_timestamp: str(rawTs, parsedTs),
    source_date: parsedDate,
    parsed_timestamp: parsedTs,
    parsed_date: parsedDate,

    ticker,
    strategy,
    timeframe,
    execution,
    signal,
    price: num(first(p.price, p.Price, p.reference_price, p.avg_fill_price, p.alpaca_signal_price, p.alpaca_fresh_price)),
    trade_status: str(first(p.trade_status, p.order_status, p.status), 'SIGNAL_ONLY'),
    event_type: str(first(p.event_type, p.EventType, p.alert_type), 'SIGNAL_FEEDBACK'),
    pnl_dollars: num(first(p.pnl_dollars, p.pnl, p.realized_pnl, p.net_pnl)),
    pnl_percent: num(first(p.pnl_percent, p.return_pct)),

    headers_json: JSON.stringify(headers),
    raw_values_json: JSON.stringify(rawValues),
    raw_payload_json: JSON.stringify(p),
    idempotency_key: idempotencyKey
  }
};
