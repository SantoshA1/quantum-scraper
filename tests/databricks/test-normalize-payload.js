#!/usr/bin/env node
/* Tests: databricks/normalize-payload.js — normalization + idempotency */
'use strict';

const assert = require('assert');
const path = require('path');

const { normalizeItem, normalizeItems } = require(
  path.resolve(__dirname, '..', '..', 'databricks', 'normalize-payload.js')
);

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (err) { failed++; console.log(`  ❌ ${name} — ${err.message}`); }
}

class FrozenClock {
  constructor(iso) { this._iso = iso; }
  toISOString() { return this._iso; }
}
function frozenClockClass(iso) {
  return class extends FrozenClock { constructor() { super(iso); } };
}

console.log('\n[databricks/normalize-payload]');

t('normalizeItem fills defaults and builds sha256 idempotency_key', () => {
  const clock = frozenClockClass('2026-04-19T19:33:00.000Z');
  const out = normalizeItem({ json: {
    symbol: 'AAPL', side: 'BUY', quantity: 1, avg_fill_price: 10,
    account_id: 'a', strategy_id: 's', trade_id: 't', order_id: 'o',
    trade_ts: '2026-04-19T00:00:00Z', event_type: 'trade',
  }}, { clock });
  assert.strictEqual(out.event_type, 'trade');
  assert.strictEqual(out.account_id, 'a');
  assert.strictEqual(out.trade_id, 't');
  assert.match(out.idempotency_key, /^[a-f0-9]{64}$/);
  assert.strictEqual(out.n8n_received_at, '2026-04-19T19:33:00.000Z');
  assert.ok(out.raw_payload);
});

t('normalizeItem is idempotent under identical inputs', () => {
  const clock = frozenClockClass('2026-04-19T19:33:00.000Z');
  const a = normalizeItem({ json: { symbol: 'AAPL', side: 'BUY', quantity: 1 } }, { clock });
  const b = normalizeItem({ json: { symbol: 'AAPL', side: 'BUY', quantity: 1 } }, { clock });
  assert.strictEqual(a.idempotency_key, b.idempotency_key);
});

t('normalizeItem preserves explicit idempotency_key', () => {
  const out = normalizeItem({ json: { idempotency_key: 'abc', symbol: 'X' } });
  assert.strictEqual(out.idempotency_key, 'abc');
});

t('normalizeItem returns unknown_* defaults when missing', () => {
  const out = normalizeItem({ json: { symbol: 'X' } });
  assert.strictEqual(out.account_id, 'unknown_account');
  assert.strictEqual(out.strategy_id, 'unknown_strategy');
  assert.strictEqual(out.event_type, 'trade_log');
});

t('normalizeItems maps over an array and wraps as n8n items', () => {
  const items = [{ json: { symbol: 'A' } }, { json: { symbol: 'B' } }];
  const out = normalizeItems(items);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].json.symbol, 'A');
  assert.strictEqual(out[1].json.symbol, 'B');
});

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
