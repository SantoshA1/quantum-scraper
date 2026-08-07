-- ═══════════════════════════════════════════════════════════════════════════════════════
-- THE FOUR-QUADRANT TRUTH TABLE — tested against the LIVE plpgsql, not a mirror.
-- Ratified by the Conclave 2026-08-07: "dollar PF is the release metric, kelly* secondary"
-- means PF BLOCKS, kelly* only DOWNGRADES SIZING, kelly* NEVER VETOES.
--
-- Re-runnable. Read-only in effect: synthetic ledger rows are written under throwaway
-- strategy names inside a transaction that ROLLS BACK. Nothing persists.
--
-- EXPECTED (verified 2026-08-07 against GATE_K_v2.8_R2_DIRECTION_SCOPED_20260807):
--   Q1  PF 0.3333  kelly -0.1250  n=20  -> approved=false  negative_measured_edge
--   Q2  PF 1.0588  kelly -2.0250  n=20  -> approved=true   probation 0.50%  + degraded flag
--   Q3  PF 2.0000  kelly  (null)  n=16  -> approved=true   probation 0.50%
--   Q4  PF 2.0000  kelly +0.2500  n=24  -> approved=true   fractional_kelly  risk_pct 1.0000
--   Q5  PF 0.2500  kelly  (null)  n=10  -> approved=true   probation 0.50%   <- see note
--
-- Q2 is the load-bearing row: kelly* of -2.0250 does NOT veto a PF of 1.0588. If Q2 ever
-- returns negative_measured_edge, someone has restored kelly* to blocking authority and
-- reintroduced the corrupted-estimator veto the ruling exists to remove. That is a P0.
--
-- Q5 is NOT in the ruling's table. PF <= 1.0 with n < 20 still approves at probation size,
-- because the n<20 check short-circuits before PF is consulted. This is DELIBERATE — making
-- PF block at any n would mean a fresh direction whose first trade loses (PF=0) is blocked
-- forever, recreating the self-locking deadlock. Its safety net is the Conclave's MONITORED
-- revert (long-side cleaned dollar PF < 1.0 over >= 15 certified trades), computed at the
-- bottom of verify-gatek.sql — not by the function.
-- ═══════════════════════════════════════════════════════════════════════════════════════

BEGIN;
CREATE TEMP TABLE q(scenario text, expect text, approved bool, reason text, risk_pct text,
                    n text, pf text, kelly text, degraded text) ON COMMIT DROP;

CREATE OR REPLACE FUNCTION pg_temp.mk(p_strategy text, p_n int, p_wins int,
  p_win_pnl numeric, p_win_r numeric, p_loss_pnl numeric, p_loss_r numeric)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.trade_ledger (user_id, portfolio_id, strategy, mode, symbol, side, qty,
    contract_multiplier, status, signal_time, intended_entry, intended_stop, net_pnl, gross_pnl,
    r_multiple, risk_amount, entry_fill_price, exit_fill_price, entry_slippage_bps,
    entry_fill_time, exit_fill_time, lineage_source)
  SELECT '04a6a5d7-ddc0-437f-b95b-5340941c0742'::uuid,'38aa32eb-4269-4f13-bb36-f0a538db8ab7'::uuid,
    p_strategy,'paper','QTST','buy',100,1,'closed', now() - interval '11 days', 100, 98,
    CASE WHEN i <= p_wins THEN p_win_pnl ELSE p_loss_pnl END,
    CASE WHEN i <= p_wins THEN p_win_pnl ELSE p_loss_pnl END,
    CASE WHEN i <= p_wins THEN p_win_r   ELSE p_loss_r   END,
    300, 100, 101, 0, now() - interval '10 days', now() - interval '5 days', 'RECERT_QTEST'
  FROM generate_series(1, p_n) i;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.ask(p_strategy text) RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.compute_kelly_gate('04a6a5d7-ddc0-437f-b95b-5340941c0742'::uuid,
    '38aa32eb-4269-4f13-bb36-f0a538db8ab7'::uuid, p_strategy,'paper',100000,100.00,98.00,
    NULL,'buy','QTST',90,40,0.50,0.25,'off');
$$;

CREATE OR REPLACE FUNCTION pg_temp.rec(p_label text, p_expect text, p_strategy text)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO q SELECT p_label, p_expect, (v->>'approved')::bool, v->>'reason', v->>'risk_pct',
    v#>>'{metrics,n_trades}', v#>>'{metrics,dollar_pf}', v#>>'{metrics,kelly_star}', v->>'degraded'
  FROM (SELECT pg_temp.ask(p_strategy) v) t;
$$;

SELECT pg_temp.mk('q1', 20,  5, 100, 2.0, -100, -1.0);
SELECT pg_temp.rec('Q1  PF<=1.0, n>=20',            'BLOCK negative_measured_edge', 'q1');
SELECT pg_temp.mk('q2', 20,  3, 900, 0.4, -150, -1.5);
SELECT pg_temp.rec('Q2  PF>1.0, kelly<0, n>=20',    'APPROVE probation 0.50',       'q2');
SELECT pg_temp.mk('q3', 16,  8, 200, 2.0, -100, -1.0);
SELECT pg_temp.rec('Q3  PF>1.0, kelly>0, n<20',     'APPROVE probation 0.50',       'q3');
SELECT pg_temp.mk('q4', 24, 12, 200, 2.0, -100, -1.0);
SELECT pg_temp.rec('Q4  PF>1.0, kelly>0, n>=20',    'APPROVE fractional_kelly',     'q4');
SELECT pg_temp.mk('q5', 10,  2, 100, 2.0, -100, -1.0);
SELECT pg_temp.rec('Q5  PF<=1.0, n<20 (bootstrap)', 'APPROVE probation 0.50',       'q5');

SELECT scenario, expect, approved, reason, risk_pct, n, pf, kelly, degraded,
  CASE
    WHEN scenario LIKE 'Q1%' AND (approved OR reason <> 'negative_measured_edge') THEN 'FAIL'
    WHEN scenario LIKE 'Q2%' AND (NOT approved OR risk_pct::numeric <> 0.5) THEN 'P0 FAIL - kelly* restored as a VETO'
    WHEN scenario LIKE 'Q3%' AND (NOT approved OR risk_pct::numeric <> 0.5) THEN 'FAIL'
    WHEN scenario LIKE 'Q4%' AND (NOT approved OR reason <> 'fractional_kelly') THEN 'FAIL'
    WHEN scenario LIKE 'Q5%' AND NOT approved THEN 'FAIL - fresh directions now deadlock'
    ELSE 'ok' END AS assessment
FROM q ORDER BY scenario;
ROLLBACK;
