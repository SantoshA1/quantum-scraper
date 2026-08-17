#!/usr/bin/env node
'use strict';
/**
 * Maya regression guard — the gov 219 short-side halt (2026-08-14).
 *
 * Maya asks: "You are switching off half the book inside the one node that decides whether
 * an order is allowed to live, and that node has onError=stopWorkflow — a throw there kills
 * the whole pipeline. Prove FROM THE DEPLOYED BYTES that (a) new shorts are blocked, (b) an
 * exit, cover, stop or trailing stop on an existing short is NEVER blocked, because if you
 * get that wrong you strand a live short position with no way out, (c) longs are completely
 * unaffected, (d) it blocks when the variable is missing rather than failing open, and
 * (e) it cannot throw, whatever it is handed."
 *
 * Deterministic + offline. Fixtures are the real `QTP-10FC New Entry Pause Guard` jsCode of
 * workflow vaqfCaELhOEWnkdo: `pauseguard-deployed.js` is the pre-halt body (sha 79a0a171…)
 * and `pauseguard-patched.js` is what was published (sha 13345838…). The node body is
 * EXECUTED here against real item shapes, not grepped.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FIX = path.join(__dirname, '..', 'docs', 'short-halt-20260814');
const BEFORE = fs.readFileSync(path.join(FIX, 'pauseguard-deployed.js'), 'utf8');
const AFTER = fs.readFileSync(path.join(FIX, 'pauseguard-patched.js'), 'utf8');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

let passed = 0, failed = 0;
function check(id, name, fn) {
  try { fn(); console.log(`  ✅ ${id}  ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${id}  ${name}\n        ${e.message}`); failed++; }
}

// ── execute the real node body ────────────────────────────────────────────────
function run(src, itemsJson, vars) {
  const items = itemsJson.map((j) => ({ json: j }));
  const fn = new Function('items', '$vars', src);
  return fn(items, vars).map((o) => o.json);
}
const guard = (item, vars) => run(AFTER, [item], vars)[0];
const guardOld = (item) => run(BEFORE, [item], undefined)[0];

const ON = { QTP_SHORT_ENTRIES_ENABLED: 'true' };
const NOPAUSE = { _supabase_pause_control: { pause_new_entries: 'false' } };

// real production item shapes
const SHORT_ENTRY = { ...NOPAUSE, symbol: 'ZTS', side: 'SELL', execution: 'SELL',
  order_intent: 'sell_short_or_close_per_downstream_state', bias_score: 74 };
const LONG_ENTRY = { ...NOPAUSE, symbol: 'AMD', side: 'BUY', execution: 'BUY',
  order_intent: 'buy_long_or_cover_per_downstream_state', bias_score: 100 };
const SHORT_COVER = { ...NOPAUSE, symbol: 'ZTS', side: 'BUY', action: 'BUY_TO_COVER' };
const LONG_CLOSE = { ...NOPAUSE, symbol: 'AMD', side: 'SELL', action: 'SELL_TO_CLOSE' };
const SHORT_STOP = { ...NOPAUSE, symbol: 'WSM', side: 'BUY', order_action: 'STOP', is_protective: true };
const SHORT_TRAIL = { ...NOPAUSE, symbol: 'WSM', side: 'BUY', order_class: 'TRAILING_STOP' };
const SHORT_REDUCE = { ...NOPAUSE, symbol: 'WRB', side: 'BUY', reduce_only: true };

(async () => {
  console.log('\n═══ the bytes are the deployed bytes ═══\n');

  check('SH-01', 'fixtures are the real pre-halt and published pause-guard bodies', () => {
    assert.strictEqual(sha(BEFORE), '79a0a171d49be05e6b8f7dfa8074de78ab81da849ef6093514dbf5145425eb18');
    assert.strictEqual(sha(AFTER), '133458389c5a368f52288972268cdaee74bcc61a9ce9681d5bdca038a42cacbb');
  });

  check('SH-02', 'the three pre-existing verdicts still exist exactly once each', () => {
    for (const v of ['BYPASS_PROTECTIVE_OR_CLOSING', 'BLOCK_NEW_ENTRY_ONLY', 'ALLOW_NEW_ENTRY']) {
      assert.strictEqual(AFTER.split(v).length - 1, 1, `${v} count changed`);
      assert.strictEqual(BEFORE.split(v).length - 1, 1);
    }
    assert.ok(AFTER.includes('QTP_PAUSE_GUARD_INTENT_PARSE_FIX_v1_20260526'),
      'the 05-26 intent-parse fix must survive untouched');
  });

  console.log('\n═══ new shorts are blocked ═══\n');

  check('SH-03', 'a new short entry is blocked, and says why', () => {
    const r = guard(SHORT_ENTRY, undefined);
    assert.strictEqual(r._pause_guard_action, 'BLOCK_SHORT_ENTRY_ONLY');
    assert.strictEqual(r._pause_guard_live_order_allowed, false);
    assert.strictEqual(r._sm_route, 'SKIP');
    assert.strictEqual(r._sm_action, 'KILLED');
    assert.ok(r._pause_guard_reason.includes('PF 0.2802'), r._pause_guard_reason);
  });

  check('SH-04', 'the same signal passed straight through BEFORE the halt — this is a real change', () => {
    const old = guardOld(SHORT_ENTRY);
    assert.strictEqual(old._pause_guard_action, 'ALLOW_NEW_ENTRY');
    assert.strictEqual(old._pause_guard_live_order_allowed, true);
  });

  check('SH-05', 'every spelling of short the pipeline uses is caught', () => {
    for (const f of ['side', 'execution', 'signal', 'direction', 'signal_direction', 'action', 'order_action']) {
      for (const v of ['SELL', 'SHORT', 'BEARISH', 'sell', ' Short ']) {
        const r = guard({ ...NOPAUSE, symbol: 'X', [f]: v }, undefined);
        assert.strictEqual(r._pause_guard_live_order_allowed, false, `missed ${f}=${JSON.stringify(v)}`);
      }
    }
  });

  console.log('\n═══ an existing short can ALWAYS get out ═══\n');

  check('SH-06', 'cover / close / stop / trailing stop / reduce-only all bypass, halt or no halt', () => {
    for (const [name, item] of [['cover', SHORT_COVER], ['long close', LONG_CLOSE],
      ['protective stop', SHORT_STOP], ['trailing stop', SHORT_TRAIL], ['reduce-only', SHORT_REDUCE]]) {
      const r = guard(item, undefined);
      assert.strictEqual(r._pause_guard_action, 'BYPASS_PROTECTIVE_OR_CLOSING', `${name} was not bypassed`);
      assert.strictEqual(r._pause_guard_live_order_allowed, true, `${name} was not allowed`);
    }
  });

  check('SH-07', 'an exit is bypassed even while the entry pause is ALSO active', () => {
    const paused = { _supabase_pause_control: { pause_new_entries: 'true', reason: 'halt' } };
    const r = guard({ ...SHORT_COVER, ...paused }, undefined);
    assert.strictEqual(r._pause_guard_live_order_allowed, true, 'stranding a live short is the one unacceptable failure');
  });

  check('SH-08', 'the halt is decided AFTER the closing check, never before', () => {
    const iClosing = AFTER.indexOf('if (isClosingOrProtective(j))');
    const iShort = AFTER.indexOf('if (isNewShortEntry(j)');
    assert.ok(iClosing > -1 && iShort > -1);
    assert.ok(iClosing < iShort, 'the protective bypass must be evaluated first');
  });

  console.log('\n═══ longs are untouched ═══\n');

  check('SH-09', 'a long entry behaves byte-for-byte as it did before the halt', () => {
    const before = guardOld(LONG_ENTRY);
    const after = guard(LONG_ENTRY, undefined);
    for (const k of ['_pause_guard_action', '_pause_guard_live_order_allowed', '_pause_guard_checked']) {
      assert.deepStrictEqual(after[k], before[k], `long path changed on ${k}`);
    }
    assert.strictEqual(after._pause_guard_action, 'ALLOW_NEW_ENTRY');
    assert.strictEqual(after._short_halt_v, undefined, 'no halt stamp on a long');
  });

  check('SH-10', 'the gov-213 entry pause still blocks a long when it is active', () => {
    const paused = { _supabase_pause_control: { pause_new_entries: 'true', reason: 'gov-213' } };
    const r = guard({ ...LONG_ENTRY, ...paused }, ON);
    assert.strictEqual(r._pause_guard_action, 'BLOCK_NEW_ENTRY_ONLY');
    assert.ok(r._pause_guard_reason.includes('gov-213'));
  });

  console.log('\n═══ it fails safe, and it cannot throw ═══\n');

  check('SH-11', 'a MISSING variable blocks shorts — protection never depends on a value existing', () => {
    for (const vars of [undefined, {}, { QTP_SHORT_ENTRIES_ENABLED: '' },
      { QTP_SHORT_ENTRIES_ENABLED: 'false' }, { QTP_SHORT_ENTRIES_ENABLED: '0' },
      { QTP_SHORT_ENTRIES_ENABLED: 'yes' }, { QTP_SHORT_ENTRIES_ENABLED: null }]) {
      const r = guard(SHORT_ENTRY, vars);
      assert.strictEqual(r._pause_guard_live_order_allowed, false,
        `fail-open on vars=${JSON.stringify(vars)}`);
    }
  });

  check('SH-12', 'only the exact string true re-enables shorts, and then they flow again', () => {
    for (const v of ['true', 'TRUE', ' True ']) {
      const r = guard(SHORT_ENTRY, { QTP_SHORT_ENTRIES_ENABLED: v });
      assert.strictEqual(r._pause_guard_action, 'ALLOW_NEW_ENTRY', `did not re-enable on ${JSON.stringify(v)}`);
      assert.strictEqual(r._pause_guard_live_order_allowed, true);
    }
  });

  check('SH-13', 'hostile and empty items do not throw — this node halts the pipeline if it does', () => {
    const nasty = [{}, { side: null }, { side: {} }, { side: [] }, { execution: 123 },
      { side: 'SELL', _supabase_pause_control: null }, { _supabase_pause_control: 'garbage' }];
    for (const item of nasty) {
      const out = run(AFTER, [item], undefined);
      assert.strictEqual(out.length, 1, `item ${JSON.stringify(item)} lost`);
      assert.ok(typeof out[0]._pause_guard_live_order_allowed === 'boolean');
    }
    // and a $vars object that throws on property access must not take the pipeline down
    const hostile = new Proxy({}, { get() { throw new Error('boom'); } });
    const r = guard(SHORT_ENTRY, hostile);
    assert.strictEqual(r._pause_guard_live_order_allowed, false, 'a throwing $vars must fail safe, not fail loud');
  });

  check('SH-14', 'a mixed batch is decided per item, not per batch', () => {
    const out = run(AFTER, [LONG_ENTRY, SHORT_ENTRY, SHORT_COVER, LONG_ENTRY], undefined);
    assert.deepStrictEqual(out.map((r) => r._pause_guard_action),
      ['ALLOW_NEW_ENTRY', 'BLOCK_SHORT_ENTRY_ONLY', 'BYPASS_PROTECTIVE_OR_CLOSING', 'ALLOW_NEW_ENTRY']);
  });

  console.log(`\n  ${passed}/${passed + failed} checks passed\n`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('HARNESS FAILURE:', e); process.exit(1); });
