'use strict';

const { fullTable } = require('./config');
const {
  sha256,
  sqlString,
  sqlTimestamp,
  sqlDecimal,
  sqlBigInt,
  sqlBoolean,
  sqlVariant,
} = require('./sql-format');

const EVENT_TYPE_MAP = Object.freeze({
  trade_log: 'trade_log',
  trade: 'trade_log',
  daily_pnl: 'daily_pnl',
  'daily_p&l': 'daily_pnl',
  pnl: 'daily_pnl',
  portfolio_snapshot: 'portfolio_snapshot',
  snapshot: 'portfolio_snapshot',
  performance_metrics: 'performance_metrics',
  metrics: 'performance_metrics',
  audit_trail: 'audit_trail',
  audit: 'audit_trail',
  order_events: 'order_events',
  order_event: 'order_events',
  risk_events: 'risk_events',
  risk_event: 'risk_events',
  strategy_signals: 'strategy_signals',
  strategy_signal: 'strategy_signals',
  signal: 'strategy_signals',
  system_health: 'system_health',
  health: 'system_health',
  logging_dead_letter: 'logging_dead_letter',
  dead_letter: 'logging_dead_letter',
});

const KNOWN_TABLES = Object.freeze([
  'trade_log',
  'daily_pnl',
  'portfolio_snapshot',
  'performance_metrics',
  'audit_trail',
  'order_events',
  'risk_events',
  'strategy_signals',
  'system_health',
  'logging_dead_letter',
]);

function normalizeTargetTable(eventType) {
  const raw = String(eventType || 'trade_log').toLowerCase().replace(/\s+/g, '_');
  return EVENT_TYPE_MAP[raw] || 'audit_trail';
}

function makeIdempotencyKey(record, table) {
  if (record && record.idempotency_key) return String(record.idempotency_key);
  const parts = [
    table,
    record.account_id || '',
    record.strategy_id || '',
    record.trade_id || record.order_id || record.signal_id || '',
    record.broker_order_id || '',
    record.trade_ts || record.event_ts || record.timestamp || record.snapshot_ts || record.metric_ts || record.observed_ts || '',
    record.symbol || '',
    record.side || '',
    record.quantity || '',
    record.avg_fill_price || record.price || '',
  ].join('|');
  return sha256(parts);
}

function tradeLogRow(p) {
  const tradeId = p.trade_id || `trd_${sha256(JSON.stringify(p)).slice(0, 24)}`;
  const idem = makeIdempotencyKey(p, 'trade_log');
  return `(
    ${sqlString(tradeId)},
    ${sqlString(p.source_row_id)},
    ${sqlString(p.run_id || 'unknown_run')},
    ${sqlString(p.strategy_id || 'unknown_strategy')},
    ${sqlString(p.strategy_name)},
    ${sqlString(p.signal_id)},
    ${sqlString(p.order_id)},
    ${sqlString(p.broker_order_id)},
    ${sqlString(p.account_id || 'unknown_account')},
    ${sqlTimestamp(p.trade_ts || p.timestamp || p.event_ts)},
    ${sqlString(p.symbol)},
    ${sqlString(p.asset_class)},
    ${sqlString(p.exchange)},
    ${sqlString(p.currency || 'USD')},
    ${sqlString(p.side)},
    ${sqlString(p.order_type)},
    ${sqlString(p.time_in_force)},
    ${sqlDecimal(p.quantity)},
    ${sqlDecimal(p.filled_quantity || p.quantity)},
    ${sqlDecimal(p.avg_fill_price || p.price)},
    ${sqlDecimal(p.notional)},
    ${sqlDecimal(p.fees)},
    ${sqlDecimal(p.slippage_bps)},
    ${sqlDecimal(p.gross_pnl)},
    ${sqlDecimal(p.net_pnl)},
    ${sqlDecimal(p.realized_pnl)},
    ${sqlDecimal(p.unrealized_pnl)},
    ${sqlDecimal(p.position_after)},
    ${sqlDecimal(p.exposure_after)},
    ${sqlDecimal(p.leverage_after)},
    ${sqlString(p.trade_status || 'UNKNOWN')},
    ${sqlString(p.execution_venue)},
    ${sqlString(p.liquidity_flag)},
    ${sqlString(p.model_version)},
    ${sqlString(p.risk_check_status)},
    ${sqlString(p.notes)},
    ${sqlVariant(p.raw_payload || p)},
    ${sqlString(idem)},
    CURRENT_TIMESTAMP(),
    CURRENT_TIMESTAMP()
  )`;
}

