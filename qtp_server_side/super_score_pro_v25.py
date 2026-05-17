"""
super_score_pro_v25.py — Server-side port of
``AI Super Score Pro v2.5 Universal`` (ai_super_score_pro_v25_universal.pine)

Shadow / local use only.  Not connected to n8n or production workflows.

Key differences from Pine
==========================
* ``request.security("CBOE:VIX", ...)`` / QQQ / SPY data must be supplied by
  the caller as separate DataFrames.  Pass ``vix=None`` to skip the VIX filter
  (tradeAllowed will be True unless session filter is also active).
* Session filter (``useSessionFilter``) requires the DataFrame index to be a
  tz-aware DatetimeIndex with US/Eastern or UTC timestamps.  If the index is
  not a DatetimeIndex the session filter is silently disabled.
* ``ta.vwap(hlc3)`` resets each calendar day.  We use indicators.vwap_daily()
  when the index is a DatetimeIndex, otherwise rolling VWAP (30-bar window).
* Liquidity pools (bslLevel / sslLevel) and FVG / OB use ``var`` (persistent
  state) in Pine.  We replicate this with a forward-fill approach.
* ``chart_image_url``, ``chart_vision_enabled``, and ``signal_source`` are not
  computed in this module — they are assembled in payload.py.
* Alert payload fields are delegated to payload.py; this module returns a
  structured result dict per bar (or per-candle Series when batch=True).

VALIDATION REQUIRED:
  Run drift.py to compare output against TradingView data-window exports.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

import numpy as np
import pandas as pd

from . import indicators as ind
from .payload import (
    ALERT_TYPE_PERIODIC,
    SIGNAL_SOURCE_SUPER_SCORE,
    empty_payload,
    merge_payloads,
)

# ---------------------------------------------------------------------------
# Default inputs (mirrors Pine inputs section)
# ---------------------------------------------------------------------------

@dataclass
class SuperScoreConfig:
    # Profile
    profile_mode: str = "Balanced"  # "Aggressive" | "Balanced" | "Conservative"

    # Indicator lengths
    len_ema9: int = 9
    len_ema21: int = 21
    len_ema50: int = 50
    len_sma200: int = 200
    len_rsi: int = 14
    len_atr: int = 14
    len_roc: int = 14
    len_vol: int = 20
    len_sweep: int = 12
    len_chop: int = 14
    len_bb: int = 20
    bb_mult: float = 2.0

    # Thresholds
    eqh_tolerance_atr: float = 0.10
    ob_atr_mult: float = 0.80
    fvg_min_atr: float = 0.20
    sweep_fresh_bars: int = 20

    # VIX / session
    vix_filter_base: float = 26.0
    use_vix_filter: bool = True
    use_session_filter: bool = False
    session_primary: str = "0935-1130"   # NOTE: session filtering is approximate
    session_secondary: str = "1330-1530"

    # Display (informational only — no chart rendering server-side)
    show_only_a_grade: bool = False
    require_execution_for_alerts: bool = True

    def profile_params(self) -> dict:
        p = self.profile_mode
        return {
            "min_score":                  68.0 if p == "Aggressive" else (72.0 if p == "Balanced" else 76.0),
            "strong_buy_level":           78.0 if p == "Aggressive" else (82.0 if p == "Balanced" else 86.0),
            "elite_buy_level":            88.0 if p == "Aggressive" else (90.0 if p == "Balanced" else 92.0),
            "strong_sell_level":          22.0 if p == "Aggressive" else (18.0 if p == "Balanced" else 14.0),
            "elite_sell_level":           12.0 if p == "Aggressive" else (10.0 if p == "Balanced" else 8.0),
            "penalty_very_low_vol":        8.0 if p == "Aggressive" else (10.0 if p == "Balanced" else 12.0),
            "penalty_low_vol":             5.0 if p == "Aggressive" else  (7.0 if p == "Balanced" else  9.0),
            "penalty_neutral_regime":      4.0 if p == "Aggressive" else  (6.0 if p == "Balanced" else  8.0),
            "penalty_opposing_ob":         6.0 if p == "Aggressive" else  (8.0 if p == "Balanced" else 10.0),
            "penalty_elevated_vix":        2.0 if p == "Aggressive" else  (4.0 if p == "Balanced" else  6.0),
            "penalty_below_vwap_long":     3.0 if p == "Aggressive" else  (5.0 if p == "Balanced" else  7.0),
            "penalty_above_vwap_short":    3.0 if p == "Aggressive" else  (5.0 if p == "Balanced" else  7.0),
            "penalty_no_location":         4.0 if p == "Aggressive" else  (6.0 if p == "Balanced" else  8.0),
        }


# ---------------------------------------------------------------------------
# Result container
# ---------------------------------------------------------------------------

@dataclass
class SuperScoreBar:
    """All computed values for a single bar."""
    # Core series
    ema9: float = np.nan
    ema21: float = np.nan
    ema50: float = np.nan
    sma200: float = np.nan
    atr: float = np.nan
    rsi: float = np.nan
    roc: float = np.nan
    vwap: float = np.nan
    bb_upper: float = np.nan
    bb_lower: float = np.nan
    bb_width: float = np.nan
    rel_vol: float = np.nan
    macd_line: float = np.nan
    signal_line: float = np.nan
    macd_hist: float = np.nan

    # Regime
    adx: float = np.nan
    chop: float = np.nan
    is_trending: bool = False
    is_choppy: bool = False
    is_bull_trend: bool = False
    is_bear_trend: bool = False
    regime_score: float = 0.0
    regime_text: str = "NEUTRAL"

    # Scores
    trend_score: float = 0.0
    mtf_score: float = 0.0
    mom_score: float = 0.0
    vol_score: float = 0.0
    bb_score: float = 0.0
    price_action_score: float = 0.0
    smart_money_score: float = 0.0
    raw_bias_score: float = 50.0
    bias_score: float = 50.0

    # Penalties
    vol_penalty: float = 0.0
    regime_penalty: float = 0.0
    ob_penalty: float = 0.0
    vix_penalty: float = 0.0
    vwap_penalty: float = 0.0
    location_penalty: float = 0.0
    score_penalty: float = 0.0

    execution_score: float = 50.0
    buy_probability: float = 50.0
    sell_probability: float = 50.0

    # Signals
    buy_signal: bool = False
    strong_buy: bool = False
    elite_buy: bool = False
    sell_signal: bool = False
    strong_sell: bool = False
    elite_sell: bool = False
    new_buy_signal: bool = False
    new_strong_buy: bool = False
    new_elite_buy: bool = False
    new_sell_signal: bool = False
    new_strong_sell: bool = False
    new_elite_sell: bool = False
    execution_bias: str = "STAND ASIDE"
    signal_text: str = "NEUTRAL"
    grade: str = "C"

    # SMC
    liq_sweep_bull: bool = False
    liq_sweep_bear: bool = False
    in_bull_ob: bool = False
    in_bear_ob: bool = False
    in_bull_fvg: bool = False
    in_bear_fvg: bool = False
    bsl_swept: bool = False
    ssl_swept: bool = False
    valid_bull_location: bool = False
    valid_bear_location: bool = False

    # Filters
    trade_allowed: bool = True
    vix: float = np.nan


# ---------------------------------------------------------------------------
# Main compute function
# ---------------------------------------------------------------------------

def compute(
    ohlcv: pd.DataFrame,
    config: Optional[SuperScoreConfig] = None,
    vix: Optional[pd.Series] = None,
    qqq_close: Optional[pd.Series] = None,
    spy_close: Optional[pd.Series] = None,
    qqq_ema21: Optional[pd.Series] = None,
    spy_ema21: Optional[pd.Series] = None,
) -> pd.DataFrame:
    """
    Compute all AI Super Score Pro v2.5 values for a full OHLCV DataFrame.

    Parameters
    ----------
    ohlcv       : DataFrame with columns [open, high, low, close, volume].
                  Index may be a DatetimeIndex (required for session filter /
                  daily-reset VWAP).
    config      : SuperScoreConfig — uses defaults if None.
    vix         : Series of VIX close values aligned to ohlcv.index.
                  Pass None to disable VIX filter (tradeAllowed = True).
    qqq_close   : QQQ close aligned to ohlcv.index.  None disables MTF QQQ bias.
    spy_close   : SPY close aligned to ohlcv.index.  None disables MTF SPY bias.
    qqq_ema21   : Pre-computed QQQ EMA(21) aligned to ohlcv.index. When supplied,
                  used directly instead of recomputing from qqq_close. This is
                  the right thing when Pine's request.security has access to
                  full QQQ history that the local qqq_close series lacks (e.g.,
                  a short export window) — recomputing would yield NaN /
                  un-converged values for the first ~50 bars, flipping the
                  qqq_bias_bull/bear booleans that mtf_score depends on.
                  See `qqq_ema21_pine` columns produced by split_tv_export.
    spy_ema21   : Same idea for SPY.

    Returns
    -------
    DataFrame with one column per computed field, aligned to ohlcv.index.
    """
    if config is None:
        config = SuperScoreConfig()

    cfg = config
    pp = cfg.profile_params()

    o = ohlcv["open"]
    h = ohlcv["high"]
    l = ohlcv["low"]
    c = ohlcv["close"]
    v = ohlcv["volume"]

    # ---- Core series ----
    ema9  = ind.ema(c, cfg.len_ema9)
    ema21 = ind.ema(c, cfg.len_ema21)
    ema50 = ind.ema(c, cfg.len_ema50)
    sma200 = ind.sma(c, cfg.len_sma200)
    atr_val = ind.atr(h, l, c, cfg.len_atr)
    rsi_val = ind.rsi(c, cfg.len_rsi)
    roc_val = ind.roc(c, cfg.len_roc)

    hlc3 = (h + l + c) / 3.0
    if isinstance(ohlcv.index, pd.DatetimeIndex):
        vwap_val = ind.vwap_daily(c, v, hlc3)
    else:
        vwap_val = ind.vwap_rolling(hlc3, v, 30)

    bb_upper, bb_basis, bb_lower = ind.bollinger_bands(c, cfg.len_bb, cfg.bb_mult)
    bb_width = (bb_upper - bb_lower) / c.replace(0, np.nan)

    vol_avg = ind.sma(v, cfg.len_vol)
    rel_vol = (v / vol_avg.replace(0, np.nan)).fillna(1.0)

    macd_line, sig_line, macd_hist = ind.macd(c)
    range_pct = atr_val / c.replace(0, np.nan)

    # ---- Adaptive normalization ----
    adaptive_low_vol_thresh = range_pct.apply(lambda x: 0.85 if x > 0.01 else 0.95)
    adaptive_very_low_vol_thresh = range_pct.apply(lambda x: 0.60 if x > 0.01 else 0.75)

    # ---- VIX filter ----
    if vix is not None:
        vix_s = vix.reindex(ohlcv.index)
    else:
        vix_s = pd.Series(np.nan, index=ohlcv.index)

    # tradeAllowed — session filter requires DatetimeIndex; silently ignored otherwise
    trade_allowed = pd.Series(True, index=ohlcv.index)
    if cfg.use_vix_filter:
        vix_ok = vix_s.isna() | (vix_s < cfg.vix_filter_base)
        trade_allowed = trade_allowed & vix_ok

    # ---- QQQ / SPY bias (MTF proxy) ----
    if qqq_close is not None:
        qqq_c = qqq_close.reindex(ohlcv.index)
        # Prefer caller-supplied EMA21 (e.g. Pine's request.security value with
        # full history). Fall back to computing it from the local QQQ close —
        # which won't have converged on early bars of a short export window.
        if qqq_ema21 is not None:
            qqq_e21 = qqq_ema21.reindex(ohlcv.index)
        else:
            qqq_e21 = ind.ema(qqq_c, 21)
        qqq_bias_bull = qqq_c > qqq_e21
        qqq_bias_bear = qqq_c < qqq_e21
    else:
        qqq_bias_bull = pd.Series(False, index=ohlcv.index)
        qqq_bias_bear = pd.Series(False, index=ohlcv.index)

    if spy_close is not None:
        spy_c = spy_close.reindex(ohlcv.index)
        if spy_ema21 is not None:
            spy_e21 = spy_ema21.reindex(ohlcv.index)
        else:
            spy_e21 = ind.ema(spy_c, 21)
        spy_bias_bull = spy_c > spy_e21
        spy_bias_bear = spy_c < spy_e21
    else:
        spy_bias_bull = pd.Series(False, index=ohlcv.index)
        spy_bias_bear = pd.Series(False, index=ohlcv.index)

    # ---- Regime (ADX + Chop) ----
    plus_di, minus_di, adx_val = ind.dmi(h, l, c, cfg.len_chop, cfg.len_chop)
    chop_val = ind.chop(h, l, c, cfg.len_chop)

    is_trending = (adx_val > 20) & (chop_val < 55)
    is_choppy   = (chop_val > 61) & (adx_val < 18)
    is_bull_trend = is_trending & (ema9 > ema21) & (ema21 > ema50) & (c > vwap_val)
    is_bear_trend = is_trending & (ema9 < ema21) & (ema21 < ema50) & (c < vwap_val)

    regime_score = pd.Series(0.0, index=ohlcv.index)
    regime_score = regime_score.where(~is_bull_trend, 12.0)
    regime_score = regime_score.where(~is_bear_trend, -12.0)
    regime_score = regime_score.where(~(is_choppy & ~is_bull_trend & ~is_bear_trend), -6.0)

    # ---- Liquidity sweeps ----
    prev_high = ind.highest(h, cfg.len_sweep, shift=1)
    prev_low  = ind.lowest(l, cfg.len_sweep, shift=1)

    liq_sweep_bull = (l < prev_low) & (c > prev_low) & (rel_vol > 1.05)
    liq_sweep_bear = (h > prev_high) & (c < prev_high) & (rel_vol > 1.05)

    bull_sweep_score = liq_sweep_bull.astype(float) * 18.0
    bear_sweep_score = liq_sweep_bear.astype(float) * -18.0

    # ---- Liquidity pools (var state → forward-fill) ----
    # Pine line 157-158 has BOTH a tolerance check AND a directional clause:
    #   equalHighs = abs(high - high[1]) <= eqTol AND high >= high[1]
    #   equalLows  = abs(low  - low[1])  <= eqTol AND low  <= low[1]
    # The directional clause is critical — without it, Python would set
    # bsl_level on bars where the high DROPPED within tolerance (which Pine
    # rejects), leaving bsl_level at a stale-higher value and missing
    # subsequent bsl_swept events. This caused smart_money_score drift on
    # the worst-drift bar (2025-12-23 in test data): Python bsl=274.61 vs
    # Pine bsl=271.70 → Pine fires bslSwept=-8, Python misses it.
    eq_tol = atr_val * cfg.eqh_tolerance_atr
    equal_highs = ((h - h.shift(1)).abs() <= eq_tol) & (h >= h.shift(1))
    equal_lows  = ((l - l.shift(1)).abs() <= eq_tol) & (l <= l.shift(1))

    bsl_level = pd.Series(np.nan, index=ohlcv.index)
    ssl_level = pd.Series(np.nan, index=ohlcv.index)
    bsl_arr = bsl_level.values.copy()
    ssl_arr = ssl_level.values.copy()
    eq_h_arr = equal_highs.values
    eq_l_arr = equal_lows.values
    h_arr = h.values
    l_arr = l.values
    c_arr = c.values

    for i in range(1, len(c_arr)):
        # carry forward previous state
        bsl_arr[i] = bsl_arr[i - 1]
        ssl_arr[i] = ssl_arr[i - 1]
        if eq_h_arr[i]:
            bsl_arr[i] = max(h_arr[i], h_arr[i - 1])
        if eq_l_arr[i]:
            ssl_arr[i] = min(l_arr[i], l_arr[i - 1])

    bsl_level = pd.Series(bsl_arr, index=ohlcv.index)
    ssl_level = pd.Series(ssl_arr, index=ohlcv.index)

    bsl_swept = ~bsl_level.isna() & (h > bsl_level) & (c < bsl_level)
    ssl_swept = ~ssl_level.isna() & (l < ssl_level) & (c > ssl_level)

    # ---- Fair Value Gaps ----
    # bullFVG: low > high[2]  (current bar's low above two bars ago's high)
    # NOTE: bar_index >= 2 is handled by shift; first two bars will be NaN/False
    bull_fvg = (l > h.shift(2)) & ((l - h.shift(2)) >= atr_val * cfg.fvg_min_atr)
    bear_fvg = (h < l.shift(2)) & ((l.shift(2) - h) >= atr_val * cfg.fvg_min_atr)

    bull_fvg_top = pd.Series(np.nan, index=ohlcv.index)
    bull_fvg_bot = pd.Series(np.nan, index=ohlcv.index)
    bear_fvg_top = pd.Series(np.nan, index=ohlcv.index)
    bear_fvg_bot = pd.Series(np.nan, index=ohlcv.index)

    bft_arr = bull_fvg_top.values.copy()
    bfb_arr = bull_fvg_bot.values.copy()
    bart_arr = bear_fvg_top.values.copy()
    barb_arr = bear_fvg_bot.values.copy()
    bull_fvg_arr = bull_fvg.values
    bear_fvg_arr = bear_fvg.values
    l_arr2 = l.values
    h_arr2 = h.values

    for i in range(2, len(c_arr)):
        # carry forward
        bft_arr[i] = bft_arr[i - 1]
        bfb_arr[i] = bfb_arr[i - 1]
        bart_arr[i] = bart_arr[i - 1]
        barb_arr[i] = barb_arr[i - 1]
        if bull_fvg_arr[i]:
            bft_arr[i] = l_arr2[i]
            bfb_arr[i] = h_arr2[i - 2]
        if bear_fvg_arr[i]:
            bart_arr[i] = l_arr2[i - 2]
            barb_arr[i] = h_arr2[i]
        # Invalidation
        if not np.isnan(bfb_arr[i]) and c_arr[i] < bfb_arr[i]:
            bft_arr[i] = np.nan
            bfb_arr[i] = np.nan
        if not np.isnan(bart_arr[i]) and c_arr[i] > bart_arr[i]:
            bart_arr[i] = np.nan
            barb_arr[i] = np.nan

    bull_fvg_top = pd.Series(bft_arr, index=ohlcv.index)
    bull_fvg_bot = pd.Series(bfb_arr, index=ohlcv.index)
    bear_fvg_top = pd.Series(bart_arr, index=ohlcv.index)
    bear_fvg_bot = pd.Series(barb_arr, index=ohlcv.index)

    in_bull_fvg = (~bull_fvg_top.isna() & ~bull_fvg_bot.isna() &
                   (c <= bull_fvg_top) & (c >= bull_fvg_bot))
    in_bear_fvg = (~bear_fvg_top.isna() & ~bear_fvg_bot.isna() &
                   (c <= bear_fvg_top) & (c >= bear_fvg_bot))

    # ---- Order Blocks ----
    bull_displacement = (c > o) & ((c - o) > atr_val * 0.8) & (c > h.shift(1))
    bear_displacement = (c < o) & ((o - c) > atr_val * 0.8) & (c < l.shift(1))

    bearish_prev = c.shift(1) < o.shift(1)
    bullish_prev = c.shift(1) > o.shift(1)

    ob_high_bull = pd.Series(np.nan, index=ohlcv.index)
    ob_low_bull  = pd.Series(np.nan, index=ohlcv.index)
    ob_high_bear = pd.Series(np.nan, index=ohlcv.index)
    ob_low_bear  = pd.Series(np.nan, index=ohlcv.index)

    obhb_arr = ob_high_bull.values.copy()
    oblb_arr = ob_low_bull.values.copy()
    obhbr_arr = ob_high_bear.values.copy()
    oblbr_arr = ob_low_bear.values.copy()
    bull_disp_arr = bull_displacement.values
    bear_disp_arr = bear_displacement.values
    bearish_prev_arr = bearish_prev.values
    bullish_prev_arr = bullish_prev.values
    o_arr = o.values
    atr_arr = atr_val.values

    for i in range(1, len(c_arr)):
        obhb_arr[i] = obhb_arr[i - 1]
        oblb_arr[i] = oblb_arr[i - 1]
        obhbr_arr[i] = obhbr_arr[i - 1]
        oblbr_arr[i] = oblbr_arr[i - 1]
        if bull_disp_arr[i] and bearish_prev_arr[i]:
            obhb_arr[i] = o_arr[i - 1]
            # Pine: bullObLow = low[1] - atr[1] * obAtrMult * 0.15
            oblb_arr[i] = l_arr[i - 1] - (atr_arr[i - 1] if not np.isnan(atr_arr[i - 1]) else 0) * cfg.ob_atr_mult * 0.15
        if bear_disp_arr[i] and bullish_prev_arr[i]:
            oblbr_arr[i] = o_arr[i - 1]
            obhbr_arr[i] = h_arr[i - 1] + (atr_arr[i - 1] if not np.isnan(atr_arr[i - 1]) else 0) * cfg.ob_atr_mult * 0.15
        # Invalidation
        if not np.isnan(oblb_arr[i]) and c_arr[i] < oblb_arr[i]:
            obhb_arr[i] = np.nan
            oblb_arr[i] = np.nan
        if not np.isnan(obhbr_arr[i]) and c_arr[i] > obhbr_arr[i]:
            obhbr_arr[i] = np.nan
            oblbr_arr[i] = np.nan

    ob_high_bull = pd.Series(obhb_arr, index=ohlcv.index)
    ob_low_bull  = pd.Series(oblb_arr, index=ohlcv.index)
    ob_high_bear = pd.Series(obhbr_arr, index=ohlcv.index)
    ob_low_bear  = pd.Series(oblbr_arr, index=ohlcv.index)

    in_bull_ob = (~ob_high_bull.isna() & ~ob_low_bull.isna() &
                  (c <= ob_high_bull) & (c >= ob_low_bull))
    in_bear_ob = (~ob_high_bear.isna() & ~ob_low_bear.isna() &
                  (c >= ob_low_bear) & (c <= ob_high_bear))

    # ---- Smart Money Flow ----
    rng = (h - l).clip(lower=1e-10)
    buy_pressure  = ((c - l) / rng) * v
    sell_pressure = ((h - c) / rng) * v
    buy_pressure_avg  = ind.sma(buy_pressure, cfg.len_vol)
    sell_pressure_avg = ind.sma(sell_pressure, cfg.len_vol)

    smart_bull_flow = (buy_pressure > buy_pressure_avg * 1.35) & (c > o) & (rel_vol > 1.15)
    smart_bear_flow = (sell_pressure > sell_pressure_avg * 1.35) & (c < o) & (rel_vol > 1.15)

    sms = (
        smart_bull_flow.astype(float) * 10
        + bull_displacement.astype(float) * 8
        + in_bull_ob.astype(float) * 8
        + in_bull_fvg.astype(float) * 6
        + ssl_swept.astype(float) * 8
        - smart_bear_flow.astype(float) * 10
        - bear_displacement.astype(float) * 8
        - in_bear_ob.astype(float) * 8
        - in_bear_fvg.astype(float) * 6
        - bsl_swept.astype(float) * 8
        + bull_sweep_score + bear_sweep_score
    )

    # ---- Trend score ----
    full_bull = (ema9 > ema21) & (ema21 > ema50) & (c > sma200) & (c > vwap_val)
    full_bear = (ema9 < ema21) & (ema21 < ema50) & (c < sma200) & (c < vwap_val)
    trend_score = pd.Series(0.0, index=ohlcv.index)
    trend_score = trend_score.where(~full_bull, 25.0)
    trend_score = trend_score.where(~full_bear, -25.0)

    # ---- MTF score ----
    mtf = (
        (ema9 > ema21).astype(float) * 4
        + (c > ema50).astype(float) * 4
        + (c > sma200).astype(float) * 4
        + qqq_bias_bull.astype(float) * 4
        + spy_bias_bull.astype(float) * 4
        - (ema9 < ema21).astype(float) * 4
        - (c < ema50).astype(float) * 4
        - (c < sma200).astype(float) * 4
        - qqq_bias_bear.astype(float) * 4
        - spy_bias_bear.astype(float) * 4
    )

    # ---- Momentum score ----
    mom_bull = (
        ((rsi_val > 52) & (rsi_val > rsi_val.shift(1))).astype(float) * 7
        + ((macd_hist > 0) & (macd_hist > macd_hist.shift(1))).astype(float) * 7
        + ((roc_val > 0) & (roc_val > roc_val.shift(1))).astype(float) * 5
    )
    mom_bear = (
        ((rsi_val < 48) & (rsi_val < rsi_val.shift(1))).astype(float) * 7
        + ((macd_hist < 0) & (macd_hist < macd_hist.shift(1))).astype(float) * 7
        + ((roc_val < 0) & (roc_val < roc_val.shift(1))).astype(float) * 5
    )
    mom_score = mom_bull - mom_bear

    # ---- Volume score ----
    vol_score = (
        ((rel_vol > 1.5) & (c > o)).astype(float) * 10
        + ((rel_vol > 1.8) & smart_bull_flow).astype(float) * 5
        - ((rel_vol > 1.5) & (c < o)).astype(float) * 10
        - ((rel_vol > 1.8) & smart_bear_flow).astype(float) * 5
    )

    # ---- BB score ----
    bb_score = pd.Series(0.0, index=ohlcv.index)
    bb_score = bb_score.where(~((bb_width < 0.015) & is_trending), 8.0)
    bb_score = bb_score.where(~((bb_width > 0.06) & is_trending), 5.0)
    bb_score = bb_score.where(~is_choppy, -5.0)

    # ---- Price action score ----
    h5 = ind.highest(h, 5, shift=1)
    l5 = ind.lowest(l, 5, shift=1)
    pa_score = (
        ((c > h5) & (c > vwap_val)).astype(float) * 10
        - ((c < l5) & (c < vwap_val)).astype(float) * 10
    )

    # ---- Raw / execution scores ----
    raw_bias = 50.0 + trend_score + mtf + mom_score + vol_score + bb_score + pa_score + sms + regime_score
    bias_score = raw_bias.clip(0, 100)

    # Penalties
    # NOTE: the zip yields (rel_vol, very_low_thresh, low_thresh) — destructure
    # name order must match. The original code had `(rv, alvt, avt)` which
    # silently inverted the two thresholds, firing penalty_very_low_vol on
    # bars where rel_vol < 0.85 (intended: < 0.60). Caught 2026-05-16 via
    # diff_at_bar — Python vol_penalty=10 vs Pine vol_penalty=7 at
    # 2025-12-22 with rel_vol=0.77.
    vol_pen = pd.Series(0.0, index=ohlcv.index)
    for i, (rv, avt, alvt) in enumerate(zip(
            rel_vol.values, adaptive_very_low_vol_thresh.values, adaptive_low_vol_thresh.values)):
        if rv < avt:
            vol_pen.iloc[i] = pp["penalty_very_low_vol"]
        elif rv < alvt:
            vol_pen.iloc[i] = pp["penalty_low_vol"]

    regime_pen = (regime_score == 0).astype(float) * pp["penalty_neutral_regime"]
    bull_blocked = in_bear_ob | (~ob_low_bear.isna() & (c < ob_low_bear) & (c > vwap_val))
    bear_blocked = in_bull_ob | (~ob_high_bull.isna() & (c > ob_high_bull) & (c < vwap_val))
    ob_pen = (bull_blocked | bear_blocked).astype(float) * pp["penalty_opposing_ob"]
    vix_pen = (~vix_s.isna() & (vix_s > 22)).astype(float) * pp["penalty_elevated_vix"]
    vwap_pen = pd.Series(0.0, index=ohlcv.index)
    vwap_pen = vwap_pen.where(~((bias_score >= 50) & (c < vwap_val)), pp["penalty_below_vwap_long"])
    vwap_pen = vwap_pen.where(~((bias_score < 50) & (c > vwap_val)), pp["penalty_above_vwap_short"])

    valid_bull_location = in_bull_ob | in_bull_fvg | ssl_swept | liq_sweep_bull
    valid_bear_location = in_bear_ob | in_bear_fvg | bsl_swept | liq_sweep_bear
    loc_pen = (~valid_bull_location & ~valid_bear_location).astype(float) * pp["penalty_no_location"]

    score_penalty = vol_pen + regime_pen + ob_pen + vix_pen + vwap_pen + loc_pen
    execution_score = (raw_bias - score_penalty).clip(0, 100)
    buy_probability  = execution_score
    sell_probability = 100.0 - execution_score

    # ---- Grade system ----
    bull_structure = (ema9 > ema21) & (ema21 > ema50) & (c > ema21)
    bear_structure = (ema9 < ema21) & (ema21 < ema50) & (c < ema21)
    bull_confirmation = (c > o) & (c > h.shift(1)) & (rel_vol > 1.05)
    bear_confirmation = (c < o) & (c < l.shift(1)) & (rel_vol > 1.05)
    bullish_divergence = (c < c.shift(1)) & (rsi_val > rsi_val.shift(1))
    bearish_divergence = (c > c.shift(1)) & (rsi_val < rsi_val.shift(1))
    reversal_warning_bull = bearish_divergence & (macd_hist < macd_hist.shift(1))
    reversal_warning_bear = bullish_divergence & (macd_hist > macd_hist.shift(1))

    bull_grade_score = (
        bull_structure.astype(int)
        + is_trending.astype(int)
        + (sms > 8).astype(int)
        + bull_confirmation.astype(int)
        + (rel_vol > 1.1).astype(int)
        + (c > vwap_val).astype(int)
        + valid_bull_location.astype(int)
    )
    bear_grade_score = (
        bear_structure.astype(int)
        + is_trending.astype(int)
        + (sms < -8).astype(int)
        + bear_confirmation.astype(int)
        + (rel_vol > 1.1).astype(int)
        + (c < vwap_val).astype(int)
        + valid_bear_location.astype(int)
    )

    def grade_from_score(gs):
        return np.where(gs >= 6, "A", np.where(gs >= 4, "B", "C"))

    bull_grade = pd.Series(grade_from_score(bull_grade_score.values), index=ohlcv.index)
    bear_grade = pd.Series(grade_from_score(bear_grade_score.values), index=ohlcv.index)

    elite_bull_setup = (bull_grade == "A") & ~reversal_warning_bull & valid_bull_location & (rel_vol > 1.15)
    elite_bear_setup = (bear_grade == "A") & ~reversal_warning_bear & valid_bear_location & (rel_vol > 1.15)

    # ---- Signals ----
    allow_bull_basic = (bull_structure & valid_bull_location &
                        (rel_vol > adaptive_low_vol_thresh) &
                        ~reversal_warning_bull & ~bull_blocked)
    allow_bear_basic = (bear_structure & valid_bear_location &
                        (rel_vol > adaptive_low_vol_thresh) &
                        ~reversal_warning_bear & ~bear_blocked)

    min_score       = pp["min_score"]
    strong_buy_lv   = pp["strong_buy_level"]
    elite_buy_lv    = pp["elite_buy_level"]
    strong_sell_lv  = pp["strong_sell_level"]
    elite_sell_lv   = pp["elite_sell_level"]

    grade_ok_bull = (bull_grade == "A") if cfg.show_only_a_grade else ((bull_grade == "A") | (bull_grade == "B"))
    grade_ok_bear = (bear_grade == "A") if cfg.show_only_a_grade else ((bear_grade == "A") | (bear_grade == "B"))

    buy_signal   = (execution_score >= min_score) & (execution_score < strong_buy_lv) & allow_bull_basic & trade_allowed & grade_ok_bull
    strong_buy   = (execution_score >= strong_buy_lv) & allow_bull_basic & (bull_grade == "A") & (rel_vol > 1.05) & trade_allowed
    elite_buy    = (execution_score >= elite_buy_lv) & elite_bull_setup & trade_allowed & ~bull_blocked

    sell_signal  = (execution_score <= (100 - min_score)) & (execution_score > strong_sell_lv) & allow_bear_basic & trade_allowed & grade_ok_bear
    strong_sell  = (execution_score <= strong_sell_lv) & allow_bear_basic & (bear_grade == "A") & (rel_vol > 1.05) & trade_allowed
    elite_sell   = (execution_score <= elite_sell_lv) & elite_bear_setup & trade_allowed & ~bear_blocked

    new_buy_signal  = buy_signal  & ~buy_signal.shift(1, fill_value=False)
    new_strong_buy  = strong_buy  & ~strong_buy.shift(1, fill_value=False)
    new_elite_buy   = elite_buy   & ~elite_buy.shift(1, fill_value=False)
    new_sell_signal = sell_signal & ~sell_signal.shift(1, fill_value=False)
    new_strong_sell = strong_sell & ~strong_sell.shift(1, fill_value=False)
    new_elite_sell  = elite_sell  & ~elite_sell.shift(1, fill_value=False)

    def exec_bias(eb, sb, bs, es, ss, sel):
        if eb or sb or bs:
            return "LONG"
        if es or ss or sel:
            return "SHORT"
        return "STAND ASIDE"

    execution_bias = pd.Series([
        exec_bias(eb, sb, bs, es, ss, sel)
        for eb, sb, bs, es, ss, sel in zip(
            elite_buy.values, strong_buy.values, buy_signal.values,
            elite_sell.values, strong_sell.values, sell_signal.values)
    ], index=ohlcv.index)

    def signal_text_fn(eb, sb, bs, es, ss, sel):
        if eb:   return "ELITE BUY"
        if sb:   return "STRONG BUY"
        if bs:   return "BUY"
        if es:   return "ELITE SELL"
        if ss:   return "STRONG SELL"
        if sel:  return "SELL"
        return "NEUTRAL"

    signal_text_s = pd.Series([
        signal_text_fn(eb, sb, bs, es, ss, sel)
        for eb, sb, bs, es, ss, sel in zip(
            elite_buy.values, strong_buy.values, buy_signal.values,
            elite_sell.values, strong_sell.values, sell_signal.values)
    ], index=ohlcv.index)

    def grade_fn(st, bg, beargrade, escore):
        if st in ("ELITE BUY", "BUY", "STRONG BUY"):
            return bg
        if st in ("ELITE SELL", "SELL", "STRONG SELL"):
            return beargrade
        return bg if escore >= 50 else beargrade

    grade_s = pd.Series([
        grade_fn(st, bg, beargrade, escore)
        for st, bg, beargrade, escore in zip(
            signal_text_s.values, bull_grade.values, bear_grade.values, execution_score.values)
    ], index=ohlcv.index)

    # ---- Regime text ----
    regime_text = pd.Series("NEUTRAL", index=ohlcv.index)
    regime_text = regime_text.where(~is_bull_trend, "TRENDING BULL")
    regime_text = regime_text.where(~is_bear_trend, "TRENDING BEAR")
    regime_text = regime_text.where(~is_choppy, "CHOP / RANGE")

    # ---- Assemble result DataFrame ----
    result = pd.DataFrame(index=ohlcv.index)
    result["ema9"] = ema9
    result["ema21"] = ema21
    result["ema50"] = ema50
    result["sma200"] = sma200
    result["atr"] = atr_val
    result["rsi"] = rsi_val
    result["roc"] = roc_val
    result["vwap"] = vwap_val
    result["bb_upper"] = bb_upper
    result["bb_lower"] = bb_lower
    result["bb_width"] = bb_width
    result["rel_vol"] = rel_vol
    result["macd_line"] = macd_line
    result["macd_signal"] = sig_line
    result["macd_hist"] = macd_hist
    result["adx"] = adx_val
    result["chop"] = chop_val
    result["plus_di"] = plus_di
    result["minus_di"] = minus_di
    result["is_trending"] = is_trending
    result["is_choppy"] = is_choppy
    result["is_bull_trend"] = is_bull_trend
    result["is_bear_trend"] = is_bear_trend
    result["regime_score"] = regime_score
    result["regime_text"] = regime_text
    result["trend_score"] = trend_score
    result["mtf_score"] = mtf
    result["mom_score"] = mom_score
    result["vol_score"] = vol_score
    result["bb_score"] = bb_score
    result["price_action_score"] = pa_score
    result["smart_money_score"] = sms
    result["raw_bias_score"] = raw_bias
    result["bias_score"] = bias_score
    result["vol_penalty"] = vol_pen
    result["regime_penalty"] = regime_pen
    result["ob_penalty"] = ob_pen
    result["vix_penalty"] = vix_pen
    result["vwap_penalty"] = vwap_pen
    result["location_penalty"] = loc_pen
    result["score_penalty"] = score_penalty
    result["execution_score"] = execution_score
    result["buy_probability"] = buy_probability
    result["sell_probability"] = sell_probability
    result["liq_sweep_bull"] = liq_sweep_bull
    result["liq_sweep_bear"] = liq_sweep_bear
    # Internal smart_money_score components — exposed for diff_at_bar diagnostics
    result["bull_displacement"] = bull_displacement
    result["bear_displacement"] = bear_displacement
    result["smart_bull_flow"]   = smart_bull_flow
    result["smart_bear_flow"]   = smart_bear_flow
    result["bull_sweep_score"]  = bull_sweep_score
    result["bear_sweep_score"]  = bear_sweep_score
    # OB zones (Pine bullObHigh/Low, bearObHigh/Low) — path-dependent state.
    # Exposed so diff_at_bar can locate the first bar where OB zone diverges.
    result["bull_ob_high"]      = ob_high_bull
    result["bull_ob_low"]       = ob_low_bull
    result["bear_ob_high"]      = ob_high_bear
    result["bear_ob_low"]       = ob_low_bear
    result["bsl_level"] = bsl_level
    result["ssl_level"] = ssl_level
    result["bsl_swept"] = bsl_swept
    result["ssl_swept"] = ssl_swept
    result["bull_fvg"] = bull_fvg
    result["bear_fvg"] = bear_fvg
    result["in_bull_fvg"] = in_bull_fvg
    result["in_bear_fvg"] = in_bear_fvg
    result["in_bull_ob"] = in_bull_ob
    result["in_bear_ob"] = in_bear_ob
    result["bull_blocked_by_bear_ob"] = bull_blocked
    result["bear_blocked_by_bull_ob"] = bear_blocked
    result["valid_bull_location"] = valid_bull_location
    result["valid_bear_location"] = valid_bear_location
    result["bull_grade"] = bull_grade
    result["bear_grade"] = bear_grade
    result["buy_signal"] = buy_signal
    result["strong_buy"] = strong_buy
    result["elite_buy"] = elite_buy
    result["sell_signal"] = sell_signal
    result["strong_sell"] = strong_sell
    result["elite_sell"] = elite_sell
    result["new_buy_signal"] = new_buy_signal
    result["new_strong_buy"] = new_strong_buy
    result["new_elite_buy"] = new_elite_buy
    result["new_sell_signal"] = new_sell_signal
    result["new_strong_sell"] = new_strong_sell
    result["new_elite_sell"] = new_elite_sell
    result["execution_bias"] = execution_bias
    result["signal_text"] = signal_text_s
    result["grade"] = grade_s
    result["vix"] = vix_s
    result["trade_allowed"] = trade_allowed

    return result


def latest(
    ohlcv: pd.DataFrame,
    config: Optional[SuperScoreConfig] = None,
    **kwargs,
) -> dict:
    """
    Compute and return a dict of scalar values for the *last* bar only.
    Convenience wrapper around compute(); kwargs passed through.
    """
    df = compute(ohlcv, config=config, **kwargs)
    row = df.iloc[-1]
    return row.to_dict()


# ---------------------------------------------------------------------------
# Signal payload builder (canonical payload.py bridge)
# ---------------------------------------------------------------------------

def build_signal_payload(
    row: pd.Series,
    ohlcv_row: pd.Series,
    *,
    ticker: str = "",
    exchange: str = "",
    timeframe: str = "",
    alert_type: str = ALERT_TYPE_PERIODIC,
    previous_execution: str = "",
    chart_image_url: str = "",
    chart_vision_enabled: bool = False,
    signal_source: str = SIGNAL_SOURCE_SUPER_SCORE,
) -> dict:
    """
    Build a canonical QTP payload for one Super Score Pro v2.5 bar.

    Pine reference:
      * Core scores and signal labels: ai_super_score_pro_v25_universal.pine
        lines 358-395 and 418-424.
      * Alert conditions: lines 489-506. The Pro script emits alertcondition()
        messages rather than a full JSON alert, so this function maps the
        computed Pro state into the shared payload.py schema for server-side
        parity / drift testing.

    This is additive and shadow/local only. It does not connect to n8n.
    """
    def _f(key: str, default: float = 0.0) -> float:
        try:
            value = row.get(key, default)
            if pd.isna(value):
                return default
            return float(value)
        except Exception:
            return default

    def _s(key: str, default: str = "") -> str:
        value = row.get(key, default)
        if value is None or (isinstance(value, float) and pd.isna(value)):
            return default
        return str(value)

    price = float(ohlcv_row.get("close", 0.0))
    execution = _s("execution_bias", "STAND ASIDE")
    signal = "BULLISH" if execution == "LONG" else ("BEARISH" if execution == "SHORT" else "NEUTRAL")

    payload = {
        "timestamp": int(row.name.timestamp() * 1000) if hasattr(row.name, "timestamp") else 0,
        "ticker": ticker,
        "exchange": exchange,
        "timeframe": timeframe,
        "price": round(price, 4),
        "daily_high": round(float(ohlcv_row.get("high", price)), 4),
        "daily_low": round(float(ohlcv_row.get("low", price)), 4),
        "volume": int(float(ohlcv_row.get("volume", 0))),
        "avg_volume_30d": 0.0,
        "ai_super_score": {
            "execution": execution,
            "signal": signal,
            "regime": _s("regime_text", "NEUTRAL"),
            "bias_score": round(_f("bias_score", 50.0), 2),
            "exec_score": round(_f("execution_score", 50.0), 2),
            "grade": _s("grade", "C"),
            "smart_money": _s("smart_money_text", "NEUTRAL"),
            "liquidity": _s("liquidity_text", "NONE"),
            "fvg": _s("fvg_text", "NONE"),
            "order_block": _s("ob_text", "NONE"),
        },
        "technicals": {
            "rsi_14": round(_f("rsi", 50.0), 2),
            "macd_line": round(_f("macd_line", 0.0), 4),
            "macd_signal": round(_f("macd_signal", 0.0), 4),
            "macd_hist": round(_f("macd_hist", 0.0), 4),
            "sma_50": round(_f("ema50", 0.0), 2),
            "ema_200": round(_f("sma200", 0.0), 2),
            "vwap": round(_f("vwap", 0.0), 2),
            "atr_14": round(_f("atr", 0.0), 4),
            "price_vs_sma50": "ABOVE" if price > _f("ema50", price) else "BELOW",
            "price_vs_ema200": "ABOVE" if price > _f("sma200", price) else "BELOW",
        },
        "sweep": {
            "type": "BULL_SWEEP" if bool(row.get("liq_sweep_bull", False)) else (
                "BEAR_SWEEP" if bool(row.get("liq_sweep_bear", False)) else "NONE"
            ),
            "swing_low": round(_f("ssl_level", 0.0), 2),
            "swing_high": round(_f("bsl_level", 0.0), 2),
            "volume_ratio": round(_f("rel_vol", 0.0), 2),
        },
        "cross_asset": {
            "spy_price": 0.0,
            "spy_change_pct": 0.0,
            "spy_status": "WEAK",
            "qqq_price": 0.0,
            "qqq_change_pct": 0.0,
            "qqq_status": "WEAK",
            "xly_price": 0.0,
            "xly_change_pct": 0.0,
            "xly_status": "DIVERGING",
            "vix": round(_f("vix", 20.0), 2),
            "cross_asset_status": "PARTIAL",
        },
        "alert_type": alert_type,
        "previous_execution": previous_execution,
        "chart_image_url": chart_image_url,
        "chart_vision_enabled": chart_vision_enabled,
        "signal_source": signal_source,
        # Pro-specific flat fields for drift/debug parity.
        "execution_bias": execution,
        "signal_text": _s("signal_text", "NEUTRAL"),
        "grade": _s("grade", "C"),
        "execution_score": round(_f("execution_score", 50.0), 2),
        "bias_score": round(_f("bias_score", 50.0), 2),
        "buy_probability": round(_f("buy_probability", 50.0), 2),
        "sell_probability": round(_f("sell_probability", 50.0), 2),
        "regime_text": _s("regime_text", "NEUTRAL"),
        "smart_money_text": _s("smart_money_text", "NEUTRAL"),
        "liquidity_text": _s("liquidity_text", "NONE"),
        "fvg_text": _s("fvg_text", "NONE"),
        "ob_text": _s("ob_text", "NONE"),
        "score_penalty": round(_f("score_penalty", 0.0), 2),
        "vol_penalty": round(_f("vol_penalty", 0.0), 2),
        "regime_penalty": round(_f("regime_penalty", 0.0), 2),
        "ob_penalty": round(_f("ob_penalty", 0.0), 2),
        "vix_penalty": round(_f("vix_penalty", 0.0), 2),
        "vwap_penalty": round(_f("vwap_penalty", 0.0), 2),
        "location_penalty": round(_f("location_penalty", 0.0), 2),
    }
    return merge_payloads(empty_payload(signal_source), payload)
