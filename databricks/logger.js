'use strict';

const { loadConfig, assertConfig, warehousePath } = require('./config');
const { buildSqlForTable, normalizeTargetTable, chunk } = require('./sql-builders');
const { withRetries } = require('./retry');
const { alertFinalFailure } = require('./telegram-alert');

function groupByTable(payloads) {
  const groups = {};
  for (const p of payloads) {
    const table = normalizeTargetTable(p.event_type || p.worksheet || p.table);
    (groups[table] = groups[table] || []).push(p);
  }
  return groups;
}

async function executeSql(session, statement) {
  const operation = await session.executeStatement(statement, { runAsync: false });
  try {
    await operation.fetchAll();
  } finally {
    await operation.close();
  }
}

async function writeBatchesToWarehouse(cfg, groups, deps = {}) {
  const clientFactory = deps.clientFactory;
  if (typeof clientFactory !== 'function') {
    throw new Error('writeBatchesToWarehouse: deps.clientFactory required');
  }
  const client = clientFactory();
  let connection;
  let session;
  try {
    connection = await client.connect({
      host: cfg.host,
      path: warehousePath(cfg.warehouseId),
      token: cfg.token,
    });
    session = await connection.openSession();
    for (const [table, rows] of Object.entries(groups)) {
      for (const batch of chunk(rows, cfg.batchSize)) {
        const sql = buildSqlForTable(cfg, table, batch);
        await executeSql(session, sql);
      }
    }
    return { tables: Object.keys(groups), rows: Object.values(groups).reduce((a, b) => a + b.length, 0) };
  } finally {
    try { if (session) await session.close(); } catch (_) {}
    try { if (connection) await connection.close(); } catch (_) {}
  }
}

async function logPayloads(items, deps = {}) {
  const env = deps.env || process.env;
  const cfg = assertConfig(loadConfig(env));
  const payloads = (items || []).map((i) => (i && i.json) || i || {});
  const groups = groupByTable(payloads);

  const writeResult = await withRetries(
    async () => writeBatchesToWarehouse(cfg, groups, deps),
    {
      maxRetries: cfg.maxRetries,
      baseDelayMs: cfg.baseDelayMs,
      maxDelayMs: cfg.maxDelayMs,
      random: deps.random,
      sleeper: deps.sleeper,
      payloads,
      onFinalFailure: (error, p, retries) => alertFinalFailure({
        error, payloads: p, retryCount: retries, cfg, https: deps.https,
      }),
    }
  );

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

module.exports = {
  groupByTable,
  executeSql,
  writeBatchesToWarehouse,
  logPayloads,
};