const TRADE_LOG_COLS = [
  'trade_id', 'source_row_id', 'run_id', 'strategy_id', 'strategy_name', 'signal_id', 'order_id',
  'broker_order_id', 'account_id', 'trade_ts', 'symbol', 'asset_class', 'exchange', 'currency',
  'side', 'order_type', 'time_in_force', 'quantity', 'filled_quantity', 'avg_fill_price',
  'notional', 'fees', 'slippage_bps', 'gross_pnl', 'net_pnl', 'realized_pnl', 'unrealized_pnl',
  'position_after', 'exposure_after', 'leverage_after', 'trade_status', 'execution_venue',
  'liquidity_flag', 'model_version', 'risk_check_status', 'notes', 'raw_payload',
  'idempotency_key', 'ingested_at', 'updated_at',
];

const AUDIT_COLS = [
  'audit_id', 'source_row_id', 'event_ts', 'actor_type', 'actor_id', 'workflow_id',
  'workflow_name', 'run_id', 'account_id', 'strategy_id', 'event_type', 'event_severity',
  'event_status', 'entity_type', 'entity_id', 'message', 'before_state', 'after_state',
  'raw_payload', 'ip_address', 'user_agent', 'correlation_id', 'idempotency_key', 'ingested_at',
];

function buildMerge(cfg, targetTable, columns, valueRows) {
  const colList = columns.join(', ');
  const prefixed = columns.map((c) => `s.${c}`).join(', ');
  return `
MERGE INTO ${fullTable(cfg, targetTable)} AS t
USING (
  SELECT * FROM VALUES
  ${valueRows.join(',\n')}
  AS s(${colList})
) AS s
ON t.idempotency_key = s.idempotency_key
WHEN NOT MATCHED THEN INSERT (${colList}) VALUES (${prefixed})
`.trim();
}

function mergeTradeLogSql(cfg, rows) {
  if (!rows || rows.length === 0) throw new Error('mergeTradeLogSql: rows required');
  return buildMerge(cfg, 'trade_log', TRADE_LOG_COLS, rows.map(tradeLogRow));
}

function auditRow(p, targetTable) {
  const auditId = p.audit_id || `${targetTable}_${sha256(JSON.stringify(p)).slice(0, 24)}`;
  const idem = makeIdempotencyKey(p, targetTable);
  return `(
    ${sqlString(auditId)},
    ${sqlString(p.source_row_id)},
    ${sqlTimestamp(p.event_ts || p.timestamp || p.n8n_received_at)},
    ${sqlString(p.actor_type || 'system')},
    ${sqlString(p.actor_id || 'n8n')},
    ${sqlString(p.workflow_id)},
    ${sqlString(p.workflow_name || 'Quantum Trading Pipeline')},
    ${sqlString(p.run_id)},
    ${sqlString(p.account_id)},
    ${sqlString(p.strategy_id)},
    ${sqlString(p.event_type || targetTable)},
    ${sqlString(p.event_severity || 'INFO')},
    ${sqlString(p.event_status || 'RECEIVED')},
    ${sqlString(p.entity_type)},
    ${sqlString(p.entity_id || p.trade_id || p.order_id)},
    ${sqlString(p.message || `Logged ${targetTable}`)},
    ${sqlVariant(p.before_state || {})},
    ${sqlVariant(p.after_state || {})},
    ${sqlVariant(p.raw_payload || p)},
    ${sqlString(p.ip_address)},
    ${sqlString(p.user_agent)},
    ${sqlString(p.correlation_id)},
    ${sqlString(idem)},
    CURRENT_TIMESTAMP()
  )`;
}

function mergeAuditSql(cfg, rows, targetTable = 'audit_trail') {
  if (!rows || rows.length === 0) throw new Error('mergeAuditSql: rows required');
  return buildMerge(cfg, 'audit_trail', AUDIT_COLS, rows.map((p) => auditRow(p, targetTable)));
}

function buildSqlForTable(cfg, table, rows) {
  if (table === 'trade_log') return mergeTradeLogSql(cfg, rows);
  return mergeAuditSql(cfg, rows, table);
}

function chunk(arr, size) {
  if (!Array.isArray(arr)) throw new Error('chunk: array required');
  if (!Number.isInteger(size) || size <= 0) throw new Error('chunk: positive integer size required');
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

module.exports = {
  KNOWN_TABLES,
  EVENT_TYPE_MAP,
  TRADE_LOG_COLS,
  AUDIT_COLS,
  normalizeTargetTable,
  makeIdempotencyKey,
  tradeLogRow,
  auditRow,
  mergeTradeLogSql,
  mergeAuditSql,
  buildSqlForTable,
  buildMerge,
  chunk,
};
