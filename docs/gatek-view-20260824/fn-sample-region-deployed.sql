IF v_dir_scoped AND v_direction IS NOT NULL THEN
    v_sample_scope   := 'direction:' || v_direction;
    v_min_trades_eff := v_dir_min;
    SELECT count(*) AS n, count(*) FILTER (WHERE net_pnl > 0)::numeric AS wins,
           avg(r_multiple) FILTER (WHERE r_multiple > 0) AS b,
           abs(avg(r_multiple) FILTER (WHERE r_multiple <= 0)) AS a,
           coalesce(sum(net_pnl) FILTER (WHERE net_pnl > 0), 0) AS gw,
           coalesce(abs(sum(net_pnl) FILTER (WHERE net_pnl <= 0)), 0) AS gl
    INTO m
    FROM public.trade_ledger
    WHERE user_id = p_user_id AND strategy = p_strategy AND mode = p_mode AND status = 'closed'
      AND r_multiple IS NOT NULL
      AND exit_fill_time  >= now() - make_interval(days => p_lookback_days)
      AND entry_fill_time >= now() - make_interval(days => p_lookback_days)
      AND coalesce(lineage_source, '') NOT LIKE 'RECERT_QUARANTINE%'
      AND risk_amount IS NOT NULL AND risk_amount > 0
      AND intended_stop IS NOT NULL AND entry_fill_price IS NOT NULL
      AND (CASE WHEN side IN ('buy','buy_call','sell_put') THEN 'bullish' ELSE 'bearish' END) = v_direction;
