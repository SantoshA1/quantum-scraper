// n8n Code node: Databricks Batch Writer
// Mode: Run Once for All Items
// Language: JavaScript
// Requires environment:
//   DATABRICKS_HOST, DATABRICKS_TOKEN, DATABRICKS_WAREHOUSE_ID,
//   DATABRICKS_CATALOG, DATABRICKS_SCHEMA
//   TELEGRAM_BOT_TOKEN, TELEGRAM_PERSONAL_CHAT_ID, TELEGRAM_SUBSCRIBER_CHAT_ID
//   NODE_FUNCTION_ALLOW_EXTERNAL must include @databricks/sql
//   NODE_FUNCTION_ALLOW_BUILTIN must include crypto,https
//
// Non-blocking: never throws. Final failure routes to Telegram alert and
// a status item for the downstream IF node.

const crypto = require('crypto');
const https = require('https');
const { DBSQLClient } = require('@databricks/sql');

const CONFIG = {
  host: ($env.DATABRICKS_HOST || process.env.DATABRICKS_HOST || '').replace(/^https?:\/\//i, '').replace(/\/+$/g, ''),
  token: $env.DATABRICKS_TOKEN || process.env.DATABRICKS_TOKEN,
  warehouseId: $env.DATABRICKS_WAREHOUSE_ID || process.env.DATABRICKS_WAREHOUSE_ID,
  catalog: $env.DATABRICKS_CATALOG || process.env.DATABRICKS_CATALOG || 'trading_prod',
  schema: $env.DATABRICKS_SCHEMA || process.env.DATABRICKS_SCHEMA || 'quantum',
  telegramBotToken: $env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN,
  telegramPersonalChatId: $env.TELEGRAM_PERSONAL_CHAT_ID || process.env.TELEGRAM_PERSONAL_CHAT_ID,
  telegramSubscriberChatId: $env.TELEGRAM_SUBSCRIBER_CHAT_ID || process.env.TELEGRAM_SUBSCRIBER_CHAT_ID,
  maxRetries: 8,
  baseDelayMs: 250,
  maxDelayMs: 30000,
  batchSize: 100,
};

function assertConfig() {
  const required = ['host', 'token', 'warehouseId'];
  const missing = required.filter((k) => !CONFIG[k]);
  if (missing.length) throw new Error(`Missing Databricks config: ${missing.join(', ')}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function jitterDelay(attempt) {
  const exp = Math.min(CONFIG.maxDelayMs, CONFIG.baseDelayMs * Math.pow(2, attempt));
  return Math.floor(Math.random() * exp);
}

function sha256(v) { return crypto.createHash('sha256').update(String(v)).digest('hex'); }

function sqlString(v) {
  if (v === null || v === undefined) return 'NULL';
  const s = String(v);
  if (s === '') return 'NULL';
  return `'${s.replace(/'/g, "''")}'`;
}
function sqlTimestamp(v) {
  if (!v) return 'CURRENT_TIMESTAMP()';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return 'CURRENT_TIMESTAMP()';
  return `TIMESTAMP ${sqlString(d.toISOString().replace('T', ' ').replace('Z', ''))}`;
}
function sqlDecimal(v) {
  if (v === null || v === undefined || v === '') return 'NULL';
  if (Number.isNaN(Number(v))) return 'NULL';
  return String(v);
}
function sqlVariant(v) {
  if (v === null || v === undefined) return 'parse_json(NULL)';
  return `parse_json(${sqlString(JSON.stringify(v))})`;
}
function fullTable(name) {
  return `\`${CONFIG.catalog}\`.\`${CONFIG.schema}\`.\`${name}\``;
}
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const EVENT_MAP = {
  trade_log: 'trade_log', trade: 'trade_log',
  daily_pnl: 'daily_pnl', 'daily_p&l': 'daily_pnl', pnl: 'daily_pnl',
  portfolio_snapshot: 'portfolio_snapshot', snapshot: 'portfolio_snapshot',
  performance_metrics: 'performance_metrics', metrics: 'performance_metrics',
  audit_trail: 'audit_trail', audit: 'audit_trail',
  order_events: 'order_events', order_event: 'order_events',
  risk_events: 'risk_events', risk_event: 'risk_events',
  strategy_signals: 'strategy_signals', strategy_signal: 'strategy_signals', signal: 'strategy_signals',
  system_health: 'system_health', health: 'system_health',
};

function normalizeTargetTable(eventType) {
  const t = String(eventType || 'trade_log').toLowerCase().replace(/\s+/g, '_');
  return EVENT_MAP[t] || 'audit_trail';
}

