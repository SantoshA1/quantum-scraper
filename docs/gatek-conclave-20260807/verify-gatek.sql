-- ═══════════════════════════════════════════════════════════════════════════════════════
-- GATE-K POST-CONCLAVE VERIFICATION — re-runnable, read-only, safe on production.
-- Every mutation below is inside a transaction that ROLLS BACK. Nothing persists.
-- Run this after ANY change to compute_kelly_gate or quantum.gate_config.
--
-- Expected (2026-08-12, GATE_K_v2.9_K3_EXTENDED_20260812, functiondef md5 d2a9e381...):
--   (gov 209: K3 cooldown is now 120h / symbol-wide / any-loss, checked BEFORE R1/R2 —
--    so the candidates below are SYNTHETIC never-traded symbols; a real symbol with a
--    losing exit in the last 120h would return stop_out_cooldown and mask the R1/R2 reads.
--    K3 itself is proven by the gov209 fixture set, docs/gov209-k3/.)
--   LONG                              -> approved=true  probation_sizing_insufficient_sample 0.50%
--   SHORT (all flags on)              -> approved=false short_side_blocked_pf_below_bar
--   SHORT (R1 off)                    -> approved=false negative_measured_edge
--   SHORT (R1 off + forced probation) -> approved=false short_side_probation_forbidden   <-- THE seal
--   SHORT (config wiped)              -> approved=false short_side_blocked_pf_below_bar  <-- fail-closed
--   LONG  (config wiped)              -> approved=true  0.50%
-- ANY row where a SHORT comes back approved is a P0 incident: revert immediately with
--   UPDATE quantum.gate_config SET live_value=0 WHERE gate_id='GATE_K' AND constant_name='direction_scoped_edge_active';
-- ═══════════════════════════════════════════════════════════════════════════════════════

-- 0. what is live right now
SELECT public.compute_kelly_gate(
         '04a6a5d7-ddc0-437f-b95b-5340941c0742'::uuid,'38aa32eb-4269-4f13-bb36-f0a538db8ab7'::uuid,
         'qtp-main-pipeline','paper',100000,200.00,197.60,NULL,'buy','MAYAOK')->>'gate_version' AS live_gate_version,
       md5(pg_get_functiondef(p.oid)) AS functiondef_md5
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.proname='compute_kelly_gate';

-- 1. the flags (all three must exist and be PROMOTED)
SELECT gate_id, constant_name, live_value, status FROM quantum.gate_config
WHERE gate_id='GATE_K' ORDER BY constant_name;

-- 2. THE SAFETY MATRIX
BEGIN;
CREATE TEMP TABLE res(scenario text, approved bool, reason text, risk_pct text) ON COMMIT DROP;

INSERT INTO res SELECT '1. SHORT, all flags on', (v->>'approved')::bool, v->>'reason', v->>'risk_pct'
FROM (SELECT public.compute_kelly_gate('04a6a5d7-ddc0-437f-b95b-5340941c0742'::uuid,
  '38aa32eb-4269-4f13-bb36-f0a538db8ab7'::uuid,'qtp-main-pipeline','paper',100000,50.00,50.60,
  NULL,'sell','MAYAZZ',90,40,0.50,0.25,'off') v) t;

UPDATE quantum.gate_config SET live_value=0 WHERE gate_id='GATE_K' AND constant_name='short_side_block_active';
INSERT INTO res SELECT '2. SHORT, R1 OFF (R2 must hold)', (v->>'approved')::bool, v->>'reason', v->>'risk_pct'
FROM (SELECT public.compute_kelly_gate('04a6a5d7-ddc0-437f-b95b-5340941c0742'::uuid,
  '38aa32eb-4269-4f13-bb36-f0a538db8ab7'::uuid,'qtp-main-pipeline','paper',100000,50.00,50.60,
  NULL,'sell','MAYAZZ',90,40,0.50,0.25,'off') v) t;

UPDATE quantum.gate_config SET live_value=999 WHERE gate_id='GATE_K' AND constant_name='direction_min_trades';
INSERT INTO res SELECT '3. SHORT, R1 OFF + forced to probation', (v->>'approved')::bool, v->>'reason', v->>'risk_pct'
FROM (SELECT public.compute_kelly_gate('04a6a5d7-ddc0-437f-b95b-5340941c0742'::uuid,
  '38aa32eb-4269-4f13-bb36-f0a538db8ab7'::uuid,'qtp-main-pipeline','paper',100000,50.00,50.60,
  NULL,'sell','MAYAZZ',90,40,0.50,0.25,'off') v) t;
INSERT INTO res SELECT '4. LONG, same forced-probation config', (v->>'approved')::bool, v->>'reason', v->>'risk_pct'
FROM (SELECT public.compute_kelly_gate('04a6a5d7-ddc0-437f-b95b-5340941c0742'::uuid,
  '38aa32eb-4269-4f13-bb36-f0a538db8ab7'::uuid,'qtp-main-pipeline','paper',100000,200.00,197.60,
  NULL,'buy','MAYAOK',90,40,0.50,0.25,'off') v) t;

DELETE FROM quantum.gate_config WHERE gate_id='GATE_K';
INSERT INTO res SELECT '5. SHORT, GATE_K config WIPED', (v->>'approved')::bool, v->>'reason', v->>'risk_pct'
FROM (SELECT public.compute_kelly_gate('04a6a5d7-ddc0-437f-b95b-5340941c0742'::uuid,
  '38aa32eb-4269-4f13-bb36-f0a538db8ab7'::uuid,'qtp-main-pipeline','paper',100000,50.00,50.60,
  NULL,'sell','MAYAZZ',90,40,0.50,0.25,'off') v) t;
