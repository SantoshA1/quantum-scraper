-- Supabase migration: qtp_console_live_signalflow  (version 20260712003445)
-- Project: qtp_prod (vdmtwmwpxvohodyrdlon)
-- Live signal-flow + committee-verdict views for the operations console.
-- Session day = latest day with scanned candidates (today during market hours; last
-- session on weekends/after-hours) so the cockpit is never blank.

create or replace view console.v_session_day as
  select coalesce(max(observed_at::date), current_date) as session_day
  from quantum.candidate_path_trace_10fc;

-- Pipeline strip: one row per stage, real counts for the session.
create or replace view console.v_funnel_session as
with sd as (select session_day from console.v_session_day),
cpt as (
  select * from quantum.candidate_path_trace_10fc, sd
  where observed_at::date = sd.session_day
),
gate as (
  select
    count(*) filter (where decision in ('approved','sized')) as sized,
    count(*) filter (where decision = 'rejected') as rej
  from audit_log, sd
  where workflow_name = 'qet-kelly-risk-gate'
    and "timestamp"::date = sd.session_day
),
led as (
  select
    count(*) filter (where entry_fill_time::date = (select session_day from sd)) as filled,
    count(*) as rows_total
  from public.trade_ledger, sd
  where created_at::date = sd.session_day
)
select 1 as ord, 'Signals'        as stage, (select count(*) from cpt) as n_in,
       (select count(*) from cpt) as n_pass, 0 as n_fail, false as is_live,
       'candidates scanned' as note
union all
select 2, 'Bias / SSM',
       (select count(*) from cpt),
       (select count(*) filter (where ssm_action='PASS') from cpt),
       (select count(*) filter (where ssm_action is distinct from 'PASS') from cpt),
       false, 'multi-timeframe / bias filter'
union all
select 3, 'VC Gate',
       (select count(*) from cpt),
       (select count(*) filter (where vc_verdict='PASS') from cpt),
       (select count(*) filter (where vc_verdict in ('KILL','REJECT')) from cpt),
       true, 'conviction score gate'
union all
select 4, 'Gate-K (Risk)',
       (select sized+rej from gate),
       (select sized from gate),
       (select rej from gate),
       true, 'fractional-Kelly sizing + risk gates'
union all
select 5, 'Execution',
       (select filled from led),
       (select filled from led),
       0, false, 'broker fills (bracketed)'
union all
select 6, 'Ledger',
       (select rows_total from led),
       (select rows_total from led),
       0, false, 'cost-survived rows written'
order by ord;

-- Committee verdicts: recent candidate journeys, one card per ticker per session,
-- newest first. Front-half agents are real per-signal; executed match is added by
-- the feed against live broker positions.
create or replace view console.v_cards_live as
select distinct on (ticker, observed_at::date)
  trace_id,
  observed_at,
  ticker,
  signal_direction,
  scanner_score,
  ssm_action,
  vc_verdict,
  live_vc_score,
  case
    when vc_verdict in ('KILL','REJECT') then 'rejected'
    when vc_verdict = 'PASS' then 'advanced'
    else 'evaluated'
  end as disposition,
  case
    when vc_verdict = 'KILL'   then 'VC Agent killed — conviction below floor'
    when vc_verdict = 'REJECT' then 'VC Agent rejected — parity/quality check'
    when vc_verdict = 'PASS'   then 'passed VC — advanced to risk sizing'
    else 'evaluated'
  end as disposition_note
from quantum.candidate_path_trace_10fc
where observed_at >= now() - interval '5 days'
order by ticker, observed_at::date, observed_at desc;

grant select on console.v_session_day, console.v_funnel_session, console.v_cards_live to anon, authenticated, service_role;
