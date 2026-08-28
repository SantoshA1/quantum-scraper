"""
webhook_bridge_v8.py — Server-side port of
``AI Super Score Webhook Bridge v8`` (ai_super_score_webhook_bridge_v8.pine)

Shadow / local use only.  Not connected to n8n or production workflows.

Role
----
The Pine bridge is a *manual data entry + technical overlay* indicator.
The user types in AI Super Score readings (execution, signal, regime, etc.)
as Pine inputs, and the bridge wraps them into a JSON payload alongside
live technicals and cross-asset data.

Server-side equivalent
-----------------------
``build_payload()`` assembles the same JSON structure.  The AI Super Score
readings are provided as keyword arguments rather than manual Pine inputs.

Cross-asset fields (SPY, QQQ, XLY, VIX) must be supplied by the caller
as scalar floats or as Series aligned to the bar's timestamp.

Pine-specific fields preserved
-------------------------------
* chart_image_url  — passed through from caller (default "")
* chart_vision_enabled — passed through (default False)
* signal_source    — passed through (default "webhook_bridge_v8")

Sweep detection
---------------
Pine computes bull/bear sweeps on every bar.  We expose
``detect_sweeps()`` which operates on a full OHLCV DataFrame and returns
a DataFrame with sweep columns, mirroring Pine lines 90-115.

NOTE: Pine ``adx_val`` in this file uses a non-standard formula:
    ``ta.rma(abs(ta.change(high) - ta.change(low)), 14)``
  This is NOT the canonical ADX.  We reproduce it faithfully as
  ``pseudo_adx()``.  Use indicators.dmi() for true ADX.
"""

from __future__ import annotations

import json
import time as _time
from dataclasses import dataclass, field
from typing import Any, Optional

import numpy as np
import pandas as pd

from . import indicators as ind
from .payload import SIGNAL_SOURCE_BRIDGE, empty_payload, merge_payloads

# ---------------------------------------------------------------------------
# Config / defaults — mirrors Pine inputs
# ---------------------------------------------------------------------------

@dataclass
class BridgeConfig:
    # AI Super Score manual fields (Pine inputs i_*)
    execution:   str = "STAND ASIDE"   # "BUY" | "SELL" | "STAND ASIDE"
    signal:      str = "NEUTRAL"       # "BULLISH" | "BEARISH" | "NEUTRAL"
    regime:      str = "NEUTRAL"       # "TRENDING" | "MEAN REVERTING" | "NEUTRAL"
    bias_score:  float = 25.0
    exec_score:  float = 0.0
    grade:       str = "C"
    smart_money: str = "BULLISH"
    liquidity:   str = "SSL NEAR"
    fvg:         str = "NONE"
    order_block: str = "BULL OB BELOW"

    # Sweep settings
    sweep_lookback: int = 20
    sweep_vol_mult: float = 1.5

    # Extra fields preserved from payload.py spec
    chart_image_url: str = ""
    chart_vision_enabled: bool = False
    signal_source: str = "webhook_bridge_v8"


# ---------------------------------------------------------------------------
# Pseudo-ADX from Pine bridge (non-standard formula)
# ---------------------------------------------------------------------------

def pseudo_adx(high: pd.Series, low: pd.Series, length: int = 14) -> pd.Series:
    """
    Reproduces Pine bridge line:
        adx_val = ta.rma(abs(ta.change(high) - ta.change(low)), 14)

    This is NOT canonical ADX — it is the formula in the bridge script only.
    NOTE: This is an unusual proxy for directional strength and will diverge
    significantly from standard ADX.  VALIDATION REQUIRED.
    """
    dh = ind.change(high, 1)
    dl = ind.change(low, 1)
    return ind.rma((dh - dl).abs(), length)


# ---------------------------------------------------------------------------
# Cross-asset health helpers (mirrors Pine lines 68-82)
# ---------------------------------------------------------------------------

