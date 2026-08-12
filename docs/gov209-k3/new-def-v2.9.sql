CREATE OR REPLACE FUNCTION public.compute_kelly_gate(p_user_id uuid, p_portfolio_id uuid, p_strategy text, p_mode text, p_equity numeric, p_entry numeric, p_stop numeric, p_confidence numeric DEFAULT NULL::numeric, p_side text DEFAULT NULL::text, p_symbol text DEFAULT NULL::text, p_lookback_days integer DEFAULT 90, p_min_trades integer DEFAULT 40, p_probation_risk_pct numeric DEFAULT 0.50, p_kelly_fraction numeric DEFAULT 0.25, p_regime_mode text DEFAULT 'enforce'::text, p_max_stop_width_pct numeric DEFAULT 5.0, p_cooldown_hours integer DEFAULT 24, p_regime_max_age_min integer DEFAULT 90)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
DECLARE
  m              record;
  v_port         record;
  v_regime       record;
  v_dd           numeric;
  v_dd_mult      numeric;
  v_gate1_cap    numeric;
  v_kelly_star   numeric;
  v_risk_pct     numeric;
  v_risk_dollars numeric;
  v_qty          numeric;
  v_probation    boolean := false;
  v_conc_pct     numeric;
  v_max_qty      numeric;
  v_conc_capped  boolean := false;
  v_rps          numeric;
  v_direction    text;
  v_width_pct    numeric;
  v_cooldown_hit record;
  v_degraded     text[] := ARRAY[]::text[];
  v_regime_info  jsonb := NULL;
  v_regime_violation text := NULL;
  v_min_trades_eff integer;
  v_short_mult   numeric := 1.0;
  v_short_n      integer := 0;
  v_short_gw     numeric := 0;
  v_short_gl     numeric := 0;
  v_short_pf     numeric;
  v_short_block_on boolean;
  v_dollar_pf    numeric;
  v_dir_scoped   boolean;
  v_dir_min      integer;
  v_sample_scope text;
  v_k3_hours     numeric;
  v_k3_symbol_wide boolean;
  v_k3_any_loss  boolean;
