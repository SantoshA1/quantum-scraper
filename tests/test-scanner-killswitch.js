#!/usr/bin/env node
'use strict';
/**
 * Maya regression guard — Broad Scanner GLOBAL KILL SWITCH (QTP_KS_MARGIN_PROXY_v1_20260805).
 *
 * Maya asks: "My scanner went dark at 09:40 and nobody — not the dashboard, not the pause
 * table, not a single red execution — told me. You traced it to the margin guard reading
 * Alpaca's initial_margin, the same field that froze me on July 23rd. Prove today's freeze
 * against my real account numbers, prove the proxy fix would have kept me trading, prove
 * every guard I actually rely on still trips, and prove a frozen cycle can never be
 * invisible again."
 *
 * Deterministic + offline. Fixtures are the REAL 2026-08-05 account/book numbers
 * (Alpaca via monitor exec 517651 + trade_ledger): equity 106,980, last_equity 106,972,
 * book after 09:36 = 6 positions / $63,760 gross (3 long + 3 short, XPEV/AES sub-$17).
 * 'live' mirrors scanner v3.4; 'proposed' mirrors v3.5+ (deployed 2026-08-05).
 *
 * v3.6 addendum (QTP_KS_CAPACITY_v1_20260805, PO: "take it through the same harness"):
 * Maya adds: "The guard you fixed at lunch declared my book FULL by 13:35 — seven
 * positions, thirty-five percent, done for the day — while my own config says I sized
 * for twenty. Make the caps agree with each other: margin still binds first, but at a
 * number that lets the system I designed actually run — and make the pre-entry sim do
 * the same arithmetic as the guard, so I stop a breach BEFORE the entry, never after."
 * MAX_MARGIN_PCT 0.35 -> 0.50 (gross <= 1.0x equity); sim factor 0.25 -> 0.5 (coherent).
 */
const assert = require('assert');
const K = require('../lib/scanner/killswitch');

let passed = 0, failed = 0;
function check(id, name, fn) {
  try { fn(); console.log(`  ✅ ${id}  ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${id}  ${name}  — ${e.message}`); failed++; }
}
const base = { equity: 106980.34, lastEquity: 106972.06, today: '2026-08-05',
  manualHalt: false, fetchFailed: false, alertAlreadySentToday: false };
const both = (input) => ({ live: K.killSwitchDecision(input, 'live'), proposed: K.killSwitchDecision(input, 'proposed') });

// ── the freeze, pinned against the real numbers ────────────────────────────────
check('KS-01', 'TODAY 09:40 as it happened: 6 pos / $63.8k gross, elevated initial_margin -> LIVE trips Margin, PROPOSED (proxy 29.8%) keeps trading', () => {
  const r = both({ ...base, posCount: 6, grossExposure: 63760, alpacaInitialMargin: 42300 });
  assert.strictEqual(r.live.tripped, true, 'this freeze happened in production 09:40 ET -> all session');
  assert.ok(r.live.reason.startsWith('Margin'), r.live.reason);
  assert.strictEqual(r.live.marginSource, 'alpaca_initial_margin');
  assert.strictEqual(r.proposed.tripped, false, 'proxy 63,760*0.5/106,980 = 29.8% < 35%');
  assert.ok(Math.abs(r.proposed.marginPct - 0.298) < 0.002, String(r.proposed.marginPct));
});
check('KS-02', '09:35 as it happened (4 pos / $42.6k, before ALLE+DGX): BOTH clear — matches the last scan that emitted', () => {
  const r = both({ ...base, posCount: 4, grossExposure: 42577, alpacaInitialMargin: 31700 });
  assert.strictEqual(r.live.tripped, false);
  assert.strictEqual(r.proposed.tripped, false);
});
check('KS-03', 'the 07-23 broker-suspect class (last_equity=0, initial_margin garbage): both variants use the proxy -> identical verdicts', () => {
  const input = { ...base, lastEquity: 0, posCount: 6, grossExposure: 63760, alpacaInitialMargin: 999999 };
  const r = both(input);
  assert.strictEqual(r.live.brokerDataSuspect, true);
  assert.strictEqual(r.live.tripped, r.proposed.tripped, 'suspect path was already the proxy');
  assert.strictEqual(r.live.tripped, false);
  assert.strictEqual(r.live.dailyPnLPct, 0, 'last_equity fallback to equity -> day P&L 0, not -100%');
});

