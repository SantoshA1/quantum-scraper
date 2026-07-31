'use strict';
/**
 * Pure spec-mirror of quantum.v_risk_gate_status (created 2026-07-29) + the AFTO
 * pause wiring. The view summarises the latest position_risk_state snapshot; AFTO
 * reads unprotected_positions from it. The pause-on-unprotected trigger is flag-gated
 * ($vars.QTP_AFTO_PAUSE_ON_UNPROTECTED, default off) so building the view did NOT
 * re-arm a trading halt — the PO arms it explicitly.
 */
function riskGateStatus(latestRows) {
  const open = latestRows.length;
  const prot = latestRows.filter(r => r.protection_status === 'FULLY_PROTECTED').length;
  const unprotected = latestRows.filter(r => r.protection_status !== 'FULLY_PROTECTED').length;
  const newEntryBlockers = latestRows.filter(r => r.blocks_new_entries === true).length;
  const phase2Blockers = latestRows.filter(r => r.protection_status !== 'FULLY_PROTECTED' || r.blocks_phase_2 === true).length;
  return {
    open_positions: open,
    fully_protected_positions: prot,
    unprotected_positions: unprotected,
    new_entry_blockers: newEntryBlockers,
    new_entry_status: newEntryBlockers === 0 ? 'ALLOW_WITH_NORMAL_GATES' : 'BLOCK_NEW_ENTRIES',
    phase_2_status: phase2Blockers === 0 ? 'GO' : 'BLOCK_PHASE_2',
  };
}

/** Mirror of AFTO pause: unprotected only contributes when the PO flag is enabled. */
function aftoPause(o) {
  const zeroSignalPause = !o.marketHoliday && o.inSession && o.scannerSignals === 0;
  return zeroSignalPause
    || o.deadLetters > 0
    || (o.pauseOnUnprotectedEnabled && o.unprotected > 0)
    || o.tradingBlocked === true;
}

module.exports = { riskGateStatus, aftoPause };
