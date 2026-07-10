-- ============================================================================
-- 202607091500_qet_edge_ledger.sql
-- QET Edge-Measurement Ledger
--
-- Purpose: one row per trade, from intent to cost-survived P&L.
--   signal -> intended price -> actual fill -> slippage -> fees -> net P&L -> R
-- This is the evidence base for the fractional-Kelly gate (next migration).
-- No sizing decision is ever made from backtest numbers — only from this table.
--
-- PREREQUISITE: canonical QET bootstrap must exist first
--   (set_updated_at(), portfolios, signals, positions, audit_log, pnl_snapshots).
--   NOTE: as of 2026-07-09 qtp_prod public schema is EMPTY — apply the
--   bootstrap migration before this one.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. trade_ledger — append-mostly. Row created on entry fill (hook H3),
--    completed on exit fill (hook H4). Never deleted.
-- ----------------------------------------------------------------------------
CREATE TABLE public.trade_ledger (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  portfolio_id        uuid REFERENCES public.portfolios(id),
  signal_id           uuid REFERENCES public.signals(id),
  position_id         uuid REFERENCES public.positions(id),

  -- Attribution: edge is measured PER STRATEGY, never blended.
  strategy            text NOT NULL,
  mode                text NOT NULL CHECK (mode IN ('paper', 'live')),
  symbol              text NOT NULL,
  side                text NOT NULL CHECK (side IN ('buy','sell','sell_call','sell_put','buy_call','buy_put')),
  qty                 numeric(14,6) NOT NULL CHECK (qty > 0),
  contract_multiplier numeric(8,2) NOT NULL DEFAULT 1,   -- 100 for options
  confidence          numeric(4,3),                       -- copied from signal, for IC analysis

  -- Intent, frozen at signal time (never updated after insert)
  signal_time         timestamptz NOT NULL,
  intended_entry      numeric(14,4) NOT NULL,
  intended_stop       numeric(14,4),
  intended_target     numeric(14,4),
  risk_amount         numeric(14,4) NOT NULL CHECK (risk_amount > 0), -- planned $ at risk
  risk_pct_applied    numeric(6,4),                       -- % of equity the sizing gate approved
  sizing_meta         jsonb DEFAULT '{}',                 -- full kelly-gate output for audit
  equity_at_entry     numeric(14,2),

  -- Entry execution
  entry_order_id      text,
  entry_fill_price    numeric(14,4),
  entry_fill_time     timestamptz,
  entry_slippage_bps  numeric(10,4),                      -- positive = cost (derived)

  -- Exit execution
  exit_reason         text CHECK (exit_reason IN ('stop','target','trail','signal_flip','time','manual','liquidation')),
  exit_order_id       text,
  intended_exit       numeric(14,4),
  exit_fill_price     numeric(14,4),
  exit_fill_time      timestamptz,
  exit_slippage_bps   numeric(10,4),                      -- positive = cost (derived)

  -- Costs. All positive numbers = money lost to friction.
  fees                numeric(12,4) NOT NULL DEFAULT 0,   -- commissions + regulatory + borrow

  -- Outcome (derived on close unless supplied explicitly, e.g. options)
  gross_pnl           numeric(14,4),
  net_pnl             numeric(14,4),
  r_multiple          numeric(10,4),                      -- net_pnl / risk_amount

  status              text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','busted')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_ledger_user_strat_mode   ON public.trade_ledger(user_id, strategy, mode, status);
CREATE INDEX idx_ledger_exit_time         ON public.trade_ledger(exit_fill_time DESC) WHERE status = 'closed';
CREATE INDEX idx_ledger_signal_id         ON public.trade_ledger(signal_id);
CREATE INDEX idx_ledger_position_id       ON public.trade_ledger(position_id);
CREATE INDEX idx_ledger_entry_order       ON public.trade_ledger(entry_order_id);

CREATE TRIGGER trade_ledger_updated_at
  BEFORE UPDATE ON public.trade_ledger
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE public.trade_ledger IS
  'Edge-measurement ledger: intent vs execution per trade. Written only by n8n (service role). Source of truth for the Kelly gate.';
COMMENT ON COLUMN public.trade_ledger.r_multiple IS
  'net_pnl / risk_amount. The unit all edge metrics are computed in.';
COMMENT ON COLUMN public.trade_ledger.status IS
  'open -> closed. busted = reconciliation found a mismatch vs broker records; excluded from metrics, alerts fired.';

-- ----------------------------------------------------------------------------
-- 2. Derivation trigger — fills slippage / P&L / R when the raw inputs land.
--    Fill-if-null semantics: n8n may pre-compute (e.g. multi-leg options) and
--    the trigger will not overwrite an explicit value.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trade_ledger_derive()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  dir numeric;  -- +1 long-ish, -1 short-ish
BEGIN
  dir := CASE WHEN NEW.side LIKE 'buy%' THEN 1 ELSE -1 END;

  -- Entry slippage: positive = paid more (long) / received less (short) than intended
  IF NEW.entry_fill_price IS NOT NULL AND NEW.entry_slippage_bps IS NULL
     AND NEW.intended_entry <> 0 THEN
    NEW.entry_slippage_bps :=
      dir * (NEW.entry_fill_price - NEW.intended_entry) / NEW.intended_entry * 10000;
  END IF;

  -- Exit slippage: positive = exited worse than intended
  IF NEW.exit_fill_price IS NOT NULL AND NEW.exit_slippage_bps IS NULL
     AND NEW.intended_exit IS NOT NULL AND NEW.intended_exit <> 0 THEN
    NEW.exit_slippage_bps :=
      -dir * (NEW.exit_fill_price - NEW.intended_exit) / NEW.intended_exit * 10000;
  END IF;

  -- Outcome on close
  IF NEW.status = 'closed'
     AND NEW.entry_fill_price IS NOT NULL AND NEW.exit_fill_price IS NOT NULL THEN
    IF NEW.gross_pnl IS NULL THEN
      NEW.gross_pnl := dir * (NEW.exit_fill_price - NEW.entry_fill_price)
                       * NEW.qty * NEW.contract_multiplier;
    END IF;
    IF NEW.net_pnl IS NULL THEN
      NEW.net_pnl := NEW.gross_pnl - NEW.fees;
    END IF;
    IF NEW.r_multiple IS NULL AND NEW.risk_amount > 0 THEN
      NEW.r_multiple := NEW.net_pnl / NEW.risk_amount;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trade_ledger_derive
  BEFORE INSERT OR UPDATE ON public.trade_ledger
  FOR EACH ROW EXECUTE FUNCTION public.trade_ledger_derive();

-- ----------------------------------------------------------------------------
-- 3. edge_metrics_by_strategy — the scoreboard. Closed, non-busted trades only.
--    Everything the Kelly gate and the dashboard need, per user/strategy/mode.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.edge_metrics_by_strategy AS
WITH base AS (
  SELECT user_id, strategy, mode,
         net_pnl, r_multiple, entry_slippage_bps, exit_slippage_bps, fees,
         entry_fill_time, exit_fill_time
  FROM public.trade_ledger
  WHERE status = 'closed' AND r_multiple IS NOT NULL
),
agg AS (
  SELECT
    user_id, strategy, mode,
    count(*)                                             AS n_trades,
    min(entry_fill_time)                                 AS first_trade,
    max(exit_fill_time)                                  AS last_trade,
    count(*) FILTER (WHERE net_pnl > 0)                  AS wins,
    avg(r_multiple)                                      AS expectancy_r,
    stddev_samp(r_multiple)                              AS stdev_r,
    avg(r_multiple)     FILTER (WHERE r_multiple > 0)    AS avg_win_r,
    abs(avg(r_multiple) FILTER (WHERE r_multiple <= 0))  AS avg_loss_r,
    sum(net_pnl)        FILTER (WHERE net_pnl > 0)       AS gross_wins,
    abs(sum(net_pnl)    FILTER (WHERE net_pnl <= 0))     AS gross_losses,
    sum(net_pnl)                                         AS total_net_pnl,
    sum(fees)                                            AS total_fees,
    avg(entry_slippage_bps)                              AS avg_entry_slip_bps,
    avg(exit_slippage_bps)                               AS avg_exit_slip_bps
  FROM base
  GROUP BY user_id, strategy, mode
)
SELECT
  *,
  round(wins::numeric / n_trades, 4)                     AS win_rate,
  round(gross_wins / nullif(gross_losses, 0), 3)         AS profit_factor,
  -- t-stat of expectancy: is the edge distinguishable from zero?
  round(expectancy_r / nullif(stdev_r, 0) * sqrt(n_trades::numeric), 3) AS t_stat,
  -- annualized per-trade Sharpe: (E/sd) * sqrt(trades per year)
  round(
    expectancy_r / nullif(stdev_r, 0)
    * sqrt( (n_trades::numeric / nullif(greatest((extract(epoch FROM (last_trade - first_trade)))::numeric / 86400.0, 1) / 365.25, 0))::numeric )
  , 3)                                                   AS sharpe_annualized,
  -- Discrete Kelly on R-multiples: f* = W/a - (1-W)/b
  round(
    (wins::numeric / n_trades) / nullif(avg_loss_r, 0)
    - (1 - wins::numeric / n_trades) / nullif(avg_win_r, 0)
  , 4)                                                   AS kelly_star
FROM agg;

COMMENT ON VIEW public.edge_metrics_by_strategy IS
  'Live, cost-survived edge per strategy. kelly_star is FULL Kelly — the gate applies the fraction. t_stat < 2 means the edge is not yet statistically real.';

-- ----------------------------------------------------------------------------
-- 4. RLS — users read their own rows; only service role (n8n) writes.
-- ----------------------------------------------------------------------------
ALTER TABLE public.trade_ledger ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read their own trade ledger"
  ON public.trade_ledger FOR SELECT
  USING (auth.uid() = user_id);
-- No INSERT/UPDATE/DELETE policies: anon/authenticated keys cannot write.
-- n8n writes with service role, which bypasses RLS.

-- ----------------------------------------------------------------------------
-- 5. Realtime — dashboard "trade tape" subscription.
-- ----------------------------------------------------------------------------
ALTER PUBLICATION supabase_realtime ADD TABLE public.trade_ledger;

-- ----------------------------------------------------------------------------
-- 6. Security hardening (advisor remediation, applied to qtp_prod 2026-07-09)
-- ----------------------------------------------------------------------------
ALTER VIEW public.edge_metrics_by_strategy SET (security_invoker = true);
ALTER FUNCTION public.trade_ledger_derive() SET search_path = '';
