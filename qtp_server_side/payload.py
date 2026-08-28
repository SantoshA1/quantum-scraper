"""
payload.py — Canonical alert payload field definitions and assemblers.

This module defines:
  1. PayloadFields — dataclass with every field name that appears in any of
     the four Pine scripts, plus server-side extension fields.
  2. normalize_payload() — coerce raw dict to well-typed dict.
  3. merge_payloads()   — merge component payloads with priority ordering.
  4. validate_payload() — check required fields, return list of errors.
  5. signal_source constants.

chart_image_url, chart_vision_enabled, signal_source
------------------------------------------------------
These three fields are NOT present in the original Pine scripts but are
expected by the downstream n8n AI Vision node and shadow logger.
They are injected server-side and MUST survive any merge / normalize call.

Field inventory (by script)
----------------------------
SUPER SCORE PRO v2.5
  execution_bias, signal_text, grade, execution_score, bias_score,
  buy_probability, sell_probability, regime_text, smart_money_text,
  liquidity_text, fvg_text, ob_text, vix, rel_vol, adx, score_penalty,
  vol_penalty, regime_penalty, ob_penalty, vix_penalty, vwap_penalty,
  location_penalty

WEBHOOK BRIDGE v8
  timestamp, ticker, exchange, timeframe, price, daily_high, daily_low,
  volume, avg_volume_30d,
  ai_super_score.{execution, signal, regime, bias_score, exec_score,
      grade, smart_money, liquidity, fvg, order_block},
  technicals.{rsi_14, macd_line, macd_signal, macd_hist, sma_50, ema_200,
      vwap, atr_14, price_vs_sma50, price_vs_ema200},
  sweep.{type, swing_low, swing_high, volume_ratio},
  cross_asset.{spy_price, spy_change_pct, spy_status, qqq_price,
      qqq_change_pct, qqq_status, xly_price, xly_change_pct, xly_status,
      vix, cross_asset_status},
  alert_type, previous_execution

ENSEMBLE ENGINE v1
  ensemble.{execution, signal, regime, bias, score, grade, bull_score,
      bear_score, previous_execution},
  components.{manual_bull, manual_bear, mtf_bull, mtf_bear, regime,
      volume, momentum_bull, momentum_bear, location_bull, location_bear,
      market_bull, market_bear, div_bull, div_bear},
  gates.{tradeable_environment, bull/bear_mtf_gate, bull/bear_market_gate,
      bull/bear_location_gate, bull/bear_confirm_gate},
  mirrored_ai_super_score.{…},
  vix_regime, adx, relative_volume,
  day_high, day_low, prev_day_high, prev_day_low

QUANTUM SCALP v5
  All webhook bridge fields +
  bias_score, regime, adx, rsi, macd_hist, atr, volume_ratio, vix,
  alert_type, spy_price/change_pct/status, qqq_price/change_pct/status,
  xly_status, cross_asset_status, tv_recommendation, sma50, ema200,
  sma200, bb_upper, bb_lower, stoch_k, stoch_d, cci, momentum,
  pivot_classic, psar, daily_trend, bull_score, bear_score, comment,
  strat_net_pct, strat_win_rate, strat_wins, strat_losses,
  strat_profit_factor, strat_max_dd, strat_avg_trade, strat_total_trades,
  daily_dd_pct, daily_dd_halt, weekly_dd_pct,
  vix_size_mult, eff_position_size, vix_stop_mult,
  mtf_bull_count, mtf_bear_count, mtf_bull_score, mtf_bear_score,
  mtf_bull_confirmed, mtf_bear_confirmed,
  momentum_engine, momentum_type, gap_pct, momentum_rr

SERVER-SIDE EXTENSIONS (not in Pine)
  chart_image_url, chart_vision_enabled, signal_source
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field, fields, asdict
from typing import Any, Optional

# ---------------------------------------------------------------------------
# Signal source constants
# ---------------------------------------------------------------------------

SIGNAL_SOURCE_SUPER_SCORE  = "super_score_pro_v25"
SIGNAL_SOURCE_BRIDGE       = "webhook_bridge_v8"
SIGNAL_SOURCE_ENSEMBLE     = "ensemble_engine_v1"
SIGNAL_SOURCE_SCALP        = "quantum_scalp_v5"

# Alert type constants (Pine strings)
ALERT_TYPE_SIGNAL_CHANGE   = "SIGNAL_CHANGE"
ALERT_TYPE_BULL_SWEEP      = "BULL_SWEEP"
ALERT_TYPE_BEAR_SWEEP      = "BEAR_SWEEP"
ALERT_TYPE_PERIODIC        = "PERIODIC_UPDATE"
ALERT_TYPE_HEARTBEAT       = "HEARTBEAT"

# Execution values
EXEC_BUY         = "BUY"
EXEC_SELL        = "SELL"
EXEC_STAND_ASIDE = "STAND ASIDE"
EXEC_LONG        = "LONG"   # quantum scalp uses LONG/SHORT in heartbeat
EXEC_SHORT       = "SHORT"

# Signal values
SIG_BULLISH = "BULLISH"
SIG_BEARISH = "BEARISH"
SIG_NEUTRAL = "NEUTRAL"

# Regime values
REGIME_TRENDING       = "TRENDING"
REGIME_MEAN_REVERTING = "MEAN REVERTING"
REGIME_NEUTRAL        = "NEUTRAL"
REGIME_STRONG_TREND   = "STRONG_TREND"
REGIME_RANGING        = "RANGING"


# ---------------------------------------------------------------------------
# Flat canonical field list (for validation / mapping)
# ---------------------------------------------------------------------------

# Required in every payload from the bridge / ensemble
REQUIRED_TOP_FIELDS = frozenset([
    "timestamp", "ticker", "price", "alert_type",
])

# Required ai_super_score sub-fields
REQUIRED_AI_FIELDS = frozenset([
    "execution", "signal", "regime", "bias_score", "exec_score", "grade",
])

# Server-side extensions always injected
SERVER_SIDE_FIELDS = frozenset([
    "chart_image_url", "chart_vision_enabled", "signal_source",
])


# ---------------------------------------------------------------------------
# Normalize / validate helpers
# ---------------------------------------------------------------------------

def normalize_payload(raw: dict) -> dict:
    """
    Coerce a raw payload dict to well-typed values.
    - Numeric strings → float (for all known numeric keys)
    - Ensure server-side fields exist with safe defaults
    - Ensure alert_type has a valid value
    """
    numeric_keys = {
        "price", "daily_high", "daily_low", "volume", "avg_volume_30d",
        "bias_score", "exec_score", "adx", "rsi", "macd_hist", "atr",
        "volume_ratio", "vix", "spy_price", "spy_change_pct",
        "qqq_price", "qqq_change_pct", "xly_price", "xly_change_pct",
        "daily_dd_pct", "weekly_dd_pct", "vix_size_mult", "eff_position_size",
        "vix_stop_mult", "gap_pct", "momentum_rr", "relative_volume",
        "mtf_bull_score", "mtf_bear_score", "bull_score", "bear_score",
        "strat_net_pct", "strat_win_rate", "strat_profit_factor",
        "strat_max_dd", "strat_avg_trade",
    }
    result = dict(raw)

    for k in numeric_keys:
        if k in result:
            try:
                result[k] = float(result[k])
            except (TypeError, ValueError):
                pass

    # Boolean string normalization
    bool_keys = {"chart_vision_enabled", "daily_dd_halt", "mtf_bull_confirmed", "mtf_bear_confirmed",
                 "momentum_engine"}
    for k in bool_keys:
        if k in result:
            v = result[k]
            if isinstance(v, str):
                result[k] = v.lower() in ("true", "1", "yes")

    # Server-side extension defaults
    result.setdefault("chart_image_url", "")
    result.setdefault("chart_vision_enabled", False)
    result.setdefault("signal_source", "unknown")

    # Alert type fallback
    valid_alert_types = {
        ALERT_TYPE_SIGNAL_CHANGE, ALERT_TYPE_BULL_SWEEP, ALERT_TYPE_BEAR_SWEEP,
        ALERT_TYPE_PERIODIC, ALERT_TYPE_HEARTBEAT,
    }
    if result.get("alert_type") not in valid_alert_types:
        result["alert_type"] = ALERT_TYPE_PERIODIC

    return result


def validate_payload(payload: dict) -> list[str]:
    """
    Check payload completeness.  Returns a list of error strings.
    Empty list = valid.
    """
    errors = []
    for f in REQUIRED_TOP_FIELDS:
        if f not in payload or payload[f] is None or payload[f] == "":
            errors.append(f"Missing required field: {f!r}")

    ai = payload.get("ai_super_score", {})
    if ai:
        for f in REQUIRED_AI_FIELDS:
            if f not in ai:
                errors.append(f"Missing ai_super_score.{f!r}")

    for f in SERVER_SIDE_FIELDS:
        if f not in payload:
            errors.append(f"Missing server-side extension field: {f!r}")

    return errors


def merge_payloads(*payloads: dict, priority: str = "last") -> dict:
    """
    Merge multiple payload dicts.  ``priority='last'`` means later dicts
    overwrite earlier ones; ``priority='first'`` keeps the first value found.

    Server-side fields (chart_image_url etc.) from any source are preserved.
    """
    result: dict = {}
    sources = list(payloads) if priority == "last" else list(reversed(payloads))
    for p in sources:
        result.update(p)
    return normalize_payload(result)


def payload_to_json(payload: dict, indent: Optional[int] = None) -> str:
    """Serialize to JSON, coercing any non-serializable values to strings."""
    def _default(o):
        return str(o)
    return json.dumps(payload, indent=indent, default=_default)


# ---------------------------------------------------------------------------
# Canonical empty payload template
# ---------------------------------------------------------------------------

def empty_payload(signal_source: str = "unknown") -> dict:
    """
    Return a fully-populated payload dict with all known fields set to safe
    zero/empty defaults.  Useful for testing and drift comparison.
    """
    return {
        "timestamp": 0,
        "ticker": "",
        "exchange": "",
        "timeframe": "",
        "price": 0.0,
        "daily_high": 0.0,
        "daily_low": 0.0,
        "volume": 0,
        "avg_volume_30d": 0.0,
        "ai_super_score": {
            "execution":   EXEC_STAND_ASIDE,
            "signal":      SIG_NEUTRAL,
            "regime":      REGIME_NEUTRAL,
            "bias_score":  50.0,
            "exec_score":  50.0,
            "grade":       "C",
            "smart_money": "NEUTRAL",
            "liquidity":   "NONE",
            "fvg":         "NONE",
            "order_block": "NONE",
        },
        "technicals": {
            "rsi_14": 50.0,
            "macd_line": 0.0,
            "macd_signal": 0.0,
            "macd_hist": 0.0,
            "sma_50": 0.0,
            "ema_200": 0.0,
            "vwap": 0.0,
            "atr_14": 0.0,
            "price_vs_sma50": "BELOW",
            "price_vs_ema200": "BELOW",
        },
        "sweep": {
            "type": "NONE",
            "swing_low": 0.0,
            "swing_high": 0.0,
            "volume_ratio": 0.0,
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
            "vix": 20.0,
            "cross_asset_status": "PARTIAL",
        },
        "alert_type": ALERT_TYPE_PERIODIC,
        "previous_execution": "",
        # Server-side extensions
        "chart_image_url": "",
        "chart_vision_enabled": False,
        "signal_source": signal_source,
        # Scalp-specific flat fields
        "bias_score": 50.0,
        "regime": REGIME_NEUTRAL,
        "adx": 0.0,
        "rsi": 50.0,
        "macd_hist": 0.0,
        "atr": 0.0,
        "volume_ratio": 0.0,
        "vix": 20.0,
        "daily_trend": "MIXED",
        "bull_score": 0.0,
        "bear_score": 0.0,
        "comment": "",
        "daily_dd_pct": 0.0,
        "daily_dd_halt": False,
        "weekly_dd_pct": 0.0,
        "vix_size_mult": 1.0,
        "eff_position_size": 10.0,
        "vix_stop_mult": 1.0,
        "mtf_bull_count": 0,
        "mtf_bear_count": 0,
        "mtf_bull_score": 0.0,
        "mtf_bear_score": 0.0,
        "mtf_bull_confirmed": False,
        "mtf_bear_confirmed": False,
        "momentum_engine": False,
        "momentum_type": "",
        "gap_pct": 0.0,
        "momentum_rr": 0.0,
    }
