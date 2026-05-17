"""
QTP Server-Side Scanner v5.5

Purpose:
  Server-side Polygon.io scanner for Quantlys.ai Quantum Trading Pipeline.
  It generates TradingView-compatible webhook payloads and sends them into the
  existing n8n Webhook Trigger (B2) without disrupting desktop TradingView alerts.

Important:
  The strategy functions below are production scaffolds with deterministic,
  auditable formulas. For exact 1:1 parity with TradingView indicators, replace
  the placeholder scoring functions with formulas transcribed from:
    - Super Score Pro V2.5
    - AI Super Score Webhook Bridge V8
    - AI Super Score Ensemble Engine
    - Quantum Scalp Strategy

Environment variables:
  POLYGON_API_KEY
  QTP_N8N_WEBHOOK_URL
  QTP_N8N_WEBHOOK_SECRET       optional, sent as x-qtp-secret
  QTP_CHART_VISION_ENABLED     true/false, default false
  QTP_DEFAULT_TIMEFRAME        default 5
  QTP_DRY_RUN                  true/false, default true
"""

from __future__ import annotations

import argparse
import dataclasses
import datetime as dt
import hashlib
import json
import math
import os
import statistics
import time
from typing import Any, Dict, Iterable, List, Optional, Tuple

import pandas as pd
import requests

from qtp_server_side.super_score_pro_v25 import (
    SuperScoreConfig,
    build_signal_payload as build_super_score_pro_payload,
    compute as compute_super_score_pro,
)
from qtp_server_side.ensemble_engine_v1 import (
    EnsembleConfig,
    build_signal_payload as build_ensemble_payload,
    compute as compute_ensemble,
)
from qtp_server_side.webhook_bridge_v8 import (
    BridgeConfig,
    build_signal_payload as build_webhook_bridge_payload,
    compute as compute_webhook_bridge,
)
from qtp_server_side.quantum_scalp_strategy_v5 import (
    PortfolioState,
    build_signal_payload as build_scalp_strategy_payload,
    compute as compute_scalp_strategy,
)
from qtp_server_side.payload import (
    SIGNAL_SOURCE_ENSEMBLE,
    SIGNAL_SOURCE_SCALP,
    SIGNAL_SOURCE_SUPER_SCORE,
    SIGNAL_SOURCE_WEBHOOK,
    empty_payload,
    merge_payloads,
)


NY_TZ = dt.timezone(dt.timedelta(hours=-4))  # EDT-safe for current deployment season.


NASDAQ_DEFAULTS = {
    "AAPL", "MSFT", "NVDA", "AMZN", "META", "GOOGL", "GOOG", "TSLA", "AVGO",
    "COST", "NFLX", "AMD", "ADBE", "PEP", "CSCO", "TMUS", "INTU", "QCOM",
    "AMAT", "TXN", "ISRG", "BKNG", "VRTX", "PANW", "MU", "LRCX", "ADI",
    "KLAC", "MELI", "CRWD", "CDNS", "SNPS", "MRVL", "ORLY", "MAR", "ABNB",
    "PYPL", "FTNT", "REGN", "ASML", "NTNX", "OLED", "NDAQ",
}


@dataclasses.dataclass
class Candle:
    ts: dt.datetime
    open: float
    high: float
    low: float
    close: float
    volume: float


def now_utc() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def parse_bool(v: Any, default: bool = False) -> bool:
    if v is None:
        return default
    return str(v).strip().lower() in {"1", "true", "yes", "y", "on"}


def clamp(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))


def safe_num(x: Any, default: float = 0.0) -> float:
    try:
        n = float(x)
        if math.isfinite(n):
            return n
    except Exception:
        pass
    return default


