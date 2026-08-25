
// QTP Supabase Trailing Stop Manager context query v4.2.1
// Read-only context for SCALP_TO_SWING_CONVERSION. Broker/order logic remains in the TSM Code node.
return [{
  json: {
    __supabase_query: `
      WITH params AS (
        SELECT
          CURRENT_DATE AS current_session_date,
          CASE
            WHEN EXTRACT(ISODOW FROM CURRENT_DATE) = 1 THEN CURRENT_DATE - INTERVAL '3 days'
            ELSE CURRENT_DATE - INTERVAL '1 day'
          END::date AS prior_session_date
      ),
      event_days AS (
        SELECT current_session_date AS event_date FROM params
        UNION
        SELECT prior_session_date AS event_date FROM params
      ),
      latest_risk_time AS (
        SELECT MAX(observed_at) AS observed_at
        FROM quantum.position_risk_state
      ),
      risk AS (
        SELECT
          UPPER(symbol) AS symbol,
          protection_status,
          blocks_new_entries::text AS blocks_new_entries,
          protected_qty::text AS protected_qty
        FROM quantum.position_risk_state
        WHERE observed_at = (SELECT observed_at FROM latest_risk_time)
      ),
      order_daily AS (
        SELECT
          event_ts::date AS event_date,
          UPPER(symbol) AS symbol,
          COUNT(*) FILTER (WHERE UPPER(order_status) = 'FILLED')::text AS filled_logged,
          COUNT(*) FILTER (WHERE UPPER(order_status) IN ('PENDING_NEW','NEW','ACCEPTED','SUBMITTED'))::text AS open_submit_events
        FROM quantum.order_events
        WHERE event_ts::date IN (SELECT event_date FROM event_days)
        GROUP BY event_ts::date, UPPER(symbol)
      ),
      latest_payload AS (
        SELECT DISTINCT ON (event_ts::date, UPPER(symbol))
          event_ts::date AS event_date,
          UPPER(symbol) AS symbol,
          COALESCE(raw_payload->'raw_payload'->>'_bias_filter_score', raw_payload->>'_bias_filter_score') AS bias_score,
          COALESCE(raw_payload->'raw_payload'->>'_bias_filter_cross_asset', raw_payload->>'_bias_filter_cross_asset') AS cross_asset,
          COALESCE(raw_payload->'raw_payload'->>'_ai_conflict_guard_confidence', raw_payload->>'_ai_conflict_guard_confidence') AS ai_confidence,
          COALESCE(raw_payload->'raw_payload'->>'_ai_conflict_guard_pass', raw_payload->>'_ai_conflict_guard_pass') AS ai_guard_pass,
          COALESCE(raw_payload->'raw_payload'->>'_ai_conflict_guard_reason', raw_payload->>'_ai_conflict_guard_reason') AS ai_guard_reason,
          COALESCE(raw_payload->'raw_payload'->>'vwap', raw_payload->>'vwap') AS vwap,
          COALESCE(raw_payload->'raw_payload'->>'sma50', raw_payload->>'sma50') AS sma50,
          COALESCE(raw_payload->'raw_payload'->>'ema200', raw_payload->>'ema200') AS ema200,
          COALESCE(raw_payload->'raw_payload'->>'backtest_sample_size', raw_payload->>'backtest_sample_size', raw_payload->'raw_payload'->>'strat_total_trades', raw_payload->>'strat_total_trades') AS backtest_sample,
          COALESCE(raw_payload->'raw_payload'->>'backtest_profit_factor', raw_payload->>'backtest_profit_factor', raw_payload->'raw_payload'->>'strat_profit_factor', raw_payload->>'strat_profit_factor') AS backtest_pf
        FROM quantum.order_events
        WHERE event_ts::date IN (SELECT event_date FROM event_days)
          AND raw_payload IS NOT NULL
        ORDER BY event_ts::date, UPPER(symbol), event_ts DESC
      ),
      scalp_proof AS (
        SELECT
          event_ts::date AS event_date,
          UPPER(symbol) AS symbol,
          COUNT(*)::text AS scalp_rows,
          MAX(event_ts)::text AS latest_event_ts,
          MAX(COALESCE(raw_payload->'raw_payload'->>'alert_type', raw_payload->>'alert_type')) AS alert_type,
          MAX(COALESCE(raw_payload->'raw_payload'->>'timeframe', raw_payload->>'timeframe', raw_payload->'raw_payload'->>'tf', raw_payload->>'tf')) AS timeframe,
          MAX(COALESCE(raw_payload->'raw_payload'->>'execution', raw_payload->>'execution')) AS execution,
          MAX(COALESCE(raw_payload->'raw_payload'->>'signal', raw_payload->>'signal')) AS signal,
          MAX(COALESCE(raw_payload->'raw_payload'->>'parser_version', raw_payload->>'parser_version')) AS parser_version
        FROM quantum.order_events
        WHERE event_ts::date IN (SELECT event_date FROM event_days)
          AND UPPER(COALESCE(raw_payload->'raw_payload'->>'execution', raw_payload->>'execution', side)) IN ('BUY','SELL','LONG','SHORT')
          AND (
            UPPER(COALESCE(raw_payload->'raw_payload'->>'alert_type', raw_payload->>'alert_type', '')) LIKE '%BROAD_SCANNER%'
            OR UPPER(COALESCE(raw_payload->'raw_payload'->>'momentum_type', raw_payload->>'momentum_type', '')) LIKE '%SCALP%'
            OR COALESCE(raw_payload->'raw_payload'->>'timeframe', raw_payload->>'timeframe', raw_payload->'raw_payload'->>'tf', raw_payload->>'tf') IN ('5','15')
          )
        GROUP BY event_ts::date, UPPER(symbol)
      ),
      keys AS (
        SELECT symbol, event_date FROM order_daily
        UNION
        SELECT symbol, event_date FROM latest_payload
        UNION
        SELECT symbol, event_date FROM scalp_proof
        UNION
        SELECT r.symbol, d.event_date FROM risk r CROSS JOIN event_days d
      )
      SELECT
        k.event_date::text AS event_date,
        k.symbol AS symbol,
        COALESCE(od.filled_logged, '0') AS filled_logged,
        COALESCE(od.open_submit_events, '0') AS open_submit_events,
        r.protection_status,
        r.blocks_new_entries,
        r.protected_qty,
        lp.bias_score,
        lp.cross_asset,
        lp.ai_confidence,
        lp.ai_guard_pass,
        lp.ai_guard_reason,
        lp.vwap,
        lp.sma50,
        lp.ema200,
        lp.backtest_sample,
        lp.backtest_pf,
        COALESCE(sp.scalp_rows, '0') AS scalp_rows,
        sp.latest_event_ts,
        sp.alert_type,
        sp.timeframe,
        sp.execution,
        sp.signal,
        sp.parser_version
      FROM keys k
      LEFT JOIN risk r ON r.symbol = k.symbol
      LEFT JOIN order_daily od ON od.symbol = k.symbol AND od.event_date = k.event_date
      LEFT JOIN latest_payload lp ON lp.symbol = k.symbol AND lp.event_date = k.event_date
      LEFT JOIN scalp_proof sp ON sp.symbol = k.symbol AND sp.event_date = k.event_date
      ORDER BY k.event_date, k.symbol
    `,
    migration_version: 'QTP_SUPABASE_TRAILING_STOP_MANAGER_v4.2.1'
  }
}];
