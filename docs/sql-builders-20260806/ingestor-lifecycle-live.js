// QTP Order Lifecycle Ingestor v1.2 (Conclave gap G22 + QTP_INGEST_HEARTBEAT_v1_20260805)
// v1.1 returned [] when there was nothing to insert, so the Postgres node was skipped and a
// healthy-quiet run was indistinguishable from a dead one (the 2026-08-05 false alarm:
// max(event_ts) lag read as "dead 18h" on a static book). v1.2 ALWAYS emits one atomic
// statement: a data-modifying CTE inserts any new order events (idempotent via NOT EXISTS)
// and the outer INSERT writes one quantum.ingest_heartbeat row with the REAL inserted count.
// Health is judged by quantum.v_order_ingest_health, never by event_ts staleness.
const WF_ID = 'n31KzRDp6wR5BlFb';
const WF_NAME = 'QTP Order Lifecycle Ingestor';
const orders = $input.all().map(i => i.json).filter(o => o && o.id);
function esc(v) { return String(v).replace(/'/g, "''").replace(/\$(\d)/g, 'USD $1'); }
function txt(v) { if (v === null || v === undefined || v === '') { return 'NULL'; } return "'" + esc(v) + "'"; }
function num(v) { if (v === null || v === undefined || v === '') { return 'NULL::numeric'; } const n = Number(v); if (!isFinite(n)) { return 'NULL::numeric'; } return "'" + n + "'::numeric"; }
function toRow(o) {
  const ts = o.updated_at || o.submitted_at || o.created_at || '';
  if (!o.id || !ts) { return null; }
  const eventId = o.id + ':' + o.status + ':' + ts;
  let rp = JSON.stringify(o) || '{}';
  if (rp.length > 8000) { rp = JSON.stringify({ _truncated: true, id: o.id, status: o.status, symbol: o.symbol, order_type: o.type, updated_at: o.updated_at }); }
  const side = o.position_intent ? String(o.side || '') + ':' + o.position_intent : String(o.side || 'unknown');
  const vals = [
    txt(eventId), txt(o.id), txt(o.id), "'alpaca_paper'",
    txt(ts) + '::timestamptz', txt(String(ts).slice(0, 10)) + '::date',
    txt(o.symbol || 'UNKNOWN'), txt(side), txt(o.type), txt(o.time_in_force),
    txt(String(o.status || 'unknown').toUpperCase()),
    num(o.qty), num(o.filled_qty), num(o.limit_price), num(o.stop_price), num(o.filled_avg_price),
    txt(rp) + '::jsonb', txt(eventId), 'now()'
  ];
  return { eventId: eventId, sql: '(' + vals.join(', ') + ')' };
}
const rows = [];
const seen = {};
for (const o of orders) {
  const fam = [o].concat(Array.isArray(o.legs) ? o.legs : []);
  for (const ord of fam) {
    const r = toRow(ord);
    if (r && !seen[r.eventId]) { seen[r.eventId] = true; rows.push(r.sql); }
  }
}
function heartbeatSql(inserted, note) {
  return 'INSERT INTO quantum.ingest_heartbeat (workflow_id, workflow_name, orders_seen, candidate_rows, rows_inserted, note) ' +
    "SELECT '" + WF_ID + "', '" + esc(WF_NAME) + "', " + orders.length + ', ' + rows.length + ', ' + inserted + ", '" + esc(note) + "'";
}
let sql;
if (rows.length === 0) {
  sql = heartbeatSql('0', orders.length === 0 ? 'v1.2 no orders returned' : 'v1.2 no stampable rows');
} else {
  const cols = 'order_event_id, order_id, broker_order_id, account_id, event_ts, event_date, symbol, side, order_type, time_in_force, order_status, requested_quantity, filled_quantity, limit_price, stop_price, avg_fill_price, raw_payload, idempotency_key, ingested_at';
  sql = 'WITH ins AS (INSERT INTO quantum.order_events (' + cols + ') SELECT * FROM (VALUES ' + rows.join(', ') + ') AS v(' + cols + ') ' +
    'WHERE NOT EXISTS (SELECT 1 FROM quantum.order_events oe WHERE oe.order_event_id = v.order_event_id) RETURNING 1) ' +
    heartbeatSql('(SELECT count(*) FROM ins)', 'v1.2');
}
return [{ json: { __supabase_insert_sql: sql, fetched_orders: orders.length, candidate_rows: rows.length, base_used: 'https://paper-api.alpaca.markets via n8n credential Alpaca-PAPER', window_et_ok: true } }];
