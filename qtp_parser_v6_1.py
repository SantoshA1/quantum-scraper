"""QTP v6.1 — Quantum Trading Pipeline signal parser.

Surgical backtest-threshold relaxation. The strict default mirrors the
historical gate (min_trades=100, min_pf=1.20). Pre-market and a generic
"relaxed" mode soften it; an explicit high-vol allowlist softens it
further for symbols whose backtest population is structurally thin
(e.g. VFS, USO) but whose live tape still merits attention.

The intent is narrow:
  - Do NOT touch the R3.2 hard-opposite KILL short-circuit.
  - Do NOT touch the BROAD_SCANNER bias path / scoring.
  - Only the backtest enforcement decision and its audit trail change.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)


# Default high-vol allowlist. Tickers here always qualify for the
# HIGH_VOL_RELAXED threshold regardless of pre_market_mode / relaxed_mode.
# Callers can extend via ParserConfig.high_vol_symbols, or a per-payload
# `high_vol: true` flag.
DEFAULT_HIGH_VOL_SYMBOLS = frozenset({"VFS", "USO"})


@dataclass
class ParserConfig:
    # Strict thresholds — the historical default gate.
    strict_min_trades: int = 100
    strict_min_pf: float = 1.20

    # Relaxed / pre-market thresholds.
    relaxed_min_trades: int = 40
    relaxed_min_pf: float = 1.05

    # High-vol thresholds — applied to symbols in high_vol_symbols
    # or any payload carrying high_vol == True.
    high_vol_min_trades: int = 30
    high_vol_min_pf: float = 0.95

    # Symbol allowlist for HIGH_VOL_RELAXED. Defaults include VFS and USO.
    high_vol_symbols: frozenset = field(default_factory=lambda: frozenset(DEFAULT_HIGH_VOL_SYMBOLS))

    # If True, payload high_vol flag is honored. Defaults True.
    honor_payload_high_vol: bool = True


def _coerce_float(value: Any, default: float = 0.0) -> float:
    try:
        if value is None or value == "" or value == "N/A":
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def _coerce_int(value: Any, default: int = 0) -> int:
    try:
        if value is None or value == "" or value == "N/A":
            return default
        return int(float(value))
    except (TypeError, ValueError):
        return default


def _coerce_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in ("true", "1", "yes", "y")
    return bool(value)


def _select_backtest_thresholds(
    ticker: str,
    payload: Dict[str, Any],
    config: ParserConfig,
    pre_market_mode: bool,
    relaxed_mode: bool,
) -> Dict[str, Any]:
    """Pick the threshold tuple. High-vol wins over generic relaxed/pre-market."""
    payload_high_vol = (
        config.honor_payload_high_vol
        and _coerce_bool(payload.get("high_vol", False))
    )
    is_high_vol = (
        ticker.upper() in {s.upper() for s in config.high_vol_symbols}
        or payload_high_vol
    )

    if is_high_vol:
        return {
            "min_trades": config.high_vol_min_trades,
            "min_pf": config.high_vol_min_pf,
            "action": "HIGH_VOL_RELAXED",
            "relaxed": True,
        }
    if relaxed_mode or pre_market_mode:
        return {
            "min_trades": config.relaxed_min_trades,
            "min_pf": config.relaxed_min_pf,
            "action": "RELAXED",
            "relaxed": True,
        }
    return {
        "min_trades": config.strict_min_trades,
        "min_pf": config.strict_min_pf,
        "action": "STRICT",
        "relaxed": False,
    }


def _log_relaxation(ticker: str, actual_trades: int, actual_pf: float, action: str) -> None:
    if action == "HIGH_VOL_RELAXED":
        reason = "high-vol"
    elif action == "RELAXED":
        reason = "pre-market"
    else:
        return
    logger.info(
        "BACKTEST RELAXED for %s → trades=%d pf=%.2f (%s)",
        ticker, actual_trades, actual_pf, reason,
    )


def parse_signal_v6_1(
    payload: Dict[str, Any],
    config: Optional[ParserConfig] = None,
    pre_market_mode: bool = False,
    relaxed_mode: bool = False,
) -> Dict[str, Any]:
    """Parse a QTP signal payload and apply v6.1 backtest enforcement.

    Returns an enriched dict containing every input field plus the
    standard parse outputs and the new v6.1 audit fields:
      _backtest_enforcement_action ∈ {STRICT, RELAXED, HIGH_VOL_RELAXED}
      _backtest_relaxed_thresholds : bool
      _used_min_trades             : int
      _used_min_pf                 : float
    """
    if config is None:
        config = ParserConfig()

    out: Dict[str, Any] = dict(payload)  # never mutate caller's dict

    ticker = str(payload.get("ticker", "")).strip().upper()
    alert_type = str(payload.get("alert_type", "")).strip().upper()
    signal = str(payload.get("signal", "")).strip().lower()
    bias = str(payload.get("bias", "")).strip().lower()

    out["ticker"] = ticker
    out["alert_type"] = alert_type

    # ── R3.2 Hard-opposite KILL short-circuit ─────────────────────
    # Untouched contract: if the incoming signal is the hard opposite
    # of the established bias, the row dies here regardless of mode.
    if signal and bias and (
        (signal == "long" and bias == "short")
        or (signal == "short" and bias == "long")
    ):
        out["_sm_action"] = "KILL"
        out["_sm_route"] = "SKIP"
        out["_kill_rule"] = "R3.2_HARD_OPPOSITE"
        # Still expose the audit fields so downstream filters are uniform.
        out["_backtest_enforcement_action"] = "N/A"
        out["_backtest_relaxed_thresholds"] = False
        out["_used_min_trades"] = 0
        out["_used_min_pf"] = 0.0
        out["backtest_valid"] = False
        out["action"] = "KILL"
        return out

    # ── BROAD_SCANNER bias path / scoring untouched ──────────────
    # Scanner alerts have no backtest stats; we preserve the prior
    # contract of "skip backtest gate, do not pretend to score it".
    if alert_type in ("BROAD_SCANNER", "SENTIMENT_AGENT"):
        out["_backtest_enforcement_action"] = "SKIPPED_SCANNER"
        out["_backtest_relaxed_thresholds"] = False
        out["_used_min_trades"] = 0
        out["_used_min_pf"] = 0.0
        out["backtest_valid"] = True  # scanner path is not gated by backtest
        out["action"] = "PASS"
        return out

    actual_trades = _coerce_int(payload.get("strat_total_trades"))
    actual_pf = _coerce_float(payload.get("strat_profit_factor"))

    thresholds = _select_backtest_thresholds(
        ticker=ticker,
        payload=payload,
        config=config,
        pre_market_mode=pre_market_mode,
        relaxed_mode=relaxed_mode,
    )

    passes = (actual_trades >= thresholds["min_trades"]
              and actual_pf >= thresholds["min_pf"])

    out["_backtest_enforcement_action"] = thresholds["action"]
    out["_backtest_relaxed_thresholds"] = thresholds["relaxed"]
    out["_used_min_trades"] = thresholds["min_trades"]
    out["_used_min_pf"] = thresholds["min_pf"]
    out["backtest_valid"] = passes
    out["action"] = "PASS" if passes else "REJECT_BACKTEST"

    if thresholds["relaxed"]:
        _log_relaxation(ticker, actual_trades, actual_pf, thresholds["action"])

    return out