// ── every real protection still trips under the proxy ──────────────────────────
check('KS-04', 'position cap: 20th position still freezes both variants', () => {
  const r = both({ ...base, posCount: 20, grossExposure: 63760, alpacaInitialMargin: 31700 });
  assert.ok(r.live.tripped && r.proposed.tripped);
  assert.ok(r.proposed.reason.includes('Positions 20/20'));
});
check('KS-05', 'exposure cap: $151k gross still freezes (and proxy margin 70% co-fires — both named in reason)', () => {
  const r = K.killSwitchDecision({ ...base, posCount: 10, grossExposure: 151000, alpacaInitialMargin: 31700 }, 'proposed');
  assert.strictEqual(r.tripped, true);
  assert.ok(r.reason.includes('Exposure $151K/$150K'), r.reason);
  assert.ok(r.reason.includes('Margin'), 'proxy margin 70.6% also named');
});
check('KS-06', 'daily-loss cap: -2.6% day still freezes both variants', () => {
  const r = both({ ...base, lastEquity: 109836, equity: 106980.34, posCount: 6, grossExposure: 63760, alpacaInitialMargin: 31700 });
  assert.ok(r.live.tripped && r.proposed.tripped);
  assert.ok(r.proposed.reason.includes('Daily Loss -2.6%'), r.proposed.reason);
});
check('KS-07', 'margin cap still real under the proxy (v3.6 bar): $110k gross on $107k equity = 51.4% -> freezes; $80k (37.4%) now trades', () => {
  const over = K.killSwitchDecision({ ...base, posCount: 11, grossExposure: 110000, alpacaInitialMargin: 0 }, 'proposed');
  assert.strictEqual(over.tripped, true);
  assert.ok(over.reason.startsWith('Margin 51%/50'), over.reason);
  const under = K.killSwitchDecision({ ...base, posCount: 8, grossExposure: 80000, alpacaInitialMargin: 0 }, 'proposed');
  assert.strictEqual(under.tripped, false, '37.4% was a freeze under v3.5 (35% cap); capacity is the point of v3.6');
});
check('KS-08', 'manual halt still halts both variants, before any account math', () => {
  const r = both({ ...base, manualHalt: true, manualHaltDate: '2026-08-05', posCount: 0, grossExposure: 0, alpacaInitialMargin: 0 });
  assert.ok(r.live.tripped && r.proposed.tripped);
  assert.strictEqual(r.proposed.reason, 'manual_halt');
});
check('KS-09', 'portfolio-fetch failure keeps failing OPEN (scan proceeds) in both variants', () => {
  const r = both({ ...base, fetchFailed: true, posCount: 0, grossExposure: 0, alpacaInitialMargin: 0 });
  assert.strictEqual(r.live.tripped, false);
  assert.strictEqual(r.proposed.tripped, false);
});

