-- QTP Policy Invariant Monitor v1.0 (gov 242, 2026-08-26) — DB-side invariants.
-- Runs nightly 18:25 ET weekdays. READ-ONLY. One row out, jsonb `inv`.
-- Born from gov 241c: three private copies of one retired stop policy; issues were
-- found by losses instead of machines. Each invariant names the gov that ratified it.
-- The paired Code node ("PIM Broker Checks") adds broker-truth checks and ALWAYS
-- sends the nightly Telegram line — green heartbeat or named violations.
with epoch as (
  select live_value as v, status from quantum.gate_config
  where gate_id = 'GATE_K' and constant_name = 'edge_baseline_epoch'
),
today0 as (
  select (date_trunc('day', now() at time zone 'America/New_York') at time zone 'America/New_York') as t0
),
entries_today as (
  select symbol, side, qty, entry_fill_price, intended_stop, risk_amount, status,
         round(100.0 * abs(entry_fill_price - intended_stop) / nullif(entry_fill_price, 0), 3) as stop_pct,
         coalesce(sizing_meta->>'stop_reanchored', 'false') as reanchored,
         coalesce(nullif(sizing_meta->>'fill_price','')::numeric, entry_fill_price) as fillpx
  from public.trade_ledger, today0
  where strategy = 'qtp-main-pipeline' and mode = 'paper' and entry_fill_time >= today0.t0
    -- RECERT rows are PO-adjudicated incidents: the quarantine IS the resolution
    -- record, so the monitor does not re-alarm them (first light 2026-08-26: CHTR/EQT).
    and coalesce(lineage_source, '') not like 'RECERT_QUARANTINE%'
),
open_post_epoch as (
  select symbol, qty, entry_fill_price, intended_stop, entry_fill_time,
         ((select count(distinct d) from quantum.scorer_bars_daily cal
             where cal.d > (t.entry_fill_time at time zone 'America/New_York')::date
               and cal.d < (now() at time zone 'America/New_York')::date) + 1) as sessions
  from public.trade_ledger t
  where t.status = 'open' and t.strategy = 'qtp-main-pipeline' and t.mode = 'paper'
    and t.side in ('buy', 'buy_call', 'sell_put')
    and exists (select 1 from epoch)
    and t.entry_fill_time >= to_timestamp((select v from epoch)::double precision)
)
select jsonb_build_object(
  -- I1 (gov 241/241c): every long entered today carries the 2.5% policy stop.
  -- v1.2 CALIBRATION (first-light lesson, 2026-08-27): the stop is 2.5% of the entry
  -- ANCHOR, but this column measures it against the FILL — a favorable capped-limit
  -- fill (UHS −0.53% on 08-27) legitimately reads 1.97% of fill. The stored fields
  -- cannot reconstruct the anchor, so the band is a fill-basis SANITY band [1.8, 3.2]:
  -- wide enough for slip variance, still catches every seen incident class (the
  -- repealed 1.145% regime, a 0.9% forced stop, any >3.2% runaway). A reanchored=true
  -- row is legal ONLY inside the same band.
  'I1_bad_stop_widths', (select coalesce(jsonb_agg(jsonb_build_object(
       'sym', symbol, 'stop_pct', stop_pct, 'reanchored', reanchored)), '[]'::jsonb)
     from entries_today where side in ('buy','buy_call')
       and (stop_pct < 1.8 or stop_pct > 3.2)),
  -- I4 (gov 241): epoch row exists, value PINNED to the ratified activation second.
  -- A silently rewritten epoch would re-admit legacy trades into the cohort.
  'I4_epoch', (select coalesce(jsonb_build_object('v', v, 'status', status), '{}'::jsonb) from epoch),
  -- I6 (gov 241): the 2-day time exit actually fires — no post-epoch long may ever
  -- reach session 3 (the selector exits at 2; 3 = the 15:50 run failed or lied).
  'I6_overdue_longs', (select coalesce(jsonb_agg(jsonb_build_object(
       'sym', symbol, 'sessions', sessions)), '[]'::jsonb)
     from open_post_epoch where sessions >= 3),
  -- I8 (gov 235/239): earnings calendar freshness (nightly refresh; >3d = stale).
  'I8_earnings_stale_days', (select coalesce(round((extract(epoch from (now() - max(fetched_at))) / 86400.0)::numeric, 2), 999) from quantum.earnings_calendar),
  -- I9 (gov 219): the short halt holds — zero short-side entries, ever.
  'I9_short_entries_today', (select coalesce(jsonb_agg(symbol), '[]'::jsonb)
     from entries_today where side not in ('buy','buy_call','sell_put')),
  -- I10 (gov 241 pre-commitment): interim look due at n>=10 with PF<0.6.
  'I10_cohort', (select coalesce(jsonb_build_object('n', n_trades, 'pf', dollar_pf), '{"n": 0, "pf": null}'::jsonb)
     from quantum.v_gatek_certified_metrics where direction = 'bullish'),
  -- inputs for the broker-side checks (I2 geometry, I3 TIF, I5 sizing)
  'open_post_epoch', (select coalesce(jsonb_agg(jsonb_build_object(
       'sym', symbol, 'qty', qty, 'entry', entry_fill_price, 'stop', intended_stop, 'sessions', sessions)), '[]'::jsonb)
     from open_post_epoch),
  'entries', (select coalesce(jsonb_agg(jsonb_build_object(
       'sym', symbol, 'side', side, 'qty', qty, 'entry', entry_fill_price, 'risk', risk_amount)), '[]'::jsonb)
     from entries_today),
  'entries_today_n', (select count(*) from entries_today)
) as inv;
