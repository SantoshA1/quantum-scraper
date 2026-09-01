-- QTP PEAD Backfill (A'2, gov 246) — batch selector. Read-only.
-- v2: the n8n Code-node runner caps a node at ~60s, so pacing lives ACROSS runs:
-- batches of 4 with 13s spacing (~45s/run), cron 6x per evening = 24 requests/day
-- (+1 calendar guard = the 25/day free cap; fail-soft retries absorb any slip).
with universe as (select distinct symbol from quantum.scorer_bars_daily),
todo as (
  select u.symbol from universe u
  where not exists (select 1 from quantum.pead_backfill_progress p where p.symbol=u.symbol)
  order by u.symbol limit 4
)
select (select coalesce(json_agg(symbol), '[]'::json) from todo) as batch,
       (select count(*) from universe u
         where not exists (select 1 from quantum.pead_backfill_progress p where p.symbol=u.symbol)) as remaining_before;