def cross_asset_flags(
    spy_close: float,
    spy_sma20: float,
    spy_ema50: float,
    spy_prev: float,
    qqq_close: float,
    qqq_sma20: float,
    qqq_ema50: float,
    qqq_prev: float,
    xly_close: float,
    xly_sma20: float,
    xly_ema50: float,
) -> dict:
    """
    Compute cross-asset health flags for a single bar — mirrors Pine lines 68-82.
    All inputs are scalar floats.
    """
    spy_change = spy_close - spy_prev
    qqq_change = qqq_close - qqq_prev

    spy_healthy       = spy_close > spy_sma20 and spy_close > spy_ema50
    qqq_healthy       = qqq_close > qqq_sma20 and qqq_close > qqq_ema50
    xly_aligned       = xly_close > xly_sma20 and xly_close > xly_ema50

    spy_breaking_down = (spy_close < spy_sma20 and spy_close < spy_ema50 and spy_change < 0)
    qqq_breaking_down = (qqq_close < qqq_sma20 and qqq_close < qqq_ema50 and qqq_change < 0)

    cross_asset_bullish = not spy_breaking_down and not qqq_breaking_down
    cross_asset_strong  = cross_asset_bullish and xly_aligned

    if spy_breaking_down:
        cross_asset_status = "SPY_BREAKDOWN"
    elif qqq_breaking_down:
        cross_asset_status = "QQQ_BREAKDOWN"
    elif cross_asset_strong:
        cross_asset_status = "ALL_ALIGNED"
    else:
        cross_asset_status = "PARTIAL"

    spy_chg_pct = (spy_change / spy_prev * 100) if spy_prev != 0 else 0.0
    qqq_chg_pct = (qqq_change / qqq_prev * 100) if qqq_prev != 0 else 0.0

    spy_health_str = "HEALTHY" if spy_healthy else ("BREAKING_DOWN" if spy_breaking_down else "WEAK")
    qqq_health_str = "HEALTHY" if qqq_healthy else ("BREAKING_DOWN" if qqq_breaking_down else "WEAK")
    xly_health_str = "ALIGNED" if xly_aligned else "DIVERGING"

    return {
        "spy_healthy": spy_healthy,
        "qqq_healthy": qqq_healthy,
        "xly_aligned": xly_aligned,
        "spy_breaking_down": spy_breaking_down,
        "qqq_breaking_down": qqq_breaking_down,
        "cross_asset_bullish": cross_asset_bullish,
        "cross_asset_strong": cross_asset_strong,
        "cross_asset_status": cross_asset_status,
        "spy_change_pct": spy_chg_pct,
        "qqq_change_pct": qqq_chg_pct,
        "spy_status": spy_health_str,
        "qqq_status": qqq_health_str,
        "xly_status": xly_health_str,
    }


# ---------------------------------------------------------------------------
# Sweep detection (mirrors Pine lines 90-115)
# ---------------------------------------------------------------------------

def detect_sweeps(
    ohlcv: pd.DataFrame,
    lookback: int = 20,
    vol_mult: float = 1.5,
    vol_avg_len: int = 30,
) -> pd.DataFrame:
    """
    Detect bull / bear sweeps on a full OHLCV DataFrame.

    Returns a DataFrame with columns:
        bull_sweep, bear_sweep, prev_swing_high, prev_swing_low,
        swing_high, swing_low, high_volume, volume_ratio
    """
    h = ohlcv["high"]
    l = ohlcv["low"]
    c = ohlcv["close"]
    v = ohlcv["volume"]
    o = ohlcv["open"]

    avg_vol = ind.sma(v, vol_avg_len)
    high_volume = v > avg_vol * vol_mult

    swing_high = ind.highest(h, lookback)
    swing_low  = ind.lowest(l, lookback)
    prev_swing_high = ind.highest(h, lookback, shift=1)
    prev_swing_low  = ind.lowest(l, lookback, shift=1)

    # Pine: bull_sweep = low < prev_swing_low AND close > open AND high_volume
    bull_sweep = (l < prev_swing_low) & (c > o) & high_volume
    # Pine: bear_sweep = high > prev_swing_high AND close < open AND high_volume
    bear_sweep = (h > prev_swing_high) & (c < o) & high_volume

    volume_ratio = (v / avg_vol.replace(0, np.nan)).fillna(0)

    result = pd.DataFrame(index=ohlcv.index)
    result["bull_sweep"]      = bull_sweep
    result["bear_sweep"]      = bear_sweep
    result["sweep_type"]      = np.where(bull_sweep, "BULL_SWEEP",
                                np.where(bear_sweep, "BEAR_SWEEP", "NONE"))
    result["swing_high"]      = swing_high
    result["swing_low"]       = swing_low
    result["prev_swing_high"] = prev_swing_high
    result["prev_swing_low"]  = prev_swing_low
    result["high_volume"]     = high_volume
    result["volume_ratio"]    = volume_ratio

    return result


