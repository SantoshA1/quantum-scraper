#!/usr/bin/env node
'use strict';
/**
 * Maya regression guard — Gate-K K3 stop-out cooldown (QTP_K3_COOLDOWN_SEMANTICS_v1_20260805).
 *
 * Maya asks: "You told me the cooldown 'correctly didn't block' my WSM re-entry. Then you
 * read the code and it turned out the pass was 14 minutes and one label away from a block —
 * and the same gate blocked my AKAM winner yesterday while waving through an XPEV revenge
 * trade three hours after a loss. Pin exactly when this gate fires, prove both live failures
 * against the real rows, and prove the proposed fix keeps every protection I was promised."
 *
 * Deterministic + offline. Fixtures are the REAL public.trade_ledger rows from 08-03..08-05.
 * Variant 'live' mirrors v2.1 (GATE_K_v2.1_20260710) — the pre-fix regression reference.
 * Variant 'proposed' mirrors v2.2 (GATE_K_v2.2_K3_LOSS_ONLY_20260805) — DEPLOYED 2026-08-05
 * (migration qtp_gate_k_v2_2_k3_loss_only_20260805; flip proven live with tagged fixtures).
 */
const assert = require('assert');
const K = require('../lib/risk/cooldown');

let passed = 0, failed = 0;
function check(id, name, fn) {
  try { fn(); console.log(`  ✅ ${id}  ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${id}  ${name}  — ${e.message}`); failed++; }
}
const both = (candidate, ledger) => ({
  live: K.cooldownDecision(candidate, ledger, 'live'),
  proposed: K.cooldownDecision(candidate, ledger, 'proposed'),
});

// ── real rows ──────────────────────────────────────────────────────────────────
const WSM_EXIT_TARGET = { symbol: 'WSM', side: 'buy', mode: 'paper', status: 'closed',
  exit_reason: 'target', net_pnl: 484.65, exit_fill_time: '2026-08-04T13:46:04Z' };
const AKAM_EXIT_WIN_AS_STOP = { symbol: 'AKAM', side: 'buy', mode: 'paper', status: 'closed',
  exit_reason: 'stop', net_pnl: 555.08, exit_fill_time: '2026-08-03T15:00:00Z' }; // H5-healed label
const XPEV_LOSS_STOP = { symbol: 'XPEV', side: 'sell', mode: 'paper', status: 'closed',
  exit_reason: 'stop', net_pnl: -94.27, exit_fill_time: '2026-08-03T15:01:00Z' };
const XPEV_STILL_OPEN_AT_1440 = { ...XPEV_LOSS_STOP, status: 'open', exit_reason: null, exit_fill_time: null, net_pnl: null };
const WDAY_CLASS_LOSS = { symbol: 'WDAY', side: 'sell', mode: 'paper', status: 'closed',
  exit_reason: 'stop', net_pnl: -166, exit_fill_time: '2026-08-05T11:00:00Z' };
const WMB_TRAIL_LOSS = { symbol: 'WMB', side: 'sell', mode: 'paper', status: 'closed',
  exit_reason: 'trail', net_pnl: -341.14, exit_fill_time: '2026-08-04T15:06:48Z' };

// ── the registry-evidence protection (must survive any fix) ────────────────────
check('CD-01', 'WDAY-class revenge trade: loss stop 2h ago, same dir -> BLOCKED in live AND proposed', () => {
  const r = both({ symbol: 'WDAY', side: 'sell', mode: 'paper', now: '2026-08-05T13:00:00Z' }, [WDAY_CLASS_LOSS]);
  assert.strictEqual(r.live.blocked, true);
  assert.strictEqual(r.proposed.blocked, true, 'the fix must not weaken the documented protection');
});
check('CD-02', "a trail-LOSS (WMB's recovery re-stop, -$341) still cools down under the proposed fix", () => {
  const r = both({ symbol: 'WMB', side: 'sell', mode: 'paper', now: '2026-08-05T13:30:00Z' }, [WMB_TRAIL_LOSS]);
  assert.strictEqual(r.live.blocked, true);
  assert.strictEqual(r.proposed.blocked, true, "'trail' stays in the list; the pnl guard only exempts wins");
});

// ── F3: the WSM pass was label-fragile, not principled ─────────────────────────
check('CD-03', "WSM as it happened: 'target' +$485, 23h46m ago (INSIDE window) -> passes both", () => {
  const r = both({ symbol: 'WSM', side: 'buy', mode: 'paper', now: '2026-08-05T13:32:00Z' }, [WSM_EXIT_TARGET]);
  assert.strictEqual(r.live.blocked, false);
  assert.strictEqual(r.proposed.blocked, false);
});
check('CD-04', "same WSM exit relabeled 'trail' (one string) -> LIVE BLOCKS the winning re-entry", () => {
  const relabeled = { ...WSM_EXIT_TARGET, exit_reason: 'trail' };
  const r = both({ symbol: 'WSM', side: 'buy', mode: 'paper', now: '2026-08-05T13:32:00Z' }, [relabeled]);
  assert.strictEqual(r.live.blocked, true, 'the pass hinged entirely on the exit_reason string');
  assert.strictEqual(r.proposed.blocked, false, 'proposed: a +$485 win never cools down, whatever its label');
});

