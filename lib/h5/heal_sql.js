'use strict';
/**
 * QTP_H5_CERTIFIED_HEAL_v3_20260805 — spec-mirror of the H5 heal-UPDATE builder
 * (workflow RKK5aLIXKhNrVPpD, "Reconcile Fills vs Ledger" Code node, v3).
 *
 * Conclave ruling step 3: close the LAST uncertified exit writer. The v2 heal hard-coded
 *   reason = isEod ? 'time' : 'stop'
 * and stamped no lineage — the exact fabrication behind the empty −1R bucket and the
 * winners-wearing-'stop' rows that froze Kelly activation.
 *
 * v3 CONTRACT (mirrored verbatim by the live node):
 *  - exit_reason is CLASSIFIED in SQL from quantum.order_events lifecycle of the actual
 *    exit order: >1 distinct stop_price => 'trail' (TSM only ratchets one way);
 *    stop/stop_limit/trailing_stop => 'stop'; limit => 'target'; market at EOD => 'time';
 *    any other events => 'manual'; NO events => NULL (never guessed).
 *  - lineage_source stamps the writer: 'H4_H5HEAL_v3_20260805' when order_events has the
 *    exit order (CERTIFIED family, starts_with H4_), 'H5_QUARANTINE_v3_20260805' when it
 *    does not — quarantined rows also get r_multiple = NULL so they can NEVER enter the
 *    Kelly sample or the short-mult release record.
 *  - price/pnl/status arithmetic is unchanged from v2 (broker fills are truth for money;
 *    only the LABEL pipeline was corrupt).
 */

const CERTIFIED_LINEAGE = 'H4_H5HEAL_v3_20260805';
const QUARANTINE_LINEAGE = 'H5_QUARANTINE_v3_20260805';

const esc = (s) => (s == null ? '' : String(s).replace(/'/g, "''"));

/** The classify subquery for one exit order id. */
function classifySubquery(orderId, isEod) {
  return "(SELECT CASE" +
    " WHEN count(DISTINCT oe.stop_price) FILTER (WHERE oe.stop_price IS NOT NULL) > 1 THEN 'trail'" +
    " WHEN bool_or(oe.order_type IN ('stop','stop_limit','trailing_stop')) THEN 'stop'" +
    " WHEN bool_or(oe.order_type = 'limit') THEN 'target'" +
    (isEod ? " WHEN bool_or(oe.order_type = 'market') THEN 'time'" : "") +
    " WHEN count(*) > 0 THEN 'manual' ELSE NULL END" +
    " FROM quantum.order_events oe WHERE oe.broker_order_id = '" + esc(orderId) + "')";
}

/**
 * Build the v3 heal UPDATE for one matched (ledger row, orphan fill-group).
 * row: {id}; wavg: numeric; lastT: ISO string; orderId: string.
 */
function buildHealUpdate(row, wavg, lastT, orderId) {
  const isEod = !!(lastT && lastT.slice(11, 16) >= '19:29');
  const oid = esc(orderId);
  return "UPDATE public.trade_ledger SET exit_order_id='" + oid + "', exit_fill_price=" + wavg.toFixed(4) +
    ", exit_fill_time='" + esc(lastT) + "'" +
    ", exit_reason=" + classifySubquery(orderId, isEod) +
    ", lineage_source=(SELECT CASE WHEN count(*) > 0 THEN '" + CERTIFIED_LINEAGE + "' ELSE '" + QUARANTINE_LINEAGE + "' END" +
      " FROM quantum.order_events oe WHERE oe.broker_order_id = '" + oid + "')" +
    ", r_multiple = CASE WHEN EXISTS (SELECT 1 FROM quantum.order_events oe WHERE oe.broker_order_id = '" + oid + "')" +
      " THEN r_multiple ELSE NULL END" +
    ", gross_pnl=round(((CASE WHEN side='sell' THEN entry_fill_price - " + wavg.toFixed(4) + " ELSE " + wavg.toFixed(4) + " - entry_fill_price END) * qty)::numeric, 2)" +
    ", net_pnl=round(((CASE WHEN side='sell' THEN entry_fill_price - " + wavg.toFixed(4) + " ELSE " + wavg.toFixed(4) + " - entry_fill_price END) * qty)::numeric, 2)" +
    ", sizing_meta=coalesce(sizing_meta,'{}'::jsonb) || '{\"exit_backfill\":\"H5_CERTIFIED_HEAL_v3\"}'::jsonb" +
    ", status='closed', updated_at=now() WHERE id='" + esc(row.id) + "' AND status='open'";
}

module.exports = { CERTIFIED_LINEAGE, QUARANTINE_LINEAGE, esc, classifySubquery, buildHealUpdate };
