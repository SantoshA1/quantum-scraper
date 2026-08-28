#!/usr/bin/env node
/* Tests: databricks/sql-builders.js + sql-format.js — SQL generation, DDL coverage, normalization */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  normalizeTargetTable,
  makeIdempotencyKey,
  mergeTradeLogSql,
  mergeAuditSql,
  buildSqlForTable,
  chunk,
  KNOWN_TABLES,
  TRADE_LOG_COLS,
  AUDIT_COLS,
} = require(path.resolve(__dirname, '..', '..', 'databricks', 'sql-builders.js'));

const {
  sqlString, sqlTimestamp, sqlDate, sqlDecimal, sqlBigInt, sqlBoolean, sqlVariant, sha256,
} = require(path.resolve(__dirname, '..', '..', 'databricks', 'sql-format.js'));

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (err) { failed++; console.log(`  ❌ ${name} — ${err.message}`); }
}

console.log('\n[databricks/sql-format]');

t('sqlString quotes single quotes', () => {
  assert.strictEqual(sqlString("it's a string"), "'it''s a string'");
  assert.strictEqual(sqlString('plain'), "'plain'");
});

t('sqlString returns NULL for null/undefined/empty', () => {
  assert.strictEqual(sqlString(null), 'NULL');
  assert.strictEqual(sqlString(undefined), 'NULL');
  assert.strictEqual(sqlString(''), 'NULL');
});

t('sqlTimestamp formats ISO to TIMESTAMP literal', () => {
  assert.strictEqual(sqlTimestamp('2026-04-19T19:33:00.000Z'), "TIMESTAMP '2026-04-19 19:33:00.000'");
});

t('sqlTimestamp returns CURRENT_TIMESTAMP() for empty/invalid', () => {
  assert.strictEqual(sqlTimestamp(''), 'CURRENT_TIMESTAMP()');
  assert.strictEqual(sqlTimestamp(null), 'CURRENT_TIMESTAMP()');
  assert.strictEqual(sqlTimestamp('not-a-date'), 'CURRENT_TIMESTAMP()');
});

t('sqlDate formats yyyy-mm-dd', () => {
  assert.strictEqual(sqlDate('2026-04-19T19:33:00Z'), "DATE '2026-04-19'");
});

t('sqlDate returns NULL on bad date', () => {
  assert.strictEqual(sqlDate(null), 'NULL');
  assert.strictEqual(sqlDate(''), 'NULL');
  assert.strictEqual(sqlDate('nope'), 'NULL');
});

t('sqlDecimal passes through numeric strings and NULLs non-numeric', () => {
  assert.strictEqual(sqlDecimal('182.45'), '182.45');
  assert.strictEqual(sqlDecimal(100), '100');
  assert.strictEqual(sqlDecimal(''), 'NULL');
  assert.strictEqual(sqlDecimal('abc'), 'NULL');
});

t('sqlBigInt truncates to integer', () => {
  assert.strictEqual(sqlBigInt('42.9'), '42');
  assert.strictEqual(sqlBigInt(''), 'NULL');
});

t('sqlBoolean emits true/false/NULL', () => {
  assert.strictEqual(sqlBoolean(true), 'true');
  assert.strictEqual(sqlBoolean(false), 'false');
  assert.strictEqual(sqlBoolean(null), 'NULL');
});

t('sqlVariant wraps JSON via parse_json', () => {
  const out = sqlVariant({ a: 1, b: "quote's" });
  assert.match(out, /^parse_json\('.*'\)$/);
  assert.match(out, /\\"a\\":1|"a":1|a..1/);  // flexible
  assert.match(out, /quote''s/); // escaped single quote
});

console.log('\n[databricks/sql-builders]');

t('normalizeTargetTable maps aliases', () => {
  assert.strictEqual(normalizeTargetTable('trade'), 'trade_log');
  assert.strictEqual(normalizeTargetTable('trade_log'), 'trade_log');
  assert.strictEqual(normalizeTargetTable('Daily P&L'), 'daily_pnl');
  assert.strictEqual(normalizeTargetTable('signal'), 'strategy_signals');
  assert.strictEqual(normalizeTargetTable('health'), 'system_health');
});

t('normalizeTargetTable falls back to audit_trail for unknown event types', () => {
  assert.strictEqual(normalizeTargetTable('some_unknown_thing'), 'audit_trail');
});

t('normalizeTargetTable defaults nullish/empty input to trade_log', () => {
  assert.strictEqual(normalizeTargetTable(null), 'trade_log');
  assert.strictEqual(normalizeTargetTable(undefined), 'trade_log');
  assert.strictEqual(normalizeTargetTable(''), 'trade_log');
});

t('makeIdempotencyKey is deterministic (sha256 hex)', () => {
  const a = makeIdempotencyKey({ account_id: 'a', strategy_id: 's', trade_ts: '2026-04-19T00:00:00Z', symbol: 'AAPL', side: 'BUY', quantity: 1, avg_fill_price: 1 }, 'trade_log');
  const b = makeIdempotencyKey({ account_id: 'a', strategy_id: 's', trade_ts: '2026-04-19T00:00:00Z', symbol: 'AAPL', side: 'BUY', quantity: 1, avg_fill_price: 1 }, 'trade_log');
  assert.strictEqual(a, b);
  assert.match(a, /^[a-f0-9]{64}$/);
});