class PolygonClient:
    def __init__(self, api_key: str, timeout: int = 30):
        if not api_key:
            raise ValueError("POLYGON_API_KEY is required")
        self.api_key = api_key
        self.timeout = timeout
        self.base = "https://api.polygon.io"

    def aggregates(
        self,
        ticker: str,
        multiplier: int,
        timespan: str,
        start: dt.date,
        end: dt.date,
        adjusted: bool = True,
        limit: int = 50000,
    ) -> List[Candle]:
        url = f"{self.base}/v2/aggs/ticker/{ticker}/range/{multiplier}/{timespan}/{start}/{end}"
        params = {
            "adjusted": "true" if adjusted else "false",
            "sort": "asc",
            "limit": limit,
            "apiKey": self.api_key,
        }
        r = requests.get(url, params=params, timeout=self.timeout)
        r.raise_for_status()
        data = r.json()
        if data.get("status") not in {"OK", "DELAYED"} and not data.get("results"):
            raise RuntimeError(f"Polygon aggregate error for {ticker}: {data}")
        out: List[Candle] = []
        for row in data.get("results") or []:
            out.append(
                Candle(
                    ts=dt.datetime.fromtimestamp(row["t"] / 1000, tz=dt.timezone.utc),
                    open=safe_num(row.get("o")),
                    high=safe_num(row.get("h")),
                    low=safe_num(row.get("l")),
                    close=safe_num(row.get("c")),
                    volume=safe_num(row.get("v")),
                )
            )
        return out


def sma(values: List[float], period: int) -> Optional[float]:
    if len(values) < period:
        return None
    return sum(values[-period:]) / period


def ema(values: List[float], period: int) -> Optional[float]:
    if len(values) < period:
        return None
    k = 2 / (period + 1)
    e = sum(values[:period]) / period
    for v in values[period:]:
        e = v * k + e * (1 - k)
    return e


def rsi(values: List[float], period: int = 14) -> Optional[float]:
    if len(values) < period + 1:
        return None
    gains, losses = [], []
    for a, b in zip(values[-period - 1 : -1], values[-period:]):
        d = b - a
        gains.append(max(d, 0))
        losses.append(max(-d, 0))
    avg_gain = sum(gains) / period
    avg_loss = sum(losses) / period
    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return 100 - (100 / (1 + rs))


def atr(candles: List[Candle], period: int = 14) -> Optional[float]:
    if len(candles) < period + 1:
        return None
    trs = []
    for prev, cur in zip(candles[-period - 1 : -1], candles[-period:]):
        trs.append(max(cur.high - cur.low, abs(cur.high - prev.close), abs(cur.low - prev.close)))
    return sum(trs) / period


def macd_hist(values: List[float], fast: int = 12, slow: int = 26, signal: int = 9) -> Optional[float]:
    if len(values) < slow + signal + 5:
        return None
    macd_series = []
    for i in range(slow, len(values) + 1):
        sub = values[:i]
        ef = ema(sub, fast)
        es = ema(sub, slow)
        if ef is not None and es is not None:
            macd_series.append(ef - es)
    sig = ema(macd_series, signal)
    if sig is None or not macd_series:
        return None
    return macd_series[-1] - sig


def vwap(candles: List[Candle], lookback: int = 78) -> Optional[float]:
    subset = candles[-lookback:]
    denom = sum(c.volume for c in subset)
    if denom <= 0:
        return None
    return sum(((c.high + c.low + c.close) / 3) * c.volume for c in subset) / denom


def volume_ratio(candles: List[Candle], period: int = 20) -> Optional[float]:
    if len(candles) < period + 1:
        return None
    avg = sum(c.volume for c in candles[-period - 1 : -1]) / period
    return candles[-1].volume / avg if avg > 0 else None


def trend_from_daily(daily: List[Candle]) -> str:
    closes = [c.close for c in daily]
    e20 = ema(closes, 20)
    e50 = ema(closes, 50)
    if e20 is None or e50 is None:
        return "UNKNOWN"
    if closes[-1] > e20 > e50:
        return "BULLISH"
    if closes[-1] < e20 < e50:
        return "BEARISH"
    return "NEUTRAL"


def exchange_for_ticker(ticker: str, override: Optional[str] = None) -> str:
    if override:
        return override.upper()
    return "NASDAQ" if ticker.upper() in NASDAQ_DEFAULTS else "NYSE"


def tradingview_chart_url(ticker: str, exchange: str) -> str:
    # Required v5.5 future-vision field. This is a chart page URL, not a direct screenshot.
    symbol = f"{exchange.upper()}:{ticker.upper()}"
    return f"https://www.tradingview.com/chart/00rMdbml/?symbol={symbol.replace(':', '%3A')}"