// ── F2: a frozen cycle can never be invisible again ────────────────────────────
check('KS-10', 'proposed trip emits the marker: reason + real numbers + telemetry-only pause row', () => {
  const r = K.killSwitchDecision({ ...base, posCount: 6, grossExposure: 63760, alpacaInitialMargin: 42300, lastEquity: 0 }, 'proposed');
  // force a trip for marker shape: use exposure instead
  const t = K.killSwitchDecision({ ...base, posCount: 6, grossExposure: 151000, alpacaInitialMargin: 0 }, 'proposed');
  assert.strictEqual(r.marker, null, 'no trip -> no marker');
  assert.ok(t.marker && t.marker.__qtp_killswitch === true);
  assert.strictEqual(t.marker.pos_count, 6);
  assert.strictEqual(t.marker.gross_exposure, 151000);
  assert.strictEqual(t.marker.pause_row.pause_new_entries, false, 'observational row — scanner is the control');
  assert.strictEqual(t.marker.pause_row.trading_blocked, false, 'no coupling into the pipeline pause guard');
  assert.strictEqual(t.marker.pause_row.status, 'SCANNER_KILLSWITCH_ACTIVE');
  assert.strictEqual(t.marker.pause_row.source, 'broad_scanner_killswitch');
});
check('KS-11', 'live trip emits NOTHING (the defect): no marker — this is the invisibility being fixed', () => {
  const r = K.killSwitchDecision({ ...base, posCount: 6, grossExposure: 63760, alpacaInitialMargin: 42300 }, 'live');
  assert.strictEqual(r.tripped, true);
  assert.strictEqual(r.marker, null);
});
check('KS-12', 'Telegram stays once-a-day: first trip sends, later trips of the same day do not', () => {
  const first = K.killSwitchDecision({ ...base, posCount: 20, grossExposure: 63760, alpacaInitialMargin: 0 }, 'proposed');
  const later = K.killSwitchDecision({ ...base, posCount: 20, grossExposure: 63760, alpacaInitialMargin: 0, alertAlreadySentToday: true }, 'proposed');
  assert.strictEqual(first.sendTelegram, true);
  assert.strictEqual(later.sendTelegram, false);
  assert.ok(later.marker, 'pause-row marker still emitted every tripped cycle — visibility never dedups');
});

// ── v3.6: capacity coherence (QTP_KS_CAPACITY_v1_20260805) ─────────────────────
check('KS-13', "TODAY 13:40 book (7 pos / $74.3k / 34.7%): 'full' under v3.5's 35% cap, ~3 entries of headroom under v3.6", () => {
  const r = K.killSwitchDecision({ ...base, posCount: 7, grossExposure: 74346, alpacaInitialMargin: 0 }, 'proposed');
  assert.strictEqual(r.tripped, false);
  assert.ok(Math.abs(r.marginPct - 0.3475) < 0.001, String(r.marginPct));
  assert.ok(K.simNextEntryMarginPct(74346, 106980.34) < K.MAX_MARGIN_PCT, 'next $10k entry projects 39.4% — allowed');
});
check('KS-14', 'the new boundary is gross = 1.0x equity: $106.9k passes (49.97%), $110k trips (51.4%)', () => {
  assert.strictEqual(K.killSwitchDecision({ ...base, posCount: 10, grossExposure: 106900, alpacaInitialMargin: 0 }, 'proposed').tripped, false);
  assert.strictEqual(K.killSwitchDecision({ ...base, posCount: 11, grossExposure: 110000, alpacaInitialMargin: 0 }, 'proposed').tripped, true);
});
check('KS-15', 'sim does the SAME arithmetic as the guard: $98k book -> next entry projects 50.5% -> REJECTED pre-emission (old 0.25 factor said 48.1% and let it through)', () => {
  const proj = K.simNextEntryMarginPct(98000, 106980.34);
  assert.ok(proj > K.MAX_MARGIN_PCT, `projects ${(proj * 100).toFixed(1)}% > 50% — candidate stopped BEFORE the breach`);
  const oldFactorProj = ((98000 * 0.5) + 10000 * 0.25) / 106980.34;
  assert.ok(oldFactorProj < K.MAX_MARGIN_PCT, 'the v3.5 incoherence: sim under-projected and the global switch tripped a cycle AFTER the entry');
  assert.ok(K.simNextEntryMarginPct(96000, 106980.34) < K.MAX_MARGIN_PCT, '$96k book (44.9%) still has room for one more');
});
check('KS-16', 'cap ordering preserved: margin (at ~$107k gross) binds before exposure ($150k) before positions (20)', () => {
  const marginFirst = K.killSwitchDecision({ ...base, posCount: 11, grossExposure: 112000, alpacaInitialMargin: 0 }, 'proposed');
  assert.ok(marginFirst.reason.includes('Margin') && !marginFirst.reason.includes('Exposure'), marginFirst.reason);
  assert.ok(107000 < K.MAX_EXPOSURE && K.MAX_EXPOSURE / 10000 < K.MAX_POSITIONS * 1.0 + 5, 'ordering: 107k < 150k < 20x10k');
});

console.log(`\n  ${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
