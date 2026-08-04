#!/usr/bin/env node
'use strict';
/**
 * Maya regression guard — the TSM ATR proxy bug (found 2026-08-03).
 * Maya asks: "You told me every stock was trading on a fake 2% ATR because the bars call
 * returns one bar. Prove the fallback fires exactly there, that real bars give real ATR,
 * and that the difference is as violent as claimed (AES 0.36% vs XPEV 4.29%)."
 */
const assert = require('assert');
const { calcATR, engineAtr, realAtrDecision, t1Move } = require('../lib/tsm/atr');
let passed = 0, failed = 0;
function check(id, name, fn) { try { fn(); console.log(`  ✅ ${id}  ${name}`); passed++; } catch (e) { console.log(`  ❌ ${id}  ${name}  — ${e.message}`); failed++; } }
const near = (a, b, eps) => assert.ok(Math.abs(a - b) <= eps, `${a} !~ ${b}`);

check('ATR-01', 'ONE bar (the live bug) -> calcATR null -> engine falls back to entry*2%', () => {
  assert.strictEqual(calcATR([{ h: 10, l: 9, c: 9.5 }]), null);
  near(engineAtr([{ h: 10, l: 9, c: 9.5 }], 12.42), 0.2484, 1e-9); // XPEV proxied to 2%
});
check('ATR-02', 'real bar series -> true-range ATR (not 2%)', () => {
  const bars = [{ h: 100, l: 98, c: 99 }, { h: 101, l: 99, c: 100 }, { h: 102, l: 100, c: 101 }];
  near(calcATR(bars), 2.0, 1e-9);
  near(engineAtr(bars, 100), 2.0, 1e-9); // real, NOT 100*0.02 coincidence-checked by next case
});
check('ATR-03', 'low-vol name: real ATR far below the proxy (AES-class, 0.36% vs 2%)', () => {
  const bars = []; let c = 14.66;
  for (let i = 0; i < 15; i++) { bars.push({ h: c + 0.03, l: c - 0.03, c }); }
  const a = calcATR(bars);
  assert.ok(a < 0.001 * 14.66 * 10, `real ATR ${a} should be tiny vs proxy ${14.66 * 0.02}`);
  assert.ok(engineAtr(bars, 14.66) === a, 'engine must use the real value when bars exist');
});
check('ATR-04', 'zero/garbage ATR -> proxy fallback (FIX-C guard parity)', () => {
  near(engineAtr([], 100), 2.0, 1e-9);
  near(engineAtr(null, 100), 2.0, 1e-9);
});
check('RA-01', 'flag OFF -> legacy proxy path byte-identical (engineAtr)', () => {
  const d = realAtrDecision({ flagOn: false, legacyBars: [{ h: 1, l: 1, c: 1 }], bars: [], entry: 100 });
  near(d.atr, 2.0, 1e-9); assert.strictEqual(d.model, 'PROXY'); assert.strictEqual(d.skip, false);
});
check('RA-02', 'flag ON + valid bars -> REAL ATR, frozen payload returned', () => {
  const bars = []; let c = 100; for (let i = 0; i < 15; i++) bars.push({ h: c + 1, l: c - 1, c });
  const d = realAtrDecision({ flagOn: true, bars, entry: 100 });
  assert.strictEqual(d.model, 'REAL'); near(d.atr, 2.0, 1e-9); assert.ok(d.frozen);
});
check('RA-03', 'flag ON + 1 bar (the live bug condition) -> SKIP, never the 2% proxy', () => {
  const d = realAtrDecision({ flagOn: true, bars: [{ h: 10, l: 9, c: 9.5 }], entry: 12.42 });
  assert.strictEqual(d.skip, true); assert.strictEqual(d.atr, null);
});
check('RA-04', 'A2 clamp: out-of-band ATR (0.2% or 8% of price) -> invalid -> SKIP', () => {
  const tiny = []; let c1 = 100; for (let i = 0; i < 15; i++) tiny.push({ h: c1 + 0.1, l: c1 - 0.1, c: c1 }); // ~0.2%
  assert.strictEqual(realAtrDecision({ flagOn: true, bars: tiny, entry: 100 }).skip, true);
  const wild = []; let c2 = 100; for (let i = 0; i < 15; i++) wild.push({ h: c2 + 4, l: c2 - 4, c: c2 }); // ~8%
  assert.strictEqual(realAtrDecision({ flagOn: true, bars: wild, entry: 100 }).skip, true);
});
check('RA-05', 'frozen-at-entry: later different bars do NOT move the ATR (reuse wins)', () => {
  const newBars = []; let c = 100; for (let i = 0; i < 15; i++) newBars.push({ h: c + 3, l: c - 3, c });
  const d = realAtrDecision({ flagOn: true, bars: newBars, entry: 100, frozen: { atr: 1.5, model: 'REAL', entry: 100 } });
  near(d.atr, 1.5, 1e-9);
});
check('RA-06', 're-entry at a different price invalidates the old freeze (recomputes)', () => {
  const bars = []; let c = 90; for (let i = 0; i < 15; i++) bars.push({ h: c + 1, l: c - 1, c });
  const d = realAtrDecision({ flagOn: true, bars, entry: 90, frozen: { atr: 1.5, model: 'REAL', entry: 100 } });
  near(d.atr, 2.0, 1e-9); // fresh compute, not the stale 1.5
});
check('FLOOR-01', 'low-vol name: 0.7% floor beats 1.5*ATR (AES-class, ATR 0.36%)', () => {
  near(t1Move({ flagOn: true, atr: 0.0528, entry: 14.66 }), 14.66 * 0.007, 1e-9); // floor wins over 0.079
});
check('FLOOR-02', 'high-vol name: 1.5*ATR beats the floor (XPEV-class)', () => {
  near(t1Move({ flagOn: true, atr: 0.53, entry: 12.42 }), 0.795, 1e-9);
});
check('FLOOR-03', 'flag OFF -> floor inactive (legacy 1.5*ATR exactly)', () => {
  near(t1Move({ flagOn: false, atr: 0.0528, entry: 14.66 }), 0.0792, 1e-9);
});

console.log(`\n  ${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
