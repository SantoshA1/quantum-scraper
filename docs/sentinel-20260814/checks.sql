WITH rth AS (
  SELECT (extract(isodow from now() AT TIME ZONE 'America/New_York') BETWEEN 1 AND 5)
     AND ((now() AT TIME ZONE 'America/New_York')::time BETWEEN '09:30' AND '16:00') AS in_rth
), sig90 AS (
  SELECT count(*) n FROM quantum.strategy_signals WHERE ingested_at > now() - interval '90 minutes'
), wl AS (
  SELECT DISTINCT upper(trim(coalesce(symbol, ticker))) tk
  FROM quantum.quantum_watchlist_raw
  WHERE coalesce(symbol, ticker) IS NOT NULL AND trim(coalesce(symbol, ticker)) <> ''
), eff AS (
  SELECT tk, row_number() OVER (ORDER BY tk) - 1 AS idx FROM wl
  WHERE tk ~ '^[A-Z]+$' AND length(tk) <= 6
), univcov AS (
  -- gov 218: assert the scanner is still looking at the MIDDLE of its own watchlist.
  -- The 07-23 collapse had an unmistakable signature: signals only ever from the
  -- alphabetical head and tail, zero from the middle 50%, for 16 straight sessions.
  -- Nothing asserted coverage, so nobody saw it. This is that assertion.
  SELECT (SELECT count(*) FROM eff) AS uni,
         (SELECT count(DISTINCT e.tk) FROM eff e
            JOIN (SELECT DISTINCT upper(symbol) s FROM quantum.strategy_signals
                   WHERE ingested_at > now() - interval '5 days') g ON g.s = e.tk
           WHERE e.idx BETWEEN (SELECT count(*) FROM eff) / 4
                           AND (SELECT count(*) FROM eff) * 3 / 4) AS mid_seen
), sig24 AS (
  SELECT count(*) n,
         max(coalesce((raw_payload->>'ADX')::numeric, 0)) max_adx,
         max(greatest(coalesce((raw_payload->>'MTF_Bull')::numeric,0), coalesce((raw_payload->>'MTF_Bear')::numeric,0))) max_mtf,
         count(*) FILTER (WHERE raw_payload->>'VIX' NOT IN ('0','24')) offvals,
         round(avg(extract(epoch from (ingested_at - signal_ts))/3600.0)::numeric, 2) ts_offset_h
  FROM quantum.strategy_signals WHERE ingested_at > now() - interval '24 hours'
), afto AS (
  SELECT extract(epoch from (now() - max(checked_at)))/60.0 age_min
  FROM quantum.entry_pause_control WHERE source = 'qtp_afto_monitor'
), prs AS (
  SELECT extract(epoch from (now() - max(observed_at)))/3600.0 age_h FROM quantum.position_risk_state
), oev AS (
  SELECT extract(epoch from (now() - max(event_ts)))/86400.0 age_d FROM quantum.order_events
), btc AS (
  SELECT extract(epoch from (now() - max(run_ts)))/86400.0 age_d FROM quantum.backtest_symbol_metrics_latest
), tlog AS (
  SELECT count(*) FILTER (WHERE coalesce(net_pnl,0) <> 0) nonzero
  FROM quantum.trade_log WHERE trade_ts > now() - interval '30 days'
), cfg AS (
  SELECT count(*) present FROM quantum.gate_config WHERE gate_id='EXPANSION'
     AND constant_name IN ('killswitch_cohort_cumulative_usd','killswitch_day_pnl_pct','killswitch_consec_stopouts','killswitch_cum_baseline_epoch')
)
SELECT c.check_name, c.expected, c.observed, c.status FROM (
  SELECT 'scanner_signals' check_name, 'ALIVE' expected,
         (SELECT n FROM sig90)::text || ' signals/90min' observed,
         CASE WHEN NOT (SELECT in_rth FROM rth) THEN 'OK'
              WHEN (SELECT n FROM sig90) > 0 THEN 'OK' ELSE 'ALARM' END status
  UNION ALL
  SELECT 'afto_heartbeat', 'ALIVE', round((SELECT age_min FROM afto)::numeric,1)::text || ' min old',
         CASE WHEN (SELECT age_min FROM afto) IS NULL THEN 'ALARM'
              WHEN (SELECT age_min FROM afto) <= 35 THEN 'OK' ELSE 'ALARM' END
  UNION ALL
  SELECT 'position_risk_state', 'ALIVE', round((SELECT age_h FROM prs)::numeric,2)::text || ' h old',
         CASE WHEN NOT (SELECT in_rth FROM rth) THEN 'OK'
              WHEN (SELECT age_h FROM prs) <= 2 THEN 'OK' ELSE 'ALARM' END
  UNION ALL
  SELECT 'order_events_feed', 'ALIVE', round((SELECT age_d FROM oev)::numeric,1)::text || ' d since last event',
         CASE WHEN (SELECT age_d FROM oev) <= 10 THEN 'OK' ELSE 'ALARM' END
  UNION ALL
  SELECT 'killswitch_config', 'ALIVE', (SELECT present FROM cfg)::text || '/4 constants',
         CASE WHEN (SELECT present FROM cfg) = 4 THEN 'OK' ELSE 'ALARM' END
  UNION ALL
  SELECT 'adx_payload', 'DEAD(known 06-08)', 'max24h=' || (SELECT max_adx FROM sig24)::text,
         CASE WHEN (SELECT n FROM sig24) = 0 THEN 'EXPECTED'
              WHEN (SELECT max_adx FROM sig24) = 0 THEN 'EXPECTED' ELSE 'NOTICE' END
  UNION ALL
  SELECT 'mtf_payload', 'DEAD(known 06-01)', 'max24h=' || (SELECT max_mtf FROM sig24)::text,
         CASE WHEN (SELECT n FROM sig24) = 0 THEN 'EXPECTED'
              WHEN (SELECT max_mtf FROM sig24) = 0 THEN 'EXPECTED' ELSE 'NOTICE' END
  UNION ALL
  SELECT 'vix_payload', 'INERT(known: 24 new-signal / 0 repeat rows)', 'offvals24h=' || (SELECT offvals FROM sig24)::text,
         CASE WHEN (SELECT n FROM sig24) = 0 THEN 'EXPECTED'
              WHEN (SELECT offvals FROM sig24) = 0 THEN 'EXPECTED' ELSE 'NOTICE' END
  UNION ALL
  SELECT 'trade_log_pnl', 'DEAD(known; ks bypassed gov215)', 'nonzero30d=' || (SELECT nonzero FROM tlog)::text,
         CASE WHEN (SELECT nonzero FROM tlog) = 0 THEN 'EXPECTED' ELSE 'NOTICE' END
  UNION ALL
  SELECT 'signal_ts_offset', 'DEFECT(known ~4h ET-as-UTC)', 'avg24h=' || coalesce((SELECT ts_offset_h FROM sig24)::text,'n/a') || 'h',
         CASE WHEN (SELECT n FROM sig24) = 0 THEN 'EXPECTED'
              WHEN (SELECT ts_offset_h FROM sig24) BETWEEN 3.9 AND 4.1 THEN 'EXPECTED' ELSE 'NOTICE' END
  UNION ALL
  SELECT 'backtest_cache', 'STALE(known, 60d limit)', round((SELECT age_d FROM btc)::numeric,0)::text || ' d old',
         CASE WHEN (SELECT age_d FROM btc) > 60 THEN 'EXPECTED' ELSE 'NOTICE' END
  UNION ALL
  SELECT 'scanner_universe_coverage', 'MID-UNIVERSE NAMES SIGNALLED (>=1 in 5d)',
         (SELECT mid_seen FROM univcov)::text || ' of ' || (SELECT uni FROM univcov)::text || ' universe',
         CASE WHEN NOT (SELECT in_rth FROM rth) THEN 'OK'
              WHEN (SELECT uni FROM univcov) < 50 THEN 'OK'
              WHEN (SELECT mid_seen FROM univcov) = 0 THEN 'ALARM' ELSE 'OK' END
) c