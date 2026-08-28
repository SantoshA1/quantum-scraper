=WITH cfg AS (
  SELECT constant_name, live_value FROM quantum.gate_config WHERE gate_id = 'EXPANSION'
), inp AS (
  SELECT
    {{ $json.account_ok && $json.day_pnl !== null ? $json.day_pnl : 'NULL' }}::numeric AS day_pnl,
    {{ $json.account_ok && $json.equity ? $json.equity : 'NULL' }}::numeric AS equity,
    {{ $json.account_ok ? 'true' : 'false' }}::boolean AS account_ok
), thr AS (
  -- QTP_EXPANSION_KS_PCT_v3_20260724: day-loss cap = -2.5% of equity (scales with book); was fixed -$500
  SELECT round((SELECT equity FROM inp) * (SELECT live_value FROM cfg WHERE constant_name = 'killswitch_day_pnl_pct') / 100.0, 2) AS pnl_threshold_usd
), stops AS (
  -- QTP_KS_STOPLEG_v5_gov231_20260819: the writer stamps Alpaca-style 'FILLED'; the old
  -- order_status='filled' matched ZERO rows in the table's entire history (witness: 08-18,
  -- four stop-outs standing, execution 600258 read stop_fills_today=0). DISTINCT orders
  -- because each fill emits ~2 events (8 events / 4 orders on 08-18); a raw count would
  -- trip the >=4 threshold at just 2 real stop-outs. coalesce covers NULL broker ids
  -- (0 such rows to date; defensive only).
  SELECT count(DISTINCT coalesce(broker_order_id, order_event_id::text)) AS stop_fills_today
  FROM quantum.order_events
  WHERE event_date = (now() AT TIME ZONE 'America/New_York')::date
    AND upper(order_status) = 'FILLED'
    AND order_type IN ('trailing_stop','stop','stop_limit')
), cum AS (
  -- QTP_KSCUM_v4_20260814 gov215: real money, not quantum.trade_log (net_pnl all zero there).
  -- Baseline = killswitch_cum_baseline_epoch (gov-214 re-enable). Missing baseline => 'epoch'
  -- => counts ALL history => trips immediately: FAIL-CLOSED by construction.
  SELECT coalesce(sum(l.net_pnl), 0)::numeric AS cohort_cum_net, count(*) AS cohort_trades
  FROM public.trade_ledger l
  WHERE l.strategy = 'qtp-main-pipeline' AND l.mode = 'paper'
    AND l.exit_fill_time IS NOT NULL AND l.net_pnl IS NOT NULL
    -- QTP_KSCUM_v5_gov243_20260827 (PO-ratified): adjudicated RECERT_QUARANTINE rows
    -- (execution/risk-model defects, not policy outcomes) can no longer trip the
    -- CUMULATIVE brake. They still count in the daily P&L leg (Alpaca-side) and in all
    -- reporting; the legacy bucket (gov-215 baseline -> gov-241 epoch) is reported by
    -- PIM as a frozen historical figure. Paired knob changes: baseline epoch ->
    -- 1787692697 (gov-241 activation), threshold -> -1250 (~1.2% of equity).
    AND coalesce(l.lineage_source, '') NOT LIKE 'RECERT_QUARANTINE%'
    AND l.exit_fill_time >= coalesce(
      to_timestamp((SELECT live_value FROM cfg WHERE constant_name = 'killswitch_cum_baseline_epoch')::double precision),
      'epoch'::timestamptz)
), trip AS (
  SELECT
    ((SELECT account_ok FROM inp) AND (SELECT day_pnl FROM inp) IS NOT NULL AND (SELECT equity FROM inp) IS NOT NULL AND (SELECT day_pnl FROM inp) <= (SELECT pnl_threshold_usd FROM thr)) AS pnl_trip,
    ((SELECT stop_fills_today FROM stops) >= (SELECT live_value FROM cfg WHERE constant_name = 'killswitch_consec_stopouts')) AS stop_trip,
    ((SELECT cohort_cum_net FROM cum) <= coalesce((SELECT live_value FROM cfg WHERE constant_name = 'killswitch_cohort_cumulative_usd'), 0)) AS cum_trip
), ins AS (
  INSERT INTO quantum.entry_pause_control (control_id, checked_at, pause_new_entries, reason, trading_blocked, status, source, expires_at)
  SELECT
    'ksmon-' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSMS'),
    -- gov215: checked_at = expires_at so the pause reader (ORDER BY checked_at DESC LIMIT 1)
    -- keeps returning this halt for its whole life despite AFTO's 15-min NOMINAL inserts.
    CASE WHEN t.cum_trip
      THEN (now() + interval '30 days')
      ELSE (((now() AT TIME ZONE 'America/New_York')::date)::timestamp + interval '16 hours 30 minutes') AT TIME ZONE 'America/New_York'
    END, true,
    CASE WHEN t.cum_trip
      THEN 'EXPANSION_CUMULATIVE_HALT: cohort_cum_net=' || (SELECT cohort_cum_net FROM cum)::text || ' <= ' || (SELECT live_value FROM cfg WHERE constant_name = 'killswitch_cohort_cumulative_usd')::text || ' over ' || (SELECT cohort_trades FROM cum)::text || ' trades — RECONVENE REQUIRED'
      ELSE 'EXPANSION_KILLSWITCH: pnl_trip=' || t.pnl_trip::text || ' (day_pnl=' || coalesce((SELECT day_pnl FROM inp)::text, 'n/a') || ' vs -2.5% = ' || coalesce((SELECT pnl_threshold_usd FROM thr)::text, 'n/a') || ' USD), stop_trip=' || t.stop_trip::text || ' (stop_fills=' || (SELECT stop_fills_today FROM stops)::text || ' vs ' || (SELECT live_value FROM cfg WHERE constant_name = 'killswitch_consec_stopouts')::text || ')'
    END,
    true,
    CASE WHEN t.cum_trip THEN 'EXPANSION_CUMULATIVE_HALT' ELSE 'EXPANSION_KILLSWITCH' END,
    'qtp-expansion-killswitch-monitor',
    CASE WHEN t.cum_trip
      THEN (now() + interval '30 days')
      ELSE (((now() AT TIME ZONE 'America/New_York')::date)::timestamp + interval '16 hours 30 minutes') AT TIME ZONE 'America/New_York'
    END
  FROM trip t
  WHERE (t.pnl_trip OR t.stop_trip OR t.cum_trip)
    AND NOT EXISTS (
      SELECT 1 FROM quantum.entry_pause_control e
      WHERE e.source = 'qtp-expansion-killswitch-monitor'
        AND e.pause_new_entries = true
        AND e.expires_at > now()
        AND e.checked_at >= (now() AT TIME ZONE 'America/New_York')::date
    )
  RETURNING control_id
)
SELECT (SELECT pnl_trip FROM trip) AS pnl_trip, (SELECT stop_trip FROM trip) AS stop_trip, (SELECT cum_trip FROM trip) AS cum_trip, (SELECT day_pnl FROM inp) AS day_pnl, (SELECT equity FROM inp) AS equity, (SELECT pnl_threshold_usd FROM thr) AS pnl_threshold_usd, (SELECT account_ok FROM inp) AS account_ok, (SELECT stop_fills_today FROM stops) AS stop_fills_today, (SELECT cohort_cum_net FROM cum) AS cohort_cum_net, (SELECT cohort_trades FROM cum) AS cohort_trades, coalesce((SELECT live_value FROM cfg WHERE constant_name = 'killswitch_cohort_cumulative_usd'), 0) AS cum_threshold_usd, (SELECT count(*) FROM ins) AS pause_rows_written