// ── F1: the wrongful block that already happened in production ─────────────────
check('CD-05', "AKAM 08-04 09:55 as it happened: +$555 WIN wearing an H5 'stop' label -> LIVE wrongly BLOCKED", () => {
  const r = both({ symbol: 'AKAM', side: 'buy', mode: 'paper', now: '2026-08-04T13:55:00Z' }, [AKAM_EXIT_WIN_AS_STOP]);
  assert.strictEqual(r.live.blocked, true, 'this block fired in production (audit_log 08-04 09:55)');
  assert.strictEqual(r.proposed.blocked, false, 'net_pnl<0 guard un-blocks winner re-entries');
});

// ── F2: the blindness that let the real revenge trade through ──────────────────
check('CD-06', 'XPEV 08-03 14:40 as it happened: loss-stop 3h39m earlier but exit UNWRITTEN -> both blind, entry passed', () => {
  const r = both({ symbol: 'XPEV', side: 'sell', mode: 'paper', now: '2026-08-03T18:40:00Z' }, [XPEV_STILL_OPEN_AT_1440]);
  assert.strictEqual(r.live.blocked, false, 'status=closed required — K3 cannot see an unwritten exit');
  assert.strictEqual(r.proposed.blocked, false, 'no predicate fixes this; the fix is exit latency (H4 v2, <=5 min)');
});
check('CD-07', 'same XPEV moment WITH the exit written (H4 v2 world) -> revenge trade correctly BLOCKED', () => {
  const r = both({ symbol: 'XPEV', side: 'sell', mode: 'paper', now: '2026-08-03T18:40:00Z' }, [XPEV_LOSS_STOP]);
  assert.strictEqual(r.live.blocked, true);
  assert.strictEqual(r.proposed.blocked, true);
});

// ── boundary + scope semantics ─────────────────────────────────────────────────
check('CD-08', 'window boundary: loss stop 24h+1min ago passes; 23h59m ago blocks', () => {
  const loss = (t) => ({ ...WDAY_CLASS_LOSS, exit_fill_time: t });
  const now = '2026-08-05T13:00:00Z';
  assert.strictEqual(K.cooldownDecision({ symbol: 'WDAY', side: 'sell', mode: 'paper', now }, [loss('2026-08-04T12:59:00Z')], 'live').blocked, false);
  assert.strictEqual(K.cooldownDecision({ symbol: 'WDAY', side: 'sell', mode: 'paper', now }, [loss('2026-08-04T13:01:00Z')], 'live').blocked, true);
});
check('CD-09', 'opposite direction is never cooled down (short loss does not block a long)', () => {
  const r = both({ symbol: 'XPEV', side: 'buy', mode: 'paper', now: '2026-08-03T18:40:00Z' }, [XPEV_LOSS_STOP]);
  assert.strictEqual(r.live.blocked, false);
});
check('CD-10', "'time' and 'manual' exits never trigger the cooldown", () => {
  for (const reason of ['time', 'manual', 'target', 'signal_flip', 'liquidation']) {
    const row = { ...WDAY_CLASS_LOSS, exit_reason: reason };
    assert.strictEqual(K.cooldownDecision({ symbol: 'WDAY', side: 'sell', mode: 'paper', now: '2026-08-05T13:00:00Z' }, [row], 'live').blocked,
      false, reason);
  }
});
check('CD-11', 'mode isolation: a live-mode exit does not cool down a paper entry', () => {
  const liveRow = { ...WDAY_CLASS_LOSS, mode: 'live' };
  assert.strictEqual(K.cooldownDecision({ symbol: 'WDAY', side: 'sell', mode: 'paper', now: '2026-08-05T13:00:00Z' }, [liveRow], 'live').blocked, false);
});
check('CD-12', 'direction mapping matches the live CASE: sell_put is bullish, buy_put is bearish', () => {
  assert.strictEqual(K.direction('sell_put'), 'bullish');
  assert.strictEqual(K.direction('buy_put'), 'bearish');
  assert.strictEqual(K.direction('sell_call'), 'bearish');
  const putExit = { ...WDAY_CLASS_LOSS, side: 'buy_put' }; // bearish loss
  assert.strictEqual(K.cooldownDecision({ symbol: 'WDAY', side: 'sell', mode: 'paper', now: '2026-08-05T13:00:00Z' }, [putExit], 'live').blocked,
    true, 'bearish put loss cools down a bearish equity short');
});
check('CD-13', 'missing symbol or unknown side degrades to skip (matches the live v_degraded path)', () => {
  assert.strictEqual(K.cooldownDecision({ symbol: null, side: 'buy', mode: 'paper', now: '2026-08-05T13:00:00Z' }, [WDAY_CLASS_LOSS], 'live').blocked, false);
  assert.strictEqual(K.cooldownDecision({ symbol: 'WDAY', side: 'weird', mode: 'paper', now: '2026-08-05T13:00:00Z' }, [WDAY_CLASS_LOSS], 'live').blocked, false);
});

console.log(`\n  ${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
