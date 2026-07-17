#!/usr/bin/env node
'use strict';
/**
 * A2 unit test — BACKTEST_ENFORCEMENT + F2 PF shadow gate.
 *
 * Maya asks: "Does the backtest gate pick the right sample/PF bar (strict vs
 * relaxed vs high-vol), refuse to pass when PF/sample data is missing (never a
 * silent pass), and — with the cohort on — stop blocking on PF while still
 * recording what it WOULD have done?"
 *
 * Pins the Ruling-2 fail-closed UNKNOWN and the F2 cohort on/off behaviour.
 * Tests lib/gates/backtest.js. Run: node tests/test-backtest-gate.js (or: npm test)
 */
const assert = require('assert');
const { BT, btBool, selectBacktestThresholds, baseBacktestValid, pfWouldBlockRaw, pfVerdict, backtestValid } = require('../lib/gates/backtest');

let passed = 0, failed = 0;
function check(id, name, fn) {
  try { fn(); console.log(`  ✅ ${id}  ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${id}  ${name}  — ${e.message}`); failed++; }
}

// --- tier constants ---
check('BT-01', 'tier bars: strict 100/1.20, relaxed 40/1.05, highVol 30/0.95; VFS/USO high-vol', () => {
  assert.deepStrictEqual([BT.strict.minTrades, BT.strict.minPf], [100, 1.20]);
  assert.deepStrictEqual([BT.relaxed.minTrades, BT.relaxed.minPf], [40, 1.05]);
  assert.deepStrictEqual([BT.highVol.minTrades, BT.highVol.minPf], [30, 0.95]);
  assert.ok(BT.highVolSymbols.has('VFS') && BT.highVolSymbols.has('USO'));
});

// --- tier selection precedence ---
check('BT-02', 'selection: default->strict, relaxed_mode/pre-market->relaxed, high-vol wins', () => {
  assert.strictEqual(selectBacktestThresholds({ ticker: 'AAPL' }).action, 'STRICT');
  assert.strictEqual(selectBacktestThresholds({ ticker: 'AAPL', relaxed_mode: true }).action, 'RELAXED');
  assert.strictEqual(selectBacktestThresholds({ ticker: 'AAPL', market_status: 'PREMARKET' }).action, 'RELAXED');
  assert.strictEqual(selectBacktestThresholds({ ticker: 'VFS' }).action, 'HIGH_VOL_RELAXED');         // symbol
  assert.strictEqual(selectBacktestThresholds({ ticker: 'AAPL', high_vol: 'yes' }).action, 'HIGH_VOL_RELAXED'); // flag
  assert.strictEqual(selectBacktestThresholds({ ticker: 'USO', relaxed_mode: true }).action, 'HIGH_VOL_RELAXED'); // highVol beats relaxed
});

// --- base validity gate ---
check('BT-03', 'baseBacktestValid: not-required->true; required needs sample>=min AND pf>=min', () => {
  const t = BT.strict; // 100/1.20
  assert.strictEqual(baseBacktestValid(false, null, null, t), true);          // not required
  assert.strictEqual(baseBacktestValid(true, 100, 1.20, t), true);            // exactly at bar
  assert.strictEqual(baseBacktestValid(true, 99, 1.20, t), false);            // sample short
  assert.strictEqual(baseBacktestValid(true, 100, 1.19, t), false);           // pf short
  assert.strictEqual(baseBacktestValid(true, null, 1.5, t), false);           // missing sample
  assert.strictEqual(baseBacktestValid(true, 200, null, t), false);           // missing pf
});

// --- would-block composition ---
check('BT-04', 'pfWouldBlockRaw true if base invalid OR any paired block set', () => {
  assert.strictEqual(pfWouldBlockRaw(true, false, false, false), false);   // all clear
  assert.strictEqual(pfWouldBlockRaw(false, false, false, false), true);   // base invalid
  assert.strictEqual(pfWouldBlockRaw(true, true, false, false), true);     // weak backtest
  assert.strictEqual(pfWouldBlockRaw(true, false, true, false), true);     // composite opposition
  assert.strictEqual(pfWouldBlockRaw(true, false, false, true), true);     // mtf block
});

// --- FAIL-CLOSED verdict (the Ruling-2 guarantee) ---
check('BT-05', 'pfVerdict: missing PF or sample -> UNKNOWN, never an implicit pass', () => {
  assert.strictEqual(pfVerdict(null, 1.5, false), 'UNKNOWN');   // missing sample
  assert.strictEqual(pfVerdict(100, null, false), 'UNKNOWN');   // missing pf
  assert.strictEqual(pfVerdict(undefined, undefined, false), 'UNKNOWN');
  assert.strictEqual(pfVerdict(100, 1.5, true), 'WOULD_BLOCK'); // present + would block
  assert.strictEqual(pfVerdict(100, 1.5, false), 'PASS');       // present + passes
  // UNKNOWN must not be mistakable for a pass:
  assert.notStrictEqual(pfVerdict(null, null, false), 'PASS');
});

// --- F2 shadow: cohort on/off ---
check('BT-06', 'backtestValid: cohort OFF enforces (!wouldBlock); cohort ON always valid', () => {
  assert.strictEqual(backtestValid(false, true), false);   // off + wouldBlock => enforced block
  assert.strictEqual(backtestValid(false, false), true);   // off + clear => valid
  assert.strictEqual(backtestValid(true, true), true);     // on => PF blocks nothing
  assert.strictEqual(backtestValid(true, false), true);
});
check('BT-07', 'cohort OFF is byte-equivalent to pre-F2 (backtestValid === !wouldBlock)', () => {
  for (const wb of [true, false]) assert.strictEqual(backtestValid(false, wb), !wb);
});

// --- btBool truthiness matches the live set exactly ---
check('BT-08', 'btBool: true/1/yes/y/on (case-insensitive) truthy; else falsy', () => {
  for (const v of ['true', 'TRUE', '1', 'yes', 'Y', 'on', ' On ']) assert.strictEqual(btBool(v), true, String(v));
  for (const v of ['false', '0', 'no', '', null, undefined, 'maybe']) assert.strictEqual(btBool(v), false, String(v));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
