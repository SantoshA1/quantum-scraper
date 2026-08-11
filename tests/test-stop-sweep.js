#!/usr/bin/env node
'use strict';
/**
 * Maya regression guard — the S1 stop-width replay (Conclave ruling 2026-08-11).
 *
 * Maya asks: "You're about to tell the council what my strategy would have earned at a stop
 * width it never ran at. That's a counterfactual on 41 trades and it decides a live risk
 * parameter. So prove the arithmetic against something I can check: run it at the width the
 * trades ACTUALLY had, and it had better reproduce what actually happened. If it can't
 * reproduce the past, I'm not betting the stop on its version of the future.
 *
 * And prove you're not quietly assuming a stop fills at the stop price. Mine didn't — four of
 * them lost more than 1R. If your model says every stop costs exactly 1R, it's flattering the
 * tight stop, and the tight stop is the thing you're testing."
 *
 * Deterministic and offline. Fixtures are the real measured rows.
 */
const assert = require('assert');
const S = require('../lib/analysis/stop_sweep');
const ROWS = require('../analysis/excursion-rows-20260810.json');
const ACTUAL = require('../analysis/actual-stop-pct-20260810.json');

let passed = 0, failed = 0;
function check(id, name, fn) {
  try { fn(); console.log(`  ✅ ${id}  ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${id}  ${name}\n        ${e.message}`); failed++; }
}
const opt = (o) => ({ actualStopPct: (t) => ACTUAL[t.sym], overshoot: o });

console.log('\n═══ does the model reproduce the past? ═══\n');

check('SWP-01', 'THE BACK-CHECK: replayed at the width the trades really had, expectancy matches reality', () => {
  // true mean R = mean(realized move / actual stop width) = -0.2134, computed independently
  const truth = ROWS.reduce((s, t) => s + S.realizedMove(t) / (ACTUAL[t.sym] / 100), 0) / ROWS.length;
  assert.ok(Math.abs(truth - (-0.2134)) < 0.001, `independent truth drifted: ${truth}`);
  const replay = S.sweepVariable(ROWS, (t) => ACTUAL[t.sym] / 100, 'as-traded', opt(1.67)).expectancy_R;
  assert.ok(Math.abs(replay - truth) < 0.002,
    `replay ${replay} must reproduce the observed ${truth.toFixed(4)} — if it cannot reproduce the past it cannot be trusted on the counterfactual`);
});
check('SWP-02', 'a flat -1R stop cost does NOT reproduce the past — which is why it is not the default read', () => {
  const naive = S.sweepVariable(ROWS, (t) => ACTUAL[t.sym] / 100, 'as-traded', opt(1.0)).expectancy_R;
  assert.ok(naive > -0.2, `flat -1R gives ${naive}, materially rosier than the observed -0.2134`);
  assert.ok(naive - (-0.2134) > 0.05, 'the gap is large enough that reporting only the naive number would mislead');
});
check('SWP-03', 'the four trades that really breached their stop lost MORE than 1R — the reason overshoot exists', () => {
  const breached = ROWS.filter((t) => t.mae_pct / 100 >= ACTUAL[t.sym] / 100);
  assert.strictEqual(breached.length, 4, `expected 4, got ${breached.length}: ${breached.map((b) => b.sym)}`);
  for (const b of breached) {
    const realR = Math.abs(S.realizedMove(b) / (ACTUAL[b.sym] / 100));
    assert.ok(realR > 1.0, `${b.sym} lost ${realR.toFixed(3)}R — a stop that filled at the stop price would be 1.0`);
  }
});

console.log('\n═══ the arithmetic ═══\n');

