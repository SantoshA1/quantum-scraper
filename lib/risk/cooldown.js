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
 * THE FIX — DEPLOYED 2026-08-05 as GATE_K_v2.2_K3_LOSS_ONLY_20260805 (PO-authorized,
 * migration qtp_gate_k_v2_2_k3_loss_only_20260805, governance row 177):
 *   add AND net_pnl < 0 — block only LOSS exits. Preserves every documented protection
 *   (WDAY/ASML/CBRE were losses; trail-LOSSES like WMB's recovery re-stop still block)
 *   and stops the wrongful winner-blocks (AKAM). 'trail' stays in the list — harmless
 *   for wins once the pnl guard exists, correct for losses.
 *
 * THE EXTENSION — DEPLOYED 2026-08-12 as GATE_K_v2.9_K3_EXTENDED_20260812 (PO "Authorized
 * K3", migration qtp_gate_k_v2_9_k3_extended_20260812, governance row 209):
 *   24h -> 120h (~3 trading sessions), SYMBOL-WIDE (any direction), ANY losing exit
 *   (net_pnl < 0 regardless of exit_reason). Evidence: five re-entries within 120h of a
 *   same-symbol losing exit — WMT@71h same-dir, WST@72h cross-dir, AVB@96h cross-dir,
 *   WMB@91h same-dir, WSM@114h same-dir — ALL FIVE lost, -785.71 USD total, and zero
 *   winning re-entries occurred inside any such window (first winners at 142h and 240h).
 *   WST#2's prior loss exited 'manual', which the v2.2 stop/trail list would miss even at
 *   120h — hence any-loss. Governed by quantum.gate_config flags (k3_cooldown_hours,
 *   k3_symbol_wide, k3_any_loss_exit) that FAIL CLOSED to 120/1/1; setting 24/0/0 restores
 *   v2.2 exactly (proven live, rollback-safe fixtures S1-S7, docs/gov209-k3/).
 *
 * Variant naming in this mirror (kept stable so the suite pins the DELTA):
 *   'live'     = the v2.1 predicate (pre-fix; retained as the regression reference)
 *   'proposed' = the v2.2 predicate (net_pnl < 0) — deployed 2026-08-05, superseded 08-12.
 *   'v29'      = the v2.9 predicate (120h, symbol-wide, any loss) — THE DEPLOYED GATE.
 * Live flip proven 2026-08-05 with tagged fixtures (lineage MAYA_K3_FIXTURE_20260805):
 *   v2.1 blocked both MAYAK3L (sell after -$100 trail loss) and MAYAK3W (buy after +$500
 *   'stop'-labeled win); v2.2 still blocks MAYAK3L and approves MAYAK3W. Fixtures deleted.
 */

const COOLDOWN_HOURS = 24;            // v2.1/v2.2 window — kept as the regression reference
const COOLDOWN_HOURS_V29 = 120;       // v2.9 (gov 209): ~3 trading sessions
const TRIGGER_REASONS = ['stop', 'trail'];   // v2.1/v2.2 list; v2.9 accepts ANY losing exit

function direction(side) {
  const s = String(side || '').toLowerCase();
  if (['buy', 'buy_call', 'sell_put'].includes(s)) return 'bullish';
  if (['sell', 'sell_call', 'buy_put'].includes(s)) return 'bearish';
  return null;
}

/**
 * Mirror of the live FIX-3 block. `candidate` = {symbol, side, mode, now};
 * `ledger` = array of trade_ledger-shaped rows. variant: 'live' | 'proposed' | 'v29'.
 * Returns {blocked, reason, hit} — hit is the most recent qualifying exit.
 *
 * 'v29' mirrors the deployed outer condition `p_symbol IS NOT NULL AND (v_k3_symbol_wide OR
 * v_direction IS NOT NULL)`: symbol-wide, so only the symbol is required; a candidate with
 * an unknown side is still cooled down. v2.1/v2.2 keep their direction requirement.
 */
function cooldownDecision(candidate, ledger, variant, hours) {
  const v = variant || 'live';
  const v29 = v === 'v29';
  const h = hours || (v29 ? COOLDOWN_HOURS_V29 : COOLDOWN_HOURS);
  const dir = direction(candidate.side);
  if (!candidate.symbol || (!v29 && !dir)) return { blocked: false, reason: 'degraded_inputs_skipped' };
  const nowMs = new Date(candidate.now).getTime();
  const hits = (ledger || []).filter((r) => {
    if (String(r.mode) !== String(candidate.mode)) return false;
    if (String(r.symbol).toUpperCase() !== String(candidate.symbol).toUpperCase()) return false;
    if (r.status !== 'closed') return false;                                   // F2: unwritten exit = blind
    if (!v29 && !TRIGGER_REASONS.includes(String(r.exit_reason))) return false;  // v2.9: ANY losing exit
    if (!r.exit_fill_time) return false;
    if (new Date(r.exit_fill_time).getTime() < nowMs - h * 3600000) return false;
    if (!v29 && direction(r.side) !== dir) return false;                       // v2.9: symbol-wide
    if ((v === 'proposed' || v29) && !(Number(r.net_pnl) < 0)) return false;   // losses only (v2.2+)
    return true;
  }).sort((a, b) => new Date(b.exit_fill_time) - new Date(a.exit_fill_time));
  if (!hits.length) return { blocked: false, reason: 'no_qualifying_exit' };
  return { blocked: true, reason: 'stop_out_cooldown', hit: hits[0] };
}

module.exports = { COOLDOWN_HOURS, COOLDOWN_HOURS_V29, TRIGGER_REASONS, direction, cooldownDecision };
