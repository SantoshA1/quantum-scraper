'use strict';
/**
 * QTP_LEDGER_BROKER_DIVERGENCE_v1_20260804 — spec-mirror of the exit-resolution fix and the
 * ledger/broker divergence detector (migration qtp_ledger_broker_divergence_20260804).
 *
 * THE BUG (found 2026-08-04, three live rows: AEE, WSM, WMB).
 * `qet-h4-exit-sync` resolves a position's exit by reading the ENTRY order's nested bracket
 * legs. TSM does not fill those legs — it CANCELS them and places a STANDALONE replacement
 * order, which is what actually fills. H4 therefore never sees the fill, reports
 * "0 closed" indefinitely, and the ledger row stays status='open' forever:
 *
 *   AEE  entry ce4330db  bracket stop 6be4434b CANCELED 08-03 09:45:14
 *                        replacement  e562f3bb NEW     08-03 09:45:16  -> FILLED 08-04 09:40:27
 *   WMB  entry dec5732d  bracket stop f2c52de9 CANCELED 08-04 09:45:12
 *                        replacement  d31fa51e NEW     08-04 10:00:23  -> FILLED 08-04 11:06:48
 *   WSM  entry e98efeb5  stop 5ca1bfa0 CANCELED 08-04 09:46:01
 *                        market  64bd14e2                              -> FILLED 08-04 09:46:04
 *
 * Consequence: every read of edge_metrics_by_strategy between the broker close and the next
 * 02:00 H5 heal is computed on an incomplete trade set — and that view is what Gate-K sizes
 * from. H5 is NOT at fault; at 02:00 those positions were still genuinely open.
 *
 * THE FIX: resolve the exit by (symbol, opposite side, FILLED, after entry, qty match)
 * against the order-event stream — never by bracket-leg identity.
 */

const OPPOSITE = { buy: 'sell', sell: 'buy' };

/** Normalize Alpaca's many side spellings to 'buy' | 'sell'. */
function normSide(side) {
  const s = String(side || '').toLowerCase();
  if (s.startsWith('sell') || s.includes('sell_short') || s.includes('sell_to')) return 'sell';
  if (s.startsWith('buy') || s.includes('buy_to')) return 'buy';
  return s;
}

const isFilled = (e) => String(e.order_status || '').toUpperCase() === 'FILLED';

/**
 * THE OLD (broken) H4 rule — kept so the suite can prove the fix changed behaviour.
 * Only considers orders nested under the entry order.
 */
function resolveExitOld(row, orderEvents) {
  const want = OPPOSITE[normSide(row.side)];
  const hit = (orderEvents || []).find((e) =>
    e.parent_order_id === row.entry_order_id &&
    normSide(e.side) === want && isFilled(e));
  return hit ? { found: true, order: hit } : { found: false, reason: 'no_filled_bracket_leg' };
}

/**
 * THE FIX. Identity-free: the exit is whichever order actually closed the position.
 * Requires an exact quantity match so a partial or a different position cannot be claimed.
 */
function resolveExit(row, orderEvents) {
  const want = OPPOSITE[normSide(row.side)];
  const entryMs = new Date(row.entry_fill_time).getTime();
  const cands = (orderEvents || [])
    .filter((e) => String(e.symbol).toUpperCase() === String(row.symbol).toUpperCase())
    .filter((e) => normSide(e.side) === want && isFilled(e))
    .filter((e) => new Date(e.event_ts).getTime() >= entryMs)
    .filter((e) => Math.abs(Number(e.filled_quantity) - Number(row.qty)) < 1e-9);
  if (!cands.length) return { found: false, reason: 'no_matching_fill' };
  // earliest qualifying fill closes the position
  cands.sort((a, b) => new Date(a.event_ts) - new Date(b.event_ts));
  const e = cands[0];
  return {
    found: true,
    exitOrderId: e.broker_order_id,
    exitPrice: Number(e.avg_fill_price),
    exitTime: e.event_ts,
    orderType: String(e.order_type || '').toLowerCase(),
    stopPrice: e.stop_price == null ? null : Number(e.stop_price),
  };
}

/**
 * Exit attribution. The live H5 heal hard-codes 'time' or 'stop', which is why
 * exit_reason='trail' shows only n=2 in v_learning_summary while trail is the ONLY
 * profitable exit bucket — the attribution, not the strategy, was wrong.
 *
 * A stop that has been moved TOWARD entry (protecting profit) is a trail.
 * A stop moved AWAY from entry is a recovery re-stop, not a trail.
 */
