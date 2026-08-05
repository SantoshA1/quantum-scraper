-- QTP_LEDGER_BROKER_DIVERGENCE_v1_20260804
-- Applied to qtp_prod (vdmtwmwpxvohodyrdlon) as migration
-- `qtp_ledger_broker_divergence_20260804` on 2026-08-04. Committed here for version control.
--
-- Detector for the class found 2026-08-04: trade_ledger rows stuck status='open' after the
-- broker already closed the position, because H4 exit-sync resolves exits through the ENTRY
-- order's nested bracket legs, and TSM cancel/replaces those legs with standalone orders.
-- H5's nightly heal only runs at 02:00, so an intraday exit is invisible for up to ~16h and
-- every read of edge_metrics_by_strategy in that window is computed on an incomplete set.

CREATE OR REPLACE VIEW quantum.v_ledger_broker_divergence AS
WITH snap AS (
  SELECT max(observed_at) AS observed_at FROM quantum.position_risk_state
),
broker AS (
  SELECT upper(p.symbol) AS symbol,
         sum(abs(p.quantity)) AS broker_qty
  FROM quantum.position_risk_state p, snap s
  WHERE p.observed_at = s.observed_at
  GROUP BY 1
),
ledger AS (
  SELECT upper(t.symbol) AS symbol,
         sum(t.qty) AS ledger_qty,
         count(*) AS open_rows,
         min(t.entry_fill_time) AS oldest_entry
  FROM public.trade_ledger t
  WHERE t.status = 'open'
  GROUP BY 1
)
SELECT
  coalesce(l.symbol, b.symbol) AS symbol,
  coalesce(l.ledger_qty, 0) AS ledger_open_qty,
  coalesce(b.broker_qty, 0) AS broker_qty,
  coalesce(l.open_rows, 0) AS ledger_open_rows,
  l.oldest_entry,
  round(extract(epoch FROM (now() - l.oldest_entry)) / 3600.0, 2) AS open_hours,
  (SELECT observed_at FROM snap) AS broker_snapshot_at,
  ((SELECT observed_at FROM snap) < now() - interval '90 minutes') AS broker_snapshot_stale,
  CASE
    WHEN b.symbol IS NULL THEN 'PHANTOM_OPEN'
    WHEN l.symbol IS NULL THEN 'UNLEDGERED_POSITION'
    WHEN abs(coalesce(l.ledger_qty,0) - coalesce(b.broker_qty,0)) > 1e-9 THEN 'QTY_DIVERGENCE'
    ELSE 'OK'
  END AS divergence,
  CASE
    WHEN b.symbol IS NULL THEN 'broker is flat but the ledger still shows this open — exit was never written back (H4 gap)'
    WHEN l.symbol IS NULL THEN 'broker holds a position with no open ledger row — entry was never written'
    WHEN abs(coalesce(l.ledger_qty,0) - coalesce(b.broker_qty,0)) > 1e-9 THEN 'quantity mismatch between ledger and broker'
    ELSE NULL
  END AS detail
FROM ledger l
FULL OUTER JOIN broker b ON b.symbol = l.symbol;

COMMENT ON VIEW quantum.v_ledger_broker_divergence IS
  'QTP_LEDGER_BROKER_DIVERGENCE_v1_20260804 — per-symbol reconciliation of public.trade_ledger open rows against the latest quantum.position_risk_state broker snapshot. PHANTOM_OPEN is the 2026-08-04 class (H4 misses TSM-replaced exit orders).';

CREATE OR REPLACE VIEW quantum.v_ledger_recon_health AS
SELECT
  count(*) FILTER (WHERE divergence <> 'OK') AS divergent_symbols,
  count(*) FILTER (WHERE divergence = 'PHANTOM_OPEN') AS phantom_open,
  count(*) FILTER (WHERE divergence = 'UNLEDGERED_POSITION') AS unledgered,
  count(*) FILTER (WHERE divergence = 'QTY_DIVERGENCE') AS qty_divergent,
  max(open_hours) FILTER (WHERE divergence = 'PHANTOM_OPEN') AS worst_phantom_hours,
  bool_or(broker_snapshot_stale) AS broker_snapshot_stale,
  max(broker_snapshot_at) AS broker_snapshot_at,
  CASE WHEN count(*) FILTER (WHERE divergence <> 'OK') = 0
         AND NOT bool_or(broker_snapshot_stale) THEN 'CLEAN' ELSE 'DIVERGENT' END AS status
FROM quantum.v_ledger_broker_divergence;

COMMENT ON VIEW quantum.v_ledger_recon_health IS
  'QTP_LEDGER_BROKER_DIVERGENCE_v1_20260804 — one-row rollup. status=CLEAN is the invariant; anything else means edge_metrics_by_strategy is being computed on an incomplete trade set.';

-- ─────────────────────────────────────────────────────────────────────────────
-- DATA REPAIR applied the same day (3 rows), sourced entirely from
-- quantum.order_events — no price was inferred. Recorded here for audit.
-- The trade_ledger_derive trigger computed gross/net/R and exit slippage.
--
-- WITH fix(id, xoid, xpx, xts, xint, xreason) AS (VALUES
--   ('e711978b-…'::uuid,'e562f3bb-…',108.0017,'2026-08-04T13:40:27Z'::timestamptz,108.1400,'trail'),
--   ('caafac4c-…'::uuid,'64bd14e2-…',245.3100,'2026-08-04T13:46:04Z'::timestamptz,245.5400,'target'),
--   ('c02fe3c3-…'::uuid,'d31fa51e-…', 71.6000,'2026-08-04T15:06:48Z'::timestamptz, 71.5600,'stop')
-- )
-- UPDATE public.trade_ledger t SET exit_order_id=f.xoid, exit_fill_price=f.xpx,
--        exit_fill_time=f.xts, intended_exit=f.xint, exit_reason=f.xreason,
--        status='closed', lineage_source='H4_GAP_REPAIR_20260804'
--   FROM fix f WHERE t.id=f.id AND t.status='open';
--
-- Result: AEE  −107.36 (−0.242R, trail)   WSM +484.65 (+1.969R, target)
--         WMB  −341.14 (−2.110R, stop)    net +36.15 for 2026-08-04
-- Rollback: set the five columns back to NULL and status='open' for
--           lineage_source='H4_GAP_REPAIR_20260804'.