# ---------------------------------------------------------------------------
# Technicals block (mirrors Pine lines 28-37)
# ---------------------------------------------------------------------------

def compute_technicals(ohlcv: pd.DataFrame, vol_avg_len: int = 30) -> pd.DataFrame:
    """
    Compute technicals that the bridge attaches to each payload.
    Returns last-bar scalars when called via .iloc[-1].to_dict().

    NOTE: bridge uses ta.vwap(close) (uses close, not hlc3).
    Pine bridge ADX is pseudo_adx not canonical — reproduced faithfully.
    """
    c = ohlcv["close"]
    h = ohlcv["high"]
    l = ohlcv["low"]
    v = ohlcv["volume"]

    avg_vol = ind.sma(v, vol_avg_len)
    rsi_14  = ind.rsi(c, 14)
    macd_l, macd_s, macd_h = ind.macd(c, 12, 26, 9)
    sma_50  = ind.sma(c, 50)
    ema_200 = ind.ema(c, 200)
    vwap_val = ind.vwap_rolling(c, v, 30)  # bridge uses close not hlc3
    atr_val = ind.atr(h, l, c, 14)
    adx_val = pseudo_adx(h, l, 14)

    df = pd.DataFrame(index=ohlcv.index)
    df["rsi_14"]        = rsi_14
    df["macd_line"]     = macd_l
    df["macd_signal"]   = macd_s
    df["macd_hist"]     = macd_h
    df["sma_50"]        = sma_50
    df["ema_200"]       = ema_200
    df["vwap"]          = vwap_val
    df["atr_14"]        = atr_val
    df["adx_val"]       = adx_val
    df["avg_volume_30d"]= avg_vol
    df["price_vs_sma50"]  = np.where(c > sma_50, "ABOVE", "BELOW")
    df["price_vs_ema200"] = np.where(c > ema_200, "ABOVE", "BELOW")
    return df


# ---------------------------------------------------------------------------
# Alert type detection (mirrors Pine lines 173-176)
# ---------------------------------------------------------------------------

def alert_type(
    prev_execution: str,
    current_execution: str,
    bull_sweep: bool,
    bear_sweep: bool,
) -> tuple[str, bool]:
    """
    Returns (alert_type_str, should_alert) mirroring Pine lines 173-176.

    Priority: SIGNAL_CHANGE > BULL_SWEEP > BEAR_SWEEP > PERIODIC_UPDATE
    should_alert = True for signal changes and sweeps.
    """
    execution_changed = (prev_execution != "" and current_execution != prev_execution)
    if execution_changed:
        return "SIGNAL_CHANGE", True
    if bull_sweep:
        return "BULL_SWEEP", True
    if bear_sweep:
        return "BEAR_SWEEP", True
    return "PERIODIC_UPDATE", False


# ---------------------------------------------------------------------------
# Payload builder (mirrors Pine lines 181-244)
# ---------------------------------------------------------------------------

