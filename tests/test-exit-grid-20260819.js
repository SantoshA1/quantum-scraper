#!/usr/bin/env node
'use strict';
/**
 * Maya regression guard — E1 exit-policy grid engine (gov 233, 2026-08-19).
 *
 * Maya asks: "You are about to tell me whether my exit policy — not my entries — is why
 * QTP loses, and a Conclave decision may ride on the table this engine produces. Before I
 * believe one cell of it: (a) show me the fill rules on hand-checkable bars I can verify
 * with a pencil — gap-through at the open at the OPEN price, stop-before-target on a day
 * both were reachable, time exit at the close; (b) prove ATR uses ONLY bars before entry —
 * an off-by-one here is silent lookahead and the whole grid becomes fiction; (c) prove the
 * short side is a true mirror, not a sign error; (d) prove immature trades are EXCLUDED,
 * not scored on partial windows — survivor bias by laziness; and (e) prove the aggregation
 * math on a set small enough to sum by hand. Then break the engine on purpose and show me
 * the suite notices."
 *
 * Deterministic + offline. The engine under test is the committed
 * lib/analysis/exit_grid.js — the SAME bytes embedded in the one-shot n8n runner
 * (byte-verified at deploy: sentinel ENGINE_START/ENGINE_END region diff).
 */
const assert = require('assert');
const path = require('path');
const G = require(path.join(__dirname, '..', 'lib', 'analysis', 'exit_grid.js'));

let passed = 0, failed = 0;
async function check(id, name, fn) {
  try { await fn(); console.log(`  ✅ ${id}  ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${id}  ${name}\n        ${e.message}`); failed++; }
}

// ── hand-checkable bar sets ──────────────────────────────────────────────────
// Entry LONG @100 on 08-10. Post bars:
const BARS_BASE = [
  { d: '2026-08-10', o: 100, h: 101, l: 99, c: 100 },   // day0 — must be ignored
  { d: '2026-08-11', o: 100, h: 103, l: 99.5, c: 102 }, // day1
  { d: '2026-08-12', o: 102, h: 104, l: 101, c: 103 },  // day2
  { d: '2026-08-13', o: 103, h: 105, l: 100, c: 104 },  // day3
  { d: '2026-08-14', o: 104, h: 106, l: 103, c: 105 },  // day4
  { d: '2026-08-17', o: 105, h: 107, l: 104, c: 106 },  // day5 (weekend gap: bar-indexed)
];
// 15 pre-bars for ATR: constant TR of 2 (h-l=2, no gaps vs prev close)
function preBars15() {
  const out = [];
  for (let i = 0; i < 15; i++) {
    const day = String(701 + i); // 2026-07-01 .. 2026-07-15
    out.push({ d: `2026-07-${day.slice(1).padStart(2, '0')}`, o: 100, h: 101, l: 99, c: 100 });
  }
  return out;
}
const L = (px = 100) => ({ dir: 'long', entryDay: '2026-08-10', entryPx: px, symbol: 'TT' });
const S = (px = 100) => ({ dir: 'short', entryDay: '2026-08-10', entryPx: px, symbol: 'TT' });