INSERT INTO res SELECT '6. LONG, GATE_K config WIPED', (v->>'approved')::bool, v->>'reason', v->>'risk_pct'
FROM (SELECT public.compute_kelly_gate('04a6a5d7-ddc0-437f-b95b-5340941c0742'::uuid,
  '38aa32eb-4269-4f13-bb36-f0a538db8ab7'::uuid,'qtp-main-pipeline','paper',100000,200.00,197.60,
  NULL,'buy','MAYAOK',90,40,0.50,0.25,'off') v) t;

SELECT scenario, approved, reason, risk_pct,
       CASE WHEN scenario LIKE '%SHORT%' AND approved THEN 'P0 FAIL - SHORT BOOK REOPENED'
            WHEN scenario LIKE '%SHORT%' THEN 'ok - refused'
            WHEN approved THEN 'ok - long trades' ELSE 'CHECK - long refused' END AS assessment
FROM res ORDER BY scenario;
ROLLBACK;

-- 2b. QUADRANT 5 WATCH — the one cell in the truth table the function does NOT guard.
-- PF <= 1.0 with n < 20 still approves at probation size (deliberate: blocking there would
-- deadlock any fresh direction). Its ONLY safety net is the Conclave's monitored revert:
-- "long-side cleaned dollar PF drops below 1.0 over the next >= 15 certified trades ->
--  long side returns to negative_measured_edge halt."  Nothing computes that automatically,
-- so compute it here. If TRIGGERED, revert with:
--   UPDATE quantum.gate_config SET live_value=0 WHERE gate_id='GATE_K' AND constant_name='direction_scoped_edge_active';
SELECT 'Q5 WATCH: long side, cleaned dollar PF over the most recent certified trades' AS rule,
       count(*) AS n_certified,
       round(coalesce(sum(net_pnl) FILTER (WHERE net_pnl>0),0)
             / NULLIF(abs(sum(net_pnl) FILTER (WHERE net_pnl<=0)),0), 4) AS dollar_pf,
       count(*) >= 15 AS trigger_armed,
       CASE
         WHEN count(*) < 15 THEN 'not yet armed - needs >= 15 certified trades'
         WHEN coalesce(sum(net_pnl) FILTER (WHERE net_pnl>0),0)
              / NULLIF(abs(sum(net_pnl) FILTER (WHERE net_pnl<=0)),0) < 1.0
           THEN 'TRIGGERED - halt the long side'
         ELSE 'ok - long side may continue'
       END AS verdict
FROM public.trade_ledger
WHERE user_id='04a6a5d7-ddc0-437f-b95b-5340941c0742' AND strategy='qtp-main-pipeline'
  AND mode='paper' AND status='closed' AND r_multiple IS NOT NULL
  AND (CASE WHEN side IN ('buy','buy_call','sell_put') THEN 'bullish' ELSE 'bearish' END)='bullish'
  AND exit_fill_time >= now() - interval '90 days' AND entry_fill_time >= now() - interval '90 days'
  AND coalesce(lineage_source,'') NOT LIKE 'RECERT_QUARANTINE%'
  AND risk_amount IS NOT NULL AND risk_amount > 0
  AND intended_stop IS NOT NULL AND entry_fill_price IS NOT NULL;

-- 3. the release conditions, so the PO can see how far each book is from its bar
SELECT 'SHORT release: certified dollar PF > 1.0 over >= 20 trades' AS rule,
       count(*) AS n_certified,
       round(coalesce(sum(net_pnl) FILTER (WHERE net_pnl>0),0)
             / NULLIF(abs(sum(net_pnl) FILTER (WHERE net_pnl<=0)),0), 4) AS dollar_pf,
       count(*) >= 20 AS meets_sample_bar
FROM public.trade_ledger
WHERE user_id='04a6a5d7-ddc0-437f-b95b-5340941c0742' AND mode='paper' AND status='closed'
  AND (CASE WHEN side IN ('buy','buy_call','sell_put') THEN 'bullish' ELSE 'bearish' END)='bearish'
  AND (starts_with(coalesce(lineage_source,''),'H4_') OR starts_with(coalesce(lineage_source,''),'RECERT_'))
  AND exit_fill_time >= now() - interval '90 days' AND entry_fill_time >= now() - interval '90 days'
  AND coalesce(lineage_source,'') NOT LIKE 'RECERT_QUARANTINE%'
  AND risk_amount IS NOT NULL AND risk_amount > 0
  AND intended_stop IS NOT NULL AND entry_fill_price IS NOT NULL
UNION ALL
SELECT 'LONG exits probation at n >= 20 (then judged on dollar PF > 1.0)',
       count(*),
       round(coalesce(sum(net_pnl) FILTER (WHERE net_pnl>0),0)
             / NULLIF(abs(sum(net_pnl) FILTER (WHERE net_pnl<=0)),0), 4),
       count(*) >= 20
FROM public.trade_ledger
WHERE user_id='04a6a5d7-ddc0-437f-b95b-5340941c0742' AND strategy='qtp-main-pipeline'
  AND mode='paper' AND status='closed' AND r_multiple IS NOT NULL
  AND (CASE WHEN side IN ('buy','buy_call','sell_put') THEN 'bullish' ELSE 'bearish' END)='bullish'
  AND exit_fill_time >= now() - interval '90 days' AND entry_fill_time >= now() - interval '90 days'
  AND coalesce(lineage_source,'') NOT LIKE 'RECERT_QUARANTINE%'
  AND risk_amount IS NOT NULL AND risk_amount > 0
  AND intended_stop IS NOT NULL AND entry_fill_price IS NOT NULL;
