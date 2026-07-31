'use strict';
/**
 * Pure spec-mirror of QET H5 Reconciliation heal logic (live RKK5aLIXKhNrVPpD v2071b219)
 * + the 2026-07-29 window fix. The reconciler heals broker-closed positions whose
 * ledger row is still status=open. Bug fixed: the "Get Recent Ledger Rows" query only
 * pulled rows created in the last 3 days, so swing positions held >3 days (WMT, 6d)
 * fell outside the window and their broker closes became permanent unhealable orphans.
 */
const DAY = 86400000;

/** With the fix: every OPEN row is visible regardless of age; closed rows only if recent. */
function ledgerRowVisibleToRecon(row, nowMs, windowDays = 3) {
  if (row.status === 'open') return true;
  return (nowMs - new Date(row.createdAt).getTime()) < windowDays * DAY;
}
/** The OLD (buggy) behaviour — kept so the guard proves the fix changed something. */
function ledgerRowVisibleOld(row, nowMs, windowDays = 3) {
  return (nowMs - new Date(row.createdAt).getTime()) < windowDays * DAY;
}

/**
 * Decide whether an open row should be healed from a set of orphan broker fills.
 * Mirrors: exit side = opposite of entry; exact total-qty match required; weighted
 * avg exit price; exit_reason = 'time' if last fill >= 19:29 ET else 'stop'.
 */
function healDecision(openRow, orphanFills) {
  const exitSide = String(openRow.side).toLowerCase() === 'sell' ? 'buy' : 'sell';
  const grp = orphanFills.filter(f => f.symbol === openRow.symbol && f.side === exitSide);
  if (!grp.length) return { heal: false };
  const totQty = grp.reduce((s, f) => s + Number(f.qty), 0);
  if (Math.abs(totQty - Number(openRow.qty)) > 1e-9) return { heal: false, reason: 'qty_mismatch' };
  const wavg = grp.reduce((s, f) => s + Number(f.qty) * Number(f.price), 0) / totQty;
  const lastT = grp.map(f => f.transaction_time).sort().slice(-1)[0];
  const isEod = lastT && lastT.slice(11, 16) >= '19:29';
  return { heal: true, exitReason: isEod ? 'time' : 'stop', exitPrice: Math.round(wavg * 10000) / 10000 };
}

/**
 * QTP_H5_BENIGN_ORPHAN_FILTER_20260729: a broker fill is NOT a real orphan if its symbol is
 * fully reconciled-closed (a closed ledger row exists and no still-open row) — e.g. a 2nd exit
 * leg the single exit_order_id slot cannot also hold (ZBRA). Real orphans (symbol with an open
 * row, or with no ledger row at all) are still flagged.
 */
function benignOrphanFilter(orphanFills, rows, healedRowIds) {
  const healed = Array.isArray(healedRowIds) ? healedRowIds : Array.from(healedRowIds || []);
  const closed = new Set(rows.filter(r => r.status === 'closed').map(r => String(r.symbol).toUpperCase()));
  for (const id of healed) { const r = rows.find(x => x.id === id); if (r) closed.add(String(r.symbol).toUpperCase()); }
  const open = new Set(rows.filter(r => r.status === 'open' && !healed.includes(r.id)).map(r => String(r.symbol).toUpperCase()));
  return orphanFills.filter(f => !(closed.has(String(f.symbol).toUpperCase()) && !open.has(String(f.symbol).toUpperCase())));
}

module.exports = { ledgerRowVisibleToRecon, ledgerRowVisibleOld, healDecision, benignOrphanFilter };
