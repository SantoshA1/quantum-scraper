#!/usr/bin/env node
'use strict';
/**
 * Maya regression guard — the signal scorer (2026-08-13).
 *
 * Maya asks: "You are about to tell me to shut down a system I spent months on, on the strength
 * of one measurement. So prove the measurement works. Show me it screams when there IS an edge,
 * show me it stays quiet when there ISN'T, and show me you didn't get your answer by counting
 * eight thousand correlated things as eight thousand independent facts. And if you're going to
 * hunt through slices until one looks good, tell me how many you looked at."
 *
 * Deterministic + offline. Fixtures are the REAL day-level series from
 * analysis/scorer-daily-ALL-20260813.json (78 days, 8,289 signals).
 */
const assert = require('assert');
const S = require('../lib/analysis/signal_scorer');
const ALL = require('../analysis/scorer-daily-ALL-20260813.json');

let passed = 0, failed = 0;
function check(id, name, fn) {
  try { fn(); console.log(`  ✅ ${id}  ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${id}  ${name}\n        ${e.message}`); failed++; }
}

const R = S.scoreDaily(ALL.rows);

console.log('\n═══ can the instrument detect an edge that IS there? ═══\n');

check('SCR-01', 'THE POSITIVE CONTROL: an oracle that knows the outcome is detected overwhelmingly', () => {
  assert.ok(R.control_oracle.mean > 0.01,
    `oracle mean ${R.control_oracle.mean} — a perfect forecaster must earn >1%/day of excess`);
  assert.ok(R.control_oracle.t > 10,
    `oracle t=${R.control_oracle.t} — if a perfect forecaster does not light this up, the instrument is broken and every other number here is void`);
});
check('SCR-02', 'THE NEGATIVE CONTROL: a coin flip on the identical rows produces nothing', () => {
  assert.ok(Math.abs(R.control_random.mean) < 0.001, `random mean ${R.control_random.mean} should be ~0`);
  assert.ok(Math.abs(R.control_random.t) < 2, `random t=${R.control_random.t} — a coin flip must not clear the bar`);
});
check('SCR-03', 'the two controls are separated by an enormous margin — the instrument has range', () => {
  assert.ok(R.control_oracle.t / Math.max(Math.abs(R.control_random.t), 0.1) > 20,
    'oracle and random must not be within shouting distance of each other');
});

console.log('\n═══ the arithmetic ═══\n');

check('SCR-04', 'day-clustering counts DAYS, not signals — the correction that decides this case', () => {
  assert.strictEqual(R.days, 78, 'the sample is 78 trading days');
  assert.strictEqual(R.signals, 8289, 'even though it contains 8,289 signals');
  assert.strictEqual(R.h1.n, 78, 'the clustered test must use 78, not 8289');
});
check('SCR-05', 'pooling 8,289 correlated observations inflates t versus clustering — shown, not assumed', () => {
  // same daily means, but pretended to be independent per-signal observations
  const fake = [];
  for (const r of ALL.rows) for (let i = 0; i < r[1]; i++) fake.push(r[2]);
  const naive = S.pooled(fake), clustered = R.h1;
  assert.ok(Math.abs(naive.t) > Math.abs(clustered.t) * 2,
    `naive t=${naive.t} vs clustered t=${clustered.t} — the inflation is the whole reason clustering governs`);
});
check('SCR-06', 'nulls are dropped, never treated as zero returns', () => {
  assert.strictEqual(S.mean([1, null, 3]), 2, 'a missing forward bar is unknown, not a 0% return');
  assert.strictEqual(S.mean([null, null]), null);
  assert.strictEqual(S.famaMacBeth([1]).t, null, 'one cluster cannot produce a t-statistic');
});
check('SCR-07', 'the last days legitimately have no 5-day forward window and are excluded there', () => {
  const missing5 = ALL.rows.filter((r) => r[4] == null).length;
  assert.ok(missing5 >= 2 && missing5 <= 6, `expected a few unfinished tails, got ${missing5}`);
  assert.ok(R.h5.n < R.h1.n, 'so the 5-day test runs on fewer days than the 1-day test');
});

console.log('\n═══ the verdict, on the real numbers ═══\n');

check('SCR-08', 'QTP signals: no horizon clears t=2 once days are clustered', () => {
  for (const [h, r] of [['1d', R.h1], ['3d', R.h3], ['5d', R.h5]]) {
    assert.ok(Math.abs(r.t) < 2, `${h} clustered t=${r.t.toFixed(2)} — must be reported if it ever clears 2`);
  }
});
check('SCR-09', 'QTP signals are statistically indistinguishable from the coin flip', () => {
  assert.ok(Math.abs(R.h1.t) < 2 && Math.abs(R.control_random.t) < 2,
    'both the real signal and a random direction fail the same bar — that IS the finding');
});
check('SCR-10', 'the verdict function refuses to be cherry-picked across a family of tests', () => {
  // 5 slices x 3 horizons = 15 tests. A lone t=2.14 in that family is expected by chance.
  const lucky = [{ name: 'MOMENTUM_SURGE/LONG', t1: -1.70, t3: 2.14, t5: 0.61 }];
  assert.strictEqual(S.verdict(lucky, 15).verdict, 'KILL',
    'one t=2.14 out of 15 tests, on 10 day-clusters, is noise and must not read as an edge');
  assert.strictEqual(S.verdict([{ name: 'x', t1: 6.0, t3: 5.0, t5: 4.0 }], 15).verdict, 'EDGE_FOUND',
    'but a real edge must still be recognised — the guard cannot be a rubber stamp');
});
check('SCR-11', 'THE SHIPPED VERDICT: the live slice table returns KILL', () => {
  const slices = [
    { name: 'GAP/LONG',            t1: 1.83,  t3: 1.50,  t5: 1.23 },
    { name: 'GAP/SHORT',           t1: 0.55,  t3: 0.08,  t5: -0.81 },
    { name: 'NONE/LONG',           t1: -1.39, t3: -1.52, t5: -1.95 },
    { name: 'NONE/SHORT',          t1: 0.51,  t3: -0.06, t5: 0.57 },
    { name: 'MOMENTUM_SURGE/LONG', t1: -1.70, t3: 2.14,  t5: 0.61 },
  ];
  const v = S.verdict(slices, 15);
  assert.strictEqual(v.verdict, 'KILL', `survivors: ${JSON.stringify(v.survivors)}`);
  assert.strictEqual(v.survivors.length, 0);
});

console.log(`\n  ${passed}/${passed + failed} checks passed\n`);
process.exit(failed === 0 ? 0 : 1);
