-- GATE_K_v2.3_K1_REGIME_LABELS_20260805 — PO-authorized 2026-08-05 ('go with the mapping inside the gate').
-- One block changed vs v2.2: K1 regime filter now maps the labels the Regime Service
-- actually emits — RISK_ON blocks bearish entries, RISK_OFF blocks bullish entries,
-- CHOP blocks nothing; 'UP'/'DOWN' remain honored for forward-compat.
-- Evidence: quantum.regime_state has only ever stored CHOP(175)/RISK_ON(48)/RISK_OFF(28);
-- 'UP'/'DOWN' never existed, so K1 had NEVER fired despite the -$485 counter-regime-shorts
-- receipt (week of 2026-07-06). Reason strings unchanged (no consumer ever saw them).
-- Guard suite: tests/test-k1-regime.js (13/13). K3 loss-only predicate (v2.2) untouched.
-- Rollback: re-apply migration qtp_gate_k_v2_2_k3_loss_only_20260805.
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
  v_direction    text;      -- bullish | bearish | NULL (unknown)
  v_width_pct    numeric;
  v_cooldown_hit record;
  v_degraded     text[] := ARRAY[]::text[];
  v_regime_info  jsonb := NULL;
  v_regime_violation text := NULL;
BEGIN
  -- ---- Basic input guards ---------------------------------------------------
  IF p_stop IS NULL OR p_entry IS NULL OR p_entry = p_stop THEN
    RETURN jsonb_build_object('approved', false, 'reason', 'missing_or_degenerate_stop',
                              'risk_pct', 0, 'qty', 0);
  END IF;
  IF p_equity IS NULL OR p_equity <= 0 THEN
    RETURN jsonb_build_object('approved', false, 'reason', 'invalid_equity',
                              'risk_pct', 0, 'qty', 0);
  END IF;
  IF p_mode NOT IN ('paper', 'live') THEN
    RETURN jsonb_build_object('approved', false, 'reason', 'invalid_mode',
                              'risk_pct', 0, 'qty', 0);
  END IF;

  -- ---- Direction classification (v2) ----------------------------------------
  v_direction := CASE
    WHEN p_side IN ('buy', 'buy_call', 'sell_put') THEN 'bullish'
    WHEN p_side IN ('sell', 'sell_call', 'buy_put') THEN 'bearish'
    ELSE NULL
  END;
  IF v_direction IS NULL THEN
    v_degraded := array_append(v_degraded, 'side_missing_direction_checks_skipped');
  END IF;

  -- ---- FIX 2a: stop must protect (correct side of entry) ---------------------
  IF v_direction = 'bullish' AND p_stop >= p_entry THEN
    RETURN jsonb_build_object('approved', false, 'reason', 'stop_wrong_side_of_entry',
      'risk_pct', 0, 'qty', 0,
      'note', 'bullish entry requires stop BELOW entry; got stop ' || p_stop || ' vs entry ' || p_entry);
  END IF;
  IF v_direction = 'bearish' AND p_stop <= p_entry THEN
    RETURN jsonb_build_object('approved', false, 'reason', 'stop_wrong_side_of_entry',
      'risk_pct', 0, 'qty', 0,
      'note', 'bearish entry requires stop ABOVE entry; got stop ' || p_stop || ' vs entry ' || p_entry);
  END IF;

  -- ---- FIX 2b: stop width sanity ---------------------------------------------
  v_width_pct := round(abs(p_entry - p_stop) / p_entry * 100, 3);
  IF v_width_pct > p_max_stop_width_pct THEN
    RETURN jsonb_build_object('approved', false, 'reason', 'stop_width_exceeds_sanity',
      'risk_pct', 0, 'qty', 0,
      'stop_width_pct', v_width_pct, 'max_allowed_pct', p_max_stop_width_pct);
  END IF;

  -- ---- FIX 3: stop-out cooldown (v2.2: LOSS exits only) ------------------------
  IF p_symbol IS NOT NULL AND v_direction IS NOT NULL THEN
    SELECT id, exit_fill_time, exit_reason, net_pnl INTO v_cooldown_hit
    FROM public.trade_ledger
    WHERE user_id = p_user_id
      AND mode = p_mode
      AND upper(symbol) = upper(p_symbol)
      AND status = 'closed'
      AND exit_reason IN ('stop', 'trail')
      AND net_pnl < 0
      AND exit_fill_time >= now() - make_interval(hours => p_cooldown_hours)
      AND (CASE WHEN side IN ('buy','buy_call','sell_put') THEN 'bullish' ELSE 'bearish' END) = v_direction
    ORDER BY exit_fill_time DESC LIMIT 1;
    IF v_cooldown_hit.id IS NOT NULL THEN
      RETURN jsonb_build_object('approved', false, 'reason', 'stop_out_cooldown',
        'risk_pct', 0, 'qty', 0,
        'cooldown_hours', p_cooldown_hours,
        'last_stop_out', jsonb_build_object('ledger_id', v_cooldown_hit.id,
          'exit_time', v_cooldown_hit.exit_fill_time, 'exit_reason', v_cooldown_hit.exit_reason,
          'net_pnl', v_cooldown_hit.net_pnl),
        'note', 'same symbol+direction stopped out AT A LOSS within cooldown window - no revenge trades (v2.2: winner exits never cool down)');
    END IF;
  ELSIF p_symbol IS NULL THEN
    v_degraded := array_append(v_degraded, 'symbol_missing_cooldown_skipped');
  END IF;

  -- ---- FIX 1: regime filter (v2.3: RISK_ON/RISK_OFF labels mapped) ----------------------------------------------------
  IF p_regime_mode <> 'off' AND v_direction IS NOT NULL THEN
    SELECT trend_regime, volatility_regime, observed_at INTO v_regime
    FROM quantum.regime_state
    WHERE observed_at >= now() - make_interval(mins => p_regime_max_age_min)
    ORDER BY observed_at DESC LIMIT 1;
    IF v_regime.trend_regime IS NULL THEN
      v_degraded := array_append(v_degraded, 'regime_stale_or_missing_filter_skipped');
    ELSE
      v_regime_info := jsonb_build_object('trend', v_regime.trend_regime,
        'volatility', v_regime.volatility_regime, 'observed_at', v_regime.observed_at,
        'mode', p_regime_mode);
      IF upper(v_regime.trend_regime) IN ('UP', 'RISK_ON') AND v_direction = 'bearish' THEN
        v_regime_violation := 'counter_regime_bearish_in_uptrend';
      ELSIF upper(v_regime.trend_regime) IN ('DOWN', 'RISK_OFF') AND v_direction = 'bullish' THEN
        v_regime_violation := 'counter_regime_bullish_in_downtrend';
      END IF;
      IF v_regime_violation IS NOT NULL AND p_regime_mode = 'enforce' THEN
        RETURN jsonb_build_object('approved', false, 'reason', v_regime_violation,
          'risk_pct', 0, 'qty', 0, 'regime', v_regime_info,
          'note', 'week 2026-07-06 evidence: counter-regime shorts cost -485 USD realized');
      END IF;
    END IF;
  END IF;

  -- ---- Gate-1 ceiling ---------------------------------------------------------
  SELECT risk_per_trade_pct, concentration_limit_pct INTO v_port
  FROM public.portfolios WHERE id = p_portfolio_id AND user_id = p_user_id;
  v_gate1_cap := least(coalesce(v_port.risk_per_trade_pct, 1.0), 1.0);

  -- ---- Measured edge for THIS strategy in THIS mode ----------------------------
  SELECT count(*)                                            AS n,
         count(*) FILTER (WHERE net_pnl > 0)::numeric        AS wins,
         avg(r_multiple)     FILTER (WHERE r_multiple > 0)   AS b,
         abs(avg(r_multiple) FILTER (WHERE r_multiple <= 0)) AS a
  INTO m
  FROM public.trade_ledger
  WHERE user_id = p_user_id
    AND strategy = p_strategy
    AND mode = p_mode
    AND status = 'closed'
    AND r_multiple IS NOT NULL
    AND exit_fill_time >= now() - make_interval(days => p_lookback_days);

  IF m.n < p_min_trades THEN
    v_probation := true;
    v_kelly_star := NULL;
    v_risk_pct := least(p_probation_risk_pct, v_gate1_cap);
  ELSE
    IF coalesce(m.a, 0) <= 0 OR coalesce(m.b, 0) <= 0 THEN
      v_probation := true;
      v_kelly_star := NULL;
      v_risk_pct := least(p_probation_risk_pct, v_gate1_cap);
    ELSE
      v_kelly_star := (m.wins / m.n) / m.a - (1 - m.wins / m.n) / m.b;
      IF v_kelly_star <= 0 THEN
        RETURN jsonb_build_object(
          'approved', false, 'reason', 'negative_measured_edge',
          'risk_pct', 0, 'qty', 0,
          'metrics', jsonb_build_object(
            'n_trades', m.n, 'win_rate', round(m.wins / m.n, 4),
            'avg_win_r', round(m.b, 4), 'avg_loss_r', round(m.a, 4),
            'kelly_star', round(v_kelly_star, 4)));
      END IF;
      v_risk_pct := least(p_kelly_fraction * v_kelly_star * 100, v_gate1_cap);
    END IF;
  END IF;

  -- ---- Drawdown de-lever --------------------------------------------------------
  v_dd := coalesce(
    public.portfolio_drawdown_pct(p_portfolio_id, p_mode, p_equity), 0);
  v_dd_mult := CASE
    WHEN v_dd < 5  THEN 1.00
    WHEN v_dd < 8  THEN 0.60
    WHEN v_dd < 12 THEN 0.35
    ELSE 0.00
  END;

  IF v_dd_mult = 0 THEN
    RETURN jsonb_build_object(
      'approved', false, 'halted', true, 'reason', 'drawdown_halt',
      'risk_pct', 0, 'qty', 0,
      'drawdown_pct', v_dd,
      'note', 'Peak-to-trough >= 12%. No new entries until equity recovers or halt is manually reviewed.');
  END IF;

  v_risk_pct := round(v_risk_pct * v_dd_mult, 4);

  -- ---- Dollars and quantity -------------------------------------------------------
  v_risk_dollars := round(p_equity * v_risk_pct / 100, 2);
  v_rps := abs(p_entry - p_stop);
  v_qty := floor(v_risk_dollars / v_rps);

  IF v_qty < 1 THEN
    RETURN jsonb_build_object(
      'approved', false, 'reason', 'position_too_small_for_risk_budget',
      'risk_pct', v_risk_pct, 'risk_dollars', v_risk_dollars, 'qty', 0);
  END IF;

  -- v2.1: concentration cap — notional may not exceed concentration_limit_pct of equity
  v_conc_pct := least(coalesce(v_port.concentration_limit_pct, 25), 25);
  v_max_qty := floor((p_equity * v_conc_pct / 100) / p_entry);
  IF v_max_qty < 1 THEN
    RETURN jsonb_build_object(
      'approved', false, 'reason', 'concentration_cap_zero_qty',
      'risk_pct', v_risk_pct, 'qty', 0,
      'concentration_limit_pct', v_conc_pct);
  END IF;
  IF v_qty > v_max_qty THEN
    v_qty := v_max_qty;
    v_conc_capped := true;
  END IF;

  -- ---- Verdict -----------------------------------------------------------------------
  RETURN jsonb_build_object(
    'approved', true,
    'reason', CASE WHEN v_probation THEN 'probation_sizing_insufficient_sample'
                   ELSE 'fractional_kelly' END,
    'risk_pct', v_risk_pct,
    'risk_dollars', v_risk_dollars,
    'qty', v_qty,
    'drawdown_pct', v_dd,
    'dd_multiplier', v_dd_mult,
    'probation', v_probation,
    'confidence_echo', p_confidence,
    'direction', v_direction,
    'stop_width_pct', v_width_pct,
    'regime', v_regime_info,
    'regime_shadow_violation', CASE WHEN p_regime_mode = 'shadow' THEN v_regime_violation END,
    'degraded', CASE WHEN array_length(v_degraded, 1) > 0 THEN to_jsonb(v_degraded) END,
    'gate_version', 'GATE_K_v2.3_K1_REGIME_LABELS_20260805',
    'concentration', jsonb_build_object('limit_pct', v_conc_pct, 'capped', v_conc_capped,
      'notional', round(v_qty * p_entry, 2)),
    'metrics', jsonb_build_object(
      'n_trades', m.n,
      'win_rate', CASE WHEN m.n > 0 THEN round(m.wins / m.n, 4) END,
      'avg_win_r', round(m.b, 4),
      'avg_loss_r', round(m.a, 4),
      'kelly_star', round(v_kelly_star, 4),
      'kelly_fraction', p_kelly_fraction,
      'gate1_cap_pct', v_gate1_cap,
      'lookback_days', p_lookback_days,
      'min_trades', p_min_trades));
END;
$function$;