t('makeIdempotencyKey respects explicit idempotency_key', () => {
  assert.strictEqual(makeIdempotencyKey({ idempotency_key: 'pinned-key' }, 'trade_log'), 'pinned-key');
});

t('chunk splits arrays into fixed-size batches', () => {
  assert.deepStrictEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepStrictEqual(chunk([], 10), []);
});

t('chunk rejects invalid size', () => {
  assert.throws(() => chunk([1, 2], 0), /positive integer/);
  assert.throws(() => chunk([1, 2], -1), /positive integer/);
});

const cfg = { catalog: 'trading_prod', schema: 'quantum', batchSize: 100 };

t('mergeTradeLogSql contains MERGE INTO, ON idempotency_key, and all trade_log cols', () => {
  const sql = mergeTradeLogSql(cfg, [
    { trade_id: 'trd_1', account_id: 'a', strategy_id: 's', trade_ts: '2026-04-19T00:00:00Z', symbol: 'AAPL', side: 'BUY', quantity: '1', avg_fill_price: '1' },
  ]);
  assert.match(sql, /MERGE INTO `trading_prod`\.`quantum`\.`trade_log` AS t/);
  assert.match(sql, /ON t\.idempotency_key = s\.idempotency_key/);
  assert.match(sql, /WHEN NOT MATCHED THEN INSERT/);
  for (const col of TRADE_LOG_COLS) {
    assert.ok(sql.includes(col), `trade_log col missing: ${col}`);
  }
});

t('mergeTradeLogSql supports multi-row batch', () => {
  const rows = [
    { trade_id: 'a', account_id: 'x', trade_ts: '2026-04-19T00:00:00Z', symbol: 'A', side: 'BUY', quantity: '1', avg_fill_price: '1' },
    { trade_id: 'b', account_id: 'x', trade_ts: '2026-04-19T00:00:01Z', symbol: 'B', side: 'SELL', quantity: '2', avg_fill_price: '2' },
  ];
  const sql = mergeTradeLogSql(cfg, rows);
  assert.ok(sql.includes("'a'") && sql.includes("'b'"));
});

t('mergeAuditSql emits MERGE into audit_trail', () => {
  const sql = mergeAuditSql(cfg, [{ message: 'hello', account_id: 'x' }], 'system_health');
  assert.match(sql, /MERGE INTO `trading_prod`\.`quantum`\.`audit_trail`/);
  for (const col of AUDIT_COLS) assert.ok(sql.includes(col));
});

t('buildSqlForTable routes trade_log vs others', () => {
  const a = buildSqlForTable(cfg, 'trade_log', [{ trade_id: 't', account_id: 'a', trade_ts: '2026-04-19T00:00:00Z', symbol: 'AAPL', side: 'BUY', quantity: '1', avg_fill_price: '1' }]);
  const b = buildSqlForTable(cfg, 'risk_events', [{ message: 'alert' }]);
  assert.match(a, /`trade_log`/);
  assert.match(b, /`audit_trail`/);
});

t('mergeTradeLogSql escapes single quotes in text fields (injection safety)', () => {
  const sql = mergeTradeLogSql(cfg, [{
    trade_id: "t';DROP TABLE x;--",
    account_id: 'a', trade_ts: '2026-04-19T00:00:00Z',
    symbol: 'AAPL', side: 'BUY', quantity: '1', avg_fill_price: '1',
    notes: "it's; DROP TABLE trade_log; --",
  }]);
  assert.ok(sql.includes("'t'';DROP TABLE x;--'"));
  assert.ok(sql.includes("'it''s; DROP TABLE trade_log; --'"));
});

console.log('\n[DDL coverage]');

const ddl = fs.readFileSync(
  path.resolve(__dirname, '..', '..', 'databricks', 'sql', '001_create_tables.sql'),
  'utf8'
);

t('DDL file declares all 10 tables', () => {
  for (const tbl of KNOWN_TABLES) {
    const re = new RegExp(`CREATE TABLE IF NOT EXISTS trading_prod\\.quantum\\.${tbl}\\b`);
    assert.ok(re.test(ddl), `missing CREATE TABLE for ${tbl}`);
  }
});

t('DDL enables delta.feature.allowColumnDefaults on every CREATE TABLE', () => {
  const creates = (ddl.match(/CREATE TABLE IF NOT EXISTS trading_prod\.quantum\.\w+/g) || []);
  // Count only TBLPROPERTIES clauses, not doc comments that mention the flag.
  const props = (ddl.match(/^\s*TBLPROPERTIES\s*\(\s*'delta\.feature\.allowColumnDefaults'\s*=\s*'supported'\s*\)/gm) || []);
  assert.strictEqual(creates.length, 10);
  assert.strictEqual(props.length, 10);
});

t('DDL uses liquid CLUSTER BY (not PARTITIONED BY)', () => {
  assert.ok(ddl.includes('CLUSTER BY'));
  assert.ok(!/PARTITIONED BY/i.test(ddl));
});

t('DDL declares catalog + schema bootstraps', () => {
  assert.ok(/CREATE CATALOG IF NOT EXISTS trading_prod/.test(ddl));
  assert.ok(/CREATE SCHEMA IF NOT EXISTS trading_prod\.quantum/.test(ddl));
});

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
