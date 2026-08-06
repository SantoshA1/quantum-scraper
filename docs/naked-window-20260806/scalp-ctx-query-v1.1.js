// QTP Scalp Exit Watcher query builder v1.1 — Supabase-only context
// v1.1 (gov 191, PO scope order): expose the entry order's client_order_id from
// order_events.raw_payload so the watcher can attribute each position (main-pipeline
// entries carry the F-DURABLE 'qet-' prefix) and scope itself off swing entries.
// Paper-only workflow. No Databricks. No Google Sheets. No live Alpaca.
const now = new Date();
const etParts = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
}).formatToParts(now).reduce((a, p) => (a[p.type] = p.value, a), {});
const h = Number(etParts.hour);
const m = Number(etParts.minute);
const weekday = etParts.weekday;
const inRegularSession = !['Sat', 'Sun'].includes(weekday) && ((h > 9 || (h === 9 && m >= 32)) && (h < 15 || (h === 15 && m <= 55)));

const sql = `
WITH latest_risk AS (
  SELECT DISTINCT ON (symbol)
    observed_at, symbol, position_side, quantity, avg_entry_price, current_price, market_value,
    unrealized_pnl, unrealized_pnl_pct, protection_status, protected_qty, unprotected_qty,
    protective_stop_count, exit_limit_count, open_order_count, recommended_action, risk_reason
  FROM quantum.position_risk_state
  WHERE observed_at >= now() - INTERVAL '30 minutes'
    AND COALESCE(quantity,0) <> 0
  ORDER BY symbol, observed_at DESC
),
entries AS (
  SELECT DISTINCT ON (o.symbol)
    o.symbol, o.event_ts AS entry_ts, o.side AS entry_side, o.avg_fill_price AS entry_price,
    o.filled_quantity AS entry_qty, o.broker_order_id AS entry_broker_order_id,
    o.raw_payload->>'client_order_id' AS entry_client_order_id
  FROM quantum.order_events o
  JOIN latest_risk r ON r.symbol = o.symbol
  WHERE o.order_status ILIKE 'filled'
    AND o.event_ts >= now() - INTERVAL '3 days'
    AND (
      (r.position_side = 'long' AND o.side ILIKE 'buy') OR
      (r.position_side = 'short' AND o.side ILIKE 'sell')
    )
  ORDER BY o.symbol, o.event_ts DESC
),
latest_signal AS (
  SELECT DISTINCT ON (s.symbol)
    s.symbol, s.signal_ts, s.signal_type, s.signal_direction, s.signal_strength, s.confidence
  FROM quantum.strategy_signals s
  JOIN entries e ON e.symbol = s.symbol
  WHERE s.signal_ts >= e.entry_ts
  ORDER BY s.symbol, s.signal_ts DESC
),
latest_audit AS (
  SELECT DISTINCT ON (e.symbol)
    e.symbol, e.ts AS audit_ts, e.side AS audit_side, e.gate_decision, e.risk_gate_decision,
    e.pause_guard_decision, e.parser_version
  FROM quantum.exec_flow_audit e
  JOIN entries ent ON ent.symbol = e.symbol
  WHERE e.ts >= ent.entry_ts
  ORDER BY e.symbol, e.ts DESC
),
recent_exit_events AS (
  SELECT o.symbol, COUNT(*)::int AS recent_exit_event_count, MAX(o.event_ts) AS latest_exit_event_ts
  FROM quantum.order_events o
  JOIN entries e ON e.symbol = o.symbol
  WHERE o.event_ts >= e.entry_ts
    AND (
      (o.side ILIKE 'sell' AND EXISTS (SELECT 1 FROM latest_risk r WHERE r.symbol=o.symbol AND r.position_side='long')) OR
      (o.side ILIKE 'buy' AND EXISTS (SELECT 1 FROM latest_risk r WHERE r.symbol=o.symbol AND r.position_side='short'))
    )
    AND o.order_status IN ('PENDING_NEW','ACCEPTED','NEW','SUBMITTED','PARTIALLY_FILLED','FILLED')
  GROUP BY o.symbol
)
SELECT
  r.*, e.entry_ts, e.entry_side, e.entry_price, e.entry_qty, e.entry_broker_order_id, e.entry_client_order_id,
  EXTRACT(EPOCH FROM (now() - e.entry_ts))/60.0 AS hold_minutes,
  s.signal_ts, s.signal_type, s.signal_direction, s.signal_strength, s.confidence AS signal_confidence,
  a.audit_ts, a.audit_side, a.gate_decision, a.risk_gate_decision, a.pause_guard_decision, a.parser_version,
  COALESCE(x.recent_exit_event_count,0) AS recent_exit_event_count,
  x.latest_exit_event_ts
FROM latest_risk r
JOIN entries e ON e.symbol = r.symbol
LEFT JOIN latest_signal s ON s.symbol = r.symbol
LEFT JOIN latest_audit a ON a.symbol = r.symbol
LEFT JOIN recent_exit_events x ON x.symbol = r.symbol
ORDER BY r.unrealized_pnl_pct ASC NULLS LAST, hold_minutes DESC;`;

return [{ json: {
  qtp_component: 'QTP_SCALP_EXIT_WATCHER',
  qtp_version: 'QTP_SCALP_EXIT_WATCHER_PAPER_ONLY_v1.1_20260806',
  qtp_deployment_mode: 'PRODUCTION_PAPER_GATED',
  alpaca_env: 'PAPER',
  live_alpaca_trading_allowed: false,
  in_regular_session: inRegularSession,
  checked_at: now.toISOString(),
  __supabase_scalp_exit_watch_sql: sql
}}];
