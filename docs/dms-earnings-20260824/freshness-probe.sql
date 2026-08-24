-- QTP_EARNINGS_LIVENESS_PROBE_v1_gov239_20260824
-- "Did the nightly earnings workflow actually run since its last scheduled slot?"
-- Expectation = most recent WEEKDAY 18:10 ET strictly before now (so Monday mornings
-- correctly expect Friday's run and do not false-alarm across the weekend). A single
-- missed run flips calendar_fresh to false the very next morning — a flat hours-threshold
-- would not notice until ~3 days had passed.
with et as (select (now() at time zone 'America/New_York') as now_et),
slots as (
  select (((select now_et from et)::date - d)::timestamp + interval '18 hours 10 minutes') as slot
  from generate_series(0, 6) as d
),
expected as (
  select max(slot) as expected_slot from slots
  where extract(isodow from slot) between 1 and 5
    and slot < (select now_et from et)
),
cal as (
  select max(fetched_at at time zone 'America/New_York') as last_refresh_et,
         count(*) filter (where report_date >= (select now_et from et)::date) as forward_rows
  from quantum.earnings_calendar
)
select
  to_char((select expected_slot from expected),'YYYY-MM-DD HH24:MI') as expected_last_refresh_et,
  to_char((select last_refresh_et from cal),'YYYY-MM-DD HH24:MI')    as actual_last_refresh_et,
  round((extract(epoch from ((select now_et from et) - (select last_refresh_et from cal)))/3600)::numeric,2) as hours_since_refresh,
  (select forward_rows from cal) as forward_rows,
  ((select last_refresh_et from cal) >= (select expected_slot from expected) - interval '1 hour') as calendar_fresh
