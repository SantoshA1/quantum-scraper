#!/usr/bin/env node
'use strict';
/**
 * Maya regression guard — Gate-K Conclave package R3/R1/R2 (governance 195-197).
 *
 * Maya asks: "Your risk gate stopped my whole account because 25 bad short trades outvoted
 * 17 good long ones, and then it wouldn't let me place the trades it wanted me to prove
 * myself with. You've now changed it. Prove my longs can trade again at small size, prove
 * my shorts CANNOT come back by accident — not if you flip a flag, not if the config table
 * vanishes, not if the sample shrinks — and prove you didn't quietly loosen anything else."
 *
 * Deterministic + offline. Fixtures are the REAL post-R3 cleaned sample as the live function
 * measures it (verified against public.compute_kelly_gate the same session):
 *   LONG  n=16 dollar PF 1.4655 -> approved, probation, risk_pct 0.50
 *   SHORT n=24 dollar PF 0.0101 -> short_side_blocked_pf_below_bar
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const G = require('../lib/gate/kelly_gate');

let passed = 0, failed = 0;
function check(id, name, fn) {
  try { fn(); console.log(`  ✅ ${id}  ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${id}  ${name}  — ${e.message}`); failed++; }
}

// ── build a ledger that reproduces the live post-R3 aggregates exactly ──────────────
let _id = 0;
function row({ side, net_pnl, r, lineage = 'RECERT_20260805_fills', daysExit = 5, daysEntry = 6, ok = true }) {
  return { id: ++_id, side, net_pnl, r_multiple: r, lineage_source: lineage,
    exit_fill_time: 'x', entry_fill_time: 'y', days_since_exit: daysExit, days_since_entry: daysEntry,
    risk_amount: ok ? 300 : null, intended_stop: ok ? 10 : null, entry_fill_price: ok ? 11 : null };
}
// LONGS: 16 rows, 4 winners, gw 2145.27 / gl 1463.87 -> PF 1.4655
const LONGS = [
  row({ side:'buy', net_pnl: 540.80, r: 1.7650 }), row({ side:'buy', net_pnl: 564.74, r: 1.0657 }),
  row({ side:'buy', net_pnl: 555.08, r: 1.9403 }), row({ side:'buy', net_pnl: 484.65, r: 1.9871 }),
  row({ side:'buy', net_pnl: -82.73, r: -0.1859 }), row({ side:'buy', net_pnl:-453.81, r: -2.0403 }),
  row({ side:'buy', net_pnl: -35.52, r: -0.0570 }), row({ side:'buy', net_pnl: -99.94, r: -1.0278 }),
  row({ side:'buy', net_pnl:-108.50, r: -1.1232 }), row({ side:'buy', net_pnl:-104.34, r: -1.1059 }),
  row({ side:'buy', net_pnl:-119.84, r: -1.2370 }), row({ side:'buy', net_pnl: -36.04, r: -0.0988 }),
  row({ side:'buy', net_pnl:-107.36, r: -1.1411 }), row({ side:'buy', net_pnl:-112.98, r: -1.1956 }),
  row({ side:'buy', net_pnl:-157.66, r: -0.8661, lineage:'H4_EXIT_RESOLUTION_v2' }),
  row({ side:'buy', net_pnl: -45.15, r: -0.1156, lineage:'H4_EXIT_RESOLUTION_v2' }),
];
// SHORTS: 24 rows, 1 winner (+31.86), gl 3166.99 -> PF 0.0101
const SHORT_LOSSES = [-97.25,-34.65,-11.89,-29.35,-202.71,-98.28,-97.92,-109.62,-153.40,-119.21,
  -132.21,-109.47,-97.00,-316.54,-39.34,-103.23,-8.88,-615.80,-107.68,-94.27,-341.14,-136.80,-110.35];
const SHORTS = [row({ side:'sell', net_pnl: 31.86, r: 0.1059 })].concat(
  SHORT_LOSSES.map((p) => row({ side:'sell', net_pnl: p, r: -1.0 })));
const LEDGER = LONGS.concat(SHORTS);

// ── the two trades that R3 must remove, reproduced from the real rows ───────────────
const AFL  = row({ side:'buy',  net_pnl: 12.52,  r: 3.4778,  daysEntry: 120, ok: false }); // April entry, no stop
const LDOS = row({ side:'sell', net_pnl: 855.40, r: 10.2174, lineage:'RECERT_QUARANTINE_20260805', daysEntry: 106, ok: false });

check('CK-01', 'the fixture reproduces the LIVE post-R3 long book: n=16, dollar PF 1.4655', () => {
  const m = G.measure(LONGS);
  assert.strictEqual(m.n, 16);
  assert.strictEqual(Math.round(m.gw * 100) / 100, 2145.27);
  assert.strictEqual(Math.round(m.gl * 100) / 100, 1463.87);
  assert.strictEqual(Math.round(m.dollarPf * 10000) / 10000, 1.4655, `got ${m.dollarPf}`);
});
check('CK-02', 'the fixture reproduces the LIVE post-R3 short book: n=24, dollar PF 0.0101', () => {
  const m = G.measure(SHORTS);
  assert.strictEqual(m.n, 24);
  assert.strictEqual(Math.round(m.gl * 100) / 100, 3166.99);
  assert.strictEqual(Math.round(m.dollarPf * 10000) / 10000, 0.0101, `got ${m.dollarPf}`);
});

// ── R3 ──────────────────────────────────────────────────────────────────────────────
check('CK-03', 'R3 drops the quarantined row and the out-of-window April entries — on provenance, never outcome', () => {
  assert.ok(!G.r3Keep(LDOS), 'RECERT_QUARANTINE% must be excluded');
  assert.ok(!G.r3Keep(AFL), 'April entry / no reconstructable risk basis must be excluded');
  assert.ok(G.r3Keep(LONGS[0]), 'ordinary certified rows survive');
  // the precise prefix must NOT swallow valid certified lineage
  assert.ok(G.r3Keep(row({ side:'buy', net_pnl: 1, r: 1, lineage: 'RECERT_20260805_fills' })),
    'RECERT_ (non-quarantine) must be KEPT — an over-broad prefix would discard the whole book');
});
check('CK-04', 'R3 makes the blended number WORSE, which is what proves it is not self-serving', () => {
  const withLeak = G.measure(LEDGER.concat([AFL, LDOS]).filter((r) => r.r_multiple != null));
  const cleaned  = G.measure(LEDGER.filter(G.r3Keep));
  assert.ok(cleaned.kelly < withLeak.kelly,
    `cleaning must lower kelly*: leaked ${withLeak.kelly} -> cleaned ${cleaned.kelly}`);
  assert.ok(cleaned.dollarPf < withLeak.dollarPf, 'and lower dollar PF too');
});

// ── R1 ──────────────────────────────────────────────────────────────────────────────
check('CK-05', 'R1: shorts are BLOCKED — sample bar met (24>=20), PF bar failed (0.0101)', () => {
  const d = G.gateDecision({ side: 'sell', ledger: LEDGER });
  assert.strictEqual(d.approved, false);
  assert.strictEqual(d.reason, 'short_side_blocked_pf_below_bar');
  assert.strictEqual(d.short_side_record.meets_sample_bar, true, 'they have EARNED a verdict');
  assert.strictEqual(d.short_side_record.meets_pf_bar, false, 'and failed it');
});
check('CK-06', 'R1 is self-releasing: a short book that actually earns PF>1.0 over >=20 trades resumes', () => {
  const good = Array.from({ length: 22 }, (_, i) =>
    row({ side: 'sell', net_pnl: i % 3 === 0 ? -100 : 120, r: i % 3 === 0 ? -1 : 1.2 }));
  const d = G.gateDecision({ side: 'sell', ledger: LONGS.concat(good) });
  assert.notStrictEqual(d.reason, 'short_side_blocked_pf_below_bar', 'the block must not be permanent');
});

// ── R2 — the deadlock exit ──────────────────────────────────────────────────────────
check('CK-07', 'R2: LONGS resume at 0.50% probation sizing — the exit from the self-locking halt', () => {
  const d = G.gateDecision({ side: 'buy', ledger: LEDGER });
  assert.strictEqual(d.approved, true, JSON.stringify(d));
  assert.strictEqual(d.reason, 'probation_sizing_insufficient_sample');
  assert.strictEqual(d.risk_pct, 0.5);
  assert.strictEqual(d.metrics.sample_scope, 'direction:bullish');
  assert.strictEqual(d.metrics.n_trades, 16);
});
check('CK-08', 'R2 clears the halt ONLY by scoping: the pooled sample still reads negative', () => {
  const pooled = G.measure(LEDGER.filter(G.r3Keep));
  assert.ok(pooled.dollarPf < 1.0, `pooled PF ${pooled.dollarPf} must still be losing`);
  assert.ok(pooled.kelly < 0, 'and pooled kelly* still negative — we did not manufacture an edge');
});
check('CK-09', 'longs resume because the SAMPLE IS SMALL, not because an edge was proven', () => {
  const d = G.gateDecision({ side: 'buy', ledger: LEDGER });
  assert.strictEqual(d.probation, true, 'this must be probation sizing, never fractional_kelly');
  assert.ok(d.metrics.n_trades < G.RATIFIED_DIRECTION_MIN_TRADES, 'n<20 is WHY it is approved');
  assert.strictEqual(d.metrics.kelly_star, null, 'no kelly-based sizing on an unproven book');
});

// ══ THE FAILURE MODE THE CONCLAVE CALLED "THE SINGLE MOST DANGEROUS" ════════════════
check('CK-10', 'BLOCKED TEST — R2 without R1 must NOT reopen the short book', () => {
  const d = G.gateDecision({ side: 'sell', ledger: LEDGER, cfg: { shortBlockActive: 0 } });
  assert.strictEqual(d.approved, false, 'R1 off must not approve shorts: ' + JSON.stringify(d));
  assert.strictEqual(d.reason, 'negative_measured_edge', 'R2 holds the line independently');
});
check('CK-11', 'BLOCKED TEST — "both directions fall to probation" can never approve a short', () => {
  // force the short sample under the bar: exactly the both-to-probation scenario
  const d = G.gateDecision({ side: 'sell', ledger: LEDGER, cfg: { shortBlockActive: 0, directionMinTrades: 999 } });
  assert.strictEqual(d.approved, false, 'THE dangerous mode: ' + JSON.stringify(d));
  assert.strictEqual(d.reason, 'short_side_probation_forbidden');
  // and the same config must still let longs trade — the seal is short-specific, not a re-halt
  const l = G.gateDecision({ side: 'buy', ledger: LEDGER, cfg: { shortBlockActive: 0, directionMinTrades: 999 } });
  assert.strictEqual(l.approved, true, 'longs unaffected by the short seal');
});
check('CK-12', 'BLOCKED TEST — a tiny/empty short sample cannot default its way in', () => {
  for (const led of [LONGS, LONGS.concat([row({ side:'sell', net_pnl: 500, r: 5 })])]) {
    const d = G.gateDecision({ side: 'sell', ledger: led, cfg: { shortBlockActive: 0 } });
    assert.strictEqual(d.approved, false, `n=${led.filter(r=>G.directionOf(r.side)==='bearish').length}: ` + JSON.stringify(d));
  }
});
check('CK-13', 'FAIL-CLOSED — a missing/unreadable gate_config reads as ACTIVE, never as off', () => {
  const d = G.gateDecision({ side: 'sell', ledger: LEDGER, cfg: {} });   // no config at all
  assert.strictEqual(d.approved, false);
  assert.strictEqual(d.reason, 'short_side_blocked_pf_below_bar', 'wiped config must still block');
  assert.strictEqual(G.gateDecision({ side: 'buy', ledger: LEDGER, cfg: {} }).approved, true,
    'and must not accidentally halt longs');
});

// ── nothing else loosened ───────────────────────────────────────────────────────────
check('CK-14', 'the ratified thresholds are used verbatim — no number was invented to get an answer', () => {
  assert.strictEqual(G.RATIFIED_DIRECTION_MIN_TRADES, 20, 'the v2.4 bar, not a new one');
  assert.strictEqual(G.SHORT_PF_BAR, 1.0, 'unchanged from v2.4');
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'gate', 'kelly_gate.js'), 'utf8');
  assert.ok(!/1\.5|n\s*>=\s*25|n\s*>=\s*30/.test(src.split('\n').filter(l=>!l.trim().startsWith('*')&&!l.trim().startsWith('//')).join('\n')),
    'no PF>1.5 / n>=25 / n>=30 threshold inflation (the Conclave rejected these explicitly)');
});
check('CK-15', 'dollar PF is the release metric; a PF-positive but kelly-negative book trades SMALL, not big', () => {
  // Exactly the divergence the 170x risk-basis spread creates: a few LARGE dollar wins that
  // scored small in R (huge risk basis), against many small dollar losses that scored large
  // in R (tiny risk basis). Dollars say profitable; averaged R says ruinous.
  //   PF = 2700/2550 = 1.059 > 1     kelly = 0.15/1.5 - 0.85/0.4 = -2.025 < 0
  const odd = Array.from({ length: 20 }, (_, i) =>
    i < 3 ? row({ side:'buy', net_pnl: 900, r: 0.4 }) : row({ side:'buy', net_pnl: -150, r: -1.5 }));
  const m = G.measure(odd);
  assert.ok(m.dollarPf > 1.0 && m.kelly < 0, `setup must be PF ${m.dollarPf}>1 with kelly ${m.kelly}<0`);
  const d = G.gateDecision({ side: 'buy', ledger: odd });
  assert.strictEqual(d.approved, true, 'dollar PF is the release metric');
  assert.strictEqual(d.risk_pct, 0.5, 'but sized at probation, never on a negative kelly');
  assert.ok((d.degraded || []).includes('dollar_pf_positive_but_kelly_negative_probation_sized'));
});
check('CK-16', 'version stamps pin the shipped package', () => {
  assert.strictEqual(G.GATE_VERSION, 'GATE_K_v2.9_K3_EXTENDED_20260812');
  assert.strictEqual(G.SAMPLE_VERSION, 'R3_PROVENANCE_CLEANED_20260807');
});

// ══ THE FOUR-QUADRANT TRUTH TABLE — ratified by the Conclave 2026-08-07 ═════════════
// "PF is the release metric, kelly* secondary" = PF BLOCKS, kelly* only DOWNGRADES SIZING,
// kelly* NEVER VETOES. Pinned here so "release metric vs. secondary" can never again be
// re-litigated by interpretation. Each expectation was first verified against the LIVE
// plpgsql (docs/gatek-conclave-20260807/quadrant-truth-table.sql), not just this mirror.
function book({ n, wins, winPnl, winR, lossPnl, lossR }) {
  return Array.from({ length: n }, (_, i) => i < wins
    ? row({ side: 'buy', net_pnl: winPnl,  r: winR })
    : row({ side: 'buy', net_pnl: lossPnl, r: lossR }));
}

check('CK-17', 'QUADRANT 1 — PF ≤ 1.0, n ≥ 20 → BLOCK, whatever kelly★ says', () => {
  const q1 = book({ n: 20, wins: 5, winPnl: 100, winR: 2.0, lossPnl: -100, lossR: -1.0 });
  const m = G.measure(q1);
  assert.ok(Math.abs(m.dollarPf - 0.3333) < 0.001, `live pinned PF 0.3333, got ${m.dollarPf}`);
  const d = G.gateDecision({ side: 'buy', ledger: q1 });
  assert.strictEqual(d.approved, false);
  assert.strictEqual(d.reason, 'negative_measured_edge');
});
check('CK-18', 'QUADRANT 2 — PF > 1.0, kelly★ < 0, n ≥ 20 → PROBATION 0.50%, NOT a veto', () => {
  const q2 = book({ n: 20, wins: 3, winPnl: 900, winR: 0.4, lossPnl: -150, lossR: -1.5 });
  const m = G.measure(q2);
  assert.ok(Math.abs(m.dollarPf - 1.0588) < 0.001, `live pinned PF 1.0588, got ${m.dollarPf}`);
  assert.ok(Math.abs(m.kelly - (-2.025)) < 0.001, `live pinned kelly -2.0250, got ${m.kelly}`);
  const d = G.gateDecision({ side: 'buy', ledger: q2 });
  assert.strictEqual(d.approved, true, 'a negative kelly must NEVER veto PF-clearing data');
  assert.strictEqual(d.reason, 'probation_sizing_insufficient_sample');
  assert.strictEqual(d.risk_pct, 0.5, 'small size for an unstable positive — never full Kelly');
  assert.ok((d.degraded || []).includes('dollar_pf_positive_but_kelly_negative_probation_sized'),
    'and the instability must be recorded, not silently swallowed');
});
check('CK-19', 'QUADRANT 3 — PF > 1.0, kelly★ > 0, n < 20 → PROBATION 0.50% (small sample)', () => {
  const q3 = book({ n: 16, wins: 8, winPnl: 200, winR: 2.0, lossPnl: -100, lossR: -1.0 });
  assert.strictEqual(G.measure(q3).dollarPf, 2.0);
  const d = G.gateDecision({ side: 'buy', ledger: q3 });
  assert.strictEqual(d.approved, true);
  assert.strictEqual(d.reason, 'probation_sizing_insufficient_sample');
  assert.strictEqual(d.risk_pct, 0.5);
});
check('CK-20', 'QUADRANT 4 — PF > 1.0, kelly★ > 0, n ≥ 20 → FRACTIONAL KELLY (the only one)', () => {
  const q4 = book({ n: 24, wins: 12, winPnl: 200, winR: 2.0, lossPnl: -100, lossR: -1.0 });
  const m = G.measure(q4);
  assert.strictEqual(m.dollarPf, 2.0);
  assert.strictEqual(m.kelly, 0.25, 'live pinned kelly +0.2500');
  const d = G.gateDecision({ side: 'buy', ledger: q4 });
  assert.strictEqual(d.approved, true);
  assert.strictEqual(d.reason, 'fractional_kelly', 'ONLY this quadrant earns measured sizing');
  assert.strictEqual(d.risk_pct, 1.0, '0.25 fraction x 0.25 kelly x 100 = 6.25%, gate-1 capped to 1.0');
  assert.strictEqual(d.probation, false);
});
check('CK-21', 'QUADRANT 5 (not in the ruling) — PF ≤ 1.0 but n < 20 → probation, PF has NO blocking authority yet', () => {
  const q5 = book({ n: 10, wins: 2, winPnl: 100, winR: 2.0, lossPnl: -100, lossR: -1.0 });
  assert.strictEqual(G.measure(q5).dollarPf, 0.25, 'a losing book');
  const d = G.gateDecision({ side: 'buy', ledger: q5 });
  assert.strictEqual(d.approved, true, 'deliberate: blocking here would deadlock any fresh direction');
  assert.strictEqual(d.risk_pct, 0.5);
  // the deliberate part: a first-trade loss must NOT permanently block a fresh direction
  const fresh = G.gateDecision({ side: 'buy', ledger: [row({ side:'buy', net_pnl:-100, r:-1.0 })] });
  assert.strictEqual(fresh.approved, true, 'PF=0 at n=1 must not recreate the self-locking deadlock');
});
check('CK-22', 'the quadrant ordering is structural: n is consulted BEFORE PF, PF before kelly★', () => {
  // n<20 short-circuits before PF -> quadrant 5 exists at all
  assert.strictEqual(G.gateDecision({ side:'buy',
    ledger: book({ n: 10, wins: 1, winPnl: 10, winR: 0.1, lossPnl: -500, lossR: -5 }) }).approved, true);
  // at n>=20 PF decides before kelly is even allowed to matter
  const pfFailsKellyPasses = book({ n: 20, wins: 4, winPnl: 100, winR: 5.0, lossPnl: -200, lossR: -0.2 });
  const m = G.measure(pfFailsKellyPasses);
  assert.ok(m.dollarPf <= 1.0 && m.kelly > 0, `setup: PF ${m.dollarPf}<=1 with kelly ${m.kelly}>0`);
  const d = G.gateDecision({ side: 'buy', ledger: pfFailsKellyPasses });
  assert.strictEqual(d.reason, 'negative_measured_edge',
    'a POSITIVE kelly cannot rescue a failing PF — PF is the release metric, in both directions');
});

console.log(`\n  ${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
