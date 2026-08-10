#!/usr/bin/env node
'use strict';
/**
 * Maya regression guard — the excursion counterfactual (2026-08-10).
 *
 * Maya asks: "You're about to tell the Conclave that my stop is killing my winners. That's a
 * big claim and it's built on a thing that never happened. So prove the arithmetic can't lie
 * to me. Prove a winner that never went 1.2% underwater is NOT counted as killed. Prove you
 * measure the right side of the bar for a short, because that's the bug everyone makes. Prove
 * that when you have no data you say 'I don't know' instead of quietly saying 'no breach' —
 * because 'no breach' is evidence FOR the tight stop and I'd never know you made it up. And
 * prove your counterfactual can only ever take a winner away from me, never hand me one."
 *
 * Deterministic and fully offline. Fixtures are the real trades from
 * analysis/trades_20260810.json with synthetic bars constructed to a known excursion, so
 * every expected value is arithmetic rather than a recorded observation.
 *
 * Note on convention: the Maya skill's Python/TestClient skeleton targets the Quantlys FastAPI
 * repo. This repo's suites are Node and drive deployed JS directly, so this follows Maya's
 * RULES — behaviour in a user's words, misuse covered, deterministic, offline, one row per
 * behaviour, non-zero exit as a commit gate — in this repo's idiom. Said plainly rather than
 * implied.
 */
const assert = require('assert');
const E = require('../lib/analysis/excursion');

let passed = 0, failed = 0;
function check(id, name, fn) {
  try { fn(); console.log(`  ✅ ${id}  ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${id}  ${name}\n        ${e.message}`); failed++; }
}
// a bar whose high/low are an exact % away from a reference price
const bar = (px, upPct, dnPct) => ({ h: px * (1 + upPct / 100), l: px * (1 - dnPct / 100) });
const flat = (px) => ({ h: px, l: px });

console.log('\n═══ the arithmetic, on both sides ═══\n');

check('EXC-01', 'a LONG reads profit off the high and pain off the low', () => {
  // entry 100, one bar that touched 103 and 98
  const x = E.excursions([bar(100, 3, 2)], 100, 'buy');
  assert.ok(Math.abs(x.mfePct - 3) < 1e-9, `mfe ${x.mfePct}`);
  assert.ok(Math.abs(x.maePct - 2) < 1e-9, `mae ${x.maePct}`);
});
check('EXC-02', 'a SHORT is the mirror image — the classic sign bug, pinned', () => {
  const x = E.excursions([bar(100, 3, 2)], 100, 'sell');
  assert.ok(Math.abs(x.mfePct - 2) < 1e-9, `short profits when price FALLS: mfe ${x.mfePct}`);
  assert.ok(Math.abs(x.maePct - 3) < 1e-9, `and hurts when it RISES: mae ${x.maePct}`);
  // and the two sides must not agree, or the sign has collapsed
  const long = E.excursions([bar(100, 3, 2)], 100, 'buy');
  assert.notStrictEqual(x.mfePct, long.mfePct, 'long and short excursions must differ');
});
check('EXC-03', 'the excursion is the WORST point reached, not the last bar', () => {
  const x = E.excursions([bar(100, 0.1, 3), flat(100), bar(100, 0.1, 0.1)], 100, 'buy');
  assert.ok(Math.abs(x.maePct - 3) < 1e-9, `must remember the 3% dip, got ${x.maePct}`);
});
check('EXC-04', 'the breach index is the FIRST touch — a stop fires once, not at the deepest point', () => {
  const x = E.excursions([flat(100), bar(100, 0, 1.3), bar(100, 0, 5)], 100, 'buy');
  assert.strictEqual(x.firstBreachIdx, 1, `first breach at bar 1, got ${x.firstBreachIdx}`);
});
check('EXC-05', 'exactly 1.2% counts as a breach — a stop AT the price is a stop hit', () => {
  const x = E.excursions([bar(100, 0, 1.2)], 100, 'buy');
  assert.strictEqual(x.firstBreachIdx, 0, 'boundary must be inclusive');
});

console.log('\n═══ the counterfactual — the claim that has to be safe ═══\n');

const WIN_NO_BREACH  = { sym: 'AKAM', side: 'buy',  entry: 110.64, R: 1.94,  pnl: 555.08 };
const WIN_BREACHED   = { sym: 'ARE',  side: 'buy',  entry: 52.61,  R: 1.066, pnl: 564.74 };
const LOSER          = { sym: 'BA',   side: 'sell', entry: 215.02, R: -1.002, pnl: -316.54 };

