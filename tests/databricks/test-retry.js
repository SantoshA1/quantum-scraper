#!/usr/bin/env node
/* Tests: databricks/retry.js — jitter shape, retry-then-succeed, final-failure alerting, non-blocking */
'use strict';

const assert = require('assert');
const path = require('path');

const { jitterDelay, withRetries } = require(
  path.resolve(__dirname, '..', '..', 'databricks', 'retry.js')
);

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (err) { failed++; console.log(`  ❌ ${name} — ${err.message}`); }
}

(async () => {
  console.log('\n[databricks/retry]');

  await t('jitterDelay caps at maxDelayMs * random (never exceeds cap)', () => {
    const opts = { baseDelayMs: 250, maxDelayMs: 30000, random: () => 0.999999 };
    // Cap kicks in once baseDelayMs * 2^attempt >= maxDelayMs
    // 250 * 2^7 = 32000 >= 30000, so attempt 7 already capped.
    for (let a = 0; a < 20; a++) {
      const d = jitterDelay(a, opts);
      assert.ok(d <= 30000, `attempt=${a} delay=${d} exceeded cap`);
    }
  });

  await t('jitterDelay with random=0 returns 0', () => {
    assert.strictEqual(jitterDelay(0, { random: () => 0 }), 0);
    assert.strictEqual(jitterDelay(5, { random: () => 0 }), 0);
  });

  await t('jitterDelay is exponential in attempt number', () => {
    const opts = { baseDelayMs: 100, maxDelayMs: 1e9, random: () => 1 - 1e-9 };
    const d0 = jitterDelay(0, opts);
    const d1 = jitterDelay(1, opts);
    const d2 = jitterDelay(2, opts);
    assert.ok(d1 > d0);
    assert.ok(d2 > d1);
  });

  await t('withRetries returns ok on first-try success', async () => {
    const res = await withRetries(async () => 'hello', { maxRetries: 3, sleeper: () => Promise.resolve() });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.result, 'hello');
    assert.strictEqual(res.attempts, 1);
  });

  await t('withRetries retries then succeeds within maxRetries', async () => {
    let count = 0;
    const res = await withRetries(async () => {
      count++;
      if (count < 3) throw new Error('transient');
      return 'ok';
    }, { maxRetries: 5, sleeper: () => Promise.resolve(), random: () => 0 });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.result, 'ok');
    assert.strictEqual(res.attempts, 3);
    assert.strictEqual(count, 3);
  });

  await t('withRetries attempts exactly maxRetries+1 before final failure', async () => {
    let count = 0;
    const res = await withRetries(async () => {
      count++;
      throw new Error('always fails');
    }, { maxRetries: 8, sleeper: () => Promise.resolve(), random: () => 0 });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.attempts, 9);
    assert.strictEqual(count, 9);
    assert.match(res.error, /always fails/);
  });

  await t('withRetries invokes onFinalFailure with last error + payloads + retry count', async () => {
    const seen = { called: 0 };
    const payloads = [{ trade_id: 'x' }];
    const res = await withRetries(async () => { throw new Error('boom'); }, {
      maxRetries: 2,
      sleeper: () => Promise.resolve(),
      random: () => 0,
      payloads,
      onFinalFailure: async (err, p, retries) => {
        seen.called++;
        assert.strictEqual(p, payloads);
        assert.strictEqual(retries, 2);
        assert.match(err.message, /boom/);
        return { alerted: true };
      },
    });
    assert.strictEqual(seen.called, 1);
    assert.strictEqual(res.ok, false);
    assert.deepStrictEqual(res.alertResults, { alerted: true });
  });

  await t('withRetries is non-blocking: resolves with error result, does not throw', async () => {
    await withRetries(async () => { throw new Error('nope'); }, {
      maxRetries: 1,
      sleeper: () => Promise.resolve(),
      random: () => 0,
    });
    // Just reaching here without catching means we did not throw.
    assert.ok(true);
  });

  await t('withRetries swallows errors inside onFinalFailure', async () => {
    const res = await withRetries(async () => { throw new Error('underlying'); }, {
      maxRetries: 1,
      sleeper: () => Promise.resolve(),
      random: () => 0,
      onFinalFailure: async () => { throw new Error('alert-exploded'); },
    });
    assert.strictEqual(res.ok, false);
    assert.deepStrictEqual(res.alertResults, { alertError: 'alert-exploded' });
  });

  console.log(`\n  ${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
})();
