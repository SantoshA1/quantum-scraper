#!/usr/bin/env node
'use strict';
/**
 * S1-a pressure test (2026-08-12): how much confidence do the expectancy numbers deserve,
 * and how fast does each metric DETECT harvest destruction? Deterministic (seeded LCG).
 * Run from repo root: node analysis/s1a-bootstrap-20260812.js
 */
const S = require('../lib/analysis/stop_sweep');
const ROWS = require('./excursion-rows-20260810.json');
const ACTUAL = require('./actual-stop-pct-20260810.json');
let seed = 20260812;
const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;

const asTraded = ROWS.map(t => S.realizedMove(t) / (ACTUAL[t.sym] / 100));
const at12 = ROWS.map(t => S.replayTrade(t, 0.012, ACTUAL[t.sym], 1.67).R);  // actualStopPct is in PERCENT
if (at12.some(r => r == null)) throw new Error('non-replayable row leaked into the bootstrap');
const mean = a => a.reduce((s, x) => s + x, 0) / a.length;

const B = 20000, mA = [], m12 = [], mD = [];
for (let b = 0; b < B; b++) {
  let sA = 0, s12 = 0;
  for (let i = 0; i < ROWS.length; i++) { const j = Math.floor(rnd() * ROWS.length); sA += asTraded[j]; s12 += at12[j]; }
  mA.push(sA / ROWS.length); m12.push(s12 / ROWS.length); mD.push((sA - s12) / ROWS.length);
}
const q = (a, p) => a.slice().sort((x, y) => x - y)[Math.floor(p * a.length)];
const ci = a => [q(a, 0.025), q(a, 0.975)].map(x => +x.toFixed(3));
const out = {
  n: ROWS.length,
  mean_asTraded: +mean(asTraded).toFixed(4), ci_asTraded: ci(mA),
  mean_at12_overshoot167: +mean(at12).toFixed(4), ci_at12: ci(m12),
  paired_diff_asTraded_minus_12: { ci: ci(mD), p_wider_better: +(mD.filter(x => x > 0).length / B).toFixed(4) },
  canary_trades_to_reject_tail_alive_p20: (() => { let n = 1; while (Math.pow(0.8, n) > 0.05) n++; return n; })(),
  canary_trades_to_reject_tail_alive_p122: (() => { let n = 1; while (Math.pow(0.878, n) > 0.05) n++; return n; })(),
  tail_killed_effect_R: +(mean(asTraded) - mean(ROWS.map((t, i) => (S.realizedMove(t) > 0.02 ? -0.2 : asTraded[i])))).toFixed(3),
};
console.log(JSON.stringify(out, null, 2));
