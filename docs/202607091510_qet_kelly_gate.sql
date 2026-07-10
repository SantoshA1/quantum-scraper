-- ============================================================================
-- 202607091510_qet_kelly_gate.sql
-- Fractional-Kelly Sizing Gate (Gate K)
--
-- Hardens Gate 1 (1% rule). It can only REDUCE risk below the Gate-1 cap,
-- never raise it. Sizing derives exclusively from MEASURED live/paper edge
-- in trade_ledger — never from backtests, never from conviction.
--
-- Policy encoded here:
--   * < min sample (default 40 closed trades / 90d): probation risk 0.50%
--   * kelly_star <= 0 (measured negative edge): REJECT, risk 0
--   * else risk = min( 0.25 * kelly_star , portfolio.risk_per_trade_pct , 1% )
--   * drawdown de-lever (from pnl_snapshots peak):
--       dd <  5%  -> x1.00      5-8%  -> x0.60
--       8-12%     -> x0.35      >=12% -> x0     (HALT — no new trades)
--
-- PREREQUISITE: 202607091500_qet_edge_ledger.sql
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Drawdown helper — trailing peak-to-current drawdown from pnl_snapshots.
--    p_current_equity comes from Alpaca /v2/account at call time (n8n Gate 1
--    already fetches it), so the DD check is against LIVE equity, not a stale
--    snapshot.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.portfolio_drawdown_pct(
  p_portfolio_id   uuid,
  p_mode           text,
  p_current_equity numeric,
  p_lookback_days  integer DEFAULT 90
) RETURNS numeric
LANGUAGE sql STABLE AS $$
  SELECT round(
    greatest(0, (max(equity) - p_current_equity) / nullif(max(equity), 0)) * 100
  , 3)
  FROM public.pnl_snapshots
  WHERE portfolio_id = p_portfolio_id
    AND mode = p_mode
    AND captured_at >= now() - make_interval(days => p_lookback_days);
$$;

COMMENT ON FUNCTION public.portfolio_drawdown_pct IS
  'Trailing peak-to-live-equity drawdown %. NULL if no snapshots exist yet (treated as 0 by the gate, flagged in output).';

-- ----------------------------------------------------------------------------
-- 2. The gate. Returns a jsonb verdict the n8n Risk Gate consumes verbatim.
--    Called via PostgREST RPC with the service role from n8n.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.compute_kelly_gate(
  p_user_id            uuid,
  p_portfolio_id       uuid,
  p_strategy           text,
  p_mode               text,          -- 'paper' | 'live'
  p_equity             numeric,       -- live equity from Alpaca /v2/account
  p_entry              numeric,
  p_stop               numeric,
  p_confidence         numeric DEFAULT NULL,   -- echoed for audit; not used in sizing
  p_lookback_days      integer DEFAULT 90,
  p_min_trades         integer DEFAULT 40,
  p_probation_risk_pct numeric DEFAULT 0.50,   -- % of equity while sample is small
  p_kelly_fraction     numeric DEFAULT 0.25    -- quarter-Kelly
) RETURNS jsonb
LANGUAGE plpgsql STABLE AS $$
DECLARE
  m              record;      -- measured edge metrics
  v_port         record;
  v_dd           numeric;
  v_dd_mult      numeric;
  v_gate1_cap    numeric;     -- Gate-1 ceiling (portfolio override, hard cap 1.0)
  v_kelly_star   numeric;
  v_risk_pct     numeric;
  v_risk_dollars numeric;
  v_qty          numeric;
  v_probation    boolean := false;
  v_rps          numeric;     -- risk per share