def build_payload(
    *,
    # Market bar data
    timestamp: int,           # unix ms (Pine timenow)
    ticker: str,
    exchange: str,
    timeframe: str,
    price: float,
    daily_high: float,
    daily_low: float,
    volume: float,
    avg_volume_30d: float,
    # AI Super Score fields (manual in Pine; computed upstream here)
    execution: str,
    signal: str,
    regime: str,
    bias_score: float,
    exec_score: float,
    grade: str,
    smart_money: str,
    liquidity: str,
    fvg: str,
    order_block: str,
    # Technicals
    rsi_14: float,
    macd_line: float,
    macd_signal: float,
    macd_hist: float,
    sma_50: float,
    ema_200: float,
    vwap: float,
    atr_14: float,
    price_vs_sma50: str,
    price_vs_ema200: str,
    # Sweep data
    sweep_type: str,
    prev_swing_low: float,
    prev_swing_high: float,
    volume_ratio: float,
    # Cross-asset
    spy_price: float,
    spy_change_pct: float,
    spy_status: str,
    qqq_price: float,
    qqq_change_pct: float,
    qqq_status: str,
    xly_price: float,
    xly_change_pct: float,
    xly_status: str,
    vix: float,
    cross_asset_status: str,
    # Alert meta
    alert_type_str: str,
    previous_execution: str,
    # Extra fields (not in Pine, added for server-side completeness)
    chart_image_url: str = "",
    chart_vision_enabled: bool = False,
    signal_source: str = SIGNAL_SOURCE_BRIDGE,
) -> dict:
    """
    Assembles the full JSON payload matching Pine's ``full_msg`` (lines 244).
    Returns a dict (serialize with json.dumps).

    Fields exactly mirror Pine p1..p4 + p_sweep + p_cross sections.
    chart_image_url, chart_vision_enabled, signal_source are server-side
    additions — not present in Pine but expected by downstream n8n nodes.
    """
    payload = {
        "timestamp": timestamp,
        "ticker": ticker,
        "exchange": exchange,
        "timeframe": timeframe,
        "price": round(price, 4),
        "daily_high": round(daily_high, 4),
        "daily_low": round(daily_low, 4),
        "volume": int(volume),
        "avg_volume_30d": round(avg_volume_30d, 2),
        "ai_super_score": {
            "execution":   execution,
            "signal":      signal,
            "regime":      regime,
            "bias_score":  round(bias_score, 2),
            "exec_score":  round(exec_score, 2),
            "grade":       grade,
            "smart_money": smart_money,
            "liquidity":   liquidity,
            "fvg":         fvg,
            "order_block": order_block,
        },
        "technicals": {
            "rsi_14":          round(rsi_14, 2),
            "macd_line":       round(macd_line, 4),
            "macd_signal":     round(macd_signal, 4),
            "macd_hist":       round(macd_hist, 4),
            "sma_50":          round(sma_50, 2),
            "ema_200":         round(ema_200, 2),
            "vwap":            round(vwap, 2),
            "atr_14":          round(atr_14, 4),
            "price_vs_sma50":  price_vs_sma50,
            "price_vs_ema200": price_vs_ema200,
        },
        "sweep": {
            "type":         sweep_type,
            "swing_low":    round(prev_swing_low, 2),
            "swing_high":   round(prev_swing_high, 2),
            "volume_ratio": round(volume_ratio, 2),
        },
        "cross_asset": {
            "spy_price":          round(spy_price, 2),
            "spy_change_pct":     round(spy_change_pct, 2),
            "spy_status":         spy_status,
            "qqq_price":          round(qqq_price, 2),
            "qqq_change_pct":     round(qqq_change_pct, 2),
            "qqq_status":         qqq_status,
            "xly_price":          round(xly_price, 2),
            "xly_change_pct":     round(xly_change_pct, 2),
            "xly_status":         xly_status,
            "vix":                round(vix, 2),
            "cross_asset_status": cross_asset_status,
        },
        "alert_type":         alert_type_str,
        "previous_execution": previous_execution,
        # Server-side extensions
        "chart_image_url":       chart_image_url,
        "chart_vision_enabled":  chart_vision_enabled,
        "signal_source":         signal_source,
    }
    return merge_payloads(empty_payload(signal_source), payload)


def build_signal_payload(*args, **kwargs) -> dict:
    """
    Alias for build_payload().

    This keeps all indicator modules exposing a consistent payload-builder name
    while still preserving the Webhook Bridge v8 field structure from Pine
    lines 181-244. build_payload() normalizes through payload.py.
    """
    return build_payload(*args, **kwargs)


def payload_json(payload: dict, indent: Optional[int] = None) -> str:
    """Serialize payload dict to JSON string."""
    return json.dumps(payload, indent=indent)


# ---------------------------------------------------------------------------
# Convenience: build from OHLCV + config
# ---------------------------------------------------------------------------