def candles_to_dataframe(candles: List[Candle]) -> pd.DataFrame:
    """
    Convert scanner Candle objects into the canonical OHLCV DataFrame consumed
    by the Pine-parity indicator modules.

    Shadow/local only. This helper does not write to n8n, Supabase, Alpaca, or
    Telegram.
    """
    return pd.DataFrame(
        [
            {
                "open": c.open,
                "high": c.high,
                "low": c.low,
                "close": c.close,
                "volume": c.volume,
            }
            for c in candles
        ],
        index=pd.DatetimeIndex([c.ts for c in candles], name="ts"),
    )


def build_shadow_parity_payloads(
    *,
    ticker: str,
    exchange: str,
    timeframe: str,
    five_min: List[Candle],
    daily: List[Candle],
    chart_vision_enabled: bool,
    signal_source: str,
) -> Dict[str, Any]:
    """
    Run all four Pine -> Python parity modules and build canonical payloads.

    Strict safety gate:
      * Enabled only when the scanner payload signal_source is exactly
        "server_side".
      * Results are attached under shadow_parity only.
      * No live n8n, Supabase, Alpaca, Telegram, or routing side effects.
    """
    if signal_source != "server_side":
        return {
            "enabled": False,
            "mode": "SHADOW_DISABLED_NON_SERVER_SIDE",
            "reason": f"signal_source={signal_source}",
        }

    ohlcv = candles_to_dataframe(five_min)
    daily_df = candles_to_dataframe(daily)
    chart_url = tradingview_chart_url(ticker, exchange)
    day_high = float(daily_df["high"].iloc[-1]) if not daily_df.empty else float(ohlcv["high"].max())
    day_low = float(daily_df["low"].iloc[-1]) if not daily_df.empty else float(ohlcv["low"].min())
    prev_day_high = float(daily_df["high"].iloc[-2]) if len(daily_df) >= 2 else day_high
    prev_day_low = float(daily_df["low"].iloc[-2]) if len(daily_df) >= 2 else day_low
    last_bar = ohlcv.iloc[-1]

    super_df = compute_super_score_pro(ohlcv, SuperScoreConfig())
    super_payload = build_super_score_pro_payload(
        super_df.iloc[-1],
        last_bar,
        ticker=ticker,
        exchange=exchange,
        timeframe=timeframe,
        chart_image_url=chart_url,
        chart_vision_enabled=chart_vision_enabled,
        signal_source=SIGNAL_SOURCE_SUPER_SCORE,
    )

    ensemble_df = compute_ensemble(ohlcv, EnsembleConfig())
    ensemble_payload = build_ensemble_payload(
        ensemble_df.iloc[-1],
        EnsembleConfig(),
        last_bar,
        day_high,
        day_low,
        prev_day_high,
        prev_day_low,
        chart_image_url=chart_url,
        chart_vision_enabled=chart_vision_enabled,
        signal_source=SIGNAL_SOURCE_ENSEMBLE,
    )
    ensemble_payload["ticker"] = ticker.upper()
    ensemble_payload["exchange"] = exchange.upper()
    ensemble_payload["timeframe"] = timeframe

    bridge_cfg = BridgeConfig(
        chart_image_url=chart_url,
        chart_vision_enabled=chart_vision_enabled,
        signal_source=SIGNAL_SOURCE_WEBHOOK,
    )
    bridge_df = compute_webhook_bridge(ohlcv, bridge_cfg)
    bridge_payload = build_webhook_bridge_payload(
        ohlcv,
        bridge_cfg,
        daily_high=day_high,
        daily_low=day_low,
        ticker=ticker,
        exchange=exchange,
        timeframe=timeframe,
    )

    scalp_df = compute_scalp_strategy(ohlcv)
    scalp_execution = str(scalp_df.iloc[-1].get("final_execution", "STAND ASIDE"))
    scalp_signal = "BULLISH" if scalp_execution == "LONG" else ("BEARISH" if scalp_execution == "SHORT" else "NEUTRAL")
    scalp_payload = build_scalp_strategy_payload(
        scalp_df.iloc[-1],
        last_bar,
        PortfolioState(),
        execution=scalp_execution,
        signal=scalp_signal,
        alert_type="SERVER_SIDE_SHADOW_PARITY",
        comment="shadow parity only",
        ticker=ticker,
        timeframe=timeframe,
        chart_image_url=chart_url,
        chart_vision_enabled=chart_vision_enabled,
        signal_source=SIGNAL_SOURCE_SCALP,
    )

    return {
        "enabled": True,
        "mode": "SHADOW_ONLY_NO_ROUTING",
        "version": "QTP_SERVER_SIDE_PARITY_T01_v5.5",
        "modules": {
            SIGNAL_SOURCE_SUPER_SCORE: {
                "rows": len(super_df),
                "last": super_df.iloc[-1].to_dict(),
                "payload": super_payload,
            },
            SIGNAL_SOURCE_ENSEMBLE: {
                "rows": len(ensemble_df),
                "last": ensemble_df.iloc[-1].to_dict(),
                "payload": ensemble_payload,
            },
            SIGNAL_SOURCE_WEBHOOK: {
                "rows": len(bridge_df),
                "last": bridge_df.iloc[-1].to_dict(),
                "payload": bridge_payload,
            },
            SIGNAL_SOURCE_SCALP: {
                "rows": len(scalp_df),
                "last": scalp_df.iloc[-1].to_dict(),
                "payload": scalp_payload,
            },
        },
    }


