-- QTP Policy Time Exit v1.0 (gov 241, 2026-08-25) — due-position selector.
-- Ratified policy: longs exit at close of the 2nd session after entry day (E1 time_2d,
-- PF>1.2 on all three grid runs). Runs 15:50 ET weekdays.
--
-- FAIL-SAFE #1 (epoch-required): the EXISTS(epoch) predicate means a MISSING
--   GATE_K/edge_baseline_epoch config row yields ZERO rows. Legacy positions (DGX,
--   entry 2026-08-05, pre-policy) can never be time-exited: the policy applies only
--   to trades entered under the policy. Proven live 2026-08-25 with epoch absent:
--   0 rows while 1 open long existed.
-- FAIL-SAFE #2 v2 (gov 244, 2026-08-31): sessions are a DETERMINISTIC weekday count
--   (entry_date, today], minus the NYSE holiday list below. v1 counted from
--   quantum.scorer_bars_daily, whose feed is E1-run-driven, not nightly — it froze at
--   08-24 and starved the count: Friday 08-28's run found FLEX at "session 1" and
--   returned 0 due (the first live exit, missed). "Fire late, never early" degraded
--   to "never". No external feed can starve date arithmetic. HOLIDAY LIST must be
--   extended each December (2026 remaining: Labor Day, Thanksgiving, Christmas).
-- FAIL-SAFE #3 (blast radius): LIMIT 10 per run; the runner alarms if 10 arrive.
-- Session math v2: entry Wed 08-26 -> Mon 08-31 = {Thu,Fri,Mon} = 3 (overdue, exits).
--   Entry Thu 08-27 -> Mon = {Fri,Mon} = 2 = due. Entry Fri 08-28 -> Mon = 1, not due.
--   Entry today -> 0. Holiday week: entry Fri 09-04 -> Tue 09-08 = {Tue} = 1 (Labor
--   Day excluded), due Wed 09-09 — matches true d0+2 sessions. Matches E1 d0+2-close.
with epoch as (
  select live_value as v from quantum.gate_config
  where gate_id = 'GATE_K' and constant_name = 'edge_baseline_epoch'
),
nyse_holidays(h) as (values (date '2026-09-07'), (date '2026-11-26'), (date '2026-12-25')),
open_pol as (
  select t.symbol,
         t.qty,
         t.entry_fill_time,
         (select count(*) from generate_series(
             (t.entry_fill_time at time zone 'America/New_York')::date + 1,
             (now() at time zone 'America/New_York')::date, '1 day') g(d)
           where extract(isodow from g.d) < 6
             and g.d::date not in (select h from nyse_holidays)) as sessions_incl_today
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
