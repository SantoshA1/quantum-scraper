-- ═══════════════════════════════════════════════════════════════════════════════════════
-- r_multiple INTEGRITY CHECK — 2026-08-10.  Read-only. Safe on production.
-- r_multiple must equal net_pnl / risk_amount. On 2026-08-10, 30 of 42 closed trades
-- failed this (31 on the widest filter), all written by RECERT_20260805_fills.
-- FIXED 2026-08-12 by migration qtp_gov206_m1_r_multiple_entry_risk_restore (gov 208):
-- root cause was RECERT_OWN_STOP using the TSM-trailed EXIT-time stop as the risk
-- denominator instead of the entry-time stop. EXPECTED RESULT NOW: zero wrong_r rows.
-- Any non-zero result after 2026-08-12 is a NEW defect. Re-run after any backfill.
-- ═══════════════════════════════════════════════════════════════════════════════════════

-- 1. THE INVARIANT, by writer. Any non-zero "wrong_r" is a defect.
SELECT coalesce(lineage_source,'(null)') AS writer, exit_reason, count(*) AS n,
       count(*) FILTER (WHERE abs(r_multiple - net_pnl/NULLIF(risk_amount,0)) >= 0.01) AS wrong_r,
       round(avg(r_multiple - net_pnl/NULLIF(risk_amount,0))::numeric,4) AS avg_drift,
       round(max(abs(r_multiple - net_pnl/NULLIF(risk_amount,0)))::numeric,4) AS worst_drift
FROM public.trade_ledger
WHERE mode='paper' AND status='closed' AND r_multiple IS NOT NULL
  AND exit_fill_time >= now() - interval '90 days' AND entry_fill_time >= now() - interval '90 days'
  AND coalesce(lineage_source,'') NOT LIKE 'RECERT_QUARANTINE%'
  AND risk_amount > 0 AND intended_stop IS NOT NULL AND entry_fill_price IS NOT NULL
GROUP BY 1,2 ORDER BY wrong_r DESC, n DESC;

-- 2. The two inputs are NOT the problem — prove it. Both ratios must be 1.000.
SELECT symbol, exit_reason,
       round((risk_amount / NULLIF(abs(intended_entry - intended_stop) * qty,0))::numeric,3) AS risk_amount_ratio,
       round((net_pnl / NULLIF((CASE WHEN side IN ('buy','buy_call','sell_put')
              THEN (exit_fill_price - entry_fill_price) ELSE (entry_fill_price - exit_fill_price) END) * qty,0))::numeric,3) AS net_pnl_ratio,
       round(r_multiple::numeric,4) AS r_recorded,
       round((net_pnl/NULLIF(risk_amount,0))::numeric,4) AS r_true
FROM public.trade_ledger
WHERE mode='paper' AND status='closed' AND r_multiple IS NOT NULL
  AND exit_fill_time >= now() - interval '90 days' AND risk_amount > 0
ORDER BY abs(r_multiple - net_pnl/NULLIF(risk_amount,0)) DESC LIMIT 15;

-- 3. THE CONSEQUENCE — kelly* on the recorded vs the true R, by direction.
-- Same formula compute_kelly_gate uses: b = avg(R|R>0), a = |avg(R|R<=0)|, kelly = p/a - (1-p)/b.
-- dollar_pf comes from net_pnl and is UNAFFECTED — the halt decision does not depend on this.
WITH t AS (
  SELECT (CASE WHEN side IN ('buy','buy_call','sell_put') THEN 'bullish' ELSE 'bearish' END) AS dir,
         r_multiple AS r_rec, net_pnl / NULLIF(risk_amount,0) AS r_true, net_pnl
  FROM public.trade_ledger
  WHERE user_id='04a6a5d7-ddc0-437f-b95b-5340941c0742' AND strategy='qtp-main-pipeline'
    AND mode='paper' AND status='closed' AND r_multiple IS NOT NULL
    AND exit_fill_time >= now() - interval '90 days' AND entry_fill_time >= now() - interval '90 days'
    AND coalesce(lineage_source,'') NOT LIKE 'RECERT_QUARANTINE%'
    AND risk_amount > 0 AND intended_stop IS NOT NULL AND entry_fill_price IS NOT NULL
), k AS (
  SELECT dir, count(*) AS n,
         avg(CASE WHEN r_rec  > 0 THEN 1.0 ELSE 0.0 END) AS p_rec,
         avg(r_rec)  FILTER (WHERE r_rec  > 0) AS b_rec,  abs(avg(r_rec)  FILTER (WHERE r_rec  <= 0)) AS a_rec,
         avg(CASE WHEN r_true > 0 THEN 1.0 ELSE 0.0 END) AS p_true,
         avg(r_true) FILTER (WHERE r_true > 0) AS b_true, abs(avg(r_true) FILTER (WHERE r_true <= 0)) AS a_true,
         coalesce(sum(net_pnl) FILTER (WHERE net_pnl>0),0)/NULLIF(abs(sum(net_pnl) FILTER (WHERE net_pnl<=0)),0) AS dollar_pf
  FROM t GROUP BY dir
)
SELECT dir, n, round(dollar_pf::numeric,4) AS dollar_pf_unaffected,
       round(a_rec::numeric,4) AS avg_loss_R_recorded, round(a_true::numeric,4) AS avg_loss_R_true,
       round((p_rec /NULLIF(a_rec ,0) - (1-p_rec )/NULLIF(b_rec ,0))::numeric,4) AS kelly_star_recorded,
       round((p_true/NULLIF(a_true,0) - (1-p_true)/NULLIF(b_true,0))::numeric,4) AS kelly_star_true,
       CASE WHEN (p_rec/NULLIF(a_rec,0) - (1-p_rec)/NULLIF(b_rec,0)) < 0
             AND (p_true/NULLIF(a_true,0) - (1-p_true)/NULLIF(b_true,0)) > 0
            THEN 'SIGN FLIP — at n>=20 this is probation 0.50% vs fractional kelly'
            ELSE 'same sign' END AS quadrant_impact
FROM k ORDER BY dir;
