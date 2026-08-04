#!/usr/bin/env node
'use strict';
/**
 * Maya regression guard — taken-trade stop-sim (Conclave #3 Q6).
 * Maya asks: "Does the replay check my stop BEFORE giving the day's high to the ladder? Does a
 * gap through the stop fill at the open? Do tiers only tighten? And is band C really capped
 * at 2.5% and floored at 0.6%?"
 */
const assert = require('assert');
const { simBand, bandC } = require('../lib/tsm/taken_sim');
let passed = 0, failed = 0;
function check(id, name, fn) { try { fn(); console.log(`  ✅ ${id}  ${name}`); passed++; } catch (e) { console.log(`  ❌ ${id}  ${name}  — ${e.message}`); failed++; } }
const near = (a, b, eps = 0.01) => assert.ok(Math.abs(a - b) <= eps, `${a} !~ ${b}`);

check('TS-01', 'conservative ordering: same-day stop-hit + tier-worthy high -> STOP wins', () => {
  // long entry 100, atr 1, cap 0.9% -> stop 99.1; day: l=99.0 (hit) AND h=102 (would fire T1)
  const r = simBand({ side: 'long', entry: 100, qty: 10, atr: 1, capPct: 0.009, bars: [{ o: 100.5, h: 102, l: 99.0, c: 101 }] });
  assert.strictEqual(r.reason, 'stop'); near(r.pnl, -9.0);
});
check('TS-02', 'gap-through: opens below the stop -> realize at open', () => {
  const r = simBand({ side: 'long', entry: 100, qty: 10, atr: 1, capPct: 0.009, bars: [{ o: 97, h: 98, l: 96.5, c: 97.5 }] });
  assert.strictEqual(r.reason, 'stop'); near(r.pnl, -30.0);
});
check('TS-03', 'tier then trail-stop next day: T1 breakeven catches the reversal', () => {
  const bars = [
    { o: 100.2, h: 101.8, l: 99.8, c: 101.5 },  // day1: fav 101.8-eps(0.1)=101.7 >= T1 101.5 -> tier1, stop 99.95
    { o: 100.8, h: 101.0, l: 99.5, c: 99.6 },   // day2: low 99.5 <= 99.95 -> trail_stop at 99.95
  ];
  const r = simBand({ side: 'long', entry: 100, qty: 10, atr: 1, capPct: 0.012, bars });
  assert.strictEqual(r.reason, 'trail_stop'); assert.strictEqual(r.tier, 1); near(r.pnl, -0.5);
});
check('TS-04', 'unstopped survivor rides to exit-day close', () => {
  const r = simBand({ side: 'long', entry: 100, qty: 10, atr: 2, capPct: 0.025, bars: [{ o: 100, h: 101, l: 99.6, c: 100.8 }, { o: 101, h: 102, l: 100.4, c: 101.9 }] });
  assert.strictEqual(r.reason, 'rode_to_exit'); near(r.pnl, 19.0);
});
check('TS-05', 'short mirror: stop above entry; gap-up through stop fills at open', () => {
  const r = simBand({ side: 'short', entry: 50, qty: 100, atr: 0.5, capPct: 0.012, bars: [{ o: 51.2, h: 51.5, l: 50.9, c: 51.1 }] });
  assert.strictEqual(r.reason, 'stop'); near(r.pnl, -120.0);
});
check('TS-06', 'band C: floored at 0.6% for sleepy names, capped at 2.5% for wild ones', () => {
  near(bandC(0.05, 100), 0.006, 1e-9);   // 1.5*ATR=0.075% -> floor 0.6%
  near(bandC(3, 100), 0.025, 1e-9);      // 1.5*ATR=4.5% -> cap 2.5%
  near(bandC(1, 100), 0.015, 1e-9);      // in-band: 1.5%
});
console.log(`\n  ${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
