"""
quantum_swing_v83.py — Server-side port of
``Quantum Swing v8.3 — Adaptive Multi-Ticker`` (quantum_swing_v83_adaptive_multi_ticker.pine)

SHADOW_ONLY_DAILY — not wired to n8n, Alpaca, Telegram, or Supabase production
writes. The compute() function emits per-bar signals + payload data that drift.py
can diff against a Pine-exported reference CSV.

Overview (v8.3)
---------------
Three engines fire entry signals, gated by daily-DD circuit breaker, weekly-DD
position sizing, VIX-adaptive sizing and stop widening, and SPY/QQQ market
health:
  Engine A — Mean-Reversion (MR): Bollinger touch + RSI extreme + reversal
             candle (bull_reversal / bear_reversal / hammer / inv_hammer)
  Engine B — Trend-Drift (TD): SMA50 pullback (td_pb_bull/bear) OR v8.3 fresh
             SMA50 breakout/breakdown (td_fresh_breakout/breakdown)
  Engine C — Momentum Override: gap-down / multi-day breakdown / MA breakdown
             (symmetrical long-side: gap-up / multi-day breakout / MA breakout)

v8.3 changes vs v8.2
--------------------
* Added td_fresh_breakdown: close crosses below SMA50 with volume > 1.3x avg
  (catches trend-change/liquidation days that td_pb_bear misses)
* Added td_fresh_breakout (symmetrical long side)
* td_short_signal fires on td_pb_bear OR td_fresh_breakdown
* td_long_signal fires on td_pb_bull OR td_fresh_breakout

Server-side notes
-----------------
* ``strategy.*`` objects (equity, closedtrades, position_size) are replaced by
  the PortfolioState dataclass which the caller must update on fills. This
  module emits signals; it does not execute trades.
* ``barstate.isconfirmed`` is assumed True for every confirmed row.
* Cross-asset inputs (SPY, QQQ, VIX daily closes + SPY/QQQ prev close, sma20,
  ema50) must be passed as pd.Series aligned to ohlcv.index, or via the
  cross_asset dict in run_drift_manifest. When missing, market gates default
  to permissive (mkt_ok_long/short = True) and vix multipliers default to 1.0.
* DD tracking: daily_dd_pct / weekly_dd_pct require an externally-maintained
  PortfolioState. If not supplied, compute() emits zeros and daily_dd_halt
  defaults to False — matching Pine behaviour at strategy start.
* strategy.exit trailing stop is NOT emulated. compute() returns entry
  signals + the SL/TP levels Pine would have placed.
* VALIDATION: backtest equity/PnL will differ from TradingView's strategy
  tester due to use_bar_magnifier, slippage model, and commission rounding.

Preserved webhook payload fields (from buildPayload p1..p15, Pine 591-616)
--------------------------------------------------------------------------
ticker, price, execution, signal, bias_score (round(rsi)), regime, adx, rsi,
macd_hist, atr, volume_ratio, vix, timeframe="1D", alert_type,
spy_price, spy_change_pct, spy_status,
qqq_price, qqq_change_pct, qqq_status,
cross_asset_status, tv_recommendation,
sma50, ema200, sma200, bb_upper, bb_lower, bb_mid, bb_width_pct,
stoch_k, stoch_d, cci, momentum, pivot_classic, psar,
engine, comment,
strat_net_pct, strat_win_rate, strat_wins, strat_losses,
strat_profit_factor, strat_max_dd, strat_avg_trade, strat_total_trades,
daily_dd_pct, daily_dd_halt, weekly_dd_pct, vix_size_mult,
eff_position_size, vix_stop_mult,
momentum_engine, momentum_type, gap_pct, momentum_rr
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Optional

import numpy as np
import pandas as pd

from . import indicators as ind
from .payload import empty_payload, merge_payloads

# ---------------------------------------------------------------------------
# Signal source + mode tag
# ---------------------------------------------------------------------------

SIGNAL_SOURCE_SWING = "quantum_swing_v83"
MODE_SHADOW_ONLY_DAILY = "SHADOW_ONLY_DAILY"

# Pine alert payload string constants
ALERT_TYPE_SIGNAL_CHANGE = "SIGNAL_CHANGE"


# ---------------------------------------------------------------------------
# Portfolio state (replaces Pine strategy.* builtins for DD tracking)
# ---------------------------------------------------------------------------

@dataclass
class SwingPortfolio:
    """Mutable state the caller updates on fills. Used by daily/weekly DD
    tracking. When not supplied, compute() runs with zero DD and no halts —
    matching Pine behaviour at strategy start.
    """
    initial_capital: float = 100_000.0
    equity: float = 100_000.0
    position_size: float = 0.0
    net_profit: float = 0.0
    gross_profit: float = 0.0
    gross_loss: float = 0.0
    win_trades: int = 0
    loss_trades: int = 0
    closed_trades: int = 0
    max_drawdown: float = 0.0

    @property
    def net_profit_pct(self) -> float:
        return self.net_profit / self.initial_capital * 100 if self.initial_capital else 0.0

    @property
    def win_rate(self) -> float:
        t = self.win_trades + self.loss_trades
        return self.win_trades / t * 100 if t > 0 else 0.0

    @property
    def profit_factor(self) -> float:
        return self.gross_profit / abs(self.gross_loss) if self.gross_loss else 0.0

    @property
    def avg_trade(self) -> float:
        return self.net_profit / self.closed_trades if self.closed_trades else 0.0


# ---------------------------------------------------------------------------
# Config dataclass — mirrors the 25 Pine inputs
# ---------------------------------------------------------------------------

@dataclass
class SwingConfig:
    # Engine selection
    mode: str = "AUTO"                  # AUTO | MANUAL
    force_engine: str = "MR"            # MR | TD (when mode=MANUAL)

    # MR engine
    bb_len: int = 20
    bb_mult: float = 2.0
    rsi_os: int = 18                    # v8.1 default 30→18
    rsi_ob: int = 70
    mr_sl_atr_mult: float = 1.0
    mr_size_pct: float = 10.0
    mr_max_hold: int = 15
    mr_cooldown: int = 5

    # TD engine
    td_pb_len: int = 50
    td_sl_atr_mult: float = 2.0
    td_trail_atr_mult: float = 1.5
    td_size_pct: float = 10.0
    td_max_hold: int = 35
    td_cooldown: int = 5
    td_pb_buf_atr: float = 0.5

    # Market gates
    spy_symbol: str = "AMEX:SPY"
    qqq_symbol: str = "NASDAQ:QQQ"
    vix_symbol: str = "CBOE:VIX"
    max_vix: float = 30.0
    require_mkt: bool = True
    max_consec_losses: int = 3

    # v8 risk management
    max_daily_dd_pct: float = 2.0
    max_weekly_dd_pct: float = 5.0

    # Volatility classification (for AUTO engine selection)
    auto_atr_len: int = 14
    auto_vol_low_threshold: float = 0.015  # ATR/close ≤ this → MR
    auto_vol_high_threshold: float = 0.035 # ATR/close ≥ this → TD

    # Mode tag (constant — do not override)
    deployment_mode: str = MODE_SHADOW_ONLY_DAILY


# ---------------------------------------------------------------------------
# Cross-asset derivation helpers
# ---------------------------------------------------------------------------

def _derive_market_health(
    spy_close: Optional[pd.Series],
    spy_prev: Optional[pd.Series],
    spy_sma20: Optional[pd.Series],
    spy_ema50: Optional[pd.Series],
    qqq_close: Optional[pd.Series],
    qqq_prev: Optional[pd.Series],
    qqq_sma20: Optional[pd.Series],
    qqq_ema50: Optional[pd.Series],
    index: pd.Index,
) -> dict[str, pd.Series]:
    """Replicate Pine's spy_healthy / qqq_healthy / breaking_down / weak booleans
    and the split mkt_ok_long / mkt_ok_short gates.
    """
    def _zero():
        return pd.Series(0.0, index=index)
    def _false():
        return pd.Series(False, index=index)

    have_spy = spy_close is not None and spy_sma20 is not None and spy_ema50 is not None
    have_qqq = qqq_close is not None and qqq_sma20 is not None and qqq_ema50 is not None

    if have_spy:
        spy_healthy = (spy_close > spy_sma20) & (spy_close > spy_ema50)
        spy_break   = (spy_close < spy_sma20) & (spy_close < spy_ema50) & ((spy_close - (spy_prev if spy_prev is not None else spy_close)) < 0)
        spy_weak    = (spy_close < spy_sma20) | (spy_close < spy_ema50)
    else:
        spy_healthy = _false(); spy_break = _false(); spy_weak = _false()

    if have_qqq:
        qqq_healthy = (qqq_close > qqq_sma20) & (qqq_close > qqq_ema50)
        qqq_break   = (qqq_close < qqq_sma20) & (qqq_close < qqq_ema50) & ((qqq_close - (qqq_prev if qqq_prev is not None else qqq_close)) < 0)
        qqq_weak    = (qqq_close < qqq_sma20) | (qqq_close < qqq_ema50)
    else:
        qqq_healthy = _false(); qqq_break = _false(); qqq_weak = _false()

    return {
        "spy_healthy":       spy_healthy.reindex(index, fill_value=False),
        "spy_breaking_down": spy_break.reindex(index, fill_value=False),
        "spy_weak":          spy_weak.reindex(index, fill_value=False),
        "qqq_healthy":       qqq_healthy.reindex(index, fill_value=False),
        "qqq_breaking_down": qqq_break.reindex(index, fill_value=False),
        "qqq_weak":          qqq_weak.reindex(index, fill_value=False),
    }


def _vix_size_mult(vix: pd.Series) -> pd.Series:
    """Pine line 268: <18→1.0, 18-25→0.7, 25-30→0.5, >30→0.3."""
    return pd.Series(
        np.select(
            [vix < 18, vix < 25, vix < 30],
            [1.0, 0.7, 0.5],
            default=0.3,
        ),
        index=vix.index,
    )


def _vix_stop_mult(vix: pd.Series) -> pd.Series:
    """Pine line 272: <18→1.0, 18-25→1.15, 25-30→1.3, >30→1.5."""
    return pd.Series(
        np.select(
            [vix < 18, vix < 25, vix < 30],
            [1.0, 1.15, 1.3],
            default=1.5,
        ),
        index=vix.index,
    )


# ---------------------------------------------------------------------------
# Main compute()
# ---------------------------------------------------------------------------

def compute(
    ohlcv: pd.DataFrame,
    config: Optional[SwingConfig] = None,
    *,
    vix_close: Optional[pd.Series] = None,
    spy_close: Optional[pd.Series] = None,
    spy_prev: Optional[pd.Series] = None,
    spy_sma20: Optional[pd.Series] = None,
    spy_ema50: Optional[pd.Series] = None,
    qqq_close: Optional[pd.Series] = None,
    qqq_prev: Optional[pd.Series] = None,
    qqq_sma20: Optional[pd.Series] = None,
    qqq_ema50: Optional[pd.Series] = None,
    portfolio: Optional[SwingPortfolio] = None,
) -> pd.DataFrame:
    """Per-bar compute for Quantum Swing v8.3.

    Returns a DataFrame indexed like ohlcv with all indicator series, engine
    selection flags, MR/TD/Momentum signals, VIX-adaptive multipliers,
    DD tracking columns, and the fields needed by build_signal_payload().
    """
    cfg = config or SwingConfig()
    o, h, l, c, v = ohlcv["open"], ohlcv["high"], ohlcv["low"], ohlcv["close"], ohlcv["volume"]
    idx = ohlcv.index
    out = pd.DataFrame(index=idx)

    # ---- Core indicators (Pine 192-228) -------------------------------------
    bb_upper, bb_mid, bb_lower = ind.bollinger_bands(c, cfg.bb_len, cfg.bb_mult)
    out["bb_upper"] = bb_upper
    out["bb_lower"] = bb_lower
    out["bb_mid"]   = bb_mid
    out["bb_width_pct"] = (bb_upper - bb_lower) / bb_mid * 100

    out["rsi_14"]   = ind.rsi(c, 14)
    out["atr_14"]   = ind.atr(h, l, c, 14)
    macd_line, macd_signal, macd_hist = ind.macd(c, 12, 26, 9)
    out["macd_line"]   = macd_line
    out["macd_signal"] = macd_signal
    out["macd_hist"]   = macd_hist

    out["sma_50"]   = ind.sma(c, 50)
    out["sma_100"]  = ind.sma(c, 100)
    out["sma_200"]  = ind.sma(c, 200)
    out["ema_21"]   = ind.ema(c, 21)
    out["ema_50"]   = ind.ema(c, 50)
    out["ema_200"]  = ind.ema(c, 200)

    # FIX 1: ind.dmi returns (plus_di, minus_di, adx) — NOT (adx, plus_di, minus_di).
    # Previous unpacking assigned plus_di to adx_val (~10 pt mean drift vs Pine).
    plus_di, minus_di, adx_val = ind.dmi(h, l, c, 14, 14)
    out["adx_val"]   = adx_val
    out["plus_di"]   = plus_di
    out["minus_di"]  = minus_di

    # FIX 2: ind.stochastic signature is (close, high, low, ...). Previous call
    # passed (h, l, c) and then double-smoothed the already-smoothed K.
    # Pine's `ta.stoch(close, high, low, 14)` → SMA 3, then SMA again for D
    # is exactly what ind.stochastic(c, h, l, 14, 3, 3) returns.
    stoch_k, stoch_d = ind.stochastic(c, h, l, 14, 3, 3)
    out["stoch_k"]   = stoch_k
    out["stoch_d"]   = stoch_d

    # FIX 3: Pine `ta.cci(close, 20)` uses close as the typical-price source.
    # ind.cci uses TP = (h+l+c)/3 by default. Pass close three times so TP=close.
    out["cci"]       = ind.cci(c, c, c, 20)
    out["mom_val"]   = ind.momentum(c, 10)
    out["psar"]      = ind.parabolic_sar(h, l, 0.02, 0.02, 0.2)
    out["pivot_classic"] = (h.shift(1) + l.shift(1) + c.shift(1)) / 3

    # Volume / DOW-adjusted relative volume (Pine 209-212, daily timeframe)
    avg_vol = ind.sma(v, 20)
    raw_rel = (v / avg_vol).where(avg_vol > 0, 1.0)
    dow_adj = pd.Series(
        idx.to_series().dt.dayofweek.map({0: 1.3, 1: 1.0, 2: 1.0, 3: 1.0, 4: 1.2}).fillna(1.0).values,
        index=idx,
    )
    out["avg_vol"] = avg_vol
    out["rel_vol"] = raw_rel * dow_adj

    # ---- Engine selection (Pine 106-160, AUTO vs MANUAL) -------------------
    atr_pct = (out["atr_14"] / c).fillna(0.0)
    if cfg.mode == "AUTO":
        is_mr = atr_pct <= cfg.auto_vol_low_threshold
        is_td = atr_pct >= cfg.auto_vol_high_threshold
        # mid-range bars default to TD (matches Pine fallthrough)
        is_mr = is_mr & ~is_td
    else:
        is_mr = pd.Series(cfg.force_engine == "MR", index=idx)
        is_td = ~is_mr
    out["is_mr"] = is_mr
    out["is_td"] = is_td
    out["eff_engine"] = np.where(is_mr, "MR", "TD")

    # Effective per-engine params (placeholder — full Pine has AUTO-tuned dicts
    # of bb_len/rsi_os/mr_sl/etc keyed by ticker_profile + vol_class)
    eff_rsi_os = pd.Series(cfg.rsi_os, index=idx)
    eff_rsi_ob = pd.Series(cfg.rsi_ob, index=idx)
    eff_mr_sl  = pd.Series(cfg.mr_sl_atr_mult, index=idx)
    eff_td_sl  = pd.Series(cfg.td_sl_atr_mult, index=idx)
    eff_td_trail = pd.Series(cfg.td_trail_atr_mult, index=idx)
    eff_mr_size = pd.Series(cfg.mr_size_pct, index=idx)
    eff_td_size = pd.Series(cfg.td_size_pct, index=idx)
    eff_td_pb_buf = pd.Series(cfg.td_pb_buf_atr, index=idx)
    eff_max_hold = pd.Series(cfg.mr_max_hold, index=idx).where(is_mr, cfg.td_max_hold)

    # ---- Cross-asset health (Pine 230-260) ---------------------------------
    market = _derive_market_health(
        spy_close, spy_prev, spy_sma20, spy_ema50,
        qqq_close, qqq_prev, qqq_sma20, qqq_ema50,
        idx,
    )
    out["spy_healthy"]       = market["spy_healthy"]
    out["spy_breaking_down"] = market["spy_breaking_down"]
    out["spy_weak"]          = market["spy_weak"]
    out["qqq_healthy"]       = market["qqq_healthy"]
    out["qqq_breaking_down"] = market["qqq_breaking_down"]
    out["qqq_weak"]          = market["qqq_weak"]

    mkt_ok_long  = (~cfg.require_mkt) | (~out["spy_breaking_down"] & ~out["qqq_breaking_down"])
    mkt_ok_short = (~cfg.require_mkt) | (out["spy_weak"] | out["qqq_weak"] | out["spy_breaking_down"] | out["qqq_breaking_down"])
    if cfg.require_mkt is False:
        mkt_ok_long = pd.Series(True, index=idx)
        mkt_ok_short = pd.Series(True, index=idx)

    # VIX gates + adaptive multipliers (Pine 265-275)
    if vix_close is None:
        vix = pd.Series(np.nan, index=idx)
        vix_ok_long  = pd.Series(True, index=idx)   # permissive when VIX absent
        vix_size_mult = pd.Series(1.0, index=idx)
        vix_stop_mult = pd.Series(1.0, index=idx)
    else:
        vix = vix_close.reindex(idx).ffill()
        vix_ok_long = vix < cfg.max_vix
        vix_size_mult = _vix_size_mult(vix)
        vix_stop_mult = _vix_stop_mult(vix)
    vix_ok_short = pd.Series(True, index=idx)        # Pine: high VIX confirms shorts
    out["vix"] = vix
    out["vix_size_mult"] = vix_size_mult
    out["vix_stop_mult"] = vix_stop_mult

    # ---- Daily / Weekly DD tracking (Pine 27-44, lines 175-176) ------------
    # Simplified: derive from portfolio.equity if supplied, else zero.
    # Full strategy.equity emulation requires per-bar fill simulation; that is
    # a follow-up (would re-use SwingPortfolio + a fills queue).
    if portfolio is not None:
        # Caller is updating PortfolioState as it streams bars.
        # We expose the current snapshot — single value broadcast across bars.
        out["daily_dd_pct"]  = 0.0   # caller should overwrite per-bar
        out["weekly_dd_pct"] = 0.0
        out["daily_dd_halt"] = False
        out["weekly_dd_reduce"] = False
    else:
        out["daily_dd_pct"]    = 0.0
        out["weekly_dd_pct"]   = 0.0
        out["daily_dd_halt"]   = False
        out["weekly_dd_reduce"] = False

    weekly_dd_mult_ref = pd.Series(1.0, index=idx).where(~out["weekly_dd_reduce"], 0.5)
    out["eff_mr_size_adj"] = eff_mr_size * vix_size_mult * weekly_dd_mult_ref
    out["eff_td_size_adj"] = eff_td_size * vix_size_mult * weekly_dd_mult_ref

    # ---- ENGINE A: Mean-Reversion (Pine 346-388) ---------------------------
    bull_reversal = (c > o) & (l < l.shift(1)) & (c > (o + c.shift(1)) / 2)
    bear_reversal = (c < o) & (h > h.shift(1)) & (c < (o + c.shift(1)) / 2)
    body = (c - o).abs()
    lower_wick = pd.concat([o, c], axis=1).min(axis=1) - l
    upper_wick = h - pd.concat([o, c], axis=1).max(axis=1)
    hammer     = (lower_wick > body * 2) & (upper_wick < body * 0.5) & (c > o)
    inv_hammer = (upper_wick > body * 2) & (lower_wick < body * 0.5) & (c < o)

    touch_lower_bb = (l <= bb_lower) | (c <= bb_lower * 1.005)
    touch_upper_bb = (h >= bb_upper) | (c >= bb_upper * 0.995)

    rsi_oversold     = out["rsi_14"] <= eff_rsi_os
    rsi_overbought   = out["rsi_14"] >= eff_rsi_ob
    rsi_turning_up   = (out["rsi_14"] > out["rsi_14"].shift(1)) & (out["rsi_14"].shift(1) <= eff_rsi_os + 5)
    rsi_turning_down = (out["rsi_14"] < out["rsi_14"].shift(1)) & (out["rsi_14"].shift(1) >= eff_rsi_ob - 5)

    vol_confirm = out["rel_vol"] >= 0.8

    risk_ok = pd.Series(True, index=idx)  # simplified: consec_loss / month_pause is per-bar runtime

    mr_long_signal  = (is_mr & touch_lower_bb & (rsi_oversold | rsi_turning_up)
                       & (bull_reversal | hammer | (c > o)) & vol_confirm
                       & mkt_ok_long & vix_ok_long & risk_ok & ~out["daily_dd_halt"])
    mr_short_signal = (is_mr & touch_upper_bb & (rsi_overbought | rsi_turning_down)
                       & (bear_reversal | inv_hammer | (c < o)) & vol_confirm
                       & mkt_ok_short & vix_ok_short & risk_ok & ~out["daily_dd_halt"])
    out["mr_long_signal"]  = mr_long_signal.fillna(False)
    out["mr_short_signal"] = mr_short_signal.fillna(False)

    # ---- ENGINE B: Trend-Drift incl. v8.3 fresh breakouts ------------------
    sma50_slope    = out["sma_50"] - out["sma_50"].shift(20)
    sma50_rising   = sma50_slope > 0
    sma50_falling  = sma50_slope < 0
    monthly_bull   = c > out["sma_100"]
    monthly_bear   = c < out["sma_100"]
    td_bull_trend  = sma50_rising & monthly_bull
    td_bear_trend  = sma50_falling & monthly_bear

    td_pullback_ma = out["sma_50"].where(eff_td_pb_buf > 0, out["ema_50"])  # default sma_50 path
    if cfg.td_pb_len != 50:
        td_pullback_ma = out["ema_50"]
    td_pb_zone = out["atr_14"] * eff_td_pb_buf

    td_pb_bull = td_bull_trend & (l <= td_pullback_ma + td_pb_zone) & (c > td_pullback_ma) & (c > o)
    td_pb_bear = td_bear_trend & (h >= td_pullback_ma - td_pb_zone) & (c < td_pullback_ma) & (c < o)

    # v8.3 fresh breakout / breakdown — close crosses SMA50 with volume confirm
    td_fresh_breakdown = ((c < td_pullback_ma) & (c.shift(1) >= td_pullback_ma)
                          & (v > avg_vol * 1.3) & (c < o))
    td_fresh_breakout  = ((c > td_pullback_ma) & (c.shift(1) <= td_pullback_ma)
                          & (v > avg_vol * 1.3) & (c > o))
    out["td_fresh_breakdown"] = td_fresh_breakdown.fillna(False)
    out["td_fresh_breakout"]  = td_fresh_breakout.fillna(False)

    td_rsi_ok_long  = out["rsi_14"] <= 70
    td_rsi_ok_short = out["rsi_14"] >= 18
    adx_rising = out["adx_val"] > out["adx_val"].shift(3)
    td_macd_bull = out["macd_hist"] > out["macd_hist"].shift(1)
    td_macd_bear = out["macd_hist"] < out["macd_hist"].shift(1)
    td_structure_bull = c > out["ema_200"]
    td_structure_bear = c < out["ema_200"]

    td_long_signal  = (is_td & (td_pb_bull | td_fresh_breakout)
                       & td_rsi_ok_long & td_macd_bull
                       & (td_structure_bull | (c > out["sma_50"]))
                       & mkt_ok_long & vix_ok_long & risk_ok & ~out["daily_dd_halt"])
    td_short_signal = (is_td & (td_pb_bear | td_fresh_breakdown)
                       & td_rsi_ok_short & td_macd_bear
                       & (td_structure_bear | (c < out["sma_50"]))
                       & mkt_ok_short & vix_ok_short & risk_ok & ~out["daily_dd_halt"])
    out["td_long_signal"]  = td_long_signal.fillna(False)
    out["td_short_signal"] = td_short_signal.fillna(False)

    # ---- ENGINE C: Momentum Override (Pine 461-525) ------------------------
    gap_pct = ((o - c.shift(1)) / c.shift(1) * 100).where(c.shift(1) > 0, 0.0)
    gap_down = gap_pct <= -1.0
    gap_up   = gap_pct >= 1.0
    out["gap_pct"] = gap_pct

    day_bear = c < o
    day_bull = c > o
    consec_bear_days = day_bear & day_bear.shift(1).fillna(False) & day_bear.shift(2).fillna(False)
    consec_bull_days = day_bull & day_bull.shift(1).fillna(False) & day_bull.shift(2).fillna(False)
    daily_new_low  = (l < l.shift(1)) & (l.shift(1) < l.shift(2))
    daily_new_high = (h > h.shift(1)) & (h.shift(1) > h.shift(2))
    daily_vol_ok = out["rel_vol"] >= 1.2
    below_sma50_ema200 = (c < out["sma_50"]) & (c < out["ema_200"])
    above_sma50_ema200 = (c > out["sma_50"]) & (c > out["ema_200"])

    swing_mom_short_a = gap_down & (c < o) & daily_vol_ok
    swing_mom_short_b = consec_bear_days & daily_new_low & daily_vol_ok
    swing_mom_short_c = below_sma50_ema200 & day_bear & (out["spy_weak"] | out["spy_breaking_down"]) & daily_vol_ok
    swing_mom_long_a  = gap_up & (c > o) & daily_vol_ok
    swing_mom_long_b  = consec_bull_days & daily_new_high & daily_vol_ok
    swing_mom_long_c  = above_sma50_ema200 & day_bull & out["spy_healthy"] & daily_vol_ok

    swing_mom_sl = out["atr_14"] * 1.5 * vix_stop_mult
    swing_mom_tp = pd.concat([out["atr_14"] * 3.0, swing_mom_sl * 2.0], axis=1).max(axis=1)
    swing_mom_rr = (swing_mom_tp / swing_mom_sl).where(swing_mom_sl > 0, 0.0)
    swing_mom_rr_ok = swing_mom_rr >= 2.0
    out["swing_mom_sl"] = swing_mom_sl
    out["swing_mom_tp"] = swing_mom_tp
    out["swing_mom_rr"] = swing_mom_rr

    base_size = out["eff_mr_size_adj"].where(is_mr, out["eff_td_size_adj"])
    out["swing_mom_size"] = base_size * 0.6

    swing_momentum_short = ((swing_mom_short_a | swing_mom_short_b | swing_mom_short_c)
                            & swing_mom_rr_ok & ~out["daily_dd_halt"])
    swing_momentum_long  = ((swing_mom_long_a  | swing_mom_long_b  | swing_mom_long_c)
                            & swing_mom_rr_ok & vix_ok_long & ~out["daily_dd_halt"])
    out["swing_momentum_long"]  = swing_momentum_long.fillna(False)
    out["swing_momentum_short"] = swing_momentum_short.fillna(False)

    # Momentum type label (mutual exclusion, short paths first matching Pine var assign)
    mom_type = pd.Series("", index=idx, dtype=object)
    mom_type = mom_type.mask(swing_mom_short_a, "gap-down")
    mom_type = mom_type.mask(swing_mom_short_b & (mom_type == ""), "multi-day-breakdown")
    mom_type = mom_type.mask(swing_mom_short_c & (mom_type == ""), "MA-breakdown")
    mom_type = mom_type.mask(swing_mom_long_a & (mom_type == ""), "gap-up")
    mom_type = mom_type.mask(swing_mom_long_b & (mom_type == ""), "multi-day-breakout")
    mom_type = mom_type.mask(swing_mom_long_c & (mom_type == ""), "MA-breakout")
    out["momentum_type"] = mom_type

    # ---- Combined entry signals (Pine 528-540) -----------------------------
    out["long_signal"]  = (out["mr_long_signal"]  | out["td_long_signal"]  | out["swing_momentum_long"]).fillna(False)
    out["short_signal"] = (out["mr_short_signal"] | out["td_short_signal"] | out["swing_momentum_short"]).fillna(False)
    out["swing_is_momentum"] = ((swing_momentum_short & ~out["mr_short_signal"] & ~out["td_short_signal"])
                                | (swing_momentum_long  & ~out["mr_long_signal"]  & ~out["td_long_signal"])).fillna(False)

    # ---- Status strings (Pine 541-573) -------------------------------------
    spy_chg_pct = ((spy_close - spy_prev) / spy_prev * 100).fillna(0.0) if (spy_close is not None and spy_prev is not None) else pd.Series(0.0, index=idx)
    qqq_chg_pct = ((qqq_close - qqq_prev) / qqq_prev * 100).fillna(0.0) if (qqq_close is not None and qqq_prev is not None) else pd.Series(0.0, index=idx)
    out["spy_chg_pct"] = spy_chg_pct.reindex(idx, fill_value=0.0) if hasattr(spy_chg_pct, "reindex") else pd.Series(0.0, index=idx)
    out["qqq_chg_pct"] = qqq_chg_pct.reindex(idx, fill_value=0.0) if hasattr(qqq_chg_pct, "reindex") else pd.Series(0.0, index=idx)

    spy_status = np.where(out["spy_breaking_down"], "BREAKDOWN",
                  np.where(out["spy_healthy"], "HEALTHY", "WEAK"))
    qqq_status = np.where(out["qqq_breaking_down"], "BREAKDOWN",
                  np.where(out["qqq_healthy"], "HEALTHY", "WEAK"))
    out["spy_status"] = spy_status
    out["qqq_status"] = qqq_status
    cross_status = np.where(out["spy_healthy"] & out["qqq_healthy"], "BULL_CONFIRMED",
                    np.where(out["spy_breaking_down"] | out["qqq_breaking_down"], "BEAR_CONFIRMED",
                     np.where(out["spy_weak"] | out["qqq_weak"], "WEAKENING", "PARTIAL")))
    out["cross_asset_status"] = cross_status

    out["regime_str"] = np.where(
        is_mr,
        np.where(out["adx_val"] < 18, "RANGE_BOUND", "MID_RANGE"),
        np.where(sma50_rising, "TRENDING_BULL", np.where(sma50_falling, "TRENDING_BEAR", "NEUTRAL")),
    )
    out["tv_recommendation"] = np.where(
        is_mr,
        np.where(out["rsi_14"] < 30, "STRONG_BUY",
        np.where(out["rsi_14"] > 70, "STRONG_SELL",
        np.where(out["rsi_14"] < 45, "BUY",
        np.where(out["rsi_14"] > 55, "SELL", "NEUTRAL")))),
        np.where(sma50_rising & (out["rsi_14"] < 50), "BUY",
        np.where(sma50_falling & (out["rsi_14"] > 50), "SELL", "NEUTRAL")),
    )

    # ---- Payload-shape convenience fields ----------------------------------
    out["bias_score"] = out["rsi_14"].round().fillna(0).astype(int)  # Pine line 595
    out["price"]      = c

    return out


# ---------------------------------------------------------------------------
# Webhook payload builder
# ---------------------------------------------------------------------------

def build_signal_payload(
    row: pd.Series,
    ohlcv_row: pd.Series,
    portfolio: SwingPortfolio,
    execution: str,
    signal: str,
    alert_type: str = ALERT_TYPE_SIGNAL_CHANGE,
    comment: str = "",
    *,
    ticker: str = "",
    timeframe: str = "1D",
    chart_image_url: str = "",
    chart_vision_enabled: bool = False,
    signal_source: str = SIGNAL_SOURCE_SWING,
) -> dict:
    """Build the full v8.3 webhook payload from a compute() row.

    Mirrors buildPayload p1..p15 in the Pine source (lines 591-616). Returns a
    flat dict ready for JSON serialization. Server-side fields
    (chart_image_url, chart_vision_enabled, signal_source) are always present.
    """
    eff_pos_size = float(row.get("eff_mr_size_adj", 0.0)) if bool(row.get("is_mr", False)) \
                   else float(row.get("eff_td_size_adj", 0.0))
    payload = empty_payload(signal_source=signal_source)
    payload.update({
        "ticker":         ticker,
        "price":          round(float(ohlcv_row["close"]), 2),
        "execution":      execution,
        "signal":         signal,
        "bias_score":     int(row.get("bias_score", 0)),
        "regime":         str(row.get("regime_str", "NEUTRAL")),
        "adx":            round(float(row.get("adx_val", 0.0)), 1),
        "rsi":            round(float(row.get("rsi_14", 0.0)), 1),
        "macd_hist":      round(float(row.get("macd_hist", 0.0)), 3),
        "atr":            round(float(row.get("atr_14", 0.0)), 2),
        "volume_ratio":   round(float(row.get("rel_vol", 0.0)), 2),
        "vix":            round(float(row.get("vix", 0.0)), 1),
        "timeframe":      timeframe,
        "alert_type":     alert_type,
        "spy_price":      round(float(ohlcv_row.get("spy_close", 0.0)), 2) if "spy_close" in ohlcv_row else 0.0,
        "spy_change_pct": round(float(row.get("spy_chg_pct", 0.0)), 2),
        "spy_status":     str(row.get("spy_status", "WEAK")),
        "qqq_price":      round(float(ohlcv_row.get("qqq_close", 0.0)), 2) if "qqq_close" in ohlcv_row else 0.0,
        "qqq_change_pct": round(float(row.get("qqq_chg_pct", 0.0)), 2),
        "qqq_status":     str(row.get("qqq_status", "WEAK")),
        "cross_asset_status": str(row.get("cross_asset_status", "PARTIAL")),
        "tv_recommendation":  str(row.get("tv_recommendation", "NEUTRAL")),
        "sma50":          round(float(row.get("sma_50", 0.0)), 2),
        "ema200":         round(float(row.get("ema_200", 0.0)), 2),
        "sma200":         round(float(row.get("sma_200", 0.0)), 2),
        "bb_upper":       round(float(row.get("bb_upper", 0.0)), 2),
        "bb_lower":       round(float(row.get("bb_lower", 0.0)), 2),
        "bb_mid":         round(float(row.get("bb_mid", 0.0)), 2),
        "bb_width_pct":   round(float(row.get("bb_width_pct", 0.0)), 2),
        "stoch_k":        round(float(row.get("stoch_k", 0.0)), 1),
        "stoch_d":        round(float(row.get("stoch_d", 0.0)), 1),
        "cci":            round(float(row.get("cci", 0.0)), 1),
        "momentum":       round(float(row.get("mom_val", 0.0)), 2),
        "pivot_classic":  round(float(row.get("pivot_classic", 0.0)), 2),
        "psar":           round(float(row.get("psar", 0.0)), 2),
        "engine":         str(row.get("eff_engine", "MR")),
        "comment":        comment,
        # Strategy performance (from portfolio snapshot)
        "strat_net_pct":      round(portfolio.net_profit_pct, 2),
        "strat_win_rate":     round(portfolio.win_rate, 1),
        "strat_wins":         portfolio.win_trades,
        "strat_losses":       portfolio.loss_trades,
        "strat_profit_factor":round(portfolio.profit_factor, 2),
        "strat_max_dd":       round(portfolio.max_drawdown, 2),
        "strat_avg_trade":    round(portfolio.avg_trade, 2),
        "strat_total_trades": portfolio.closed_trades,
        # v8 risk
        "daily_dd_pct":       round(float(row.get("daily_dd_pct", 0.0)), 2),
        "daily_dd_halt":      bool(row.get("daily_dd_halt", False)),
        "weekly_dd_pct":      round(float(row.get("weekly_dd_pct", 0.0)), 2),
        "vix_size_mult":      round(float(row.get("vix_size_mult", 1.0)), 2),
        "eff_position_size":  round(eff_pos_size, 1),
        "vix_stop_mult":      round(float(row.get("vix_stop_mult", 1.0)), 2),
        # v8.2 momentum override
        "momentum_engine":    bool(row.get("swing_is_momentum", False)),
        "momentum_type":      str(row.get("momentum_type", "")),
        "gap_pct":            round(float(row.get("gap_pct", 0.0)), 2),
        "momentum_rr":        round(float(row.get("swing_mom_rr", 0.0)), 1),
        # Server-side extensions (also set by empty_payload, restated for clarity)
        "chart_image_url":     chart_image_url,
        "chart_vision_enabled": chart_vision_enabled,
        "signal_source":       signal_source,
    })
    return payload


# ---------------------------------------------------------------------------
# Convenience: per-bar `latest()` builder, mirrors super_score_pro_v25.latest
# ---------------------------------------------------------------------------

def latest(
    ohlcv: pd.DataFrame,
    config: Optional[SwingConfig] = None,
    portfolio: Optional[SwingPortfolio] = None,
    **compute_kwargs,
) -> dict:
    """Compute, then return a payload dict for the most recent bar."""
    df = compute(ohlcv, config, portfolio=portfolio, **compute_kwargs)
    if df.empty:
        return empty_payload(signal_source=SIGNAL_SOURCE_SWING)
    row = df.iloc[-1]
    ohlcv_row = ohlcv.iloc[-1]
    pf = portfolio or SwingPortfolio()
    if row["long_signal"]:
        execution, signal = "BUY", "BULLISH"
    elif row["short_signal"]:
        execution, signal = "SELL", "BEARISH"
    elif pf.position_size > 0:
        execution, signal = "LONG", "BULLISH"
    elif pf.position_size < 0:
        execution, signal = "SHORT", "BEARISH"
    else:
        execution, signal = "STAND ASIDE", "NEUTRAL"
    return build_signal_payload(
        row, ohlcv_row, pf,
        execution=execution, signal=signal,
        alert_type=ALERT_TYPE_SIGNAL_CHANGE,
        comment="Heartbeat — bar close update",
    )