function tradeLogRow(p) {
  const tradeId = p.trade_id || `trd_${sha256(JSON.stringify(p)).slice(0, 24)}`;
  const idem = p.idempotency_key || sha256(JSON.stringify(p));
  return `(
    ${sqlString(tradeId)}, ${sqlString(p.source_row_id)},
    ${sqlString(p.run_id || 'unknown_run')}, ${sqlString(p.strategy_id || 'unknown_strategy')},
    ${sqlString(p.strategy_name)}, ${sqlString(p.signal_id)}, ${sqlString(p.order_id)},
    ${sqlString(p.broker_order_id)}, ${sqlString(p.account_id || 'unknown_account')},
    ${sqlTimestamp(p.trade_ts || p.timestamp || p.event_ts)},
    ${sqlString(p.symbol)}, ${sqlString(p.asset_class)}, ${sqlString(p.exchange)},
    ${sqlString(p.currency || 'USD')}, ${sqlString(p.side)}, ${sqlString(p.order_type)},
    ${sqlString(p.time_in_force)}, ${sqlDecimal(p.quantity)},
    ${sqlDecimal(p.filled_quantity || p.quantity)}, ${sqlDecimal(p.avg_fill_price || p.price)},
    ${sqlDecimal(p.notional)}, ${sqlDecimal(p.fees)}, ${sqlDecimal(p.slippage_bps)},
    ${sqlDecimal(p.gross_pnl)}, ${sqlDecimal(p.net_pnl)}, ${sqlDecimal(p.realized_pnl)},
    ${sqlDecimal(p.unrealized_pnl)}, ${sqlDecimal(p.position_after)},
    ${sqlDecimal(p.exposure_after)}, ${sqlDecimal(p.leverage_after)},
    ${sqlString(p.trade_status || 'UNKNOWN')}, ${sqlString(p.execution_venue)},
    ${sqlString(p.liquidity_flag)}, ${sqlString(p.model_version)},
    ${sqlString(p.risk_check_status)}, ${sqlString(p.notes)},
    ${sqlVariant(p.raw_payload || p)}, ${sqlString(idem)},
    CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()
  )`;
}

const TRADE_LOG_COLS = `
  trade_id, source_row_id, run_id, strategy_id, strategy_name, signal_id, order_id,
  broker_order_id, account_id, trade_ts, symbol, asset_class, exchange, currency,
  side, order_type, time_in_force, quantity, filled_quantity, avg_fill_price,
  notional, fees, slippage_bps, gross_pnl, net_pnl, realized_pnl, unrealized_pnl,
  position_after, exposure_after, leverage_after, trade_status, execution_venue,
  liquidity_flag, model_version, risk_check_status, notes, raw_payload,
  idempotency_key, ingested_at, updated_at
`;

function mergeTradeLogSql(rows) {
  return `
MERGE INTO ${fullTable('trade_log')} AS t
USING (
  SELECT * FROM VALUES
  ${rows.map(tradeLogRow).join(',\n')}
  AS s(${TRADE_LOG_COLS})
) AS s
ON t.idempotency_key = s.idempotency_key
WHEN NOT MATCHED THEN INSERT (${TRADE_LOG_COLS}) VALUES (
  s.trade_id, s.source_row_id, s.run_id, s.strategy_id, s.strategy_name, s.signal_id, s.order_id,
  s.broker_order_id, s.account_id, s.trade_ts, s.symbol, s.asset_class, s.exchange, s.currency,
  s.side, s.order_type, s.time_in_force, s.quantity, s.filled_quantity, s.avg_fill_price,
  s.notional, s.fees, s.slippage_bps, s.gross_pnl, s.net_pnl, s.realized_pnl, s.unrealized_pnl,
  s.position_after, s.exposure_after, s.leverage_after, s.trade_status, s.execution_venue,
  s.liquidity_flag, s.model_version, s.risk_check_status, s.notes, s.raw_payload,
  s.idempotency_key, s.ingested_at, s.updated_at
)`;
}

const AUDIT_COLS = `
  audit_id, source_row_id, event_ts, actor_type, actor_id, workflow_id,
  workflow_name, run_id, account_id, strategy_id, event_type, event_severity,
  event_status, entity_type, entity_id, message, before_state, after_state,
  raw_payload, ip_address, user_agent, correlation_id, idempotency_key, ingested_at
`;

function genericAuditSql(rows, targetTable) {
  const values = rows.map((p) => {
    const auditId = p.audit_id || `${targetTable}_${sha256(JSON.stringify(p)).slice(0, 24)}`;
    return `(
      ${sqlString(auditId)}, ${sqlString(p.source_row_id)},
      ${sqlTimestamp(p.event_ts || p.timestamp || p.n8n_received_at)},
      ${sqlString(p.actor_type || 'system')}, ${sqlString(p.actor_id || 'n8n')},
      ${sqlString(p.workflow_id)}, ${sqlString(p.workflow_name || 'Quantum Trading Pipeline')},
      ${sqlString(p.run_id)}, ${sqlString(p.account_id)}, ${sqlString(p.strategy_id)},
      ${sqlString(p.event_type || targetTable)}, ${sqlString(p.event_severity || 'INFO')},
      ${sqlString(p.event_status || 'RECEIVED')}, ${sqlString(p.entity_type)},
      ${sqlString(p.entity_id || p.trade_id || p.order_id)},
      ${sqlString(p.message || `Logged ${targetTable}`)},
      ${sqlVariant(p.before_state || {})}, ${sqlVariant(p.after_state || {})},
      ${sqlVariant(p.raw_payload || p)},
      ${sqlString(p.ip_address)}, ${sqlString(p.user_agent)},
      ${sqlString(p.correlation_id)},
      ${sqlString(p.idempotency_key || sha256(JSON.stringify(p)))},
      CURRENT_TIMESTAMP()
    )`;
  });
  return `
MERGE INTO ${fullTable('audit_trail')} AS t
USING (
  SELECT * FROM VALUES
  ${values.join(',\n')}
  AS s(${AUDIT_COLS})
) AS s
ON t.idempotency_key = s.idempotency_key
WHEN NOT MATCHED THEN INSERT (${AUDIT_COLS}) VALUES (
  s.audit_id, s.source_row_id, s.event_ts, s.actor_type, s.actor_id, s.workflow_id,
  s.workflow_name, s.run_id, s.account_id, s.strategy_id, s.event_type, s.event_severity,
  s.event_status, s.entity_type, s.entity_id, s.message, s.before_state, s.after_state,
  s.raw_payload, s.ip_address, s.user_agent, s.correlation_id, s.idempotency_key, s.ingested_at
)`;
}