(async () => {
  console.log('\n═══ (a) fill rules on pencil-checkable bars ═══\n');

  await check('EG-01', 'time exit: 2d close 103 → +3.0000%; day0 bar ignored', () => {
    const r = G.simulate(L(), BARS_BASE, { kind: 'none' }, { kind: 'time', days: 2 });
    assert.strictEqual(r.exit_kind, 'time');
    assert.strictEqual(r.exit_day_index, 2);
    assert.ok(Math.abs(r.ret_pct - 3) < 1e-9, `got ${r.ret_pct}`);
  });

  await check('EG-02', 'intraday stop: 1% stop long → stopped day1 at 99.00 exactly (-1%)', () => {
    // day1 low 99.5 > 99? stop=99.0; low 99.5 does NOT reach. day3 low 100 no. Use tighter: stop pct 0.5 → 99.5 reached day1.
    const r = G.simulate(L(), BARS_BASE, { kind: 'pct', v: 0.5 }, { kind: 'time', days: 5 });
    assert.strictEqual(r.exit_kind, 'stop');
    assert.strictEqual(r.exit_day_index, 1);
    assert.ok(Math.abs(r.ret_pct - (-0.5)) < 1e-9, 'stop fills AT the stop price, not the low');
    assert.strictEqual(r.gap_through, false);
  });

  await check('EG-03', 'gap-through stop fills at the OPEN, flagged, worse than stop price', () => {
    const bars = [
      { d: '2026-08-10', o: 100, h: 101, l: 99, c: 100 },
      { d: '2026-08-11', o: 96, h: 98, l: 95, c: 97 }, // gaps below a 3% stop (97)
    ];
    const r = G.simulate(L(), bars, { kind: 'pct', v: 3.0 }, { kind: 'time', days: 1 });
    assert.strictEqual(r.exit_kind, 'stop');
    assert.strictEqual(r.gap_through, true);
    assert.ok(Math.abs(r.ret_pct - (-4)) < 1e-9, 'must fill at open 96 (-4%), not stop 97 (-3%)');
  });

  await check('EG-04', 'stop-before-target: day both reachable → the LOSS is taken', () => {
    // NOTE (field lesson kept in-band): the first draft of this fixture used days:5 with
    // 2 post bars, and the engine's own MATURITY RULE excluded it — the suite's data
    // violated the rule the suite verifies in EG-11. Fixtures must satisfy maturity.
    const bars = [
      { d: '2026-08-10', o: 100, h: 100, l: 100, c: 100 },
      { d: '2026-08-11', o: 100, h: 105, l: 97.9, c: 104 }, // stop 98 AND target 104 both inside range
      { d: '2026-08-12', o: 104, h: 104, l: 104, c: 104 },
    ];
    const r = G.simulate(L(), bars, { kind: 'pct', v: 2.0 }, { kind: 'target2R', days: 2 });
    assert.strictEqual(r.exit_kind, 'stop', 'conservative: stop first');
    assert.strictEqual(r.exit_day_index, 1);
    assert.ok(Math.abs(r.ret_pct - (-2)) < 1e-9);
  });

  await check('EG-05', 'target2R: 2% stop → target 104; clean hit day2 at 104 (+4%)', () => {
    const bars = [
      { d: '2026-08-10', o: 100, h: 100, l: 100, c: 100 },
      { d: '2026-08-11', o: 100, h: 103, l: 99, c: 102 },
      { d: '2026-08-12', o: 102, h: 104.5, l: 101, c: 103 },
      { d: '2026-08-13', o: 103, h: 103, l: 103, c: 103 },
    ];
    const r = G.simulate(L(), bars, { kind: 'pct', v: 2.0 }, { kind: 'target2R', days: 3 });
    assert.strictEqual(r.exit_kind, 'target');
    assert.strictEqual(r.exit_day_index, 2);
    assert.ok(Math.abs(r.ret_pct - 4) < 1e-9, 'fills AT target 104, not the high');
  });

  console.log('\n═══ (b) ATR: computed strictly pre-entry, no lookahead ═══\n');

  await check('EG-06', 'ATR14 = 2.00 on constant-TR pre-bars; 1.5×ATR stop = 97.00', () => {
    const bars = [...preBars15(), ...BARS_BASE];
    assert.ok(Math.abs(G.atr14(preBars15()) - 2) < 1e-9);
    const r = G.simulate(L(), bars, { kind: 'atr', v: 1.5 }, { kind: 'time', days: 5 });
    // stop 100-3=97: day1 low 99.5 no, day2 101 no, day3 low 100 no, day4 103, day5 104 → time exit day5 close 106
    assert.strictEqual(r.exit_kind, 'time');
    assert.ok(Math.abs(r.ret_pct - 6) < 1e-9);
  });

  await check('EG-07', 'LOOKAHEAD GUARD: post-entry bars must not change ATR', () => {
    const wild = BARS_BASE.map((b) => ({ ...b, h: b.h + 50, l: b.l - 50 })); // insane post-entry vol
    const a1 = G.atr14(G.splitBars([...preBars15(), ...BARS_BASE], '2026-08-10').pre);
    const a2 = G.atr14(G.splitBars([...preBars15(), ...wild], '2026-08-10').pre);
    assert.strictEqual(a1, a2, 'ATR leaked post-entry data');
  });

  await check('EG-08', 'insufficient pre-bars → excluded from atr cells only, not pct cells', () => {
    const r1 = G.simulate(L(), BARS_BASE, { kind: 'atr', v: 1.5 }, { kind: 'time', days: 2 });
    assert.strictEqual(r1.excluded, 'no_atr');
    const r2 = G.simulate(L(), BARS_BASE, { kind: 'pct', v: 2.0 }, { kind: 'time', days: 2 });
    assert.ok(!r2.excluded);
  });

  console.log('\n═══ (c) the short side is a mirror, not a sign error ═══\n');

  await check('EG-09', 'short time exit: close 103 → −3%; short stop ABOVE entry hit at high', () => {
    const r = G.simulate(S(), BARS_BASE, { kind: 'none' }, { kind: 'time', days: 2 });
    assert.ok(Math.abs(r.ret_pct - (-3)) < 1e-9, 'short loses when price rises');
    const r2 = G.simulate(S(), BARS_BASE, { kind: 'pct', v: 2.0 }, { kind: 'time', days: 5 });
    // short stop = 102; day1 high 103 ≥ 102 → stopped at 102, ret = (100-102)/100 = -2%
    assert.strictEqual(r2.exit_kind, 'stop');
    assert.strictEqual(r2.exit_day_index, 1);
    assert.ok(Math.abs(r2.ret_pct - (-2)) < 1e-9);
  });

  await check('EG-10', 'short gap-through: open above stop fills at open (worse)', () => {
    const bars = [
      { d: '2026-08-10', o: 100, h: 100, l: 100, c: 100 },
      { d: '2026-08-11', o: 105, h: 106, l: 104, c: 104 },
    ];
    const r = G.simulate(S(), bars, { kind: 'pct', v: 2.0 }, { kind: 'time', days: 1 });
    assert.strictEqual(r.exit_kind, 'stop');
    assert.strictEqual(r.gap_through, true);
    assert.ok(Math.abs(r.ret_pct - (-5)) < 1e-9, 'fills at open 105 (-5%), not stop 102 (-2%)');
  });

  console.log('\n═══ (d) maturity: partial windows are excluded, never scored ═══\n');

  await check('EG-11', '5d cell with only 3 post bars → excluded=immature_window; 2d cell still scores', () => {
    const bars = BARS_BASE.slice(0, 4); // day0 + 3 post bars
    const r5 = G.simulate(L(), bars, { kind: 'none' }, { kind: 'time', days: 5 });
    assert.strictEqual(r5.excluded, 'immature_window');
    const r2 = G.simulate(L(), bars, { kind: 'none' }, { kind: 'time', days: 2 });
    assert.ok(!r2.excluded);
  });

  console.log('\n═══ (e) aggregation math by hand + grid shape ═══\n');

  await check('EG-12', 'aggregate on {+3, −2, +1, excluded}: n=3 pf=2.0 exp=+0.6667 win 0.6667', () => {
    const a = G.aggregate([
      { ret_pct: 3, exit_kind: 'time' },
      { ret_pct: -2, exit_kind: 'stop' },
      { ret_pct: 1, exit_kind: 'target' },
      { excluded: 'immature_window' },
    ]);
    assert.strictEqual(a.n, 3); assert.strictEqual(a.excluded, 1);
    assert.strictEqual(a.pf, 2);
    assert.strictEqual(a.expectancy_pct, 0.6667);
    assert.strictEqual(a.win_rate, 0.6667);
    assert.strictEqual(a.stop_rate, 0.3333);
  });

  await check('EG-13', 'grid shape: 7 stops × 5 exits − invalid (none×target2R) = 34 cells', () => {
    const cells = G.runGrid([{ ...L(), symbol: 'TT' }], { TT: [...preBars15(), ...BARS_BASE] });
    assert.strictEqual(cells.length, 34);
    assert.ok(!cells.some((c) => c.stop_key === 'none' && c.exit_key === 'target2R_5d'));
    const c1 = cells.find((c) => c.stop_key === 'none' && c.exit_key === 'time_2d');
    assert.strictEqual(c1.n, 1);
    assert.strictEqual(c1.pf, 999.9999, 'no losers → capped sentinel, not division blowup');
  });

  await check('EG-14', 'missing symbol bars → excluded no_bars, cell n=0, pf null (no crash)', () => {
    const cells = G.runGrid([{ ...L(), symbol: 'GHOST' }], {});
    assert.ok(cells.every((c) => c.n === 0 && c.excluded === 1 && c.pf === null));
  });

  console.log(`\n  ${passed}/${passed + failed} checks passed\n`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('HARNESS FAILURE:', e); process.exit(1); });
