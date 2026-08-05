#!/usr/bin/env node
'use strict';
/**
 * Maya regression guard — Gate-K short-side risk multiplier (QTP_SHORT_RISK_MULT_v1_20260805).
 *
 * Maya asks: "The Conclave read my book: my shorts are 1-for-22 with a profit factor of
 * 0.01, and half my capital was being handed to the losing side at full size. You shipped
 * a half-sizing multiplier — prove it halves ONLY bearish entries, prove it can NEVER be
 * released by the fabricated column it exists to distrust, prove it retires itself the
 * moment my certified short record actually earns it, and prove my longs never pay for it."
 *
 * Deterministic + offline. Mirrors the v2.4 gate block. Evidence pinned from 2026-08-05:
 * shorts within the 37-trade sample -$2,033 (23 trades), longs +$1,010 (14).
 */
const assert = require('assert');
const S = require('../lib/risk/shortmult');

let passed = 0, failed = 0;
function check(id, name, fn) {
  try { fn(); console.log(`  ✅ ${id}  ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${id}  ${name}  — ${e.message}`); failed++; }
}
const NOW = '2026-08-05T19:30:00Z';
const row = (over) => Object.assign({ side: 'sell', status: 'closed', net_pnl: -100,
  lineage_source: 'RECERT_20260805_fills', exit_fill_time: '2026-08-04T15:00:00Z' }, over);

// ── the rule itself ────────────────────────────────────────────────────────────
check('SM-01', 'bearish entry with no certified short record -> 0.5x, applied, attributable', () => {
  const d = S.shortRiskMult('bearish', S.shortSideRecord([], NOW));
  assert.strictEqual(d.mult, 0.5);
  assert.strictEqual(d.applied, true);
  assert.strictEqual(d.why, 'no_certified_short_record');
});
check('SM-02', 'bullish entries are NEVER multiplied — longs do not pay for the short side', () => {
  const d = S.shortRiskMult('bullish', S.shortSideRecord([], NOW));
  assert.strictEqual(d.mult, 1.0);
  assert.strictEqual(d.applied, false);
});
check('SM-03', 'unknown direction is never multiplied (degrades like every other direction check)', () => {
  assert.strictEqual(S.shortRiskMult(null, S.shortSideRecord([], NOW)).mult, 1.0);
});
check('SM-04', 'probation arithmetic: longs 0.50% -> shorts 0.25% ($267 on $106,980)', () => {
  const riskPct = 0.5 * S.shortRiskMult('bearish', S.shortSideRecord([], NOW)).mult;
  assert.strictEqual(riskPct, 0.25);
  assert.strictEqual(Math.round(106980 * riskPct / 100), 267);
});

// ── the release can only be EARNED, and only on certified rows ─────────────────
check('SM-05', 'the convicted writers can never release it: 50 winning shorts with backfill/null lineage count for NOTHING', () => {
  const fabricated = Array.from({ length: 25 }, () => row({ net_pnl: 500, lineage_source: 'backfill_symbol_time_v1' }))
    .concat(Array.from({ length: 25 }, () => row({ net_pnl: 500, lineage_source: null })));
  const rec = S.shortSideRecord(fabricated, NOW);
  assert.strictEqual(rec.n, 0, 'uncertified rows are invisible to the release trigger');
  assert.strictEqual(S.shortRiskMult('bearish', rec).mult, 0.5);
});
check('SM-06', 'certified PF > 1.0 but n=19 -> still 0.5x (sample must reach 20)', () => {
  const rows = Array.from({ length: 12 }, () => row({ net_pnl: 300 }))
    .concat(Array.from({ length: 7 }, () => row({ net_pnl: -200 })));
  const rec = S.shortSideRecord(rows, NOW);
  assert.strictEqual(rec.n, 19);
  assert.ok(rec.pf > 1.0);
  assert.strictEqual(S.shortRiskMult('bearish', rec).mult, 0.5);
});
check('SM-07', 'n=20 certified, PF exactly 1.0 -> NOT released (must exceed, not meet)', () => {
  const rows = Array.from({ length: 10 }, () => row({ net_pnl: 200 }))
    .concat(Array.from({ length: 10 }, () => row({ net_pnl: -200 })));
  const rec = S.shortSideRecord(rows, NOW);
  assert.strictEqual(rec.n, 20);
  assert.strictEqual(rec.pf, 1.0);
  assert.strictEqual(rec.released, false);
});
check('SM-08', 'SELF-RETIRING: 20 certified shorts at PF 1.4 -> released, mult 1.0, why=released_certified_pf', () => {
  const rows = Array.from({ length: 11 }, () => row({ net_pnl: 280 }))
    .concat(Array.from({ length: 9 }, () => row({ net_pnl: -244 })));
  const rec = S.shortSideRecord(rows, NOW);
  assert.strictEqual(rec.n, 20);
  assert.ok(Math.abs(rec.pf - 1.4) < 0.02, String(rec.pf));
  const d = S.shortRiskMult('bearish', rec);
  assert.strictEqual(d.mult, 1.0);
  assert.strictEqual(d.why, 'released_certified_pf');
});
check('SM-09', 'RE-ENGAGES: certified PF drops back to 0.8 on the rolling window -> 0.5x returns (precommitted revert)', () => {
  const rows = Array.from({ length: 8 }, () => row({ net_pnl: 200 }))
    .concat(Array.from({ length: 12 }, () => row({ net_pnl: -167 })));
  const rec = S.shortSideRecord(rows, NOW);
  assert.ok(rec.n >= 20 && rec.pf < 1.0);
  assert.strictEqual(S.shortRiskMult('bearish', rec).mult, 0.5);
});

// ── scope hygiene ──────────────────────────────────────────────────────────────
check('SM-10', 'window discipline: certified shorts older than 90d are outside the rolling record', () => {
  const stale = Array.from({ length: 30 }, () => row({ net_pnl: 500, exit_fill_time: '2026-04-01T15:00:00Z' }));
  assert.strictEqual(S.shortSideRecord(stale, NOW).n, 0);
});
check('SM-11', 'options map through direction: buy_put halves (bearish), sell_put never does (bullish)', () => {
  assert.strictEqual(S.direction('buy_put'), 'bearish');
  assert.strictEqual(S.shortRiskMult(S.direction('buy_put'), S.shortSideRecord([], NOW)).mult, 0.5);
  assert.strictEqual(S.shortRiskMult(S.direction('sell_put'), S.shortSideRecord([], NOW)).mult, 1.0);
});
check('SM-12', 'ordering contract: K1 decides IF (eligibility), this decides HOW MUCH — a K1-blocked short never reaches the multiplier (documented, not enforced here)', () => {
  // The gate applies the multiplier only on the approved path, after K1's return points.
  // Pinned here as the contract the live SQL mirrors: multiplier math never appears in a
  // rejection verdict.
  assert.ok(S.SHORT_RISK_MULT === 0.5 && S.RELEASE_MIN_TRADES === 20 && S.RELEASE_MIN_PF === 1.0);
});

console.log(`\n  ${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
