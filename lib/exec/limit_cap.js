'use strict';
/**
 * Spec-mirror for APT v4.9 EX-C1/C2/C3 — the execution fix of 2026-08-10.
 *
 * This file is the human-readable statement of the contract. The Maya suite executes the
 * ACTUAL deployed node bytes and asserts they agree with this, case for case; if the two
 * ever diverge, one of them is wrong and the suite says which.
 *
 * ── Why a cap and not a better reference price ──────────────────────────────
 * The 2026-08-10 pre-flight measured this account's data tier: IEX-only, sip_available
 * false, and on every mid-cap QTP actually trades the quote was 5-12% wide with last
 * prints up to 36 minutes old. There is no usable reference price available at any
 * endpoint on this feed. So the guard cannot be repaired by measuring better. The cap
 * moves enforcement off a number we cannot trust and onto the broker's own matching:
 * a limit price is not an opinion about the market, it is a refusal to pay more.
 *
 * ── Why 0.30% ───────────────────────────────────────────────────────────────
 * Measured over the real 48-entry / 30-day distribution:
 *   cap     fills   fill rate   slippage paid on filled   P&L of the trades it skips
 *   0.25%   33/48   68.8%       -$78.56                   -$1,018.88
 *   0.30%   35/48   72.9%       -$20.00                   -$915.65   <- chosen
 *   0.40%   39/48   81.3%       +$117.45                  -$312.04
 *   0.50%   41/48   85.4%       +$212.23                  +$4.50
 * 0.30% is the point where the filled book pays about nothing net, while what the cap
 * turns away is still clearly loss-making. Note what this table is NOT: it is not a
 * promise of recovered P&L. The skipped column is what those trades did AFTER filling at
 * a price we would now refuse; a limit that does not fill earns zero, not the counterfactual.
 *
 * ── Why 1.15% and not 1.20% for the fill-anchored stop ──────────────────────
 * The Trailing Stop Manager classifies a held bracket stop leg as UNPROTECTED_STOP_TOO_WIDE
 * at |stop-entry|/entry > 1.20% and responds by cancelling it and forcing a 0.9% stop.
 * On WST (2026-08-10) that forced stop sat 0.25% under the market and was hit by ordinary
 * noise 40 minutes later. Cent-rounding puts a 1.20% target on BOTH sides of that line —
 * ALGN on 08-07 landed at 1.2003% against its signal and escaped only because its fill
 * happened to be favourable. 1.15% is provably inside it at every price QTP trades.
 */

const CAP_PCT_DEFAULT   = 0.30;    // percent
const CAP_PCT_MAX       = 2.0;     // percent — bound, so a bad variable cannot restore
                                   // unbounded slippage silently
const STOP_TARGET_PCT   = 0.0115;  // fraction
const TSM_TOO_WIDE_BAR  = 0.012;   // fraction — the TSM's own classifier
const STOP_SAFE_BAR     = 0.0119;  // fraction — the margin we hold against it
const POLL_MS           = 1500;
const POLL_TRIES        = 8;
const REGIME            = 'EXEC_V49_LIMIT_CAP';

const r2 = n => Math.round(n * 100) / 100;

/** FAIL-CLOSED: undefined / '' / anything but the literal '0' means the cap is ACTIVE. */
function capActive(varValue) {
  return String(varValue !== undefined && varValue !== '' ? varValue : '1') !== '0';
}

/** Percent -> fraction, bounded. Garbage falls back to the default rather than to "off". */
function capPct(varValue) {
  const raw = Number(varValue || CAP_PCT_DEFAULT);
  return (Number.isFinite(raw) && raw > 0 && raw <= CAP_PCT_MAX) ? raw / 100 : CAP_PCT_DEFAULT / 100;
}

/**
 * The capped marketable limit. Anchored to the SIGNAL price deliberately: the cap was
 * derived from the (fill - signal)/signal distribution and trade_ledger.intended_entry is
 * the signal price, so this is the one anchor under which the number means what the
 * analysis said. Anchoring to the IEX print would put the falsified reference back on the
 * money path.
 */
function capLimit(signalPrice, isLong, pctFraction) {
  return isLong ? r2(signalPrice * (1 + pctFraction)) : r2(signalPrice * (1 - pctFraction));
}

/**
 * The fill-anchored protective stop. Rounds to cents, then nudges toward the fill until the
 * REALISED distance is provably inside the TSM's bar — and never crosses the fill, which
 * matters on low-priced names where one cent is a large fraction of the target.
 */
function fillStop(fill, isLong) {
  let s = isLong ? r2(fill * (1 - STOP_TARGET_PCT)) : r2(fill * (1 + STOP_TARGET_PCT));
  for (let i = 0; i < 60; i++) {
    if (!(Math.abs(s - fill) / fill > STOP_SAFE_BAR)) break;
    const n = r2(isLong ? s + 0.01 : s - 0.01);
    if ((isLong && n >= fill) || (!isLong && n <= fill)) break;
    s = n;
  }
  return s;
}

/** Does an already-placed stop need re-anchoring? Only ever TIGHTEN — never widen. */
function needsReanchor(placedStop, fillPrice) {
  if (!(fillPrice > 0)) return false;
  return Math.abs(placedStop - fillPrice) / fillPrice > STOP_SAFE_BAR;
}

/** Would the TSM call this stop too wide, and therefore arm its forced-0.9% recovery? */
function tsmWouldCallTooWide(stop, entry) {
  return Math.abs(stop - entry) / entry > TSM_TOO_WIDE_BAR;
}

/**
 * What to do about the remainder of an entry, given the poll outcome and whether the entry
 * carries a bracket. The asymmetry is the whole safety argument:
 *   bracket + partial   -> LEAVE. Alpaca: "if any one of the orders is canceled, any
 *                          remaining open order in the group is canceled" — cancelling the
 *                          remainder would strip the stop and target from shares already held.
 *   standalone + partial-> CANCEL. No group to damage, and a later fill would sit unprotected
 *                          until the next 15-minute TSM sweep.
 *   zero fill           -> CANCEL. Nothing exists to be harmed (proven: probe 545502).
 *   unreadable          -> LEAVE, and do not claim a skip. "It did not fill" and "we could
 *                          not find out" are different facts and must not share an outcome.
 */
function remainderAction(outcome, isBracket) {
  if (outcome === 'UNREADABLE')        return 'LEAVE_UNKNOWN';
  if (outcome === 'TERMINAL_NO_FILL')  return 'NONE_ALREADY_TERMINAL';
  if (outcome === 'NO_FILL')           return 'CANCEL';
  if (outcome === 'PARTIAL')           return isBracket ? 'LEAVE_PROTECTED' : 'CANCEL';
  return 'NONE';
}

module.exports = {
  CAP_PCT_DEFAULT, CAP_PCT_MAX, STOP_TARGET_PCT, TSM_TOO_WIDE_BAR, STOP_SAFE_BAR,
  POLL_MS, POLL_TRIES, REGIME,
  r2, capActive, capPct, capLimit, fillStop, needsReanchor, tsmWouldCallTooWide, remainderAction
};
