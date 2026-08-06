#!/usr/bin/env node
'use strict';
/**
 * Maya regression guard — entry bracket stop clamp v1 (gov 189).
 *
 * Maya asks: "My entries were born with 3-6% stops, my stop manager only allows 1.2%,
 * and the fight between them left two positions naked today. Replay MY real entries and
 * prove they'd now be born inside the manager's limit, prove quiet names keep their
 * tighter ATR stops untouched, and prove my share counts don't change."
 *
 * Deterministic + offline. Fixtures are today's REAL entries (WRB atr→3.05% placed stop,
 * APA 3.96%) and the AKAM signal payload (atr 3.97 on 119.67).
 */
const assert = require('assert');
const fs = require('fs');
const C = require('../lib/entry/stop_clamp');

let passed = 0, failed = 0;
function check(id, name, fn) {
  try { fn(); console.log(`  ✅ ${id}  ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${id}  ${name}  — ${e.message}`); failed++; }
}

check('CLP-01', "WRB-class entry (73.06, wide ATR): stop born at 1.2% = 72.18, not 3.1% = 70.83", () => {
  const e = C.entryStop({ isLong: true, price: 73.06, atr: 1.49, vol: false }); // 1.49×1.5 = 2.24 raw
  assert.ok(e.clamped, 'raw 3.06% must clamp');
  assert.strictEqual(e.stopPct, 1.2);
  assert.strictEqual(e.stopPrice, 72.18);
});
check('CLP-02', 'APA-class entry (35.90, raw 3.96%): clamped to 1.2% = 35.47', () => {
  const e = C.entryStop({ isLong: true, price: 35.9, atr: 0.948, vol: false });
  assert.ok(e.clamped);
  assert.strictEqual(e.stopPrice, r2(35.9 - 35.9 * 0.012));
  function r2(n) { return Math.round(n * 100) / 100; }
});
check('CLP-03', 'AKAM signal payload (SELL 119.67, atr 3.97): short stop 121.11 (1.2% above), not 125.63 (5%)', () => {
  const e = C.entryStop({ isLong: false, price: 119.67, atr: 3.97, vol: false });
  assert.ok(e.clamped, 'raw 4.97% clamps');
  assert.strictEqual(e.stopPrice, 121.11);
});
check('CLP-04', 'quiet name (ATR 0.5% of price): tighter-than-cap ATR stop is UNTOUCHED', () => {
  const e = C.entryStop({ isLong: true, price: 100, atr: 0.5, vol: false }); // 0.75% raw
  assert.ok(!e.clamped, 'no clamp below the cap');
  assert.strictEqual(e.stopPrice, 99.25, 'pure ATR arithmetic preserved');
});
check('CLP-05', 'volatile mult path (SL_MULT=1.0) preserved; missing ATR falls back to 1.5% then clamps to 1.2%', () => {
  const v = C.entryStop({ isLong: true, price: 100, atr: 1.0, vol: true });
  assert.strictEqual(v.slMult, 1.0);
  assert.strictEqual(v.stopPrice, 99.0, '1.0×1.0=1.0% < cap, untouched');
  const f = C.entryStop({ isLong: true, price: 100, atr: 0, vol: false }); // fallback 1.5×1.5%=2.25%
  assert.ok(f.clamped);
  assert.strictEqual(f.stopPrice, 98.8);
});
check('CLP-06', 'every clamped stop is inside TSM territory: stopPct ≤ 1.2 across a 60-case sweep (no recovery can ever arm)', () => {
  for (let i = 1; i <= 60; i++) {
    const e = C.entryStop({ isLong: i % 2 === 0, price: 10 + i * 7.3, atr: (i % 9) * 0.9, vol: i % 3 === 0 });
    assert.ok(e.stopPct <= 1.2 + 1e-9, `case ${i}: ${e.stopPct}%`);
  }
});
check('CLP-07', 'lockstep: the deployed node file carries the clamp verbatim and the take-profit line is untouched', () => {
  const node = fs.readFileSync(__dirname + '/../docs/naked-window-20260806/alpaca-paper-trade-v4.8-clamp.js', 'utf8');
  assert.ok(node.includes('const MAX_ENTRY_STOP_PCT = 0.012;'));
  assert.ok(node.includes('const _stopDist = Math.min(_rawStopDist, price * MAX_ENTRY_STOP_PCT);'));
  assert.ok(node.includes('const stopPrice = isLong ? r2(price - _stopDist) : r2(price + _stopDist);'));
  assert.ok(!node.includes('r2(price - atr * SL_MULT)'), 'old raw-ATR stop line gone');
  assert.ok(node.includes('? r2(price + atr * (vol ? 2.0 : 3.0))'), 'tpPrice untouched');
  assert.ok(node.includes('QTP_ENTRY_STOP_CLAMP_v1_20260806'));
});

console.log(`\n  ${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
