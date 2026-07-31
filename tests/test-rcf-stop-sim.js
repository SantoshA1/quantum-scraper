#!/usr/bin/env node
'use strict';
/**
 * Maya regression guard — RCF stop-simulated scoring (Conclave ruling 07-31 #2).
 *
 * Maya asks: "The council said the drift number was a mirage because real trades have stops.
 * Does the simulation actually stop the trade when the intraday low pierces? Does a gap
 * through the stop fill at the open, not at a price that never traded? Does an unstopped
 * winner ride to the +2d close? And does an immature row refuse to produce a number?"
 */
const assert = require('assert');
const { stopSimLong, mfeMae } = require('../lib/rcf/stop_sim');

let passed = 0, failed = 0;
function check(id, name, fn) {
  try { fn(); console.log(`  ✅ ${id}  ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${id}  ${name}  — ${e.message}`); failed++; }
}
const near = (a, b, eps = 0.01) => { assert.ok(Math.abs(a - b) <= eps, `${a} !~ ${b}`); };

// entry 100, 1% stop => stop at 99
check('SS-01', 'day-1 low pierces the stop -> stopped at the stop price (-1%)', () => {
  const r = stopSimLong({ entry: 100, widthPct: 0.01, d1: { o: 100.2, h: 100.6, l: 98.8, c: 100.4 }, d2: { o: 101, h: 103, l: 100.5, c: 102.9 } });
  assert.strictEqual(r.stopped, true); near(r.ret, -1.0);
  // the +2.9% drift day-2 close is NEVER reached — this is exactly the drift-vs-P&L gap
});
check('SS-02', 'gap-through: day-1 opens BELOW the stop -> realize at the open, not the stop', () => {
  const r = stopSimLong({ entry: 100, widthPct: 0.01, d1: { o: 97.5, h: 98.4, l: 97.0, c: 98.0 }, d2: null });
  assert.strictEqual(r.stopped, true); near(r.ret, -2.5);
});
check('SS-03', 'unstopped both days -> rides to the +2d close (no TP leg, matches live)', () => {
  const r = stopSimLong({ entry: 100, widthPct: 0.01, d1: { o: 100.1, h: 101, l: 99.4, c: 100.8 }, d2: { o: 100.9, h: 102.2, l: 100.2, c: 102.0 } });
  assert.strictEqual(r.stopped, false); near(r.ret, 2.0);
});
check('SS-04', 'day-2 stop-out after a green day-1 -> stopped on day 2', () => {
  const r = stopSimLong({ entry: 100, widthPct: 0.009, d1: { o: 100.2, h: 101, l: 99.5, c: 100.7 }, d2: { o: 100.5, h: 100.6, l: 98.9, c: 99.2 } });
  assert.strictEqual(r.stopped, true); near(r.ret, -0.9);
});
check('SS-05', 'immature row (no day-2, day-1 did not stop) -> refuses to score (ret null)', () => {
  const r = stopSimLong({ entry: 100, widthPct: 0.01, d1: { o: 100.1, h: 101, l: 99.6, c: 100.8 }, d2: null });
  assert.strictEqual(r.ret, null);
});
check('SS-06', 'band sensitivity: 0.9% stops a -0.95% low but 1.2% survives it', () => {
  const d1 = { o: 100.1, h: 100.5, l: 99.05, c: 100.2 }, d2 = { o: 100.3, h: 101.8, l: 99.9, c: 101.5 };
  assert.strictEqual(stopSimLong({ entry: 100, widthPct: 0.009, d1, d2 }).stopped, true);
  const wide = stopSimLong({ entry: 100, widthPct: 0.012, d1, d2 });
  assert.strictEqual(wide.stopped, false); near(wide.ret, 1.5);
});
check('SS-07', 'MFE/MAE from two-day extremes; null when immature', () => {
  const m = mfeMae({ entry: 100, d1: { h: 101, l: 99 }, d2: { h: 103, l: 98.5 } });
  near(m.mfe, 3.0); near(m.mae, -1.5);
  assert.strictEqual(mfeMae({ entry: 100, d1: { h: 101, l: 99 }, d2: null }).mfe, null);
});

console.log(`\n  ${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
