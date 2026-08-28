"""
quantum_scalp_strategy_v5.py — Server-side port of
``Quantum Scalp Strategy v5`` (quantum_scalp_strategy_v5.pine)

Shadow / local use only.  Not connected to n8n or production workflows.

Overview (v5.2)
---------------
The strategy has three components:
  Engine A  — Score-based long/short via MTF EMA confluence, ADX/VIX regime,
              sweep validation, divergence, MACD, EMA trend, VWAP
  Engine B  — Daily drawdown + weekly drawdown circuit breakers,
              VIX-adaptive position sizing, loss cooldown
  Engine C  — Momentum override (gap-down/up, consecutive bars, panic moves)

Server-side notes
-----------------
* ``strategy.*`` objects (equity, closedtrades, etc.) are replaced by the
  PortfolioState dataclass which the caller must update on fills.
* ``barstate.isconfirmed`` is assumed True for every row.
* HTF EMAs must be pre-computed and passed in (same pattern as ensemble_engine).
* Cross-asset data (SPY/QQQ/XLY intraday 5-min) must be passed as Series
  aligned to ohlcv.index.
* Time-normalized volume: the TOD adjustment is approximated using bar_of_day
  derived from the index position within each calendar date.
* ``strategy.exit`` trailing stop emulation requires a live order manager —
  this module only signals entries; exit levels are returned per signal.
* VALIDATION: backtest results will differ from TradingView due to order
  execution model, bar magnifier, fill_orders_on_standard_ohlc, etc.

Preserved webhook payload fields
---------------------------------
All fields from buildPayload (Pine lines 628-646) are included in
build_signal_payload(), including:
  chart_image_url, chart_vision_enabled, signal_source,
  daily_dd_pct, daily_dd_halt, weekly_dd_pct, vix_size_mult,
  eff_position_size, vix_stop_mult, mtf_bull_count, mtf_bear_count,
  mtf_bull_score, mtf_bear_score, mtf_bull_confirmed, mtf_bear_confirmed,
  momentum_engine, momentum_type, gap_pct, momentum_rr
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Optional

import numpy as np
import pandas as pd

from . import indicators as ind
from .payload import SIGNAL_SOURCE_SCALP, empty_payload, merge_payloads

# ---------------------------------------------------------------------------
# Portfolio state (replaces Pine strategy.* builtins)
# ---------------------------------------------------------------------------

@dataclass
class PortfolioState:
    """Mutable state updated by the caller when fills occur."""
    initial_capital: float = 100_000.0
    equity: float = 100_000.0
    position_size: float = 0.0        # + = long, - = short, 0 = flat
    net_profit: float = 0.0
    gross_profit: float = 0.0
    gross_loss: float = 0.0
    win_trades: int = 0
    loss_trades: int = 0
    closed_trades: int = 0
    max_drawdown: float = 0.0
    # Internal daily/weekly tracking
    day_start_equity: float = 100_000.0
    week_start_equity: float = 100_000.0
    daily_dd_pct: float = 0.0
    weekly_dd_pct: float = 0.0
    daily_dd_halt: bool = False

    @property
    def net_profit_pct(self):
        return self.net_profit / self.initial_capital * 100

    @property
    def win_rate(self):
        t = self.win_trades + self.loss_trades
        return self.win_trades / t * 100 if t > 0 else 0.0

    @property
    def profit_factor(self):
        return self.gross_profit / abs(self.gross_loss) if self.gross_loss != 0 else 0.0

    @property
    def max_dd_pct(self):
        return self.max_drawdown / self.initial_capital * 100

    @property
    def avg_trade(self):
        return self.net_profit / self.closed_trades if self.closed_trades > 0 else 0.0

    @property
    def total_trades(self):
        return self.win_trades + self.loss_trades


# ---------------------------------------------------------------------------
# Config — mirrors all Pine inputs with defaults
# ---------------------------------------------------------------------------

@dataclass
class ScalpConfig:
    # Mode
    mode: str = "AUTO"   # "AUTO" | "MANUAL"

    # Manual tuning
    atr_sl_mult:   float = 1.5
    atr_tp_mult:   float = 2.5
    trail_atr:     float = 1.0
    use_trail:     bool = True
    max_trades:    int = 4
    session_start: str = "0945-1545"
    close_eod:     bool = True
    cooldown_bars: int = 4
    position_pct:  float = 10.0
    max_daily_dd:  float = 2.0
    max_weekly_dd: float = 5.0

    # Core indicators / HTF
    tf_1: str = "5"
    tf_2: str = "15"
    tf_3: str = "60"
    tf_4: str = "240"
    min_tf_confirm: int = 2

    # Sweep
    sweep_lookback:   int   = 20
    sweep_vol_mult:   float = 1.3
    disp_body_mult:   float = 1.20
    wick_body_max:    float = 0.70
    location_atr_buffer: float = 0.50
    div_lookback:     int   = 10

    # Regime
    min_adx:    float = 15.0
    trend_adx:  float = 22.0
    strong_adx: float = 35.0
    max_vix:    float = 35.0

    # Bayesian
    min_action_score:     float = 45.0
    min_directional_edge: float = 3.0

    # Cross-asset
    spy_symbol: str = "AMEX:SPY"
    qqq_symbol: str = "NASDAQ:QQQ"
    xly_symbol: str = "AMEX:XLY"
    require_cross: bool = True

    # Entry filters (v4: most are scoring not gating)
    require_sweep:      bool  = False
    require_vwap:       bool  = False
    require_ema_trend:  bool  = False
    daily_trend_lock:   bool  = False
    require_macd_align: bool  = False
    min_rel_vol:        float = 0.5
    rsi_ob:             float = 72.0
    rsi_os:             float = 28.0
    rsi_os_short:       float = 18.0   # v5.1: widened gate for shorts
    min_adx_entry:      float = 15.0

    # Momentum Override (v5.2)
    enable_momentum:    bool  = True
    gap_threshold:      float = 1.0
    momentum_bars:      int   = 3
    momentum_vol_mult:  float = 1.2
    momentum_sl_mult:   float = 1.5
    momentum_tp_mult:   float = 3.0
    momentum_min_rr:    float = 2.0
    momentum_size_pct:  float = 5.0

    # Extra
    chart_image_url:       str  = ""
    chart_vision_enabled:  bool = False
    signal_source:         str  = "quantum_scalp_v5"


# ---------------------------------------------------------------------------
# Auto-adaptive volatility classification
# ---------------------------------------------------------------------------

def volatility_class(
    close: pd.Series,
    atr_length: int = 14,
    smooth: int = 20,
) -> tuple[pd.Series, pd.Series, pd.Series, pd.Series]:
    """
    Returns (is_high_vol, is_med_vol, is_low_vol, atr_pct_smooth).
    Mirrors Pine lines 70-76.
    """
    atr_14 = ind.atr(close, close, close, atr_length)  # h==l==c → only close needed
    atr_pct = (atr_14 / close.replace(0, np.nan)) * 100
    atr_pct_smooth = ind.sma(atr_pct, smooth)
    is_high = atr_pct_smooth >= 3.0
    is_low  = atr_pct_smooth < 1.5
    is_med  = ~is_high & ~is_low
    return is_high, is_med, is_low, atr_pct_smooth


def effective_params(
    cfg: ScalpConfig,
    is_high_vol: bool,
    is_med_vol: bool,
    vix: float,
    weekly_dd_reduce: bool,
) -> dict:
    """
    Resolve AUTO vs MANUAL parameters for a single bar.
    Mirrors Pine lines 82-107.
    """
    if cfg.mode == "AUTO":
        sl     = 1.5 if is_high_vol else (1.3 if is_med_vol else 1.1)
        tp     = 2.5 if is_high_vol else (2.2 if is_med_vol else 1.8)
        trail  = 1.2 if is_high_vol else (1.0 if is_med_vol else 0.8)
        score  = 48.0 if is_high_vol else (45.0 if is_med_vol else 42.0)
        cool   = 5   if is_high_vol else (4   if is_med_vol else 3)
        max_t  = 3   if is_high_vol else (4   if is_med_vol else 5)
        size_b = 8.0 if is_high_vol else (10.0 if is_med_vol else 13.0)
    else:
        sl, tp, trail, score, cool, max_t, size_b = (
            cfg.atr_sl_mult, cfg.atr_tp_mult, cfg.trail_atr,
            45.0, cfg.cooldown_bars, cfg.max_trades, cfg.position_pct,
        )

    # VIX-adaptive sizing
    vix_size_mult = 1.0 if vix < 18 else (0.7 if vix < 25 else (0.5 if vix < 30 else 0.3))
    weekly_dd_mult = 0.5 if weekly_dd_reduce else 1.0
    eff_size = size_b * vix_size_mult * weekly_dd_mult

    # VIX-adaptive stop widening
    vix_stop_mult = 1.0 if vix < 18 else (1.15 if vix < 25 else (1.3 if vix < 30 else 1.5))

    return {
        "sl": sl, "tp": tp, "trail": trail, "score": score,
        "cool": cool, "max_trades": max_t,
        "eff_size_pct": eff_size, "vix_size_mult": vix_size_mult,
        "vix_stop_mult": vix_stop_mult, "weekly_dd_mult": weekly_dd_mult,
    }


# ---------------------------------------------------------------------------
# Time-of-day volume normalization
# ---------------------------------------------------------------------------

def tod_volume_factor(ohlcv: pd.DataFrame, bars_per_hour: float = 12.0) -> pd.Series:
    """
    Approximate time-of-day volume adjustment factor (Pine lines 184-192).
    Requires a DatetimeIndex.  Falls back to 1.0 otherwise.

    bars_per_hour defaults to 12 (5-min chart).  Adjust for other timeframes.
    """
    if not isinstance(ohlcv.index, pd.DatetimeIndex):
        return pd.Series(1.0, index=ohlcv.index)

    tod = pd.Series(1.5, index=ohlcv.index)  # default mid-session
    for date, group in ohlcv.groupby(ohlcv.index.date):
        n = len(group)
        for i, idx in enumerate(group.index):
            bar = i  # 0-indexed within the day
            if bar < bars_per_hour * 1:
                tod[idx] = 1.0      # first hour (open surge accounted for)
            elif bars_per_hour * 2 <= bar < bars_per_hour * 5:
                tod[idx] = 2.0      # midday boost
            elif bar >= bars_per_hour * 5:
                tod[idx] = 1.3      # close
            else:
                tod[idx] = 1.5
    return tod


# ---------------------------------------------------------------------------
# Main compute
# ---------------------------------------------------------------------------

def compute(
    ohlcv: pd.DataFrame,
    cfg: Optional[ScalpConfig] = None,
    *,
    htf_ema_1: Optional[pd.Series] = None,
    htf_ema_2: Optional[pd.Series] = None,
    htf_ema_3: Optional[pd.Series] = None,
    htf_ema_4: Optional[pd.Series] = None,
    vix_close: Optional[pd.Series] = None,
    spy_close:  Optional[pd.Series] = None,
    spy_prev:   Optional[pd.Series] = None,
    spy_sma20:  Optional[pd.Series] = None,
    spy_ema50:  Optional[pd.Series] = None,
    qqq_close:  Optional[pd.Series] = None,
    qqq_prev:   Optional[pd.Series] = None,
    qqq_sma20:  Optional[pd.Series] = None,
    qqq_ema50:  Optional[pd.Series] = None,
    xly_close:  Optional[pd.Series] = None,
    xly_sma20:  Optional[pd.Series] = None,
    xly_ema50:  Optional[pd.Series] = None,
    daily_close:     Optional[pd.Series] = None,
    daily_sma50:     Optional[pd.Series] = None,
    daily_ema21:     Optional[pd.Series] = None,
    day_high:        Optional[pd.Series] = None,
    day_low:         Optional[pd.Series] = None,
    prev_day_high:   Optional[pd.Series] = None,
    prev_day_low:    Optional[pd.Series] = None,
    prev_close_daily: Optional[pd.Series] = None,
    today_open_daily: Optional[pd.Series] = None,
) -> pd.DataFrame:
    """
    Compute all signal columns for a full OHLCV DataFrame.
    All external series (HTF EMAs, cross-asset) must be pre-aligned to
    ohlcv.index (forward-filled from their native timeframe).

    Returns a DataFrame with signal columns, scores, and risk parameters.
    Does NOT execute orders — use the result to drive a live order manager.
    """
    if cfg is None:
        cfg = ScalpConfig()

    c = ohlcv["close"]
    h = ohlcv["high"]
    l = ohlcv["low"]
    o = ohlcv["open"]
    v = ohlcv["volume"]

    def mk(s, fallback_series):
        return s.reindex(ohlcv.index) if s is not None else fallback_series

    # ---- Core indicators ----
    atr_val = ind.atr(h, l, c, 14)
    rsi_14  = ind.rsi(c, 14)
    macd_l, macd_s, macd_h = ind.macd(c, 12, 26, 9)
    sma_50  = ind.sma(c, 50)
    ema_200 = ind.ema(c, 200)
    vwap_val = ind.vwap_rolling(c, v, 30)
    plus_di, minus_di, adx_val = ind.dmi(h, l, c, 14, 14)
    ema_9   = ind.ema(c, 9)
    ema_21  = ind.ema(c, 21)

    # Stochastics / CCI / Momentum / BB / Pivot / PSAR (for payload)
    stoch_k, stoch_d = ind.stochastic(c, h, l, 14, 3, 3)
    cci_val  = ind.cci(h, l, c, 20)
    mom_val  = ind.momentum(c, 10)
    bb_up, bb_mid, bb_lo = ind.bollinger_bands(c, 20, 2.0)
    pivot    = (h + l + c) / 3.0
    psar_val = ind.parabolic_sar(h, l, 0.02, 0.02, 0.2)

    chart_trend_bull = ema_9 > ema_21
    chart_trend_bear = ema_9 < ema_21

    # ---- Time-normalized volume ----
    avg_vol_raw  = ind.sma(v, 30)
    safe_avg_vol = avg_vol_raw.fillna(v)
    rel_vol_raw  = (v / safe_avg_vol.replace(0, np.nan)).fillna(1.0)
    tod_adj = tod_volume_factor(ohlcv)
    rel_vol = rel_vol_raw * tod_adj

    # ---- Volatility class ----
    atr_pct_auto   = (atr_val / c.replace(0, np.nan)) * 100
    atr_pct_smooth = ind.sma(atr_pct_auto, 20)
    is_high_vol = atr_pct_smooth >= 3.0
    is_low_vol  = atr_pct_smooth < 1.5
    is_med_vol  = ~is_high_vol & ~is_low_vol

    # ---- VIX ----
    vix_s = mk(vix_close, pd.Series(20.0, index=ohlcv.index))

    # ---- Daily trend ----
    dc  = mk(daily_close, c)
    ds50 = mk(daily_sma50, sma_50)
    de21 = mk(daily_ema21, ema_21)
    daily_bull  = (dc > ds50) & (dc > de21)
    daily_bear  = (dc < ds50) & (dc < de21)
    daily_mixed = ~daily_bull & ~daily_bear

    daily_bull_bonus = pd.Series(np.where(daily_bull, 8.0, np.where(daily_mixed, 0.0, -10.0)), index=ohlcv.index)
    daily_bear_bonus = pd.Series(np.where(daily_bear, 8.0, np.where(daily_mixed, 0.0, -10.0)), index=ohlcv.index)

    allow_longs  = ~pd.Series(cfg.daily_trend_lock, index=ohlcv.index) | daily_bull | daily_mixed
    allow_shorts = ~pd.Series(cfg.daily_trend_lock, index=ohlcv.index) | daily_bear | daily_mixed

    # ---- Day H/L ----
    dh   = mk(day_high, h.rolling(390, min_periods=1).max())
    dl   = mk(day_low,  l.rolling(390, min_periods=1).min())
    pdh  = mk(prev_day_high, dh.shift(1))
    pdl  = mk(prev_day_low,  dl.shift(1))

    # ---- Cross-asset ----
    spy_c   = mk(spy_close, c)
    spy_p   = mk(spy_prev,  c.shift(1))
    spy_s20 = mk(spy_sma20, ind.sma(c, 20))
    spy_e50 = mk(spy_ema50, ind.ema(c, 50))
    qqq_c   = mk(qqq_close, c)
    qqq_p   = mk(qqq_prev,  c.shift(1))
    qqq_s20 = mk(qqq_sma20, ind.sma(c, 20))
    qqq_e50 = mk(qqq_ema50, ind.ema(c, 50))
    xly_c   = mk(xly_close, c)
    xly_s20 = mk(xly_sma20, ind.sma(c, 20))
    xly_e50 = mk(xly_ema50, ind.ema(c, 50))

    spy_chg = spy_c - spy_p
    qqq_chg = qqq_c - qqq_p
    spy_healthy       = (spy_c > spy_s20) & (spy_c > spy_e50)
    qqq_healthy       = (qqq_c > qqq_s20) & (qqq_c > qqq_e50)
    xly_aligned       = (xly_c > xly_s20) & (xly_c > xly_e50)
    spy_breaking_down = (spy_c < spy_s20) & (spy_c < spy_e50) & (spy_chg < 0)
    qqq_breaking_down = (qqq_c < qqq_s20) & (qqq_c < qqq_e50) & (qqq_chg < 0)
    spy_weak = (spy_c < spy_s20) | (spy_c < spy_e50)
    qqq_weak = (qqq_c < qqq_s20) | (qqq_c < qqq_e50)

    # v5.2: split cross-asset gate
    if cfg.require_cross:
        cross_ok_long  = ~spy_breaking_down & ~qqq_breaking_down
        cross_ok_short = spy_weak | qqq_weak | spy_breaking_down | qqq_breaking_down
    else:
        cross_ok_long  = pd.Series(True, index=ohlcv.index)
        cross_ok_short = pd.Series(True, index=ohlcv.index)

    # VIX gates
    vix_ok_long  = vix_s < cfg.max_vix
    vix_ok_short = pd.Series(True, index=ohlcv.index)  # v5: high VIX helps shorts

    # ---- MTF confluence ----
    def _htf_bull(htf_ema):
        if htf_ema is None:
            return pd.Series(0, index=ohlcv.index)
        return (c > htf_ema.reindex(ohlcv.index)).astype(int)
    def _htf_bear(htf_ema):
        if htf_ema is None:
            return pd.Series(0, index=ohlcv.index)
        return (c < htf_ema.reindex(ohlcv.index)).astype(int)

    bull_count = _htf_bull(htf_ema_1) + _htf_bull(htf_ema_2) + _htf_bull(htf_ema_3) + _htf_bull(htf_ema_4)
    bear_count = _htf_bear(htf_ema_1) + _htf_bear(htf_ema_2) + _htf_bear(htf_ema_3) + _htf_bear(htf_ema_4)
    mtf_bull_score    = bull_count / 4.0 * 25.0
    mtf_bear_score    = bear_count / 4.0 * 25.0
    bull_mtf_confirmed = bull_count >= cfg.min_tf_confirm
    bear_mtf_confirmed = bear_count >= cfg.min_tf_confirm

    # ---- Sweep validation ----
    prev_swing_high = ind.highest(h, cfg.sweep_lookback, shift=1)
    prev_swing_low  = ind.lowest(l, cfg.sweep_lookback, shift=1)
    high_volume = v > (safe_avg_vol * cfg.sweep_vol_mult)

    body_size  = (c - o).abs()
    avg_body   = ind.sma(body_size, 20)
    upper_wick = h - pd.concat([o, c], axis=1).max(axis=1)
    lower_wick = pd.concat([o, c], axis=1).min(axis=1) - l

    bull_displacement = (
        (c > o) & (body_size > avg_body * cfg.disp_body_mult)
        & (upper_wick <= body_size * cfg.wick_body_max)
        & (body_size > atr_val * 0.15)
    )
    bear_displacement = (
        (c < o) & (body_size > avg_body * cfg.disp_body_mult)
        & (lower_wick <= body_size * cfg.wick_body_max)
        & (body_size > atr_val * 0.15)
    )

    near_pdl = (c - pdl).abs() <= atr_val * cfg.location_atr_buffer
    near_pdh = (c - pdh).abs() <= atr_val * cfg.location_atr_buffer
    bull_pdl_sweep   = (l < pdl) & (c > pdl)
    bear_pdh_sweep   = (h > pdh) & (c < pdh)
    bull_swing_sweep = (l < prev_swing_low) & (c > o) & high_volume
    bear_swing_sweep = (h > prev_swing_high) & (c < o) & high_volume

    bull_location_ok = bull_pdl_sweep | near_pdl
    bear_location_ok = bear_pdh_sweep | near_pdh

    bull_sweep_valid = (
        (bull_swing_sweep | bull_pdl_sweep) & bull_location_ok & bull_displacement & high_volume
    )
    bear_sweep_valid = (
        (bear_swing_sweep | bear_pdh_sweep) & bear_location_ok & bear_displacement & high_volume
    )

    bull_sweep_score = (
        ((bull_swing_sweep | bull_pdl_sweep).astype(float) * 2.0)
        + (bull_pdl_sweep.astype(float) * 1.0)
        + (bull_displacement.astype(float) * 1.0)
    )
    bear_sweep_score = (
        ((bear_swing_sweep | bear_pdh_sweep).astype(float) * 2.0)
        + (bear_pdh_sweep.astype(float) * 1.0)
        + (bear_displacement.astype(float) * 1.0)
    )

    # ---- Regime + scoring ----
    trending      = adx_val > cfg.trend_adx
    strong_trend  = adx_val > cfg.strong_adx
    tradeable_long  = (adx_val > cfg.min_adx) & vix_ok_long
    tradeable_short = (adx_val > cfg.min_adx) & vix_ok_short

    # ADX score (directional)
    bull_adx_score = pd.Series(np.where(
        (adx_val > cfg.strong_adx) & (plus_di > minus_di), 10.0, np.where(
        (adx_val > cfg.trend_adx) & (plus_di > minus_di), 8.0, np.where(
        (adx_val > cfg.min_adx) & (plus_di > minus_di), 5.0, np.where(
        plus_di > minus_di, 2.0, 0.0)))), index=ohlcv.index)

    bear_adx_score = pd.Series(np.where(
        (adx_val > cfg.strong_adx) & (minus_di > plus_di), 10.0, np.where(
        (adx_val > cfg.trend_adx) & (minus_di > plus_di), 8.0, np.where(
        (adx_val > cfg.min_adx) & (minus_di > plus_di), 5.0, np.where(
        minus_di > plus_di, 2.0, 0.0)))), index=ohlcv.index)

    # VIX score
    bull_vix_score = pd.Series(np.where(vix_s < 18, 10.0, np.where(
        vix_s < 22, 8.0, np.where(vix_s < 28, 6.0, np.where(vix_s < 35, 3.0, 0.0)))),
        index=ohlcv.index)
    bear_vix_score = pd.Series(np.where(vix_s > 28, 10.0, np.where(
        vix_s > 22, 8.0, np.where(vix_s > 18, 6.0, 3.0))),
        index=ohlcv.index)

    # Volume scoring
    rv = rel_vol.fillna(0)
    bull_vol_score = (
        (rv >= 1.5).astype(float) * 8.0
        + (rv >= 0.8).astype(float) * 4.0
        + (c > vwap_val).astype(float) * 5.0
        + bull_displacement.astype(float) * 3.0
    )
    bear_vol_score = (
        (rv >= 1.5).astype(float) * 8.0
        + (rv >= 0.8).astype(float) * 4.0
        + (c < vwap_val).astype(float) * 5.0
        + bear_displacement.astype(float) * 3.0
    )

    # Divergence
    div_lb = cfg.div_lookback
    price_lower_low   = l < ind.lowest(l, div_lb, shift=1)
    price_higher_high = h > ind.highest(h, div_lb, shift=1)
    rsi_higher_low    = rsi_14 > ind.lowest(rsi_14, div_lb, shift=1)
    rsi_lower_high    = rsi_14 < ind.highest(rsi_14, div_lb, shift=1)
    bull_divergence = price_lower_low & rsi_higher_low
    bear_divergence = price_higher_high & rsi_lower_high

    bull_div_score = (
        bull_divergence.astype(float) * 10.0
        + ((rsi_14 < 45) & (rsi_14 > rsi_14.shift(1))).astype(float) * 5.0
    )
    bear_div_score = (
        bear_divergence.astype(float) * 10.0
        + ((rsi_14 > 55) & (rsi_14 < rsi_14.shift(1))).astype(float) * 5.0
    )

    # MACD scoring
    bull_macd_score = (
        (macd_l > macd_s).astype(float) * 7.0
        + (macd_h > macd_h.shift(1)).astype(float) * 4.0
        + (macd_h > 0).astype(float) * 4.0
    )
    bear_macd_score = (
        (macd_l < macd_s).astype(float) * 7.0
        + (macd_h < macd_h.shift(1)).astype(float) * 4.0
        + (macd_h < 0).astype(float) * 4.0
    )

    # EMA scoring (v4: not gate)
    bull_ema_score = chart_trend_bull.astype(float) * 5.0 + (c > ema_9).astype(float) * 3.0
    bear_ema_score = chart_trend_bear.astype(float) * 5.0 + (c < ema_9).astype(float) * 3.0

    # VWAP proximity
    vwap_dist = (vwap_val > 0) & ((c - vwap_val).abs() / vwap_val * 100 < 0.3)
    bull_vwap_bounce = (c > vwap_val) & (c.shift(1) < vwap_val) & (c > o)
    bear_vwap_reject = (c < vwap_val) & (c.shift(1) > vwap_val) & (c < o)
    bull_vwap_score = bull_vwap_bounce.astype(float) * 6.0 + ((c > vwap_val) & vwap_dist).astype(float) * 3.0
    bear_vwap_score = bear_vwap_reject.astype(float) * 6.0 + ((c < vwap_val) & vwap_dist).astype(float) * 3.0

    raw_bull = (
        mtf_bull_score + bull_vol_score + bull_div_score + bull_macd_score
        + bull_adx_score + bull_vix_score + bull_sweep_score + bull_ema_score
        + bull_vwap_score + daily_bull_bonus
    ).clip(0, 100)
    raw_bear = (
        mtf_bear_score + bear_vol_score + bear_div_score + bear_macd_score
        + bear_adx_score + bear_vix_score + bear_sweep_score + bear_ema_score
        + bear_vwap_score + daily_bear_bonus
    ).clip(0, 100)

    # ---- Momentum Override Engine (v5.2) ----
    prev_c_daily = mk(prev_close_daily, c.shift(1))
    tod_open     = mk(today_open_daily, o)
    gap_pct = (tod_open - prev_c_daily) / prev_c_daily.replace(0, np.nan) * 100
    gap_down = gap_pct <= -cfg.gap_threshold
    gap_up   = gap_pct >= cfg.gap_threshold

    bar_bearish = c < o
    bar_bullish = c > o
    nb = cfg.momentum_bars
    consec_bear = bar_bearish & (bar_bearish.shift(1).fillna(False))
    consec_bull = bar_bullish & (bar_bullish.shift(1).fillna(False))
    if nb >= 3:
        consec_bear = consec_bear & (bar_bearish.shift(2).fillna(False))
        consec_bull = consec_bull & (bar_bullish.shift(2).fillna(False))

    vol_expanding = (v > v.shift(1)) & (v.shift(1) > v.shift(2))
    mom_vol_ok    = rel_vol >= cfg.momentum_vol_mult
    making_new_lows  = (l < l.shift(1)) & (l.shift(1) < l.shift(2))
    making_new_highs = (h > h.shift(1)) & (h.shift(1) > h.shift(2))

    panic_bear = (rsi_14 < 25) & (rel_vol >= 2.0) & (c < vwap_val)
    panic_bull = (rsi_14 > 75) & (rel_vol >= 2.0) & (c > vwap_val)

    mom_below_vwap = c < vwap_val
    mom_above_vwap = c > vwap_val

    momentum_short_a = gap_down & mom_below_vwap & mom_vol_ok
    momentum_short_b = consec_bear & making_new_lows & (vol_expanding | mom_vol_ok) & mom_below_vwap
    momentum_short_c = panic_bear & making_new_lows
    momentum_long_a  = gap_up   & mom_above_vwap & mom_vol_ok
    momentum_long_b  = consec_bull & making_new_highs & (vol_expanding | mom_vol_ok) & mom_above_vwap
    momentum_long_c  = panic_bull & making_new_highs

    # ---- Decision engine ----
    sweep_ok_bull = ~pd.Series(cfg.require_sweep, index=ohlcv.index) | bull_sweep_valid
    sweep_ok_bear = ~pd.Series(cfg.require_sweep, index=ohlcv.index) | bear_sweep_valid
    min_eff_score = cfg.min_action_score if cfg.mode != "AUTO" else 45.0  # simplified — proper AUTO done per-bar

    bull_ready = (
        tradeable_long & bull_mtf_confirmed & sweep_ok_bull
        & (raw_bull >= min_eff_score)
        & (raw_bull > raw_bear + cfg.min_directional_edge)
        & cross_ok_long
    )
    bear_ready = (
        tradeable_short & bear_mtf_confirmed & sweep_ok_bear
        & (raw_bear >= min_eff_score)
        & (raw_bear > raw_bull + cfg.min_directional_edge)
        & cross_ok_short
    )

    # Entry filter gates (v4: most are scoring not gating, off by default)
    vwap_ok_bull = ~pd.Series(cfg.require_vwap, index=ohlcv.index) | (c > vwap_val)
    vwap_ok_bear = ~pd.Series(cfg.require_vwap, index=ohlcv.index) | (c < vwap_val)
    rsi_ok_bull  = rsi_14 < cfg.rsi_ob
    rsi_ok_bear  = rsi_14 > cfg.rsi_os_short   # v5.1: widened
    adx_ok       = adx_val >= cfg.min_adx_entry
    ema_ok_bull  = ~pd.Series(cfg.require_ema_trend, index=ohlcv.index) | chart_trend_bull
    ema_ok_bear  = ~pd.Series(cfg.require_ema_trend, index=ohlcv.index) | chart_trend_bear
    macd_ok_bull = ~pd.Series(cfg.require_macd_align, index=ohlcv.index) | (macd_h > 0)
    macd_ok_bear = ~pd.Series(cfg.require_macd_align, index=ohlcv.index) | (macd_h < 0)
    vol_ok       = rel_vol >= cfg.min_rel_vol

    score_long_signal = (
        bull_ready & allow_longs & vwap_ok_bull & rsi_ok_bull & adx_ok
        & ema_ok_bull & macd_ok_bull & vol_ok
        # session / can_trade / cooldown / daily_dd_halt applied per-bar in stateful loop
    )
    score_short_signal = (
        bear_ready & allow_shorts & vwap_ok_bear & rsi_ok_bear & adx_ok
        & ema_ok_bear & macd_ok_bear & vol_ok
    )

    # Momentum type label
    def mom_type_fn(sa, sb, sc, la, lb, lc):
        if sa: return "gap-down"
        if sb: return "intraday-momentum"
        if sc: return "panic-sell"
        if la: return "gap-up"
        if lb: return "intraday-momentum"
        if lc: return "panic-buy"
        return ""

    mom_type_s = pd.Series([
        mom_type_fn(sa, sb, sc, la, lb, lc)
        for sa, sb, sc, la, lb, lc in zip(
            momentum_short_a.values, momentum_short_b.values, momentum_short_c.values,
            momentum_long_a.values, momentum_long_b.values, momentum_long_c.values,
        )
    ], index=ohlcv.index)

    # Cross-asset strings
    spy_chg_pct = (spy_c - spy_p) / spy_p.replace(0, np.nan) * 100
    qqq_chg_pct = (qqq_c - qqq_p) / qqq_p.replace(0, np.nan) * 100
    spy_status = pd.Series(np.where(spy_breaking_down, "BREAKING_DOWN",
                            np.where(spy_healthy, "HEALTHY", "WEAK")), index=ohlcv.index)
    qqq_status = pd.Series(np.where(qqq_breaking_down, "BREAKING_DOWN",
                            np.where(qqq_healthy, "HEALTHY", "WEAK")), index=ohlcv.index)
    xly_status = pd.Series(np.where(xly_aligned, "ALIGNED", "DIVERGING"), index=ohlcv.index)
    cross_status = pd.Series(np.where(
        spy_healthy & qqq_healthy & xly_aligned, "BULL_CONFIRMED", np.where(
        spy_breaking_down | qqq_breaking_down, "BEAR_CONFIRMED", np.where(
        spy_weak | qqq_weak, "WEAKENING", "PARTIAL"))), index=ohlcv.index)
    regime_str = pd.Series(np.where(strong_trend, "STRONG_TREND", np.where(
        trending, "TRENDING", np.where(adx_val > cfg.min_adx, "NEUTRAL", "RANGING"))),
        index=ohlcv.index)
    daily_trend_str = pd.Series(np.where(daily_bull, "BULL",
                                  np.where(daily_bear, "BEAR", "MIXED")), index=ohlcv.index)

    # ---- Assemble result ----
    res = pd.DataFrame(index=ohlcv.index)
    res["atr_val"]           = atr_val
    res["atr_pct_smooth"]    = atr_pct_smooth
    res["is_high_vol"]       = is_high_vol
    res["is_med_vol"]        = is_med_vol
    res["is_low_vol"]        = is_low_vol
    res["rel_vol"]           = rel_vol
    res["rsi_14"]            = rsi_14
    res["macd_line"]         = macd_l
    res["macd_signal"]       = macd_s
    res["macd_hist"]         = macd_h
    res["adx_val"]           = adx_val
    res["plus_di"]           = plus_di
    res["minus_di"]          = minus_di
    res["sma_50"]            = sma_50
    res["ema_200"]           = ema_200
    res["vwap_val"]          = vwap_val
    res["ema_9"]             = ema_9
    res["ema_21"]            = ema_21
    res["stoch_k"]           = stoch_k
    res["stoch_d"]           = stoch_d
    res["cci"]               = cci_val
    res["momentum_ind"]      = mom_val
    res["bb_upper"]          = bb_up
    res["bb_lower"]          = bb_lo
    res["pivot_classic"]     = pivot
    res["psar"]              = psar_val
    res["vix"]               = vix_s
    res["daily_bull"]        = daily_bull
    res["daily_bear"]        = daily_bear
    res["bull_count"]        = bull_count
    res["bear_count"]        = bear_count
    res["mtf_bull_score"]    = mtf_bull_score
    res["mtf_bear_score"]    = mtf_bear_score
    res["bull_mtf_confirmed"]= bull_mtf_confirmed
    res["bear_mtf_confirmed"]= bear_mtf_confirmed
    res["raw_bull_score"]    = raw_bull
    res["raw_bear_score"]    = raw_bear
    res["score_long_signal"] = score_long_signal
    res["score_short_signal"]= score_short_signal
    res["gap_pct"]           = gap_pct
    res["gap_down"]          = gap_down
    res["gap_up"]            = gap_up
    res["consec_bear"]       = consec_bear
    res["consec_bull"]       = consec_bull
    res["momentum_short_a"]  = momentum_short_a
    res["momentum_short_b"]  = momentum_short_b
    res["momentum_short_c"]  = momentum_short_c
    res["momentum_long_a"]   = momentum_long_a
    res["momentum_long_b"]   = momentum_long_b
    res["momentum_long_c"]   = momentum_long_c
    res["momentum_type"]     = mom_type_s
    res["spy_chg_pct"]       = spy_chg_pct
    res["qqq_chg_pct"]       = qqq_chg_pct
    res["spy_status"]        = spy_status
    res["qqq_status"]        = qqq_status
    res["xly_status"]        = xly_status
    res["cross_status"]      = cross_status
    res["regime_str"]        = regime_str
    res["daily_trend_str"]   = daily_trend_str
    return res


# ---------------------------------------------------------------------------
# Signal payload builder (mirrors Pine buildPayload, lines 625-646)
# ---------------------------------------------------------------------------

def build_signal_payload(
    row: pd.Series,
    ohlcv_row: pd.Series,
    portfolio: PortfolioState,
    execution: str,
    signal: str,
    alert_type: str,
    comment: str,
    cfg: Optional[ScalpConfig] = None,
    ticker: str = "",
    timeframe: str = "",
    # v5 risk fields — pass from your per-bar risk manager
    daily_dd_pct: float = 0.0,
    daily_dd_halt: bool = False,
    weekly_dd_pct: float = 0.0,
    vix_size_mult: float = 1.0,
    eff_position_size: float = 10.0,
    vix_stop_mult: float = 1.0,
    is_momentum_entry: bool = False,
    mom_actual_rr: float = 0.0,
    chart_image_url: str = "",
    chart_vision_enabled: bool = False,
    signal_source: str = SIGNAL_SOURCE_SCALP,
) -> dict:
    """
    Assemble webhook payload matching Pine buildPayload() lines 628-646.
    All kv() fields preserved, plus server-side extensions.
    """
    if cfg is None:
        cfg = ScalpConfig()

    bull_s = float(row["raw_bull_score"])
    bear_s = float(row["raw_bear_score"])
    bs = str(round(max(bull_s, bear_s)))

    payload = {
        "ticker":              ticker,
        "price":               str(round(float(ohlcv_row["close"]), 2)),
        "execution":           execution,
        "signal":              signal,
        "bias_score":          bs,
        "regime":              str(row["regime_str"]),
        "adx":                 str(round(float(row["adx_val"]), 1)),
        "rsi":                 str(round(float(row["rsi_14"]), 1)),
        "macd_hist":           str(round(float(row["macd_hist"]), 3)),
        "atr":                 str(round(float(row["atr_val"]), 2)),
        "volume_ratio":        str(round(float(row["rel_vol"]), 2)),
        "vix":                 str(round(float(row["vix"]), 1)),
        "timeframe":           timeframe,
        "alert_type":          alert_type,
        "spy_price":           str(round(float(row.get("spy_close", 0)), 2)),
        "spy_change_pct":      str(round(float(row["spy_chg_pct"]), 2)),
        "spy_status":          str(row["spy_status"]),
        "qqq_price":           str(round(float(row.get("qqq_close", 0)), 2)),
        "qqq_change_pct":      str(round(float(row["qqq_chg_pct"]), 2)),
        "qqq_status":          str(row["qqq_status"]),
        "xly_status":          str(row["xly_status"]),
        "cross_asset_status":  str(row["cross_status"]),
        "tv_recommendation":   "N/A",
        "sma50":               str(round(float(row["sma_50"]), 2)),
        "ema200":              str(round(float(row["ema_200"]), 2)),
        "sma200":              "N/A",
        "bb_upper":            str(round(float(row["bb_upper"]), 2)),
        "bb_lower":            str(round(float(row["bb_lower"]), 2)),
        "stoch_k":             str(round(float(row["stoch_k"]), 1)),
        "stoch_d":             str(round(float(row["stoch_d"]), 1)),
        "cci":                 str(round(float(row["cci"]), 1)),
        "momentum":            str(round(float(row["momentum_ind"]), 2)),
        "pivot_classic":       str(round(float(row["pivot_classic"]), 2)),
        "psar":                str(round(float(row["psar"]), 2)),
        "daily_trend":         str(row["daily_trend_str"]),
        "bull_score":          str(round(bull_s, 1)),
        "bear_score":          str(round(bear_s, 1)),
        "comment":             comment,
        "strat_net_pct":       str(round(portfolio.net_profit_pct, 2)),
        "strat_win_rate":      str(round(portfolio.win_rate, 1)),
        "strat_wins":          str(portfolio.win_trades),
        "strat_losses":        str(portfolio.loss_trades),
        "strat_profit_factor": str(round(portfolio.profit_factor, 2)),
        "strat_max_dd":        str(round(portfolio.max_dd_pct, 2)),
        "strat_avg_trade":     str(round(portfolio.avg_trade, 2)),
        "strat_total_trades":  str(portfolio.total_trades),
        # v5 risk fields
        "daily_dd_pct":        str(round(daily_dd_pct, 2)),
        "daily_dd_halt":       "true" if daily_dd_halt else "false",
        "weekly_dd_pct":       str(round(weekly_dd_pct, 2)),
        "vix_size_mult":       str(round(vix_size_mult, 2)),
        "eff_position_size":   str(round(eff_position_size, 1)),
        "vix_stop_mult":       str(round(vix_stop_mult, 2)),
        # MTF confluence
        "mtf_bull_count":      str(int(row["bull_count"])),
        "mtf_bear_count":      str(int(row["bear_count"])),
        "mtf_bull_score":      str(round(float(row["mtf_bull_score"]), 1)),
        "mtf_bear_score":      str(round(float(row["mtf_bear_score"]), 1)),
        "mtf_bull_confirmed":  "true" if bool(row["bull_mtf_confirmed"]) else "false",
        "mtf_bear_confirmed":  "true" if bool(row["bear_mtf_confirmed"]) else "false",
        # v5.2 momentum fields
        "momentum_engine":     "true" if is_momentum_entry else "false",
        "momentum_type":       str(row["momentum_type"]),
        "gap_pct":             str(round(float(row["gap_pct"]) if not pd.isna(row["gap_pct"]) else 0.0, 2)),
        "momentum_rr":         str(round(mom_actual_rr, 1)),
        # Server-side extensions
        "chart_image_url":     chart_image_url,
        "chart_vision_enabled": chart_vision_enabled,
        "signal_source":       signal_source,
    }
    return merge_payloads(empty_payload(signal_source), payload)