function buildSqlForTable(table, rows) {
  if (table === 'trade_log') return mergeTradeLogSql(rows);
  return genericAuditSql(rows, table);
}

function sendTelegram(chatId, text) {
  if (!CONFIG.telegramBotToken || !chatId) return Promise.resolve({ skipped: true });
  const body = JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true });
  const options = {
    hostname: 'api.telegram.org',
    path: `/bot${CONFIG.telegramBotToken}/sendMessage`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    timeout: 10000,
  };
  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.on('error', (err) => resolve({ error: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'telegram_timeout' }); });
    req.write(body); req.end();
  });
}

function truncate(s, max = 3500) {
  if (!s) return '';
  return s.length > max ? s.slice(0, max) + '\n...[truncated]' : s;
}

async function alertFinalFailure(error, payloads, retryCount) {
  const first = payloads[0] || {};
  const text = truncate(
    `🚨 Databricks logging failed after ${retryCount} retries\n` +
    `Workflow: Quantum Trading Pipeline\n` +
    `Target event: ${first.event_type || 'unknown'}\n` +
    `Account: ${first.account_id || 'unknown'}\n` +
    `Strategy: ${first.strategy_id || 'unknown'}\n` +
    `Symbol: ${first.symbol || 'unknown'}\n` +
    `Trade ID: ${first.trade_id || 'none'}\n` +
    `Order ID: ${first.order_id || 'none'}\n` +
    `Error:\n${error && error.stack ? error.stack : String(error)}\n` +
    `Payload:\n${JSON.stringify(payloads, null, 2)}`
  );
  const results = [];
  results.push(await sendTelegram(CONFIG.telegramPersonalChatId, text));
  results.push(await sendTelegram(CONFIG.telegramSubscriberChatId, text));
  return results;
}

async function executeSql(session, statement) {
  const op = await session.executeStatement(statement, { runAsync: false });
  try { await op.fetchAll(); } finally { await op.close(); }
}

async function withRetries(fn, payloads) {
  let lastError;
  for (let attempt = 0; attempt <= CONFIG.maxRetries; attempt++) {
    try { return { ok: true, result: await fn(attempt), attempts: attempt + 1 }; }
    catch (err) {
      lastError = err;
      if (attempt === CONFIG.maxRetries) break;
      await sleep(jitterDelay(attempt));
    }
  }
  const alertResults = await alertFinalFailure(lastError, payloads, CONFIG.maxRetries);
  return {
    ok: false,
    error: lastError ? String(lastError.stack || lastError.message || lastError) : 'unknown_error',
    attempts: CONFIG.maxRetries + 1,
    alertResults,
  };
}

async function main() {
  assertConfig();
  const payloads = items.map((i) => i.json || {});
  const groups = {};
  for (const p of payloads) {
    const table = normalizeTargetTable(p.event_type || p.worksheet || p.table);
    (groups[table] = groups[table] || []).push(p);
  }

  const client = new DBSQLClient();
  let connection; let session;

  const writeResult = await withRetries(async () => {
    connection = await client.connect({
      host: CONFIG.host,
      path: `/sql/1.0/warehouses/${CONFIG.warehouseId}`,
      token: CONFIG.token,
    });
    session = await connection.openSession();
    for (const [table, rows] of Object.entries(groups)) {
      for (const batch of chunk(rows, CONFIG.batchSize)) {
        await executeSql(session, buildSqlForTable(table, batch));
      }
    }
    return { tables: Object.keys(groups), rows: payloads.length };
  }, payloads);

  try { if (session) await session.close(); } catch (_) {}
  try { if (connection) await connection.close(); } catch (_) {}

  return [{
    json: {
      databricks_logging_ok: writeResult.ok,
      attempts: writeResult.attempts,
      rows: payloads.length,
      tables: Object.keys(groups),
      error: writeResult.error || null,
      alert_results: writeResult.alertResults || null,
    },
  }];
}

return await main();
