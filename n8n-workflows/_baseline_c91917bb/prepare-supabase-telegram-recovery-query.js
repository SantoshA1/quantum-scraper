
// QTP Supabase Telegram recovery order lookup v4.2.1
const d = $json || {};
function esc(v) { return String(v ?? '').replace(/'/g, "''").replace(/\r/g, ' ').replace(/\n/g, ' '); }
const sym = String(d.ticker || d.symbol || '').toUpperCase().replace(/[^A-Z0-9.\-]/g, '');
let rawTs = d._signal_timestamp || d.timestamp || new Date().toISOString();
let iso = new Date(rawTs).toISOString();
return [{
  json: {
    ...d,
    __supabase_tg_recovery_sql: `
      WITH candidate AS (
        SELECT symbol, order_status, side, requested_quantity, avg_fill_price, order_id, broker_order_id, event_ts::text AS event_ts
        FROM quantum.order_events
        WHERE symbol = '${esc(sym)}'
          AND order_status IN ('PENDING_NEW','ACCEPTED','NEW','FILLED','PARTIALLY_FILLED','SUBMITTED')
          AND event_ts BETWEEN TIMESTAMPTZ '${esc(iso)}' - INTERVAL '4 minutes' AND TIMESTAMPTZ '${esc(iso)}' + INTERVAL '4 minutes'
        ORDER BY ingested_at DESC
        LIMIT 1
      )
      SELECT * FROM candidate
    `,
    migration_version: 'QTP_SUPABASE_MAIN_TRADING_v4.2.1'
  }
}];
