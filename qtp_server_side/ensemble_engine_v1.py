"""
ensemble_engine_v1.py — Server-side port of
``AI Super Score Ensemble Engine v1`` (ai_super_score_ensemble_engine_v1.pine)

Shadow / local use only.  Not connected to n8n or production workflows.

Overview
--------
The Ensemble Engine combines:
  1. Manual AI Super Score hints (execution, signal, smart_money, etc.)
  2. Multi-timeframe (HTF) EMA confluence
  3. Market / leader (SPY/QQQ) alignment
  4. Session / VIX / ADX regime
  5. Price action (displacement, PDH/PDL sweeps, divergence)
  6. Component scoring with hard gates

Server-side notes
-----------------
* HTF data (tf_1..tf_4 EMAs) must be supplied by the caller as separate
  Series aligned to the primary ohlcv index.  Pass None to skip a level.
* ``barstate.isconfirmed`` — we treat every row as confirmed (batch mode).
  For live use, pass only the completed bars.
* ``ta.dmi(14, 14)`` is used for ADX.  Pine ensemble engine uses native
  ta.dmi; we use indicators.dmi().
* Signal persistence (prev_final_execution, cooldown) is replicated with
  a stateful loop in ``compute()``.
* Alert payload mirrors Pine lines 239-305.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Optional

import numpy as np
import pandas as pd

from . import indicators as ind
from .payload import SIGNAL_SOURCE_ENSEMBLE, empty_payload, merge_payloads

# ---------------------------------------------------------------------------
# Helpers (Pine functions score_bool, clamp_0_100, grade_from_score)
# ---------------------------------------------------------------------------

def score_bool(condition: bool, pts: float) -> float:
    """Pine ``score_bool`` helper."""
    return pts if condition else 0.0


def clamp_0_100(x: float) -> float:
    """Pine ``clamp_0_100``."""
    return min(100.0, max(0.0, x))


def grade_from_score(score: float) -> str:
    """
    Pine ``grade_from_score`` function (lines 13-29).
    A+ >= 95, A >= 90, B+ >= 85, B >= 80, C+ >= 70, C >= 60, D >= 50, else F.
    """
    if score >= 95: return "A+"
    if score >= 90: return "A"
    if score >= 85: return "B+"
    if score >= 80: return "B"
    if score >= 70: return "C+"
    if score >= 60: return "C"
    if score >= 50: return "D"
    return "F"


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

@dataclass
class EnsembleConfig:
    # Mirrored AI Super Score inputs
    execution:   str = "STAND ASIDE"
    signal:      str = "NEUTRAL"
    regime:      str = "NEUTRAL"
    bias_score:  float = 50.0
    exec_score:  float = 50.0
    grade:       str = "C"
    smart_money: str = "NEUTRAL"
    liquidity:   str = "NONE"
    fvg:         str = "NONE"
    order_block: str = "NONE"

    # Engine inputs
    active_session:       str = "0940-1545"
    min_tf_confirm:       int = 3
    min_market_confirm:   int = 2
    min_adx:              float = 20.0
    strong_adx:           float = 30.0
    max_vix:              float = 35.0
    min_rel_vol:          float = 1.10
    disp_body_mult:       float = 1.40
    wick_body_max:        float = 0.60
    location_atr_buffer:  float = 0.35
    min_action_score:     float = 80.0
    min_directional_edge: float = 5.0
    cooldown_bars:        int = 1
    alert_on_change_only: bool = True

    # Symbols (informational)
    market_symbol: str = "AMEX:SPY"
    leader_symbol: str = "NASDAQ:QQQ"


# ---------------------------------------------------------------------------
# Main compute
# ---------------------------------------------------------------------------

def compute(
    ohlcv: pd.DataFrame,
    config: Optional[EnsembleConfig] = None,
    *,
    # HTF EMA Series aligned to ohlcv.index
    # Pass Series of EMA-21 values computed on tf_1 timeframe, etc.
    htf_ema_1: Optional[pd.Series] = None,   # tf_1 ema(close,21) — default "15"
    htf_ema_2: Optional[pd.Series] = None,   # tf_2 ema(close,21) — default "60"
    htf_ema_3: Optional[pd.Series] = None,   # tf_3 ema(close,50) — default "240"
    htf_ema_4: Optional[pd.Series] = None,   # tf_4 ema(close,50) — default "D"
    market_close: Optional[pd.Series] = None,  # SPY close aligned
    market_ema:   Optional[pd.Series] = None,  # SPY ema(21) aligned
    leader_close: Optional[pd.Series] = None,  # QQQ close aligned
    leader_ema:   Optional[pd.Series] = None,  # QQQ ema(21) aligned
    vix_close:    Optional[pd.Series] = None,  # VIX daily close aligned
    day_high:     Optional[pd.Series] = None,
    day_low:      Optional[pd.Series] = None,
    prev_day_high: Optional[pd.Series] = None,
    prev_day_low:  Optional[pd.Series] = None,
) -> pd.DataFrame:
    """
    Compute ensemble scores for every bar in ohlcv.

    HTF EMAs are expected to be pre-computed and aligned to ohlcv.index
    (forward-filled from the higher timeframe).  Pass None to exclude a level
    (that HTF will contribute 0 to bull/bear counts).

    Returns a DataFrame with all component scores, final signals, and gate
    states per bar.  Alert payloads are built via build_alert_payload().
    """
    if config is None:
        config = EnsembleConfig()
    cfg = config

    c = ohlcv["close"]
    h = ohlcv["high"]
    l = ohlcv["low"]
    o = ohlcv["open"]
    v = ohlcv["volume"]

    # ---- Market data ----
    avg_volume = ind.sma(v, 30)
    rel_vol = (v / avg_volume.replace(0, np.nan)).fillna(0.0)

    rsi_14  = ind.rsi(c, 14)
    macd_l, macd_s, macd_h = ind.macd(c, 12, 26, 9)
    ema_21  = ind.ema(c, 21)
    ema_50  = ind.ema(c, 50)
    ema_200 = ind.ema(c, 200)
    vwap_val = ind.vwap_rolling(c, v, 30)
    atr_14   = ind.atr(h, l, c, 14)
    plus_di, minus_di, adx_value = ind.dmi(h, l, c, 14, 14)

    # Day high/low (provided externally; fallback to rolling 1-day proxy)
    if day_high is None:
        day_high = h.rolling(390, min_periods=1).max()
    if day_low is None:
        day_low = l.rolling(390, min_periods=1).min()
    if prev_day_high is None:
        prev_day_high = day_high.shift(1)
    if prev_day_low is None:
        prev_day_low = day_low.shift(1)

    vix_s = vix_close.reindex(ohlcv.index) if vix_close is not None else pd.Series(20.0, index=ohlcv.index)

    # ---- HTF confluence ----
    def htf_count(htf_ema):
        if htf_ema is None:
            return pd.Series(0, index=ohlcv.index)
        return (c > htf_ema.reindex(ohlcv.index)).astype(int)

    def htf_bear_count(htf_ema):
        if htf_ema is None:
            return pd.Series(0, index=ohlcv.index)
        return (c < htf_ema.reindex(ohlcv.index)).astype(int)

    bull_count = htf_count(htf_ema_1) + htf_count(htf_ema_2) + htf_count(htf_ema_3) + htf_count(htf_ema_4)
    bear_count = htf_bear_count(htf_ema_1) + htf_bear_count(htf_ema_2) + htf_bear_count(htf_ema_3) + htf_bear_count(htf_ema_4)

    # ---- Market / leader alignment ----
    def mk(s, fallback):
        return s.reindex(ohlcv.index) if s is not None else pd.Series(fallback, index=ohlcv.index)

    mc = mk(market_close, c.values)
    me = mk(market_ema, ema_21.values)
    lc = mk(leader_close, c.values)
    le = mk(leader_ema, ema_21.values)

    market_bull_count = (
        (mc > me).astype(int)
        + (lc > le).astype(int)
        + (c > vwap_val).astype(int)
    )
    market_bear_count = (
        (mc < me).astype(int)
        + (lc < le).astype(int)
        + (c < vwap_val).astype(int)
    )

    # ---- Session / regime ----
    # NOTE: session_ok is approximated as always True without a DatetimeIndex
    if isinstance(ohlcv.index, pd.DatetimeIndex):
        # Approximate: allow all bars (full session filter requires timezone-aware parsing)
        session_ok = pd.Series(True, index=ohlcv.index)
    else:
        session_ok = pd.Series(True, index=ohlcv.index)

    def vix_regime_fn(v):
        if v < 15:   return "LOW_VOL"
        if v < 20:   return "NORMAL"
        if v < 25:   return "ELEVATED"
        if v < 30:   return "HIGH"
        return "EXTREME"

    vix_regime = vix_s.apply(vix_regime_fn)
    tradeable_environment = session_ok & (adx_value >= cfg.min_adx) & (vix_s < cfg.max_vix)

    # ---- Price action / location ----
    body_size = (c - o).abs()
    avg_body  = ind.sma(body_size, 20)
    upper_wick = h - pd.concat([o, c], axis=1).max(axis=1)
    lower_wick = pd.concat([o, c], axis=1).min(axis=1) - l

    bull_displacement = (
        (c > o)
        & (body_size > avg_body * cfg.disp_body_mult)
        & (upper_wick <= body_size * cfg.wick_body_max)
        & (body_size > atr_14 * 0.20)
    )
    bear_displacement = (
        (c < o)
        & (body_size > avg_body * cfg.disp_body_mult)
        & (lower_wick <= body_size * cfg.wick_body_max)
        & (body_size > atr_14 * 0.20)
    )

    near_pdl = (c - prev_day_low).abs() <= atr_14 * cfg.location_atr_buffer
    near_pdh = (c - prev_day_high).abs() <= atr_14 * cfg.location_atr_buffer

    bull_pdl_sweep = (l < prev_day_low) & (c > prev_day_low)
    bear_pdh_sweep = (h > prev_day_high) & (c < prev_day_high)

    price_lower_low   = l < ind.lowest(l, 10, shift=1)
    price_higher_high = h > ind.highest(h, 10, shift=1)
    rsi_higher_low    = rsi_14 > ind.lowest(rsi_14, 10, shift=1)
    rsi_lower_high    = rsi_14 < ind.highest(rsi_14, 10, shift=1)

    bull_divergence = price_lower_low & rsi_higher_low
    bear_divergence = price_higher_high & rsi_lower_high

    # ---- Manual hints from AI Super Score ----
    manual_bull_exec = cfg.execution == "BUY"
    manual_bear_exec = cfg.execution == "SELL"
    manual_bull_sig  = cfg.signal == "BULLISH"
    manual_bear_sig  = cfg.signal == "BEARISH"
    manual_bull_sm   = cfg.smart_money == "BULLISH"
    manual_bear_sm   = cfg.smart_money == "BEARISH"
    manual_ssl       = "SSL" in cfg.liquidity
    manual_bsl       = "BSL" in cfg.liquidity
    manual_bull_fvg  = "BULL" in cfg.fvg
    manual_bear_fvg  = "BEAR" in cfg.fvg
    manual_bull_ob   = "BULL" in cfg.order_block
    manual_bear_ob   = "BEAR" in cfg.order_block

    # ---- Component scores ----
    manual_bull_score = (
        score_bool(manual_bull_exec, 8.0)
        + score_bool(manual_bull_sig, 5.0)
        + score_bool(manual_bull_sm, 4.0)
        + score_bool(manual_bull_ob, 2.0)
        + score_bool(manual_ssl, 1.0)
    )
    manual_bear_score = (
        score_bool(manual_bear_exec, 8.0)
        + score_bool(manual_bear_sig, 5.0)
        + score_bool(manual_bear_sm, 4.0)
        + score_bool(manual_bear_ob, 2.0)
        + score_bool(manual_bsl, 1.0)
    )

    mtf_bull_score = bull_count / 4.0 * 25.0
    mtf_bear_score = bear_count / 4.0 * 25.0

    # Regime score (per bar, vector)
    def _regime_score(adx, vix):
        if adx >= cfg.strong_adx:  base = 15.0
        elif adx >= 25:            base = 12.0
        elif adx >= cfg.min_adx:   base =  8.0
        else:                      base =  0.0
        if vix < 20:               pen = 0.0
        elif vix < 25:             pen = 2.0
        elif vix < 30:             pen = 5.0
        else:                      pen = 8.0
        return max(0.0, base - pen)

    regime_score_s = pd.Series([
        _regime_score(adx, vix) if te else 0.0
        for adx, vix, te in zip(adx_value.values, vix_s.values, tradeable_environment.values)
    ], index=ohlcv.index)

    vol_score_s = pd.Series([
        10.0 if rv >= 2.0 else 8.0 if rv >= 1.5 else 6.0 if rv >= 1.2 else 4.0 if rv >= cfg.min_rel_vol else 0.0
        for rv in rel_vol.values
    ], index=ohlcv.index)

    momentum_bull = (
        ((rsi_14 > 52).astype(float) * 3.0)
        + (((macd_l > macd_s) & (macd_h > macd_h.shift(1))).astype(float) * 4.0)
        + ((c > vwap_val).astype(float) * 3.0)
    )
    momentum_bear = (
        ((rsi_14 < 48).astype(float) * 3.0)
        + (((macd_l < macd_s) & (macd_h < macd_h.shift(1))).astype(float) * 4.0)
        + ((c < vwap_val).astype(float) * 3.0)
    )

    location_bull = (
        bull_pdl_sweep.astype(float) * 5.0
        + near_pdl.astype(float) * 1.0
        + float(manual_ssl) * 1.5
        + float(manual_bull_ob) * 1.5
        + float(manual_bull_fvg) * 1.0
    )
    location_bear = (
        bear_pdh_sweep.astype(float) * 5.0
        + near_pdh.astype(float) * 1.0
        + float(manual_bsl) * 1.5
        + float(manual_bear_ob) * 1.5
        + float(manual_bear_fvg) * 1.0
    )

    market_bull_s = market_bull_count / 3.0 * 10.0
    market_bear_s = market_bear_count / 3.0 * 10.0

    divergence_bull_bonus = bull_divergence.astype(float) * 5.0
    divergence_bear_bonus = bear_divergence.astype(float) * 5.0

    # ---- Raw ensemble scores ----
    raw_bull = (
        manual_bull_score + mtf_bull_score + regime_score_s + vol_score_s
        + momentum_bull + location_bull + market_bull_s + divergence_bull_bonus
    ).clip(0, 100)
    raw_bear = (
        manual_bear_score + mtf_bear_score + regime_score_s + vol_score_s
        + momentum_bear + location_bear + market_bear_s + divergence_bear_bonus
    ).clip(0, 100)

    # ---- Hard gates ----
    bull_mtf_gate      = bull_count >= cfg.min_tf_confirm
    bear_mtf_gate      = bear_count >= cfg.min_tf_confirm
    bull_market_gate   = market_bull_count >= cfg.min_market_confirm
    bear_market_gate   = market_bear_count >= cfg.min_market_confirm
    bull_location_gate = bull_pdl_sweep | (manual_ssl & (manual_bull_ob or manual_bull_fvg))
    bear_location_gate = bear_pdh_sweep | (manual_bsl & (manual_bear_ob or manual_bear_fvg))
    bull_confirm_gate  = bull_displacement & (c > vwap_val) & (rel_vol >= cfg.min_rel_vol)
    bear_confirm_gate  = bear_displacement & (c < vwap_val) & (rel_vol >= cfg.min_rel_vol)

    bull_hard_ok = (
        tradeable_environment & bull_mtf_gate & bull_market_gate
        & bull_location_gate & bull_confirm_gate
    )
    bear_hard_ok = (
        tradeable_environment & bear_mtf_gate & bear_market_gate
        & bear_location_gate & bear_confirm_gate
    )

    bull_ready = (
        bull_hard_ok
        & (raw_bull >= cfg.min_action_score)
        & (raw_bull > raw_bear + cfg.min_directional_edge)
    )
    bear_ready = (
        bear_hard_ok
        & (raw_bear >= cfg.min_action_score)
        & (raw_bear > raw_bull + cfg.min_directional_edge)
    )

    # ---- Final outputs ----
    final_execution = pd.Series(np.where(bull_ready, "BUY", np.where(bear_ready, "SELL", "STAND ASIDE")),
                                index=ohlcv.index)
    final_signal    = pd.Series(np.where(bull_ready, "BULLISH", np.where(bear_ready, "BEARISH", "NEUTRAL")),
                                index=ohlcv.index)

    def _final_regime(adx):
        if adx > 25: return "TRENDING"
        if adx < 18: return "MEAN REVERTING"
        return "NEUTRAL"
    final_regime = adx_value.apply(_final_regime)

    final_score = pd.Series(
        np.where(bull_ready, raw_bull, np.where(bear_ready, raw_bear, np.maximum(raw_bull.values, raw_bear.values))),
        index=ohlcv.index,
    )
    final_grade = final_score.apply(grade_from_score)

    ensemble_bias = pd.Series(
        np.where(raw_bull > raw_bear, "BULLISH", np.where(raw_bear > raw_bull, "BEARISH", "NEUTRAL")),
        index=ohlcv.index,
    )

    # ---- Signal change detection with cooldown (stateful) ----
    prev_exec_arr = [""] * len(ohlcv)
    execution_changed_arr = [False] * len(ohlcv)
    new_actionable_arr = [False] * len(ohlcv)
    last_alert_bar = -999

    for i, fe in enumerate(final_execution.values):
        prev = prev_exec_arr[i - 1] if i > 0 else ""
        exec_changed = (fe != prev and prev != "")
        new_actionable = (fe != "STAND ASIDE" and fe != prev)
        can_alert = (i - last_alert_bar) >= cfg.cooldown_bars
        should = can_alert and (
            (cfg.alert_on_change_only and new_actionable)
            or (not cfg.alert_on_change_only and (new_actionable or exec_changed))
        )
        execution_changed_arr[i] = exec_changed
        new_actionable_arr[i] = new_actionable
        if should:
            last_alert_bar = i
        prev_exec_arr[i] = fe

    prev_execution_s = pd.Series(prev_exec_arr, index=ohlcv.index)
    execution_changed_s = pd.Series(execution_changed_arr, index=ohlcv.index)
    new_actionable_s = pd.Series(new_actionable_arr, index=ohlcv.index)

    # ---- Assemble result ----
    res = pd.DataFrame(index=ohlcv.index)
    res["rsi_14"]       = rsi_14
    res["adx"]          = adx_value
    res["plus_di"]      = plus_di
    res["minus_di"]     = minus_di
    res["rel_vol"]      = rel_vol
    res["vix"]          = vix_s
    res["vix_regime"]   = vix_regime
    res["tradeable_environment"] = tradeable_environment
    res["bull_count"]   = bull_count
    res["bear_count"]   = bear_count
    res["market_bull_count"] = market_bull_count
    res["market_bear_count"] = market_bear_count
    res["bull_displacement"] = bull_displacement
    res["bear_displacement"] = bear_displacement
    res["near_pdl"]     = near_pdl
    res["near_pdh"]     = near_pdh
    res["bull_pdl_sweep"] = bull_pdl_sweep
    res["bear_pdh_sweep"] = bear_pdh_sweep
    res["bull_divergence"] = bull_divergence
    res["bear_divergence"] = bear_divergence
    res["manual_bull_score"] = manual_bull_score
    res["manual_bear_score"] = manual_bear_score
    res["mtf_bull_score"] = mtf_bull_score
    res["mtf_bear_score"] = mtf_bear_score
    res["regime_score"] = regime_score_s
    res["volume_score"] = vol_score_s
    res["momentum_bull_score"] = momentum_bull
    res["momentum_bear_score"] = momentum_bear
    res["location_bull_score"] = location_bull
    res["location_bear_score"] = location_bear
    res["market_bull_score"] = market_bull_s
    res["market_bear_score"] = market_bear_s
    res["divergence_bull_bonus"] = divergence_bull_bonus
    res["divergence_bear_bonus"] = divergence_bear_bonus
    res["raw_bull_score"] = raw_bull
    res["raw_bear_score"] = raw_bear
    res["bull_mtf_gate"]      = bull_mtf_gate
    res["bear_mtf_gate"]      = bear_mtf_gate
    res["bull_market_gate"]   = bull_market_gate
    res["bear_market_gate"]   = bear_market_gate
    res["bull_location_gate"] = bull_location_gate
    res["bear_location_gate"] = bear_location_gate
    res["bull_confirm_gate"]  = bull_confirm_gate
    res["bear_confirm_gate"]  = bear_confirm_gate
    res["bull_hard_ok"]       = bull_hard_ok
    res["bear_hard_ok"]       = bear_hard_ok
    res["bull_ready"]         = bull_ready
    res["bear_ready"]         = bear_ready
    res["final_execution"]    = final_execution
    res["final_signal"]       = final_signal
    res["final_regime"]       = final_regime
    res["final_score"]        = final_score
    res["final_grade"]        = final_grade
    res["ensemble_bias"]      = ensemble_bias
    res["execution_changed"]  = execution_changed_s
    res["new_actionable_signal"] = new_actionable_s
    res["prev_final_execution"]  = prev_execution_s
    return res


# ---------------------------------------------------------------------------
# Alert payload builder (mirrors Pine lines 239-305)
# ---------------------------------------------------------------------------

def build_alert_payload(
    row: pd.Series,
    cfg: EnsembleConfig,
    ohlcv_row: pd.Series,
    day_high: float,
    day_low: float,
    prev_day_high: float,
    prev_day_low: float,
    chart_image_url: str = "",
    chart_vision_enabled: bool = False,
    signal_source: str = SIGNAL_SOURCE_ENSEMBLE,
) -> dict:
    """
    Build the alert JSON payload for a single confirmed bar.
    ``row`` is a row from the DataFrame returned by compute().
    ``ohlcv_row`` is the corresponding OHLCV row.
    """
    ts = int(row.name.timestamp() * 1000) if hasattr(row.name, "timestamp") else 0

    payload = {
        "timestamp":      str(ts),
        "ticker":         "",                            # fill from caller
        "exchange":       "",
        "timeframe":      "",
        "price":          round(float(ohlcv_row["close"]), 2),
        "day_high":       round(day_high, 2),
        "day_low":        round(day_low, 2),
        "prev_day_high":  round(prev_day_high, 2),
        "prev_day_low":   round(prev_day_low, 2),
        "volume":         int(ohlcv_row["volume"]),
        "relative_volume": round(float(row["rel_vol"]), 2),
        "vix":            round(float(row["vix"]), 2),
        "vix_regime":     str(row["vix_regime"]),
        "adx":            round(float(row["adx"]), 2),
        "ensemble": {
            "execution":          str(row["final_execution"]),
            "signal":             str(row["final_signal"]),
            "regime":             str(row["final_regime"]),
            "bias":               str(row["ensemble_bias"]),
            "score":              round(float(row["final_score"]), 2),
            "grade":              str(row["final_grade"]),
            "bull_score":         round(float(row["raw_bull_score"]), 2),
            "bear_score":         round(float(row["raw_bear_score"]), 2),
            "previous_execution": str(row["prev_final_execution"]),
        },
        "components": {
            "manual_bull":    round(float(row["manual_bull_score"]), 2),
            "manual_bear":    round(float(row["manual_bear_score"]), 2),
            "mtf_bull":       round(float(row["mtf_bull_score"]), 2),
            "mtf_bear":       round(float(row["mtf_bear_score"]), 2),
            "regime":         round(float(row["regime_score"]), 2),
            "volume":         round(float(row["volume_score"]), 2),
            "momentum_bull":  round(float(row["momentum_bull_score"]), 2),
            "momentum_bear":  round(float(row["momentum_bear_score"]), 2),
            "location_bull":  round(float(row["location_bull_score"]), 2),
            "location_bear":  round(float(row["location_bear_score"]), 2),
            "market_bull":    round(float(row["market_bull_score"]), 2),
            "market_bear":    round(float(row["market_bear_score"]), 2),
            "div_bull":       round(float(row["divergence_bull_bonus"]), 2),
            "div_bear":       round(float(row["divergence_bear_bonus"]), 2),
        },
        "gates": {
            "tradeable_environment": bool(row["tradeable_environment"]),
            "bull_mtf_gate":         bool(row["bull_mtf_gate"]),
            "bear_mtf_gate":         bool(row["bear_mtf_gate"]),
            "bull_market_gate":      bool(row["bull_market_gate"]),
            "bear_market_gate":      bool(row["bear_market_gate"]),
            "bull_location_gate":    bool(row["bull_location_gate"]),
            "bear_location_gate":    bool(row["bear_location_gate"]),
            "bull_confirm_gate":     bool(row["bull_confirm_gate"]),
            "bear_confirm_gate":     bool(row["bear_confirm_gate"]),
        },
        "mirrored_ai_super_score": {
            "execution":   cfg.execution,
            "signal":      cfg.signal,
            "regime":      cfg.regime,
            "bias_score":  round(cfg.bias_score, 2),
            "exec_score":  round(cfg.exec_score, 2),
            "grade":       cfg.grade,
            "smart_money": cfg.smart_money,
            "liquidity":   cfg.liquidity,
            "fvg":         cfg.fvg,
            "order_block": cfg.order_block,
        },
        # Server-side extensions
        "chart_image_url":      chart_image_url,
        "chart_vision_enabled": chart_vision_enabled,
        "signal_source":        signal_source,
    }
    return merge_payloads(empty_payload(signal_source), payload)


def build_signal_payload(*args, **kwargs) -> dict:
    """
    Alias for build_alert_payload().

    Kept for package-level consistency with the other indicator ports and for
    the QTP parity harness. The payload still mirrors Pine lines 239-305 and
    is normalized through payload.py via build_alert_payload().
    """
    return build_alert_payload(*args, **kwargs)