def build_from_bar(
    ohlcv: pd.DataFrame,
    cfg: BridgeConfig,
    *,
    daily_high: float,
    daily_low: float,
    vix: float = 0.0,
    spy_close: float = 0.0,
    spy_prev: float = 0.0,
    spy_sma20: float = 0.0,
    spy_ema50: float = 0.0,
    qqq_close: float = 0.0,
    qqq_prev: float = 0.0,
    qqq_sma20: float = 0.0,
    qqq_ema50: float = 0.0,
    xly_close: float = 0.0,
    xly_prev: float = 0.0,
    xly_sma20: float = 0.0,
    xly_ema50: float = 0.0,
    ticker: str = "",
    exchange: str = "",
    timeframe: str = "",
    prev_execution: str = "",
) -> dict:
    """
    High-level helper: computes sweeps + technicals for the last bar of
    ``ohlcv`` and assembles a full bridge payload dict.
    """
    techs = compute_technicals(ohlcv)
    sweeps = detect_sweeps(ohlcv, cfg.sweep_lookback, cfg.sweep_vol_mult)

    last_tech = techs.iloc[-1]
    last_sweep = sweeps.iloc[-1]
    last_bar = ohlcv.iloc[-1]

    ca = cross_asset_flags(
        spy_close, spy_sma20, spy_ema50, spy_prev,
        qqq_close, qqq_sma20, qqq_ema50, qqq_prev,
        xly_close, xly_sma20, xly_ema50,
    )

    atype, _ = alert_type(
        prev_execution, cfg.execution,
        bool(last_sweep["bull_sweep"]), bool(last_sweep["bear_sweep"]),
    )

    ts = int(last_bar.name.timestamp() * 1000) if hasattr(last_bar.name, "timestamp") else int(_time.time() * 1000)

    xly_chg = (xly_close - xly_prev) / xly_prev * 100 if xly_prev != 0 else 0.0

    return build_payload(
        timestamp=ts,
        ticker=ticker or str(ohlcv.columns[0] if hasattr(ohlcv, "columns") else ""),
        exchange=exchange,
        timeframe=timeframe,
        price=float(last_bar["close"]),
        daily_high=daily_high,
        daily_low=daily_low,
        volume=float(last_bar["volume"]),
        avg_volume_30d=float(last_tech["avg_volume_30d"]),
        execution=cfg.execution,
        signal=cfg.signal,
        regime=cfg.regime,
        bias_score=cfg.bias_score,
        exec_score=cfg.exec_score,
        grade=cfg.grade,
        smart_money=cfg.smart_money,
        liquidity=cfg.liquidity,
        fvg=cfg.fvg,
        order_block=cfg.order_block,
        rsi_14=float(last_tech["rsi_14"]),
        macd_line=float(last_tech["macd_line"]),
        macd_signal=float(last_tech["macd_signal"]),
        macd_hist=float(last_tech["macd_hist"]),
        sma_50=float(last_tech["sma_50"]),
        ema_200=float(last_tech["ema_200"]),
        vwap=float(last_tech["vwap"]),
        atr_14=float(last_tech["atr_14"]),
        price_vs_sma50=str(last_tech["price_vs_sma50"]),
        price_vs_ema200=str(last_tech["price_vs_ema200"]),
        sweep_type=str(last_sweep["sweep_type"]),
        prev_swing_low=float(last_sweep["prev_swing_low"]),
        prev_swing_high=float(last_sweep["prev_swing_high"]),
        volume_ratio=float(last_sweep["volume_ratio"]),
        spy_price=spy_close,
        spy_change_pct=ca["spy_change_pct"],
        spy_status=ca["spy_status"],
        qqq_price=qqq_close,
        qqq_change_pct=ca["qqq_change_pct"],
        qqq_status=ca["qqq_status"],
        xly_price=xly_close,
        xly_change_pct=xly_chg,
        xly_status=ca["xly_status"],
        vix=vix,
        cross_asset_status=ca["cross_asset_status"],
        alert_type_str=atype,
        previous_execution=prev_execution,
        chart_image_url=cfg.chart_image_url,
        chart_vision_enabled=cfg.chart_vision_enabled,
        signal_source=cfg.signal_source,
    )