check('EXC-06', 'a winner that never went 1.2% underwater is NOT counted as killed', () => {
  const a = E.assess(WIN_NO_BREACH, [bar(110.64, 6, 0.9)], 5.498);
  assert.strictEqual(a.is_winner, true);
  assert.strictEqual(a.clamped_stop_would_fire, false, '0.9% never reaches the 1.2% stop');
  assert.strictEqual(a.counterfactual_killed_winner, false, 'this winner survives the tight stop');
});
check('EXC-07', 'a winner that DID go 1.2% underwater before its exit IS counted as killed', () => {
  const a = E.assess(WIN_BREACHED, [bar(52.61, 0.2, 1.9), bar(52.61, 6, 0)], 1.444);
  assert.strictEqual(a.clamped_stop_would_fire, true);
  assert.strictEqual(a.counterfactual_killed_winner, true,
    'it dipped 1.9% first — the live stop closes it at -1.2% and the +$564 never happens');
  assert.strictEqual(a.minutes_to_first_breach, 0, 'and it happened on the first bar');
});
check('EXC-08', 'the counterfactual can only ever REMOVE a winner — it can never invent one', () => {
  const a = E.assess(LOSER, [bar(215.02, 3, 0.1)], 6.033);
  assert.strictEqual(a.is_winner, false);
  assert.strictEqual(a.clamped_stop_would_fire, true, 'a short with a 3% rise breaches');
  assert.strictEqual(a.counterfactual_killed_winner, false,
    'a loser that breaches is still a loser — the flag is winners-only by construction');
});
check('EXC-09', 'no bars means UNKNOWN, never "no breach" — the failure that would fake evidence', () => {
  for (const bars of [[], null, undefined]) {
    const a = E.assess(WIN_BREACHED, bars, 1.444);
    assert.strictEqual(a.clamped_stop_would_fire, null, `bars=${JSON.stringify(bars)} must be null, not false`);
    assert.strictEqual(a.counterfactual_killed_winner, false, 'and unknown must not be counted as killed either');
    assert.strictEqual(a.mae_pct, null);
    assert.strictEqual(a.bars, 0);
  }
});
check('EXC-10', 'unmeasurable trades are excluded from the rates, not silently scored as survivors', () => {
  const s = E.summarise([
    E.assess(WIN_NO_BREACH, [bar(110.64, 6, 0.9)], 5.498),
    E.assess(WIN_BREACHED, [], 1.444),                       // no data
  ]);
  assert.strictEqual(s.n_assessed, 2);
  assert.strictEqual(s.n_measurable, 1, 'only one had bars');
  assert.strictEqual(s.n_unmeasurable, 1, 'and the other is reported as such, not buried');
  assert.strictEqual(s.winners, 1, 'the unmeasurable winner is not in the denominator');
  assert.strictEqual(s.winners_killed_by_1p2_stop, 0);
});

console.log('\n═══ the tier-1 threshold ═══\n');

check('EXC-11', 'tier-1 is 1.5x ATR, but floors at 0.7% for quiet names', () => {
  assert.ok(Math.abs(E.tier1ThresholdPct(11.747, 360) - 4.895) < 0.01, String(E.tier1ThresholdPct(11.747, 360)));
  assert.strictEqual(E.tier1ThresholdPct(0.04, 14.66), 0.7, 'AES-class quiet name floors');
});
check('EXC-12', 'an unknown ATR yields a null threshold, not a fake 0.7% floor', () => {
  for (const a of [null, undefined, 0, -1, NaN]) {
    assert.strictEqual(E.tier1ThresholdPct(a, 100), null, `atr=${a}`);
  }
  assert.strictEqual(E.tier1ThresholdPct(1, 0), null, 'and a zero entry too');
  const x = E.assess(WIN_NO_BREACH, [bar(110.64, 6, 0.9)], null);
  assert.strictEqual(x.reached_t1, null, 'reached_t1 must be unknown, not false');
  assert.strictEqual(x.mfe_in_ATR, null, 'and ATR-normalised excursions must not divide by nothing');
});
check('EXC-13', 'ATR-normalised excursions never return Infinity or NaN', () => {
  for (const atr of [0, null, undefined, NaN, -5]) {
    const a = E.assess(WIN_NO_BREACH, [bar(110.64, 6, 0.9)], atr);
    assert.strictEqual(a.mfe_in_ATR, null, `atr=${atr} -> mfe_in_ATR must be null`);
    assert.strictEqual(a.mae_in_ATR, null, `atr=${atr} -> mae_in_ATR must be null`);
  }
});

console.log('\n═══ misuse, the way it actually arrives ═══\n');

check('EXC-14', 'a malformed bar is skipped, not allowed to poison the whole trade', () => {
  const x = E.excursions([{ h: 'x', l: null }, bar(100, 2, 1), { h: undefined, l: undefined }], 100, 'buy');
  assert.ok(Math.abs(x.mfePct - 2) < 1e-9, `good bar still counted, got ${x.mfePct}`);
  assert.ok(Math.abs(x.maePct - 1) < 1e-9);
  assert.strictEqual(x.bars, 3, 'and the bar count still reports what was received');
});
check('EXC-15', 'a zero or missing entry price is unknown, not a divide-by-zero', () => {
  for (const e of [0, null, undefined, -5]) {
    const x = E.excursions([bar(100, 2, 1)], e, 'buy');
    assert.strictEqual(x.maePct, null, `entry=${e}`);
  }
});
check('EXC-16', 'option-style sides classify long/short correctly, matching the ledger', () => {
  assert.strictEqual(E.isLongSide('buy'), true);
  assert.strictEqual(E.isLongSide('buy_call'), true);
  assert.strictEqual(E.isLongSide('sell_put'), true, 'a short put is a bullish position');
  assert.strictEqual(E.isLongSide('sell'), false);
  // same classifier the R3 lineage filter uses on trade_ledger
});

console.log(`\n  ${passed}/${passed + failed} checks passed\n`);
process.exit(failed === 0 ? 0 : 1);