check('SWP-04', 'R = move / width — so the SAME price move is worth more R at a tighter stop', () => {
  const t = { side: 'buy', entry: 100, exit: 105, mae_pct: 0.5, mfe_pct: 5, t1_pct: 4, atr14_pct: 3 };
  assert.ok(Math.abs(S.replayTrade(t, 0.012, null).R - 4.1667) < 0.001, 'a 5% move on a 1.2% stop is 4.17R');
  assert.ok(Math.abs(S.replayTrade(t, 0.030, null).R - 1.6667) < 0.001, 'the same move on a 3.0% stop is 1.67R');
});
check('SWP-05', 'a short reads the move the other way — the sign bug that would invert every conclusion', () => {
  const long = { side: 'buy', entry: 100, exit: 105, mae_pct: 0.5 };
  const short = { side: 'sell', entry: 100, exit: 105, mae_pct: 0.5 };
  assert.ok(S.replayTrade(long, 0.012, null).R > 0, 'long profits when price rises');
  assert.ok(S.replayTrade(short, 0.012, null).R < 0, 'short loses when price rises');
});
check('SWP-06', 'the stop fires on the WORST point reached, not on where it happened to close', () => {
  const t = { side: 'buy', entry: 100, exit: 103, mae_pct: 2.0 };   // ended up, but dipped 2% first
  assert.strictEqual(S.replayTrade(t, 0.012, null).outcome, 'STOPPED',
    'a trade that dipped 2% is stopped by a 1.2% stop even though it finished higher');
  assert.strictEqual(S.replayTrade(t, 0.030, null).outcome, 'WIN');
});

console.log('\n═══ refusing to guess ═══\n');

check('SWP-07', 'a width WIDER than the trade\'s real stop is NOT_REPLAYABLE, never estimated', () => {
  const t = { side: 'buy', entry: 100, exit: 103, mae_pct: 0.5 };
  const r = S.replayTrade(t, 0.040, 2.0);   // real stop was 2.0%, asking about 4.0%
  assert.strictEqual(r.outcome, 'NOT_REPLAYABLE');
  assert.strictEqual(r.R, null, 'no number may be produced for a path that was never observed');
  assert.strictEqual(r.replayable, false);
});
check('SWP-08', 'non-replayable trades are excluded from every rate, not scored as survivors', () => {
  const t = [{ sym: 'A', side: 'buy', entry: 100, exit: 103, mae_pct: 0.5, R: 1 },
             { sym: 'B', side: 'buy', entry: 100, exit: 103, mae_pct: 0.5, R: 1 }];
  const r = S.sweepWidth(t, 0.040, { actualStopPct: (x) => (x.sym === 'A' ? 5.0 : 2.0) });
  assert.strictEqual(r.n_replayable, 1);
  assert.strictEqual(r.n_not_replayable, 1, 'and it is reported, not buried');
});
check('SWP-09', 'the LIVE 1.2% width is replayable on all 41 — the question actually asked is answerable', () => {
  const r = S.sweepWidth(ROWS, 0.012, opt(1.67));
  assert.strictEqual(r.n_replayable, 41);
  assert.strictEqual(r.n_not_replayable, 0, 'every real stop was wider than 1.2%, so tightening is fully observed');
});

console.log('\n═══ the decisive reads the ruling asked for ═══\n');

