'use strict';
/**
 * QTP_K3_COOLDOWN_SEMANTICS_v1_20260805 — spec-mirror of Gate-K K3 (stop-out cooldown),
 * extracted from public.compute_kelly_gate v2.1 (GATE_K_v2.1_20260710), FIX 3 block.
 *
 * THE LIVE PREDICATE (mirrored verbatim in cooldownDecision):
 *   status='closed' AND exit_reason IN ('stop','trail')
 *   AND exit_fill_time >= now()-24h AND same symbol AND same direction AND same mode
 *
 * RCA (2026-08-05). Three findings, each proven from production rows:
 *
 *  F1 — K3 counts 'trail' AND ignores net_pnl, so it blocks re-entry after WINNERS.
 *       Proven live: 08-04 09:55 K3 rejected AKAM buy because AKAM's 08-03 exit
 *       (+$555.08, +1.86R — a winner) carried an H5-healed 'stop' label. The registry
 *       evidence for K3 (WDAY/ASML/CBRE revenge re-entries) is entirely about LOSSES.
 *
 *  F2 — K3 requires status='closed', so it is blind while an exit is unwritten.
 *       Proven live: XPEV loss-stopped 08-03 11:01 (-$94), re-entered SAME direction
 *       08-03 14:40 (3h39m later) — the exact revenge-trade class K3 exists to stop —
 *       because the exit row was only healed at 02:00 the next morning (H4 v1 could not
 *       see TSM-replaced exit orders). Fixed upstream by H4 v2 (exits land <= 5 min),
 *       but the era explains why K3 fired only twice in its life.
 *
 *  F3 — K3's verdict is one exit_reason string away from flipping. WSM re-entered
 *       08-05 09:32, 23h46m (inside the window) after its 08-04 09:46 exit. It passed
 *       ONLY because the exit was labeled 'target' (+$485 winner). A 'trail' or 'stop'
 *       label — which H5's heal would have written — blocks the same trade. K3 is
 *       downstream of exit-attribution integrity.
 *
 * PROPOSED FIX (Conclave-gated; encoded here as `proposed` so the change is measurable):
 *   add AND net_pnl < 0 — block only LOSS exits. Preserves every documented protection
 *   (WDAY/ASML/CBRE were losses; trail-LOSSES like WMB's recovery re-stop still block)
 *   and stops the wrongful winner-blocks (AKAM). 'trail' stays in the list — harmless
 *   for wins once the pnl guard exists, correct for losses.
 */

const COOLDOWN_HOURS = 24;
const TRIGGER_REASONS = ['stop', 'trail'];

function direction(side) {
  const s = String(side || '').toLowerCase();
  if (['buy', 'buy_call', 'sell_put'].includes(s)) return 'bullish';
  if (['sell', 'sell_call', 'buy_put'].includes(s)) return 'bearish';
  return null;
}

/**
 * Mirror of the live FIX-3 block. `candidate` = {symbol, side, mode, now};
 * `ledger` = array of trade_ledger-shaped rows. variant: 'live' | 'proposed'.
 * Returns {blocked, reason, hit} — hit is the most recent qualifying exit.
 */
function cooldownDecision(candidate, ledger, variant, hours) {
  const v = variant || 'live';
  const h = hours || COOLDOWN_HOURS;
  const dir = direction(candidate.side);
  if (!candidate.symbol || !dir) return { blocked: false, reason: 'degraded_inputs_skipped' };
  const nowMs = new Date(candidate.now).getTime();
  const hits = (ledger || []).filter((r) => {
    if (String(r.mode) !== String(candidate.mode)) return false;
    if (String(r.symbol).toUpperCase() !== String(candidate.symbol).toUpperCase()) return false;
    if (r.status !== 'closed') return false;                                   // F2: unwritten exit = blind
    if (!TRIGGER_REASONS.includes(String(r.exit_reason))) return false;
    if (!r.exit_fill_time) return false;
    if (new Date(r.exit_fill_time).getTime() < nowMs - h * 3600000) return false;
    if (direction(r.side) !== dir) return false;
    if (v === 'proposed' && !(Number(r.net_pnl) < 0)) return false;            // the fix: losses only
    return true;
  }).sort((a, b) => new Date(b.exit_fill_time) - new Date(a.exit_fill_time));
  if (!hits.length) return { blocked: false, reason: 'no_qualifying_exit' };
  return { blocked: true, reason: 'stop_out_cooldown', hit: hits[0] };
}

module.exports = { COOLDOWN_HOURS, TRIGGER_REASONS, direction, cooldownDecision };
