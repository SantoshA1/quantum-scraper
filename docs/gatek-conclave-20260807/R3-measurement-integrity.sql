-- ═══════════════════════════════════════════════════════════════════════════════
-- R3 — MEASUREMENT INTEGRITY   (Conclave ruling 2026-08-07, ship FIRST)
-- migration: qtp_gatek_r3_measurement_integrity_20260807
-- rollback:  GATE_K_v2.5_CERTIFIED_UNPIN_20260805, pg_get_functiondef md5 0303bc25e50d77aee86eee74cbce2dc0
--
-- The Conclave moved R3 ahead of R1/R2 (the brief had it last) so that R1's release
-- condition and R2's per-direction verdicts are both computed on honest numbers.
-- R3 makes the measured edge MORE negative (-0.11 -> -0.51 blended), which is exactly
-- why running it first is safe and provably not self-serving: it cannot be an attempt
-- to manufacture a resume.
--
-- THREE DEFECTS FIXED, all filtered strictly on PROVENANCE, never on outcome:
--
--  (1) QUARANTINE LEAK. The short-side leg already filters lineage; the main edge calc
--      did not. A row the Conclave had already quarantined (LDOS, +10.2174R) was the
--      single largest contributor to avg_win_r. Excluded via 'RECERT_QUARANTINE%' —
--      the precise prefix, NOT a broad 'RECERT%' match which would discard every valid
--      certified row (the Conclave warned about exactly this over-broad match).
--
--  (2) ENTRY-DATE LEAK. The window bounded exit_fill_time only, so positions ENTERED in
--      a prior regime leaked in (AFL 2026-04-09, LDOS 2026-04-23). Now bounded on BOTH
--      entry_fill_time and exit_fill_time.
--
--  (3) UNRECONSTRUCTABLE RISK BASIS. Implied risk bases span 170x ($3.60 -> $623), and
--      avg_win_r is a plain average of exactly those non-comparable numbers. Rows whose
--      risk basis cannot be reconstructed from actual fills are QUARANTINED, never
--      imputed. Measured: exactly 2 rows qualify (AFL, LDOS — both missing intended_stop),
--      and both are already removed by (1) and (2). Belt-and-braces for future rows;
--      changes nothing today. NOTE: 12 further rows differ >10% between stored
--      risk_amount and fill-implied risk — that is ordinary signal-to-fill slippage and
--      they are deliberately KEPT. Discarding them would be the over-broad filter the
--      Conclave forbade.
--
-- METRIC CHANGE: dollar profit factor is now computed alongside kelly* and is the
-- gate-release metric; kelly* is retained as a secondary read. Dollar PF is immune to
-- the R-comparability defect in (3), which is why the Conclave elevated it.
-- (Interpretation note for the record: the ruling says "Dollar PF is the gate-release
-- metric; kelly* secondary". This migration therefore computes both and REPORTS both,
-- but R3 alone changes no decision — the release logic moves in R1/R2. If the Conclave
-- intended kelly* to remain co-blocking, that is a one-line change here.)
--
-- UNCHANGED: every other gate leg (input guards, stop-side, stop-width sanity, cooldown,
-- regime filter, Gate-1 cap, drawdown de-lever, 12% halt, concentration cap, verdict shape).
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.compute_kelly_gate(
  p_user_id uuid, p_portfolio_id uuid, p_strategy text, p_mode text,
  p_equity numeric, p_entry numeric, p_stop numeric,
  p_confidence numeric DEFAULT NULL::numeric, p_side text DEFAULT NULL::text,
  p_symbol text DEFAULT NULL::text, p_lookback_days integer DEFAULT 90,
  p_min_trades integer DEFAULT 40, p_probation_risk_pct numeric DEFAULT 0.50,
  p_kelly_fraction numeric DEFAULT 0.25, p_regime_mode text DEFAULT 'enforce'::text,
  p_max_stop_width_pct numeric DEFAULT 5.0, p_cooldown_hours integer DEFAULT 24,
  p_regime_max_age_min integer DEFAULT 90)
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
  v_dollar_pf    numeric;                          -- R3: primary release metric
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

  -- ---- CERTIFIED_UNPIN_20260805 (Conclave ruling step 5) ------------------------
  v_min_trades_eff := p_min_trades;  -- UNPINNED 2026-08-05 (governance 185)

  -- ═══ R3 (Conclave 2026-08-07): measured edge on a PROVENANCE-CLEANED sample ═══
  -- Adds vs v2.5: quarantine-lineage exclusion, entry-bounded window, unreconstructable
  -- risk-basis quarantine, and gross win/loss so dollar PF can be computed.
  SELECT count(*)                                            AS n,
         count(*) FILTER (WHERE net_pnl > 0)::numeric        AS wins,
         avg(r_multiple)     FILTER (WHERE r_multiple > 0)   AS b,
         abs(avg(r_multiple) FILTER (WHERE r_multiple <= 0)) AS a,
         coalesce(sum(net_pnl) FILTER (WHERE net_pnl > 0), 0)        AS gw,
         coalesce(abs(sum(net_pnl) FILTER (WHERE net_pnl <= 0)), 0)  AS gl
  INTO m
  FROM public.trade_ledger
  WHERE user_id = p_user_id
    AND strategy = p_strategy
    AND mode = p_mode
    AND status = 'closed'
    AND r_multiple IS NOT NULL
    AND exit_fill_time >= now() - make_interval(days => p_lookback_days)
    -- R3(2): bound the window on ENTRY as well as exit — no prior-regime leakage
    AND entry_fill_time >= now() - make_interval(days => p_lookback_days)
    -- R3(1): exclude already-quarantined lineage (precise prefix, consistent w/ short leg)
    AND coalesce(lineage_source, '') NOT LIKE 'RECERT_QUARANTINE%'
    -- R3(3): quarantine rows whose risk basis cannot be reconstructed from actual fills
    AND risk_amount IS NOT NULL AND risk_amount > 0
    AND intended_stop IS NOT NULL AND entry_fill_price IS NOT NULL;

  -- R3: dollar profit factor — immune to the 170x risk-basis spread that distorts R
  v_dollar_pf := CASE WHEN m.gl > 0 THEN round(m.gw / m.gl, 4)
                      WHEN m.gw > 0 THEN 999.9999
                      ELSE NULL END;

  IF m.n < v_min_trades_eff THEN
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
            'kelly_star', round(v_kelly_star, 4),
            'dollar_pf', v_dollar_pf, 'gross_win', round(m.gw,2), 'gross_loss', round(m.gl,2),
            'sample_version', 'R3_PROVENANCE_CLEANED_20260807'));
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

  -- ---- v2.4: governed short-side risk multiplier (Conclave 2026-08-05, item 2) --
  IF v_direction = 'bearish' THEN
    SELECT count(*),
           coalesce(sum(net_pnl) FILTER (WHERE net_pnl > 0), 0),
           coalesce(abs(sum(net_pnl) FILTER (WHERE net_pnl <= 0)), 0)
    INTO v_short_n, v_short_gw, v_short_gl
    FROM public.trade_ledger
    WHERE user_id = p_user_id AND mode = p_mode AND status = 'closed'
      AND (CASE WHEN side IN ('buy','buy_call','sell_put') THEN 'bullish' ELSE 'bearish' END) = 'bearish'
      AND (starts_with(coalesce(lineage_source,''), 'H4_') OR starts_with(coalesce(lineage_source,''), 'RECERT_'))
      AND exit_fill_time >= now() - make_interval(days => p_lookback_days);
    IF NOT (v_short_n >= 20 AND
            ((v_short_gl > 0 AND v_short_gw / v_short_gl > 1.0)
             OR (v_short_gl = 0 AND v_short_gw > 0))) THEN
      v_short_mult := 0.5;
      v_risk_pct := round(v_risk_pct * v_short_mult, 4);
    END IF;
  END IF;

  -- ---- Dollars and quantity -------------------------------------------------------
  v_risk_dollars := round(p_equity * v_risk_pct / 100, 2);
  v_rps := abs(p_entry - p_stop);
  v_qty := floor(v_risk_dollars / v_rps);

  IF v_qty < 1 THEN
    RETURN jsonb_build_object(
      'approved', false, 'reason', 'position_too_small_for_risk_budget',
      'risk_pct', v_risk_pct, 'risk_dollars', v_risk_dollars, 'qty', 0);
  END IF;

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
    'probation_pin', CASE WHEN v_min_trades_eff > p_min_trades THEN 'PIN_PROBATION_20260805_measurement_not_certified' END,
    'short_risk_mult', v_short_mult,
    'short_side_record', CASE WHEN v_direction = 'bearish' THEN jsonb_build_object(
      'n_certified', v_short_n,
      'pf_certified', CASE WHEN v_short_gl > 0 THEN round(v_short_gw / v_short_gl, 2) END,
      'release_at', 'pf>1.0 over >=20 certified shorts') END,
    'confidence_echo', p_confidence,
    'direction', v_direction,
    'stop_width_pct', v_width_pct,
    'regime', v_regime_info,
    'regime_shadow_violation', CASE WHEN p_regime_mode = 'shadow' THEN v_regime_violation END,
    'degraded', CASE WHEN array_length(v_degraded, 1) > 0 THEN to_jsonb(v_degraded) END,
    'gate_version', 'GATE_K_v2.6_R3_MEASUREMENT_INTEGRITY_20260807',
    'concentration', jsonb_build_object('limit_pct', v_conc_pct, 'capped', v_conc_capped,
      'notional', round(v_qty * p_entry, 2)),
    'metrics', jsonb_build_object(
      'n_trades', m.n,
      'win_rate', CASE WHEN m.n > 0 THEN round(m.wins / m.n, 4) END,
      'avg_win_r', round(m.b, 4),
      'avg_loss_r', round(m.a, 4),
      'kelly_star', round(v_kelly_star, 4),
      'dollar_pf', v_dollar_pf,
      'gross_win', round(m.gw, 2),
      'gross_loss', round(m.gl, 2),
      'sample_version', 'R3_PROVENANCE_CLEANED_20260807',
      'kelly_fraction', p_kelly_fraction,
      'gate1_cap_pct', v_gate1_cap,
      'lookback_days', p_lookback_days,
      'min_trades', v_min_trades_eff))::jsonb;
END;
$function$;
