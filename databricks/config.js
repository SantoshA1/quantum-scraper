'use strict';

const REQUIRED_KEYS = ['host', 'token', 'warehouseId'];

const DEFAULT_CATALOG = 'trading_prod';
const DEFAULT_SCHEMA = 'quantum';

const RETRY_DEFAULTS = Object.freeze({
  maxRetries: 8,
  baseDelayMs: 250,
  maxDelayMs: 30000,
  batchSize: 100,
});

function normalizeHost(rawHost) {
  if (rawHost === null || rawHost === undefined) return '';
  return String(rawHost)
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/g, '');
}

function warehousePath(warehouseId) {
  if (!warehouseId) {
    throw new Error('warehousePath: warehouseId is required');
  }
  return `/sql/1.0/warehouses/${warehouseId}`;
}

function loadConfig(env = process.env) {
  const cfg = {
    host: normalizeHost(env.DATABRICKS_HOST),
    token: env.DATABRICKS_TOKEN || '',
    warehouseId: env.DATABRICKS_WAREHOUSE_ID || '',
    catalog: env.DATABRICKS_CATALOG || DEFAULT_CATALOG,
    schema: env.DATABRICKS_SCHEMA || DEFAULT_SCHEMA,
    telegramBotToken: env.TELEGRAM_BOT_TOKEN || '',
    telegramPersonalChatId: env.TELEGRAM_PERSONAL_CHAT_ID || '',
    telegramSubscriberChatId: env.TELEGRAM_SUBSCRIBER_CHAT_ID || '',
    maxRetries: RETRY_DEFAULTS.maxRetries,
    baseDelayMs: RETRY_DEFAULTS.baseDelayMs,
    maxDelayMs: RETRY_DEFAULTS.maxDelayMs,
    batchSize: RETRY_DEFAULTS.batchSize,
  };
  return cfg;
}

function validateConfig(cfg) {
  const missing = REQUIRED_KEYS.filter((k) => !cfg[k]);
  return {
    ok: missing.length === 0,
    missing,
  };
}

function assertConfig(cfg) {
  const { ok, missing } = validateConfig(cfg);
  if (!ok) {
    throw new Error(`Missing Databricks config: ${missing.join(', ')}`);
  }
  return cfg;
}

function fullTable(cfg, tableName) {
  if (!tableName) throw new Error('fullTable: tableName required');
  return `\`${cfg.catalog}\`.\`${cfg.schema}\`.\`${tableName}\``;
}

module.exports = {
  REQUIRED_KEYS,
  DEFAULT_CATALOG,
  DEFAULT_SCHEMA,
  RETRY_DEFAULTS,
  normalizeHost,
  warehousePath,
  loadConfig,
  validateConfig,
  assertConfig,
  fullTable,
};