function classifyExitReason({ side, intendedStop, intendedTarget, orderType, stopPrice, exitPrice }, targetTolBp = 50) {
  const s = normSide(side);
  const t = String(orderType || '').toLowerCase();

  if (t === 'stop' && stopPrice != null && intendedStop != null) {
    const ratcheted = s === 'buy' ? stopPrice > intendedStop : stopPrice < intendedStop;
    return ratcheted ? 'trail' : 'stop';
  }
  if (intendedTarget != null && exitPrice != null && intendedTarget !== 0) {
    const bpFromTarget = Math.abs((exitPrice - intendedTarget) / intendedTarget) * 10000;
    const rightSide = s === 'buy' ? exitPrice >= intendedTarget * (1 - targetTolBp / 10000)
                                  : exitPrice <= intendedTarget * (1 + targetTolBp / 10000);
    if (bpFromTarget <= targetTolBp && rightSide) return 'target';
  }
  if (t === 'stop') return 'stop';
  return 'manual';
}

/** Naked window: protective cover was canceled and not replaced for longer than maxGapMs. */
function nakedWindows(orderEvents, maxGapMs = 60000) {
  const evts = (orderEvents || [])
    .filter((e) => ['stop', 'limit'].includes(String(e.order_type || '').toLowerCase()))
    .slice()
    .sort((a, b) => new Date(a.event_ts) - new Date(b.event_ts));
  const out = [];
  let canceledAt = null;
  for (const e of evts) {
    const st = String(e.order_status || '').toUpperCase();
    if (st === 'CANCELED') { canceledAt = new Date(e.event_ts).getTime(); continue; }
    if (st === 'NEW' && canceledAt != null) {
      const gap = new Date(e.event_ts).getTime() - canceledAt;
      if (gap > maxGapMs) out.push({ from: canceledAt, to: new Date(e.event_ts).getTime(), gapMs: gap });
      canceledAt = null;
    }
  }
  return out;
}

/**
 * Mirror of quantum.v_ledger_broker_divergence. `ledgerOpen` = open rows,
 * `brokerPositions` = latest position_risk_state snapshot.
 */
function classifyDivergence(ledgerOpen, brokerPositions) {
  const led = new Map();
  for (const r of ledgerOpen || []) {
    const k = String(r.symbol).toUpperCase();
    led.set(k, (led.get(k) || 0) + Number(r.qty));
  }
  const brk = new Map();
  for (const p of brokerPositions || []) {
    const k = String(p.symbol).toUpperCase();
    brk.set(k, (brk.get(k) || 0) + Math.abs(Number(p.quantity)));
  }
  const rows = [];
  for (const sym of new Set([...led.keys(), ...brk.keys()])) {
    const l = led.get(sym), b = brk.get(sym);
    let divergence = 'OK';
    if (b === undefined) divergence = 'PHANTOM_OPEN';
    else if (l === undefined) divergence = 'UNLEDGERED_POSITION';
    else if (Math.abs(l - b) > 1e-9) divergence = 'QTY_DIVERGENCE';
    rows.push({ symbol: sym, ledgerQty: l ?? 0, brokerQty: b ?? 0, divergence });
  }
  return rows.sort((a, b) => a.symbol.localeCompare(b.symbol));
}

/** One-row rollup mirroring quantum.v_ledger_recon_health. */
function reconHealth(rows, brokerSnapshotStale = false) {
  const bad = rows.filter((r) => r.divergence !== 'OK');
  return {
    divergentSymbols: bad.length,
    phantomOpen: rows.filter((r) => r.divergence === 'PHANTOM_OPEN').length,
    unledgered: rows.filter((r) => r.divergence === 'UNLEDGERED_POSITION').length,
    qtyDivergent: rows.filter((r) => r.divergence === 'QTY_DIVERGENCE').length,
    brokerSnapshotStale: !!brokerSnapshotStale,
    status: bad.length === 0 && !brokerSnapshotStale ? 'CLEAN' : 'DIVERGENT',
  };
}

module.exports = {
  normSide, resolveExit, resolveExitOld, classifyExitReason,
  nakedWindows, classifyDivergence, reconHealth,
};