BEGIN
  -- ---- Input guards ---------------------------------------------------------
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

  -- ---- Gate-1 ceiling -------------------------------------------------------
  SELECT risk_per_trade_pct INTO v_port
  FROM public.portfolios WHERE id = p_portfolio_id AND user_id = p_user_id;
  v_gate1_cap := least(coalesce(v_port.risk_per_trade_pct, 1.0), 1.0);

  -- ---- Measured edge for THIS strategy in THIS mode -------------------------
  SELECT count(*)                                            AS n,
         count(*) FILTER (WHERE net_pnl > 0)::numeric        AS wins,
         avg(r_multiple)     FILTER (WHERE r_multiple > 0)   AS b,   -- avg win (R)
         abs(avg(r_multiple) FILTER (WHERE r_multiple <= 0)) AS a    -- avg loss (R)
  INTO m
  FROM public.trade_ledger
  WHERE user_id = p_user_id
    AND strategy = p_strategy
    AND mode = p_mode
    AND status = 'closed'
    AND r_multiple IS NOT NULL
    AND exit_fill_time >= now() - make_interval(days => p_lookback_days);

  -- ---- Base risk % ----------------------------------------------------------
  IF m.n < p_min_trades THEN
    -- Not enough evidence to size off Kelly: probation sizing. Measure first.
    v_probation := true;
    v_kelly_star := NULL;
    v_risk_pct := least(p_probation_risk_pct, v_gate1_cap);
  ELSE
    -- Discrete Kelly on R-multiples: f* = W/a - (1-W)/b
    IF coalesce(m.a, 0) <= 0 OR coalesce(m.b, 0) <= 0 THEN
      -- No losses yet (a=0) or no wins yet (b=0) in window: too degenerate to trust
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
      -- fractional Kelly, capped by Gate 1
      v_risk_pct := least(p_kelly_fraction * v_kelly_star * 100, v_gate1_cap);
    END IF;
  END IF;

  -- ---- Drawdown de-lever ----------------------------------------------------
  v_dd := coalesce(
    public.portfolio_drawdown_pct(p_portfolio_id, p_mode, p_equity), 0);
  v_dd_mult := CASE
    WHEN v_dd < 5  THEN 1.00
    WHEN v_dd < 8  THEN 0.60
    WHEN v_dd < 12 THEN 0.35
    ELSE 0.00   -- HALT
  END;

  IF v_dd_mult = 0 THEN
    RETURN jsonb_build_object(
      'approved', false, 'halted', true, 'reason', 'drawdown_halt',
      'risk_pct', 0, 'qty', 0,
      'drawdown_pct', v_dd,
      'note', 'Peak-to-trough >= 12%. No new entries until equity recovers or halt is manually reviewed.');
  END IF;

  v_risk_pct := round(v_risk_pct * v_dd_mult, 4);

  -- ---- Dollars and quantity -------------------------------------------------
  v_risk_dollars := round(p_equity * v_risk_pct / 100, 2);
  v_rps := abs(p_entry - p_stop);
  v_qty := floor(v_risk_dollars / v_rps);

  IF v_qty < 1 THEN
    RETURN jsonb_build_object(
      'approved', false, 'reason', 'position_too_small_for_risk_budget',
      'risk_pct', v_risk_pct, 'risk_dollars', v_risk_dollars, 'qty', 0);
  END IF;

  -- ---- Verdict ----------------------------------------------------------------
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
$$;

COMMENT ON FUNCTION public.compute_kelly_gate IS
  'Gate K: fractional-Kelly sizing from measured trade_ledger edge. Only ever tightens Gate 1. Returns jsonb verdict for the n8n Risk Gate. Store the full output in trade_ledger.sizing_meta.';

-- Frontend may preview sizing read-only; execution always goes through n8n.
GRANT EXECUTE ON FUNCTION public.compute_kelly_gate TO authenticated;
GRANT EXECUTE ON FUNCTION public.portfolio_drawdown_pct TO authenticated;

-- Security hardening (advisor remediation, applied to qtp_prod 2026-07-09)
ALTER FUNCTION public.portfolio_drawdown_pct(uuid, text, numeric, integer) SET search_path = '';
ALTER FUNCTION public.compute_kelly_gate(uuid, uuid, text, text, numeric, numeric, numeric, numeric, integer, integer, numeric, numeric) SET search_path = '';
