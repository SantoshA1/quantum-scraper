#!/usr/bin/env node
/* Tests: databricks/logger.js — end-to-end non-blocking behavior with fake client */
'use strict';

const assert = require('assert');
const path = require('path');

const { groupByTable, writeBatchesToWarehouse, logPayloads } = require(
  path.resolve(__dirname, '..', '..', 'databricks', 'logger.js')
);

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (err) { failed++; console.log(`  ❌ ${name} — ${err.message}`); }
}

// -------- Fake SQL client --------
function makeFakeClient(opts = {}) {
  const calls = { connect: 0, openSession: 0, statements: [], closedSession: 0, closedConnection: 0 };
  const throws = opts.throws || 0;
  let thrown = 0;
  const factory = () => ({
    async connect() {
      calls.connect++;
      return {
        async openSession() {
          calls.openSession++;
          return {
            async executeStatement(sql) {
              if (thrown < throws) { thrown++; throw new Error(`fake-sql-fail-${thrown}`); }
              calls.statements.push(sql);
              return {
                async fetchAll() { return []; },
                async close() {},
              };
            },
            async close() { calls.closedSession++; },
          };
        },
        async close() { calls.closedConnection++; },
      };
    },
  });
  return { factory, calls };
}

(async () => {
  console.log('\n[databricks/logger]');

  await t('groupByTable routes by event_type', () => {
    const groups = groupByTable([
      { event_type: 'trade' },
      { event_type: 'signal' },
      { event_type: 'trade_log' },
      { event_type: 'health' },
    ]);
    assert.deepStrictEqual(Object.keys(groups).sort(), ['strategy_signals', 'system_health', 'trade_log']);
    assert.strictEqual(groups.trade_log.length, 2);
  });

  await t('writeBatchesToWarehouse executes one statement per batch per table', async () => {
    const { factory, calls } = makeFakeClient();
    const cfg = {
      host: 'h', token: 't', warehouseId: 'w', catalog: 'trading_prod', schema: 'quantum', batchSize: 2,
    };
    const groups = {
      trade_log: [
        { trade_id: 'a', account_id: 'x', trade_ts: '2026-04-19T00:00:00Z', symbol: 'AAPL', side: 'BUY', quantity: '1', avg_fill_price: '1' },
        { trade_id: 'b', account_id: 'x', trade_ts: '2026-04-19T00:00:01Z', symbol: 'A', side: 'BUY', quantity: '1', avg_fill_price: '1' },
        { trade_id: 'c', account_id: 'x', trade_ts: '2026-04-19T00:00:02Z', symbol: 'B', side: 'BUY', quantity: '1', avg_fill_price: '1' },
      ],
      audit_trail: [{ message: 'hi' }],
    };
    const res = await writeBatchesToWarehouse(cfg, groups, { clientFactory: factory });
    assert.deepStrictEqual(res.tables.sort(), ['audit_trail', 'trade_log']);
    assert.strictEqual(res.rows, 4);
    // trade_log: 3 rows / batchSize 2 => 2 statements; audit_trail: 1 => 1 statement
    assert.strictEqual(calls.statements.length, 3);
    assert.strictEqual(calls.closedSession, 1);
    assert.strictEqual(calls.closedConnection, 1);
  });

  await t('logPayloads returns ok=true on happy path (no Telegram call)', async () => {
    const { factory } = makeFakeClient();
    const env = {
      DATABRICKS_HOST: 'https://dbc-x.cloud.databricks.com',
      DATABRICKS_TOKEN: 't', DATABRICKS_WAREHOUSE_ID: 'w',
      DATABRICKS_CATALOG: 'trading_prod', DATABRICKS_SCHEMA: 'quantum',
    };
    const items = [{ json: {
      event_type: 'trade', trade_id: 'trd_1', account_id: 'a', strategy_id: 's',
      trade_ts: '2026-04-19T00:00:00Z', symbol: 'AAPL', side: 'BUY', quantity: '1', avg_fill_price: '10',
    }}];
    const out = await logPayloads(items, {
      env, clientFactory: factory, sleeper: () => Promise.resolve(), random: () => 0,
    });
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].json.databricks_logging_ok, true);
    assert.strictEqual(out[0].json.attempts, 1);
    assert.strictEqual(out[0].json.error, null);
    assert.deepStrictEqual(out[0].json.tables, ['trade_log']);
  });

  await t('logPayloads retries transient errors and eventually succeeds', async () => {
    const { factory, calls } = makeFakeClient({ throws: 3 });
    const env = {
      DATABRICKS_HOST: 'dbc.cloud', DATABRICKS_TOKEN: 't', DATABRICKS_WAREHOUSE_ID: 'w',
    };
    const items = [{ json: { event_type: 'trade', trade_id: 'x', account_id: 'a', strategy_id: 's', trade_ts: '2026-04-19T00:00:00Z', symbol: 'X', side: 'BUY', quantity: '1', avg_fill_price: '1' } }];
    const out = await logPayloads(items, {
      env, clientFactory: factory, sleeper: () => Promise.resolve(), random: () => 0,
    });
    assert.strictEqual(out[0].json.databricks_logging_ok, true);
    assert.strictEqual(out[0].json.attempts, 4);
    assert.ok(calls.statements.length >= 1);
  });

  await t('logPayloads never throws — returns ok=false on permanent failure (non-blocking)', async () => {
    const { factory } = makeFakeClient({ throws: 10_000 });
    const env = {
      DATABRICKS_HOST: 'dbc.cloud', DATABRICKS_TOKEN: 't', DATABRICKS_WAREHOUSE_ID: 'w',
    };
    // Missing telegram creds => sendTelegram returns skipped, no network.
    const items = [{ json: { event_type: 'trade', trade_id: 'x', account_id: 'a', strategy_id: 's', trade_ts: '2026-04-19T00:00:00Z', symbol: 'X', side: 'BUY', quantity: '1', avg_fill_price: '1' } }];
    const out = await logPayloads(items, {
      env, clientFactory: factory, sleeper: () => Promise.resolve(), random: () => 0,
    });
    assert.strictEqual(out[0].json.databricks_logging_ok, false);
    assert.strictEqual(out[0].json.attempts, 9); // maxRetries 8 + 1
    assert.match(out[0].json.error, /fake-sql-fail/);
    assert.ok(out[0].json.alert_results);
  });

  await t('logPayloads surfaces missing-config error via assertConfig', async () => {
    await assert.rejects(
      () => logPayloads([{ json: { event_type: 'trade' } }], { env: {} }),
      /Missing Databricks config/
    );
  });

  console.log(`\n  ${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
})();