BEGIN
  IF p_stop IS NULL OR p_entry IS NULL OR p_entry = p_stop THEN
    RETURN jsonb_build_object('approved', false, 'reason', 'missing_or_degenerate_stop', 'risk_pct', 0, 'qty', 0);
  END IF;
  IF p_equity IS NULL OR p_equity <= 0 THEN
    RETURN jsonb_build_object('approved', false, 'reason', 'invalid_equity', 'risk_pct', 0, 'qty', 0);
  END IF;
  IF p_mode NOT IN ('paper', 'live') THEN
    RETURN jsonb_build_object('approved', false, 'reason', 'invalid_mode', 'risk_pct', 0, 'qty', 0);
  END IF;

  v_direction := CASE
    WHEN p_side IN ('buy', 'buy_call', 'sell_put') THEN 'bullish'
    WHEN p_side IN ('sell', 'sell_call', 'buy_put') THEN 'bearish'
    ELSE NULL END;
  IF v_direction IS NULL THEN
    v_degraded := array_append(v_degraded, 'side_missing_direction_checks_skipped');
  END IF;

  IF v_direction = 'bullish' AND p_stop >= p_entry THEN
    RETURN jsonb_build_object('approved', false, 'reason', 'stop_wrong_side_of_entry', 'risk_pct', 0, 'qty', 0,
      'note', 'bullish entry requires stop BELOW entry; got stop ' || p_stop || ' vs entry ' || p_entry);
  END IF;
  IF v_direction = 'bearish' AND p_stop <= p_entry THEN
    RETURN jsonb_build_object('approved', false, 'reason', 'stop_wrong_side_of_entry', 'risk_pct', 0, 'qty', 0,
      'note', 'bearish entry requires stop ABOVE entry; got stop ' || p_stop || ' vs entry ' || p_entry);
  END IF;

  v_width_pct := round(abs(p_entry - p_stop) / p_entry * 100, 3);
  IF v_width_pct > p_max_stop_width_pct THEN
    RETURN jsonb_build_object('approved', false, 'reason', 'stop_width_exceeds_sanity', 'risk_pct', 0, 'qty', 0,
      'stop_width_pct', v_width_pct, 'max_allowed_pct', p_max_stop_width_pct);
  END IF;

  -- ===== K3 v2.9 (gov 209): EXTENDED LOSS COOLDOWN ====================================
  -- Evidence 2026-08-12: five re-entries within 120h of a same-symbol losing exit, ALL five
  -- lost, -785.71 USD total, zero winners inside any such window (WMT@71h, WST@72h cross-dir,
  -- AVB@96h cross-dir, WMB@91h, WSM@114h). WST#2's prior loss exited 'manual' -> the rule
  -- counts ANY losing exit, not only stop/trail. Flags FAIL CLOSED to the extended rule;
  -- setting 24/0/0 restores the v2.2 behavior exactly. p_cooldown_hours is superseded.
  v_k3_hours       := coalesce((SELECT live_value FROM quantum.gate_config
                                WHERE gate_id = 'GATE_K' AND constant_name = 'k3_cooldown_hours'), 120);
  IF v_k3_hours <= 0 THEN v_k3_hours := 120; END IF;  -- a zero/negative flag may not silently disable K3
  v_k3_symbol_wide := coalesce((SELECT live_value FROM quantum.gate_config
                                WHERE gate_id = 'GATE_K' AND constant_name = 'k3_symbol_wide'), 1) = 1;
  v_k3_any_loss    := coalesce((SELECT live_value FROM quantum.gate_config
                                WHERE gate_id = 'GATE_K' AND constant_name = 'k3_any_loss_exit'), 1) = 1;

  IF p_symbol IS NOT NULL AND (v_k3_symbol_wide OR v_direction IS NOT NULL) THEN
    SELECT id, exit_fill_time, exit_reason, net_pnl INTO v_cooldown_hit
    FROM public.trade_ledger
    WHERE user_id = p_user_id AND mode = p_mode AND upper(symbol) = upper(p_symbol)
      AND status = 'closed' AND net_pnl < 0
      AND (v_k3_any_loss OR exit_reason IN ('stop', 'trail'))
      AND exit_fill_time >= now() - make_interval(hours => v_k3_hours::int)
      AND (v_k3_symbol_wide
           OR (CASE WHEN side IN ('buy','buy_call','sell_put') THEN 'bullish' ELSE 'bearish' END) = v_direction)
    ORDER BY exit_fill_time DESC LIMIT 1;
    IF v_cooldown_hit.id IS NOT NULL THEN
      RETURN jsonb_build_object('approved', false, 'reason', 'stop_out_cooldown', 'risk_pct', 0, 'qty', 0,
        'cooldown_hours', v_k3_hours,
        'cooldown_scope', jsonb_build_object('symbol_wide', v_k3_symbol_wide, 'any_loss_exit', v_k3_any_loss,
          'source', 'gate_config_fail_closed_120_1_1'),
        'last_stop_out', jsonb_build_object('ledger_id', v_cooldown_hit.id, 'exit_time', v_cooldown_hit.exit_fill_time,
          'exit_reason', v_cooldown_hit.exit_reason, 'net_pnl', v_cooldown_hit.net_pnl),
        'note', 'symbol closed a LOSS within the cooldown window - no revenge trades (v2.9 gov209: 120h ~ 3 sessions, symbol-wide any-direction, ANY losing exit_reason; winner exits never cool down)');
    END IF;
  ELSIF p_symbol IS NULL THEN
    v_degraded := array_append(v_degraded, 'symbol_missing_cooldown_skipped');
  END IF;

  IF p_regime_mode <> 'off' AND v_direction IS NOT NULL THEN
    SELECT trend_regime, volatility_regime, observed_at INTO v_regime
    FROM quantum.regime_state
    WHERE observed_at >= now() - make_interval(mins => p_regime_max_age_min)
    ORDER BY observed_at DESC LIMIT 1;
    IF v_regime.trend_regime IS NULL THEN
      v_degraded := array_append(v_degraded, 'regime_stale_or_missing_filter_skipped');
    ELSE
      v_regime_info := jsonb_build_object('trend', v_regime.trend_regime, 'volatility', v_regime.volatility_regime,
        'observed_at', v_regime.observed_at, 'mode', p_regime_mode);
      IF upper(v_regime.trend_regime) IN ('UP', 'RISK_ON') AND v_direction = 'bearish' THEN
        v_regime_violation := 'counter_regime_bearish_in_uptrend';
      ELSIF upper(v_regime.trend_regime) IN ('DOWN', 'RISK_OFF') AND v_direction = 'bullish' THEN
        v_regime_violation := 'counter_regime_bullish_in_downtrend';
      END IF;
      IF v_regime_violation IS NOT NULL AND p_regime_mode = 'enforce' THEN
        RETURN jsonb_build_object('approved', false, 'reason', v_regime_violation, 'risk_pct', 0, 'qty', 0,
          'regime', v_regime_info, 'note', 'week 2026-07-06 evidence: counter-regime shorts cost -485 USD realized');
      END IF;
    END IF;
  END IF;

  -- ===== R1: SHORT-SIDE BLOCK (fires before any edge measurement) =======================
  IF v_direction = 'bearish' THEN
    SELECT count(*), coalesce(sum(net_pnl) FILTER (WHERE net_pnl > 0), 0),
           coalesce(abs(sum(net_pnl) FILTER (WHERE net_pnl <= 0)), 0)
    INTO v_short_n, v_short_gw, v_short_gl
    FROM public.trade_ledger
    WHERE user_id = p_user_id AND mode = p_mode AND status = 'closed'
      AND (CASE WHEN side IN ('buy','buy_call','sell_put') THEN 'bullish' ELSE 'bearish' END) = 'bearish'
      AND (starts_with(coalesce(lineage_source,''), 'H4_') OR starts_with(coalesce(lineage_source,''), 'RECERT_'))
      AND exit_fill_time  >= now() - make_interval(days => p_lookback_days)
      AND entry_fill_time >= now() - make_interval(days => p_lookback_days)
      AND coalesce(lineage_source, '') NOT LIKE 'RECERT_QUARANTINE%'
      AND risk_amount IS NOT NULL AND risk_amount > 0
      AND intended_stop IS NOT NULL AND entry_fill_price IS NOT NULL;
    v_short_pf := CASE WHEN v_short_gl > 0 THEN round(v_short_gw / v_short_gl, 4)
                       WHEN v_short_gw > 0 THEN 999.9999 ELSE NULL END;
    v_short_block_on := coalesce((SELECT live_value FROM quantum.gate_config
                                  WHERE gate_id = 'GATE_K' AND constant_name = 'short_side_block_active'), 1) = 1;
    IF v_short_block_on AND NOT (v_short_n >= 20 AND
          ((v_short_gl > 0 AND v_short_gw / v_short_gl > 1.0) OR (v_short_gl = 0 AND v_short_gw > 0))) THEN
      RETURN jsonb_build_object('approved', false, 'reason', 'short_side_blocked_pf_below_bar',
        'risk_pct', 0, 'qty', 0, 'direction', v_direction,
        'short_side_record', jsonb_build_object('n_certified', v_short_n, 'gross_win', round(v_short_gw,2),
          'gross_loss', round(v_short_gl,2), 'dollar_pf', v_short_pf, 'sample_bar_n', 20,
          'meets_sample_bar', v_short_n >= 20, 'pf_bar', 1.0, 'meets_pf_bar', false,
          'release_at', 'certified short dollar PF > 1.0 over >= 20 trades',
          'on_release', 'block lifts automatically; restoring SIZE requires explicit Conclave re-arm'),
        'gate_version', 'GATE_K_v2.9_K3_EXTENDED_20260812',
        'note', 'Conclave 2026-08-07 R1: v2.4 x0.5 multiplier escalated to block. A 0.5x multiplier on a PF-0.28 book still bleeds, just slower.');
    END IF;
  END IF;

  SELECT risk_per_trade_pct, concentration_limit_pct INTO v_port
  FROM public.portfolios WHERE id = p_portfolio_id AND user_id = p_user_id;
  v_gate1_cap := least(coalesce(v_port.risk_per_trade_pct, 1.0), 1.0);

  -- ===== R2: DIRECTION-SCOPED EDGE MEASUREMENT ==========================================
  v_dir_scoped := coalesce((SELECT live_value FROM quantum.gate_config
                            WHERE gate_id='GATE_K' AND constant_name='direction_scoped_edge_active'), 1) = 1;
  v_dir_min    := coalesce((SELECT live_value FROM quantum.gate_config
                            WHERE gate_id='GATE_K' AND constant_name='direction_min_trades'), 20)::integer;

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
  ELSE
    v_sample_scope   := 'pooled';
    v_min_trades_eff := p_min_trades;
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
      AND intended_stop IS NOT NULL AND entry_fill_price IS NOT NULL;
  END IF;

  v_dollar_pf := CASE WHEN m.gl > 0 THEN round(m.gw / m.gl, 4)
                      WHEN m.gw > 0 THEN 999.9999 ELSE NULL END;

  IF m.n < v_min_trades_eff THEN
    v_probation := true; v_kelly_star := NULL;
    v_risk_pct := least(p_probation_risk_pct, v_gate1_cap);
  ELSE
    -- JUDGED. Dollar PF is the release metric (Conclave R3); kelly* is secondary.
    IF v_dollar_pf IS NULL OR v_dollar_pf <= 1.0 THEN
      IF coalesce(m.a,0) > 0 AND coalesce(m.b,0) > 0 THEN
        v_kelly_star := (m.wins / m.n) / m.a - (1 - m.wins / m.n) / m.b;
      END IF;
      RETURN jsonb_build_object('approved', false, 'reason', 'negative_measured_edge',
        'risk_pct', 0, 'qty', 0, 'direction', v_direction,
        'metrics', jsonb_build_object('n_trades', m.n, 'win_rate', round(m.wins / m.n, 4),
          'avg_win_r', round(m.b, 4), 'avg_loss_r', round(m.a, 4), 'kelly_star', round(v_kelly_star, 4),
          'dollar_pf', v_dollar_pf, 'gross_win', round(m.gw,2), 'gross_loss', round(m.gl,2),
          'sample_scope', v_sample_scope, 'min_trades', v_min_trades_eff,
          'sample_version', 'R3_PROVENANCE_CLEANED_20260807'),
        'gate_version', 'GATE_K_v2.9_K3_EXTENDED_20260812');
    END IF;
    IF coalesce(m.a, 0) <= 0 OR coalesce(m.b, 0) <= 0 THEN
      v_probation := true; v_kelly_star := NULL;
      v_risk_pct := least(p_probation_risk_pct, v_gate1_cap);
    ELSE
      v_kelly_star := (m.wins / m.n) / m.a - (1 - m.wins / m.n) / m.b;
      IF v_kelly_star <= 0 THEN
        -- dollar PF clears but distorted-R kelly does not: trade it SMALL, do not size on kelly
        v_probation := true;
        v_risk_pct := least(p_probation_risk_pct, v_gate1_cap);
        v_degraded := array_append(v_degraded, 'dollar_pf_positive_but_kelly_negative_probation_sized');
      ELSE
        v_risk_pct := least(p_kelly_fraction * v_kelly_star * 100, v_gate1_cap);
      END IF;
    END IF;
  END IF;

  -- ===== FAIL-CLOSED FOR SHORTS: a bearish direction may NEVER resume via probation. =====
  -- This is the seal on the "both-directions-to-probation re-enables the short book" mode.
  IF v_direction = 'bearish' AND v_probation THEN
    RETURN jsonb_build_object('approved', false, 'reason', 'short_side_probation_forbidden',
      'risk_pct', 0, 'qty', 0, 'direction', v_direction,
      'metrics', jsonb_build_object('n_trades', m.n, 'dollar_pf', v_dollar_pf,
        'sample_scope', v_sample_scope, 'min_trades', v_min_trades_eff),
      'gate_version', 'GATE_K_v2.9_K3_EXTENDED_20260812',
      'note', 'Conclave 2026-08-07: shorts must EARN their way back over >=20 certified trades at dollar PF>1.0. They may never default in on small-sample probation sizing.');
  END IF;

  v_dd := coalesce(public.portfolio_drawdown_pct(p_portfolio_id, p_mode, p_equity), 0);
  v_dd_mult := CASE WHEN v_dd < 5 THEN 1.00 WHEN v_dd < 8 THEN 0.60 WHEN v_dd < 12 THEN 0.35 ELSE 0.00 END;
  IF v_dd_mult = 0 THEN
    RETURN jsonb_build_object('approved', false, 'halted', true, 'reason', 'drawdown_halt', 'risk_pct', 0, 'qty', 0,
      'drawdown_pct', v_dd,
      'note', 'Peak-to-trough >= 12%. No new entries until equity recovers or halt is manually reviewed.');
  END IF;
  v_risk_pct := round(v_risk_pct * v_dd_mult, 4);

  IF v_direction = 'bearish' THEN
    IF NOT (v_short_n >= 20 AND
            ((v_short_gl > 0 AND v_short_gw / v_short_gl > 1.0) OR (v_short_gl = 0 AND v_short_gw > 0))) THEN
      v_short_mult := 0.5;
      v_risk_pct := round(v_risk_pct * v_short_mult, 4);
    END IF;
  END IF;

  v_risk_dollars := round(p_equity * v_risk_pct / 100, 2);
  v_rps := abs(p_entry - p_stop);
  v_qty := floor(v_risk_dollars / v_rps);
  IF v_qty < 1 THEN
    RETURN jsonb_build_object('approved', false, 'reason', 'position_too_small_for_risk_budget',
      'risk_pct', v_risk_pct, 'risk_dollars', v_risk_dollars, 'qty', 0);
  END IF;

  v_conc_pct := least(coalesce(v_port.concentration_limit_pct, 25), 25);
  v_max_qty := floor((p_equity * v_conc_pct / 100) / p_entry);
  IF v_max_qty < 1 THEN
    RETURN jsonb_build_object('approved', false, 'reason', 'concentration_cap_zero_qty',
      'risk_pct', v_risk_pct, 'qty', 0, 'concentration_limit_pct', v_conc_pct);
  END IF;
  IF v_qty > v_max_qty THEN v_qty := v_max_qty; v_conc_capped := true; END IF;

  RETURN jsonb_build_object(
    'approved', true,
    'reason', CASE WHEN v_probation THEN 'probation_sizing_insufficient_sample' ELSE 'fractional_kelly' END,
    'risk_pct', v_risk_pct, 'risk_dollars', v_risk_dollars, 'qty', v_qty,
    'drawdown_pct', v_dd, 'dd_multiplier', v_dd_mult, 'probation', v_probation,
    'probation_pin', CASE WHEN v_min_trades_eff > p_min_trades THEN 'PIN_PROBATION_20260805_measurement_not_certified' END,
    'short_risk_mult', v_short_mult,
    'short_side_record', CASE WHEN v_direction = 'bearish' THEN jsonb_build_object(
      'n_certified', v_short_n, 'pf_certified', v_short_pf,
      'release_at', 'pf>1.0 over >=20 certified shorts') END,
    'confidence_echo', p_confidence, 'direction', v_direction, 'stop_width_pct', v_width_pct,
    'regime', v_regime_info,
    'regime_shadow_violation', CASE WHEN p_regime_mode = 'shadow' THEN v_regime_violation END,
    'degraded', CASE WHEN array_length(v_degraded, 1) > 0 THEN to_jsonb(v_degraded) END,
    'gate_version', 'GATE_K_v2.9_K3_EXTENDED_20260812',
    'concentration', jsonb_build_object('limit_pct', v_conc_pct, 'capped', v_conc_capped,
      'notional', round(v_qty * p_entry, 2)),
    'metrics', jsonb_build_object('n_trades', m.n,
      'win_rate', CASE WHEN m.n > 0 THEN round(m.wins / m.n, 4) END,
      'avg_win_r', round(m.b, 4), 'avg_loss_r', round(m.a, 4), 'kelly_star', round(v_kelly_star, 4),
      'dollar_pf', v_dollar_pf, 'gross_win', round(m.gw, 2), 'gross_loss', round(m.gl, 2),
      'sample_scope', v_sample_scope, 'sample_version', 'R3_PROVENANCE_CLEANED_20260807',
      'kelly_fraction', p_kelly_fraction, 'gate1_cap_pct', v_gate1_cap,
      'lookback_days', p_lookback_days, 'min_trades', v_min_trades_eff))::jsonb;
END;
$function$
