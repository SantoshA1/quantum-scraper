#!/usr/bin/env node
/* Tests: databricks/config.js — env validation, host normalization, warehouse path */
'use strict';

const assert = require('assert');
const path = require('path');

const {
  normalizeHost,
  warehousePath,
  loadConfig,
  validateConfig,
  assertConfig,
  fullTable,
  REQUIRED_KEYS,
  DEFAULT_CATALOG,
  DEFAULT_SCHEMA,
} = require(path.resolve(__dirname, '..', '..', 'databricks', 'config.js'));

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (err) { failed++; console.log(`  ❌ ${name} — ${err.message}`); }
}

console.log('\n[databricks/config]');

t('normalizeHost strips https:// and trailing slash', () => {
  assert.strictEqual(normalizeHost('https://dbc-xyz.cloud.databricks.com'), 'dbc-xyz.cloud.databricks.com');
  assert.strictEqual(normalizeHost('http://dbc-xyz.cloud.databricks.com/'), 'dbc-xyz.cloud.databricks.com');
  assert.strictEqual(normalizeHost('HTTPS://dbc-xyz.cloud.databricks.com///'), 'dbc-xyz.cloud.databricks.com');
});

t('normalizeHost returns empty string on null/undefined', () => {
  assert.strictEqual(normalizeHost(null), '');
  assert.strictEqual(normalizeHost(undefined), '');
  assert.strictEqual(normalizeHost(''), '');
});

t('warehousePath composes correct http_path', () => {
  assert.strictEqual(warehousePath('abc123'), '/sql/1.0/warehouses/abc123');
});

t('warehousePath throws when warehouseId is missing', () => {
  assert.throws(() => warehousePath(''), /warehouseId/);
  assert.throws(() => warehousePath(null), /warehouseId/);
});

t('loadConfig normalizes host and applies defaults', () => {
  const cfg = loadConfig({
    DATABRICKS_HOST: 'https://dbc-abc.cloud.databricks.com/',
    DATABRICKS_TOKEN: 'tok',
    DATABRICKS_WAREHOUSE_ID: 'wh-1',
  });
  assert.strictEqual(cfg.host, 'dbc-abc.cloud.databricks.com');
  assert.strictEqual(cfg.token, 'tok');
  assert.strictEqual(cfg.warehouseId, 'wh-1');
  assert.strictEqual(cfg.catalog, DEFAULT_CATALOG);
  assert.strictEqual(cfg.schema, DEFAULT_SCHEMA);
  assert.strictEqual(cfg.maxRetries, 8);
  assert.strictEqual(cfg.batchSize, 100);
});

t('loadConfig respects custom catalog/schema', () => {
  const cfg = loadConfig({
    DATABRICKS_HOST: 'host',
    DATABRICKS_TOKEN: 't',
    DATABRICKS_WAREHOUSE_ID: 'w',
    DATABRICKS_CATALOG: 'custom_cat',
    DATABRICKS_SCHEMA: 'custom_schema',
  });
  assert.strictEqual(cfg.catalog, 'custom_cat');
  assert.strictEqual(cfg.schema, 'custom_schema');
});

t('validateConfig reports all missing required keys', () => {
  const res = validateConfig({ host: '', token: '', warehouseId: '' });
  assert.strictEqual(res.ok, false);
  assert.deepStrictEqual(res.missing.sort(), [...REQUIRED_KEYS].sort());
});

t('validateConfig returns ok when required keys present', () => {
  const res = validateConfig({ host: 'h', token: 't', warehouseId: 'w' });
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(res.missing, []);
});

t('assertConfig throws with joined missing keys', () => {
  assert.throws(
    () => assertConfig({ host: '', token: '', warehouseId: '' }),
    /Missing Databricks config:.*host.*token.*warehouseId/
  );
});

t('assertConfig passes through valid config', () => {
  const cfg = { host: 'h', token: 't', warehouseId: 'w' };
  assert.strictEqual(assertConfig(cfg), cfg);
});

t('fullTable backtick-quotes identifiers', () => {
  const cfg = { catalog: 'trading_prod', schema: 'quantum' };
  assert.strictEqual(fullTable(cfg, 'trade_log'), '`trading_prod`.`quantum`.`trade_log`');
});

t('fullTable requires tableName', () => {
  assert.throws(() => fullTable({ catalog: 'c', schema: 's' }, ''), /tableName/);
});

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
