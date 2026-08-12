-- Checked-in copy of migration qtp_gov206_m1_r_multiple_entry_risk_restore_20260812
-- (applied 2026-08-12 01:31 UTC, governance 208). See docs/GOV206-M1-RESULT-20260812.md.
DO $gov206m1$
DECLARE
  n_other int;
  n_bad   int;
  n_trail int;
  n_upd   int;
BEGIN
  -- Guard 1: every violating row must belong to the known faulty writer.
  SELECT count(*) INTO n_other
  FROM public.trade_ledger
  WHERE mode='paper' AND status='closed' AND r_multiple IS NOT NULL AND risk_amount > 0
    AND abs(r_multiple - net_pnl/risk_amount) >= 0.01
    AND coalesce(lineage_source,'') <> 'RECERT_20260805_fills';
  IF n_other > 0 THEN
    RAISE EXCEPTION 'GOV206M1 ABORT: % violating rows from a writer other than RECERT_20260805_fills - investigate before correcting', n_other;
  END IF;

  -- Guard 2: bounded blast radius (31 measured 2026-08-11).
  SELECT count(*) INTO n_bad
  FROM public.trade_ledger
  WHERE mode='paper' AND status='closed' AND r_multiple IS NOT NULL AND risk_amount > 0
    AND abs(r_multiple - net_pnl/risk_amount) >= 0.01
    AND lineage_source = 'RECERT_20260805_fills';
  IF n_bad > 40 THEN
    RAISE EXCEPTION 'GOV206M1 ABORT: % violating rows exceeds the measured bound of 31 - re-verify before correcting', n_bad;
  END IF;

  -- Trail first (append-only), then update, same transaction.
  WITH bad AS (
    SELECT id, symbol, strategy, exit_reason, r_multiple, lineage_source,
           intended_stop, risk_amount, round((net_pnl/risk_amount)::numeric, 4) AS r_true
    FROM public.trade_ledger
    WHERE mode='paper' AND status='closed' AND r_multiple IS NOT NULL AND risk_amount > 0
      AND abs(r_multiple - net_pnl/risk_amount) >= 0.01
      AND lineage_source = 'RECERT_20260805_fills'
    FOR UPDATE
  ),
  trail AS (
    INSERT INTO quantum.r_multiple_corrections
      (ledger_id, symbol, strategy, method,
       before_exit_reason, after_exit_reason,
       before_r_multiple, after_r_multiple,
       before_lineage, after_lineage,
       entry_stop_used, risk_dollars_used)
    SELECT id, symbol, strategy, 'GOV206_M1_ENTRY_RISK_RESTORE',
           exit_reason, exit_reason,
           r_multiple, r_true,
           lineage_source, lineage_source,
           intended_stop, risk_amount
    FROM bad
    RETURNING 1
  )
  SELECT count(*) INTO n_trail FROM trail;

  UPDATE public.trade_ledger t
  SET r_multiple = round((t.net_pnl/t.risk_amount)::numeric, 4),
      updated_at = now()
  WHERE t.mode='paper' AND t.status='closed' AND t.r_multiple IS NOT NULL AND t.risk_amount > 0
    AND abs(t.r_multiple - t.net_pnl/t.risk_amount) >= 0.01
    AND t.lineage_source = 'RECERT_20260805_fills';
  GET DIAGNOSTICS n_upd = ROW_COUNT;

  -- Guard 3: the trail and the update must cover the same set.
  IF n_trail <> n_upd THEN
    RAISE EXCEPTION 'GOV206M1 ABORT: trail rows (%) != updated rows (%) - transaction rolled back', n_trail, n_upd;
  END IF;

  RAISE NOTICE 'GOV206M1: corrected % rows, % trail rows appended', n_upd, n_trail;
END
$gov206m1$;
