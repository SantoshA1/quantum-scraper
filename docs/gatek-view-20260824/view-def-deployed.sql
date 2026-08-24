 WITH certified AS (
         SELECT t.strategy, t.mode, t.status, t.r_multiple, t.exit_fill_time, t.entry_fill_time,
            t.lineage_source, t.risk_amount, t.intended_stop, t.entry_fill_price, t.net_pnl, t.side,
                CASE
                    WHEN t.side = ANY (ARRAY['buy'::text, 'buy_call'::text, 'sell_put'::text]) THEN 'bullish'::text
                    ELSE 'bearish'::text
                END AS direction
           FROM trade_ledger t
          WHERE t.strategy = 'qtp-main-pipeline'::text AND t.mode = 'paper'::text AND t.status = 'closed'::text AND t.r_multiple IS NOT NULL AND t.exit_fill_time >= (now() - '90 days'::interval) AND t.entry_fill_time >= (now() - '90 days'::interval) AND COALESCE(t.lineage_source, ''::text) !~~ 'RECERT_QUARANTINE%'::text AND t.risk_amount IS NOT NULL AND t.risk_amount > 0::numeric AND t.intended_stop IS NOT NULL AND t.entry_fill_price IS NOT NULL
        )
 SELECT direction,
    count(*) AS n_trades,
    count(*) FILTER (WHERE net_pnl > 0::numeric) AS wins,
    round(count(*) FILTER (WHERE net_pnl > 0::numeric)::numeric / NULLIF(count(*), 0)::numeric, 4) AS win_rate,
    round(COALESCE(sum(net_pnl) FILTER (WHERE net_pnl > 0::numeric), 0::numeric), 2) AS gross_win,
    round(abs(COALESCE(sum(net_pnl) FILTER (WHERE net_pnl <= 0::numeric), 0::numeric)), 2) AS gross_loss,
    round(COALESCE(sum(net_pnl) FILTER (WHERE net_pnl > 0::numeric), 0::numeric) / NULLIF(abs(sum(net_pnl) FILTER (WHERE net_pnl <= 0::numeric)), 0::numeric), 4) AS dollar_pf,
    round(avg(r_multiple) FILTER (WHERE r_multiple > 0::numeric), 4) AS avg_win_r,
    round(abs(avg(r_multiple) FILTER (WHERE r_multiple <= 0::numeric)), 4) AS avg_loss_r,
    round(count(*) FILTER (WHERE net_pnl > 0::numeric)::numeric / NULLIF(count(*), 0)::numeric / NULLIF(abs(avg(r_multiple) FILTER (WHERE r_multiple <= 0::numeric)), 0::numeric) - (1::numeric - count(*) FILTER (WHERE net_pnl > 0::numeric)::numeric / NULLIF(count(*), 0)::numeric) / NULLIF(avg(r_multiple) FILTER (WHERE r_multiple > 0::numeric), 0::numeric), 4) AS kelly_star,
    count(*) >= COALESCE(( SELECT gate_config.live_value
           FROM quantum.gate_config
          WHERE gate_config.gate_id = 'GATE_K'::text AND gate_config.constant_name = 'direction_min_trades'::text), 20::numeric)::integer AS meets_sample_bar,
    COALESCE(sum(net_pnl) FILTER (WHERE net_pnl > 0::numeric), 0::numeric) > abs(COALESCE(sum(net_pnl) FILTER (WHERE net_pnl <= 0::numeric), 0::numeric)) AS meets_pf_bar,
    max(exit_fill_time) AS last_exit,
    'GATE_K_v2.9 direction-scoped predicate, mirrored gov238'::text AS predicate_source
   FROM certified
  GROUP BY direction;