check('SWP-10', 'THE RULING\'S TEST: at 1.2%, zero of the five real winners are stopped out', () => {
  const r = S.sweepWidth(ROWS, 0.012, opt(1.67));
  assert.strictEqual(r.original_winners, 5);
  assert.strictEqual(r.original_winners_stopped, 0,
    'the ruling: "if 0.41 ATR stops out the winners the TSM actually harvested, widen it" — it does not');
});
check('SWP-11', 'but there IS a width where the harvest breaks, and it is near 0.8%, not 1.2%', () => {
  assert.strictEqual(S.sweepWidth(ROWS, 0.008, opt(1.67)).original_winners_stopped, 0);
  assert.strictEqual(S.sweepWidth(ROWS, 0.006, opt(1.67)).original_winners_stopped, 1,
    'at 0.6% the clamp starts destroying the only exit path that ever paid');
  assert.ok(S.sweepWidth(ROWS, 0.006, opt(1.67)).harvest_survivors < S.sweepWidth(ROWS, 0.012, opt(1.67)).harvest_survivors);
});
check('SWP-12', 'expectancy is NEGATIVE at every width tested — no stop width rescues this strategy', () => {
  for (const w of [0.008, 0.010, 0.012, 0.014, 0.016, 0.017]) {
    assert.ok(S.sweepWidth(ROWS, w, opt(1.67)).expectancy_R < 0, `width ${w} came out positive — check the sign`);
  }
  assert.ok(S.sweepVariable(ROWS, (t) => ACTUAL[t.sym] / 100, 'x', opt(1.67)).expectancy_R < 0);
});
check('SWP-13', 'at the calibrated overshoot, WIDER is monotonically better on expectancy', () => {
  const e = [0.010, 0.012, 0.014, 0.016, 0.017].map((w) => S.sweepWidth(ROWS, w, opt(1.67)).expectancy_R);
  for (let i = 1; i < e.length; i++) assert.ok(e[i] > e[i - 1], `not monotonic at index ${i}: ${e}`);
});
check('SWP-14', 'the ruling\'s ≥3R kill metric points the OPPOSITE way to expectancy — the tension must not be hidden', () => {
  const tight = S.sweepWidth(ROWS, 0.012, opt(1.67));
  const asTraded = S.sweepVariable(ROWS, (t) => ACTUAL[t.sym] / 100, 'x', opt(1.67));
  assert.ok(tight.exits_ge_3R > asTraded.exits_ge_3R,
    'tightening manufactures big-R exits because R = move/width');
  assert.ok(tight.expectancy_R < asTraded.expectancy_R,
    'while making expectancy worse — optimising the kill metric and optimising expectancy disagree here');
});
check('SWP-15', 'the conclusion survives the whole overshoot range — it is not an artefact of one assumption', () => {
  for (const o of [1.0, 1.3, 1.67, 2.0]) {
    assert.strictEqual(S.sweepWidth(ROWS, 0.012, opt(o)).original_winners_stopped, 0, `overshoot ${o}`);
  }
  // and wider-is-better holds wherever the stop cost is realistic
  for (const o of [1.3, 1.67, 2.0]) {
    assert.ok(S.sweepWidth(ROWS, 0.017, opt(o)).expectancy_R > S.sweepWidth(ROWS, 0.012, opt(o)).expectancy_R, `overshoot ${o}`);
  }
});
check('SWP-16', 'the ATR-relative floor does not beat the flat cap on this sample', () => {
  const flat = S.sweepWidth(ROWS, 0.012, opt(1.67)).expectancy_R;
  for (const k of [0.2, 0.3, 0.4]) {
    const f = S.sweepVariable(ROWS, (t) => S.floorWidth(t, 1.2, k), `k=${k}`, opt(1.67)).expectancy_R;
    assert.ok(f <= flat + 0.02, `k=${k} gave ${f} vs flat ${flat} — if a floor ever wins, this pin must be revisited deliberately`);
  }
});

console.log('\n═══ misuse ═══\n');

check('SWP-17', 'a zero or negative width is refused rather than dividing by it', () => {
  for (const w of [0, -0.01]) {
    assert.strictEqual(S.replayTrade({ side: 'buy', entry: 100, exit: 103, mae_pct: 1 }, w, null).outcome, 'UNKNOWN');
  }
});
check('SWP-18', 'a missing excursion or price is UNKNOWN, never silently a win', () => {
  assert.strictEqual(S.replayTrade({ side: 'buy', entry: 100, exit: 103 }, 0.012, null).outcome, 'UNKNOWN');
  assert.strictEqual(S.replayTrade({ side: 'buy', entry: 0, exit: 103, mae_pct: 1 }, 0.012, null).outcome, 'UNKNOWN');
  assert.strictEqual(S.harvestSurvives({ mae_pct: 1 }, 0.012), null, 'harvest is unknown without MFE and the T1 bar');
});

console.log(`\n  ${passed}/${passed + failed} checks passed\n`);
process.exit(failed === 0 ? 0 : 1);
