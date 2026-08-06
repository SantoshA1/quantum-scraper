// Build Supabase audit + order_events SQL for QTP Scalp Exit Watcher decisions v1.4.
// FIX 2026-08-06 (gov 188, exec-524111 class): v1.3 esc() doubled backslashes (wrong under
// standard_conforming_strings=on) and sliced AFTER escaping (could split a doubled quote) —
// any close-status/error text containing a double quote killed the ENTIRE one-string batch
// (scalp events + order_events). v1.4: canonical escaping + quantum.safe_jsonb payloads.
// Paper-only. Supabase-only. No Databricks. No Google Sheets. No live Alpaca.
const rows = $input.all().map(i => i.json || {});

// === QTP_SAFE_PG_v1_20260806 canonical helpers (lib/sql/safe_pg.js — lockstep, do not hand-edit) ===
function escText(v) { return String(v ?? '').replace(new RegExp(String.fromCharCode(0), 'g'), '').replace(/'/g, "''"); }
function cleanStr(x) {
  const RC = String.fromCharCode(0xFFFD);
  let out = '';
  for (let i = 0; i < x.length; i++) {
    const c = x.charCodeAt(i);
    if (c === 0) { out += RC; continue; }
    if (c >= 0xD800 && c <= 0xDBFF) {
      const d = x.charCodeAt(i + 1);
      if (d >= 0xDC00 && d <= 0xDFFF) { out += x[i] + x[i + 1]; i++; }
      else out += RC;
    } else if (c >= 0xDC00 && c <= 0xDFFF) { out += RC; }
    else out += x[i];
  }
  return out;
}
function jsonText(v, maxLen) {
  let t;
  try {
    t = JSON.stringify(v ?? {}, (k, val) => (typeof val === 'string' ? cleanStr(val) : val));
  } catch (e) {
    try { t = JSON.stringify({ __stringify_error: cleanStr(String((e && e.message) || e)) }); }
    catch (_) { t = '{}'; }
  }
  if (typeof t !== 'string') t = '{}';
  if (maxLen && t.length > maxLen) {
    const head = cleanStr(t).slice(0, Math.max(200, Math.floor(maxLen / 4)));
    t = JSON.stringify({ __oversize: true, bytes: t.length, head });
  }
  return t.replace(/\$/g, '\\u0024');
}
function safeJsonbLit(v, maxLen) { return "quantum.safe_jsonb('" + escText(jsonText(v, maxLen)) + "')"; }
// === end canonical helpers ===
function esc(v) { return escText(String(v ?? '').replace(/\r/g, ' ').replace(/\n/g, ' ').slice(0, 8000)); }
function lit(v) { return v === undefined || v === null || v === '' ? 'NULL' : `'${esc(v)}'`; }
function num(v) {
  const n = Number(String(v ?? '').replace(/[$,%]/g, ''));
  return Number.isFinite(n) ? String(n) : 'NULL';
}
function bool(v) { return v === true ? 'true' : 'false'; }
function jsonLit(v) { return safeJsonbLit(v ?? {}, 8000); }

if (!rows.length) {
  return [{ json: { __supabase_scalp_exit_audit_sql: "SELECT 'NO_ROWS' AS scalp_exit_watch_audit_status;" } }];
}

const eventValues = rows.map(r => {
  const payload = { ...r, audit_builder_v: 'QTP_SCALP_EXIT_AUDIT_BUILDER_v1.4_20260806' };
  const reasons = Array.isArray(r.reasons) ? r.reasons.join('|') : (r.reason || '');
  return `(
    gen_random_uuid(),
    ${lit(r.run_id)}, CURRENT_TIMESTAMP, (CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York')::date,
    ${lit(r.symbol)}, ${lit(r.position_side)}, ${num(r.quantity)}, ${lit(r.entry_ts)},
    ${num(r.hold_minutes)}, ${num(r.current_price)}, ${num(r.avg_entry_price)},
    ${num(r.unrealized_pnl)}, ${num(r.unrealized_pnl_pct)}, ${lit(r.protection_status)},
    ${lit(r.action)}, ${lit(reasons)}, ${lit(r.alpaca_close_status)},
    ${lit(r.alpaca_close_order_id)}, ${lit(r.idempotency_key)}, ${bool(r.paper_only === true)},
    ${bool(r.live_alpaca_trading_allowed === true)}, ${jsonLit(payload)}, CURRENT_TIMESTAMP
  )`;
}).join(',\n');

const closeRows = rows.filter(r =>
  r.action === 'PAPER_CLOSE_SUBMITTED' &&
  r.alpaca_close_order_id &&
  r.paper_only === true &&
  r.live_alpaca_trading_allowed === false
);

let orderInsert = '';
if (closeRows.length) {
  const orderSelects = closeRows.map(r => {
    const closeSide = String(r.position_side || '').toUpperCase() === 'SHORT' ? 'buy' : 'sell';
    const status = String(r.alpaca_close_status || 'submitted').toUpperCase();
    const orderEventKey = 'scalp_exit_order_event:' + r.alpaca_close_order_id;
    const payload = {
      ...r,
      source: 'QTP_SCALP_EXIT_WATCHER',
      position_intent: closeSide === 'sell' ? 'sell_to_close' : 'buy_to_cover',
      paper_only: true,
      live_alpaca_trading_allowed: false,
      audit_builder_v: 'QTP_SCALP_EXIT_AUDIT_BUILDER_v1.4_20260806'
    };
    return `SELECT
      gen_random_uuid()::text AS order_event_id,
      ${lit(r.alpaca_close_order_id)} AS order_id, ${lit(r.alpaca_close_order_id)} AS broker_order_id, 'alpaca_paper' AS account_id, 'QTP_SCALP_EXIT_WATCHER' AS strategy_id, ${lit(r.idempotency_key)} AS signal_id,
      CURRENT_TIMESTAMP AS event_ts, (CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York')::date AS event_date,
      ${lit(r.symbol)} AS symbol, ${lit(closeSide)} AS side, 'market' AS order_type, 'day' AS time_in_force, ${lit(status)} AS order_status,
      ${num(r.quantity)} AS requested_quantity, NULL::numeric AS filled_quantity, NULL::numeric AS remaining_quantity, NULL::numeric AS limit_price, NULL::numeric AS stop_price, NULL::numeric AS avg_fill_price, NULL::text AS rejection_reason,
      ${jsonLit(payload)} AS raw_payload, ${lit(orderEventKey)} AS idempotency_key, CURRENT_TIMESTAMP AS ingested_at
    WHERE NOT EXISTS (SELECT 1 FROM quantum.order_events oe WHERE oe.idempotency_key = ${lit(orderEventKey)})`;
  }).join('\nUNION ALL\n');
  orderInsert = `
INSERT INTO quantum.order_events (
  order_event_id, order_id, broker_order_id, account_id, strategy_id, signal_id,
  event_ts, event_date, symbol, side, order_type, time_in_force, order_status,
  requested_quantity, filled_quantity, remaining_quantity, limit_price, stop_price, avg_fill_price, rejection_reason,
  raw_payload, idempotency_key, ingested_at
)
${orderSelects};
`;
}

const sql = `
CREATE TABLE IF NOT EXISTS quantum.scalp_exit_watch_events (
  event_id uuid PRIMARY KEY,
  run_id text,
  checked_at timestamptz NOT NULL DEFAULT now(),
  checked_date date,
  symbol text,
  position_side text,
  quantity numeric,
  entry_ts timestamptz,
  hold_minutes numeric,
  current_price numeric,
  avg_entry_price numeric,
  unrealized_pnl numeric,
  unrealized_pnl_pct numeric,
  protection_status text,
  action text,
  reason text,
  alpaca_close_status text,
  alpaca_close_order_id text,
  idempotency_key text,
  paper_only boolean NOT NULL DEFAULT true,
  live_alpaca_trading_allowed boolean NOT NULL DEFAULT false,
  raw_payload jsonb,
  ingested_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS scalp_exit_watch_events_symbol_checked_idx ON quantum.scalp_exit_watch_events(symbol, checked_at DESC);
CREATE INDEX IF NOT EXISTS scalp_exit_watch_events_idem_idx ON quantum.scalp_exit_watch_events(idempotency_key);

INSERT INTO quantum.scalp_exit_watch_events (
  event_id, run_id, checked_at, checked_date, symbol, position_side, quantity, entry_ts,
  hold_minutes, current_price, avg_entry_price, unrealized_pnl, unrealized_pnl_pct,
  protection_status, action, reason, alpaca_close_status, alpaca_close_order_id,
  idempotency_key, paper_only, live_alpaca_trading_allowed, raw_payload, ingested_at
) VALUES ${eventValues};
${orderInsert}
SELECT
  COUNT(*) AS input_rows,
  ${closeRows.length}::int AS close_rows,
  'QTP_SCALP_EXIT_AUDIT_WRITTEN' AS scalp_exit_watch_audit_status;
`;

return [{ json: { __supabase_scalp_exit_audit_sql: sql } }];