'use strict';
/**
 * QTP_TSM_TRAIL_LOGIC — pure, testable mirror of the live "Trail Stops" tier engine
 * (n8n workflow vFnPjyx8srnzcYgV, version 95b0909f / QTP_TSM_TRAIL_FIX_v1_20260724).
 *
 * The live node is a monolithic Code node and cannot import this file; this is the
 * canonical SPEC of its decision logic, pinned by tests/test-tsm-trail-guard.js so the
 * 07-24 regression (TSM never moved a stop in its life -> winners round-tripped to entry
 * brackets, worst day -$1,382) can never silently return. If you change the live tier
 * ladder, change it here too and the test will confirm the contract still holds.
 */

const BUF = 0.05;

/**
 * Tier ladder. Returns the stop-replace action for a position, or null when no tier
 * transition fires. Mirrors live lines ~1165-1290.
 *
 * @param {{side:'long'|'short', entry:number, current:number, atr:number, tier:number}} p
 * @returns {{newTier:number, newStop:number, action:'STOP_REPLACE'}|null}
 */
function trailDecision(p) {
  const isLong = String(p.side).toLowerCase() === 'long' || String(p.side).toLowerCase() === 'buy';
  const entry = Number(p.entry);
  const current = Number(p.current);
  const atr = Number(p.atr);
  const tier = Number(p.tier) || 0;
  // FIX C guard: ATR must be a real positive number. A dead feed (sip 403 -> proxy) is a bug,
  // but a zero/NaN atr here means every trigger collapses to entry -> silent mis-trail.
  if (!(atr > 0) || !(entry > 0) || !(current > 0)) return null;

  const t1_trigger = isLong ? entry + 1.5 * atr : entry - 1.5 * atr;
  const t1_stop    = isLong ? round2(entry - BUF) : round2(entry + BUF);
  const t2_trigger = isLong ? entry + 3.0 * atr : entry - 3.0 * atr;
  const t2_stop    = isLong ? round2(entry + 1.5 * atr) : round2(entry - 1.5 * atr);
  const t3_trigger = isLong ? entry + 4.5 * atr : entry - 4.5 * atr;
  const t3_stop    = isLong ? round2(entry + 3.0 * atr) : round2(entry - 3.0 * atr);

  let newTier = tier;
  let newStop = null;
  if (isLong) {
    if (current >= t3_trigger && tier < 3) { newTier = 3; newStop = t3_stop; }
    else if (current >= t2_trigger && tier < 2) { newTier = 2; newStop = t2_stop; }
    else if (current >= t1_trigger && tier < 1) { newTier = 1; newStop = t1_stop; }
  } else {
    if (current <= t3_trigger && tier < 3) { newTier = 3; newStop = t3_stop; }
    else if (current <= t2_trigger && tier < 2) { newTier = 2; newStop = t2_stop; }
    else if (current <= t1_trigger && tier < 1) { newTier = 1; newStop = t1_stop; }
  }
  if (newStop === null || newTier === tier) return null;
  return { newTier, newStop, action: 'STOP_REPLACE' };
}

/**
 * FIX D: does an existing OPEN order block the catch-up scale-out / trail for this symbol?
 * A protective STOP is NOT a duplicate close — it must be ignored, or the trail engine
 * (which sits AFTER this check) is never reached for any protected position. That was the
 * master bug: every profitable position skipped forever.
 *
 * @param {Array<{side:string,type:string,status:string}>} openOrders
 * @param {'buy'|'sell'} closeSide  the side that would CLOSE the position
 * @returns {boolean} true if a genuine (non-stop) close order is already working
 */
function catchUpBlockedByExistingClose(openOrders, closeSide) {
  const activeStatuses = ['new', 'accepted', 'pending_new', 'partially_filled'];
  const stopTypes = ['stop', 'stop_limit', 'trailing_stop'];
  return (openOrders || []).some((o) =>
    String(o.side).toLowerCase() === String(closeSide).toLowerCase() &&
    !stopTypes.includes(String(o.type).toLowerCase()) &&
    activeStatuses.includes(String(o.status).toLowerCase())
  );
}

/**
 * H5 v3 swing-aware staleness (recon RKK5aLIXKhNrVPpD, 966c4f0c). A ledger row that is
 * open and older than 2 days is only STALE if the broker has NO live position for it.
 * The swing book holds >2 days by design; the old age-only rule redlined the console on
 * every legit hold.
 *
 * @param {{status:string, entryFillTimeMs:number}} row
 * @param {boolean} brokerHasLivePosition
 * @param {number} nowMs
 * @returns {boolean}
 */
function isStaleLedgerRow(row, brokerHasLivePosition, nowMs) {
  if (row.status !== 'open') return false;
  const olderThan2d = (Number(nowMs) - Number(row.entryFillTimeMs)) > 2 * 86400000;
  if (!olderThan2d) return false;
  return !brokerHasLivePosition; // stale ONLY when broker is flat
}

/**
 * Ledger completeness invariant: every position the broker has CLOSED (realized P&L)
 * must be represented by a closed ledger row, so edge stats aren't winner-blind
 * (07-24: LDOS +855 / AFL +12 had zero rows -> recorded edge showed only losers).
 *
 * @param {Array<{symbol:string, closedAtBroker:boolean}>} brokerClosed
 * @param {Set<string>} ledgerClosedSymbols
 * @returns {string[]} symbols closed at broker but missing from the ledger
 */
function missingLedgerRows(brokerClosed, ledgerClosedSymbols) {
  return (brokerClosed || [])
    .filter((b) => b.closedAtBroker && !ledgerClosedSymbols.has(String(b.symbol).toUpperCase()))
    .map((b) => String(b.symbol).toUpperCase());
}

/**
 * QTP_TSM_BAR_EXTREME_v1_20260731 (Conclave ruling B, flag-gated default OFF).
 * Tier triggers may be evaluated against the TODAY-SESSION completed-bar extreme instead of
 * the point-in-time sample, guarded by a 0.10*ATR noise epsilon, and NEVER less favorable
 * than the point sample. Session filtering (today ET, >=09:30, completed bars only, no
 * prior-day/overnight bars) is the live caller's duty; this mirrors the evaluation math.
 *
 * @param {{isLong:boolean, current:number, atr:number, bars:Array<{h:number,l:number}>, flagOn:boolean}} p
 * @returns {number} the price the tier ladder should evaluate
 */
function barExtremeEvalPrice(p) {
  const current = Number(p.current);
  if (!p.flagOn || !Array.isArray(p.bars) || p.bars.length === 0 || !(Number(p.atr) > 0)) return current;
  const ext = p.isLong
    ? Math.max(...p.bars.map((b) => Number(b.h)))
    : Math.min(...p.bars.map((b) => Number(b.l)));
  if (!Number.isFinite(ext)) return current;
  const eps = 0.10 * Number(p.atr);
  const adj = p.isLong ? ext - eps : ext + eps;
  return p.isLong ? Math.max(current, adj) : Math.min(current, adj);
}

function round2(x) { return Math.round(x * 100) / 100; }

module.exports = { trailDecision, catchUpBlockedByExistingClose, isStaleLedgerRow, missingLedgerRows, barExtremeEvalPrice, BUF };