def compute_indicator_state(ticker: str, five_min: List[Candle], daily: List[Candle]) -> Dict[str, Any]:
    closes = [c.close for c in five_min]
    last = five_min[-1]
    sma50 = sma(closes, 50)
    ema200 = ema(closes, 200)
    cur_rsi = rsi(closes, 14)
    hist = macd_hist(closes)
    cur_atr = atr(five_min)
    cur_vwap = vwap(five_min)
    vr = volume_ratio(five_min)
    daily_trend = trend_from_daily(daily)

    # Deterministic baseline scoring. Replace internals with Pine-derived formulas for exact parity.
    trend_score = 0.0
    if sma50 and last.close > sma50:
        trend_score += 15
    if ema200 and last.close > ema200:
        trend_score += 15
    if cur_vwap and last.close > cur_vwap:
        trend_score += 12
    if hist and hist > 0:
        trend_score += 10
    if cur_rsi is not None:
        if 45 <= cur_rsi <= 68:
            trend_score += 12
        elif cur_rsi > 72:
            trend_score -= 8
        elif cur_rsi < 35:
            trend_score -= 6
    if vr and vr > 1.25:
        trend_score += 10
    if daily_trend == "BULLISH":
        trend_score += 14
    elif daily_trend == "BEARISH":
        trend_score -= 14

    bear_score = 0.0
    if sma50 and last.close < sma50:
        bear_score += 15
    if ema200 and last.close < ema200:
        bear_score += 15
    if cur_vwap and last.close < cur_vwap:
        bear_score += 12
    if hist and hist < 0:
        bear_score += 10
    if cur_rsi is not None:
        if 32 <= cur_rsi <= 55:
            bear_score += 10
        elif cur_rsi < 25:
            bear_score -= 5
    if vr and vr > 1.25:
        bear_score += 8
    if daily_trend == "BEARISH":
        bear_score += 14
    elif daily_trend == "BULLISH":
        bear_score -= 10

    bull_score = clamp(trend_score, 0, 100)
    bear_score = clamp(bear_score, 0, 100)
    if bull_score >= 68 and bull_score >= bear_score + 8:
        execution = "BUY"
    elif bear_score >= 68 and bear_score >= bull_score + 8:
        execution = "SELL"
    else:
        execution = "STAND ASIDE"

    bias_score = max(bull_score, bear_score)
    confidence = clamp(abs(bull_score - bear_score) + (vr or 1) * 8, 0, 100)
    return {
        "ticker": ticker.upper(),
        "price": last.close,
        "open": last.open,
        "high": last.high,
        "low": last.low,
        "close": last.close,
        "volume": last.volume,
        "rsi": cur_rsi,
        "macd_hist": hist,
        "sma50": sma50,
        "ema200": ema200,
        "vwap": cur_vwap,
        "atr": cur_atr,
        "volume_ratio": vr,
        "daily_trend": daily_trend,
        "bull_score": bull_score,
        "bear_score": bear_score,
        "bias_score": bias_score,
        "confidence": confidence,
        "execution": execution,
        "signal": execution,
        "side": execution,
        "action": execution,
        "verdict": "VALID" if execution in {"BUY", "SELL"} else "NEUTRAL",
    }


