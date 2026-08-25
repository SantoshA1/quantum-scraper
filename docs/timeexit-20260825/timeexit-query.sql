-- QTP Policy Time Exit v1.0 (gov 241, 2026-08-25) — due-position selector.
-- Ratified policy: longs exit at close of the 2nd session after entry day (E1 time_2d,
-- PF>1.2 on all three grid runs). Runs 15:50 ET weekdays.
--
-- FAIL-SAFE #1 (epoch-required): the EXISTS(epoch) predicate means a MISSING
--   GATE_K/edge_baseline_epoch config row yields ZERO rows. Legacy positions (DGX,
--   entry 2026-08-05, pre-policy) can never be time-exited: the policy applies only
--   to trades entered under the policy. Proven live 2026-08-25 with epoch absent:
--   0 rows while 1 open long existed.
-- FAIL-SAFE #2 (calendar lag): sessions are counted from quantum.scorer_bars_daily
--   (distinct d strictly between entry date and today) + 1 for today (this query only
--   runs at 15:50 ET on a weekday). The bars table lags ~1 day; a stalled feed
--   UNDERCOUNTS sessions, so exits can only fire late, never early.
-- FAIL-SAFE #3 (blast radius): LIMIT 10 per run; the runner alarms if 10 arrive.
-- Session math (proven live): entry Fri 08-21 -> Tue 08-25 = (Mon) 1 + 1 = 2 = due.
--   Entry today -> 1, not due. Entry yesterday -> 1, not due. Matches E1 d0+2-close.
with epoch as (
  select live_value as v from quantum.gate_config
  where gate_id = 'GATE_K' and constant_name = 'edge_baseline_epoch'
),
cal as (select distinct d from quantum.scorer_bars_daily),
open_pol as (
  select t.symbol,
         t.qty,
         t.entry_fill_time,
         ((select count(*) from cal
             where cal.d > (t.entry_fill_time at time zone 'America/New_York')::date
               and cal.d < (now() at time zone 'America/New_York')::date) + 1) as sessions_incl_today
  from public.trade_ledger t
  where t.status = 'open'
    and t.side in ('buy', 'buy_call', 'sell_put')
    and t.strategy = 'qtp-main-pipeline'
    and t.mode = 'paper'
    and exists (select 1 from epoch)
    and t.entry_fill_time >= to_timestamp((select v from epoch)::double precision)
)
select symbol,
       qty::text as ledger_qty,
       sessions_incl_today,
       to_char(entry_fill_time at time zone 'America/New_York', 'YYYY-MM-DD HH24:MI') as entered_et
from open_pol
where sessions_incl_today >= 2
order by entry_fill_time
limit 10;