def build_webhook_payload(
    ticker: str,
    exchange: str,
    indicator: Dict[str, Any],
    timeframe: str = "5",
    chart_vision_enabled: bool = False,
    signal_source: str = "server_side",
    shadow_parity: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    ts = now_utc().isoformat()
    execution = indicator["execution"]
    payload: Dict[str, Any] = {
        # Core identity
        "ticker": ticker.upper(),
        "symbol": ticker.upper(),
        "exchange": exchange.upper(),
        "timeframe": timeframe,
        "tf": timeframe,
        "timestamp": ts,
        "signal_source": signal_source,
        "source": "QTP_SERVER_SIDE_SCANNER_v5.5",
        "alert_type": "SERVER_SIDE_SCANNER",
        # Signal fields
        "execution": execution,
        "signal": execution,
        "side": execution,
        "action": execution,
        "direction": execution,
        "price": indicator.get("price"),
        "close": indicator.get("close"),
        "open": indicator.get("open"),
        "high": indicator.get("high"),
        "low": indicator.get("low"),
        "volume": indicator.get("volume"),
        # Indicator fields
        "bias_score": indicator.get("bias_score"),
        "bull_score": indicator.get("bull_score"),
        "bear_score": indicator.get("bear_score"),
        "confidence": indicator.get("confidence"),
        "ai_confidence": indicator.get("confidence"),
        "rsi": indicator.get("rsi"),
        "macd_hist": indicator.get("macd_hist"),
        "sma50": indicator.get("sma50"),
        "ema200": indicator.get("ema200"),
        "vwap": indicator.get("vwap"),
        "atr": indicator.get("atr"),
        "volume_ratio": indicator.get("volume_ratio"),
        "daily_trend": indicator.get("daily_trend"),
        "regime": indicator.get("daily_trend"),
        "verdict": indicator.get("verdict"),
        # Placeholders expected by the current 60-field desktop payload.
        "market_regime": "UNKNOWN_SERVER_SIDE",
        "spy_regime": "UNKNOWN_SERVER_SIDE",
        "qqq_regime": "UNKNOWN_SERVER_SIDE",
        "cross_asset": "UNKNOWN_SERVER_SIDE",
        "cross_asset_status": "UNKNOWN_SERVER_SIDE",
        "options_regime": "UNKNOWN_SERVER_SIDE",
        "dark_pool_regime": "UNKNOWN_SERVER_SIDE",
        "smart_money": "UNKNOWN_SERVER_SIDE",
        "liquidity": "UNKNOWN_SERVER_SIDE",
        "order_blocks": "UNKNOWN_SERVER_SIDE",
        "vix": None,
        "put_call_ratio": None,
        "gex": None,
        "max_pain": None,
        "short_volume_pct": None,
        "institutional_score": None,
        "sentiment": "UNKNOWN_SERVER_SIDE",
        "ai_action": execution,
        "ai_verdict": indicator.get("verdict"),
        "strategy_name": "Quantum Scalp Strategy",
        "scanner_version": "QTP_SERVER_SIDE_SCANNER_v5.5",
        "parser_version": "QTP_SERVER_SIDE_SCANNER_v5.5",
        "payload_schema_version": "QTP_60_FIELD_WEBHOOK_COMPAT_v5.5",
        # Backtest placeholders. Upstream backtest normalizer should overwrite when available.
        "strat_total_trades": None,
        "strat_profit_factor": None,
        "backtest_data_source": "SERVER_SIDE_PENDING_PARITY_BACKTEST",
        "backtest_data_quality": "PENDING",
        # Vision readiness
        "chart_image_url": tradingview_chart_url(ticker, exchange),
        "chart_vision_enabled": bool(chart_vision_enabled),
        "chart_vision_status": "PENDING_DOWNSTREAM_ENRICHMENT" if chart_vision_enabled else "DISABLED",
    }
    if shadow_parity is not None:
        payload["shadow_parity"] = shadow_parity
        payload["shadow_parity_enabled"] = bool(shadow_parity.get("enabled"))
        payload["shadow_parity_mode"] = shadow_parity.get("mode")
    payload = merge_payloads(empty_payload(signal_source), payload)
    payload["payload_hash"] = hashlib.sha256(json.dumps(payload, sort_keys=True, default=str).encode()).hexdigest()
    return payload


def post_to_n8n(webhook_url: str, payload: Dict[str, Any], secret: Optional[str], dry_run: bool) -> Dict[str, Any]:
    if dry_run:
        return {"dry_run": True, "payload": payload}
    headers = {"Content-Type": "application/json"}
    if secret:
        headers["x-qtp-secret"] = secret
    r = requests.post(webhook_url, json=payload, headers=headers, timeout=30)
    return {"status_code": r.status_code, "body": r.text[:1000]}


def scan_ticker(
    client: PolygonClient,
    ticker: str,
    lookback_days_5m: int = 7,
    lookback_days_daily: int = 260,
    exchange_override: Optional[str] = None,
) -> Dict[str, Any]:
    end = now_utc().date()
    five = client.aggregates(ticker, 5, "minute", end - dt.timedelta(days=lookback_days_5m), end)
    daily = client.aggregates(ticker, 1, "day", end - dt.timedelta(days=lookback_days_daily), end)
    if len(five) < 220:
        raise RuntimeError(f"Insufficient 5m candles for {ticker}: {len(five)}")
    if len(daily) < 60:
        raise RuntimeError(f"Insufficient daily candles for {ticker}: {len(daily)}")
    exchange = exchange_for_ticker(ticker, exchange_override)
    indicator = compute_indicator_state(ticker, five, daily)
    timeframe = os.getenv("QTP_DEFAULT_TIMEFRAME", "5")
    signal_source = os.getenv("QTP_SIGNAL_SOURCE", "server_side")
    chart_vision_enabled = parse_bool(os.getenv("QTP_CHART_VISION_ENABLED"), False)
    shadow_parity = build_shadow_parity_payloads(
        ticker=ticker,
        exchange=exchange,
        timeframe=timeframe,
        five_min=five,
        daily=daily,
        chart_vision_enabled=chart_vision_enabled,
        signal_source=signal_source,
    )
    return build_webhook_payload(
        ticker=ticker,
        exchange=exchange,
        indicator=indicator,
        timeframe=timeframe,
        chart_vision_enabled=chart_vision_enabled,
        signal_source=signal_source,
        shadow_parity=shadow_parity,
    )


def load_watchlist(path_or_csv: str) -> List[str]:
    if os.path.exists(path_or_csv):
        raw = open(path_or_csv, "r", encoding="utf-8").read()
    else:
        raw = path_or_csv
    out = []
    for part in raw.replace("\n", ",").split(","):
        t = part.strip().upper()
        if t:
            out.append(t)
    return sorted(set(out))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--watchlist", required=True, help="Comma list or file path")
    ap.add_argument("--dry-run", default=os.getenv("QTP_DRY_RUN", "true"))
    ap.add_argument("--sleep-ms", type=int, default=150)
    args = ap.parse_args()

    client = PolygonClient(os.getenv("POLYGON_API_KEY", ""))
    webhook_url = os.getenv("QTP_N8N_WEBHOOK_URL", "")
    secret = os.getenv("QTP_N8N_WEBHOOK_SECRET")
    dry_run = parse_bool(args.dry_run, True)
    if not dry_run and not webhook_url:
        raise ValueError("QTP_N8N_WEBHOOK_URL required when dry-run=false")

    results = []
    for ticker in load_watchlist(args.watchlist):
        try:
            payload = scan_ticker(client, ticker)
            response = post_to_n8n(webhook_url, payload, secret, dry_run)
            results.append({"ticker": ticker, "ok": True, "execution": payload.get("execution"), "response": response})
        except Exception as e:
            results.append({"ticker": ticker, "ok": False, "error": str(e)})
        time.sleep(args.sleep_ms / 1000)

    print(json.dumps({"scanner_version": "QTP_SERVER_SIDE_SCANNER_v5.5", "results": results}, indent=2, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
