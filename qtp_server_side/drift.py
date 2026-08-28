"""
drift.py — Drift validation utilities for comparing Python port output
against TradingView Pine Script reference data.

Shadow / local use only.

How to use
----------
1. In TradingView, open the Data Window (shift+click any bar) and export
   values for the indicators you want to validate.  Copy into a CSV with
   columns matching the field names in the relevant module.

2. Load the CSV as a DataFrame, run the Python compute() function on the
   same OHLCV data, and call compare_series() to see per-bar differences.

3. For each series, check:
   a. Warm-up period: Pine initializes with NaN for length-1 bars; Python
      will match after the warm-up window.  Use ``skip_warmup=True``.
   b. VWAP session reset: daily-reset VWAP requires aligned timestamps.
   c. EMA seeding: Python EMA seeds with SMA(length); verify convergence.
   d. ATR / RMA: Wilder smoothing (alpha=1/length) must converge with Pine.

Drift thresholds
----------------
* Momentum / trend indicators (RSI, MACD, EMA): tolerance 0.01
  After ~3×length bars they should converge to within floating-point error.
* ATR: tolerance 0.005 (depends on price scale)
* Score integers (bias_score, execution_score): tolerance 0.1
  Some differences are expected if VIX/SPY/QQQ data is not aligned.
* ADX: tolerance 0.1 — more sensitive to initialization differences.

Known divergence sources
------------------------
* VWAP: Python rolling window ≠ Pine session reset.  Use vwap_daily() with
  a DatetimeIndex to improve accuracy.
* Pseudo-ADX (bridge): Pine's non-standard formula
  ``ta.rma(abs(ta.change(high) - ta.change(low)), 14)`` will differ from
  standard ADX.  We reproduce it faithfully; verify using data window values.
* Parabolic SAR: simplified implementation; first 20 bars may differ.
* FVG / OB / Liquidity pools: var-state persistent values rely on the exact
  same invalidation logic; off-by-one errors are possible on the invalidation
  bars.  Compare inBullFVG, inBearOB etc. bool columns carefully.
* Smart money score on first sweep bars: sweep detection uses highest/lowest
  with shift=1; edge case at bar 0 may differ by 1 bar.
"""

from __future__ import annotations

import warnings
from typing import Optional

import numpy as np
import pandas as pd


# ---------------------------------------------------------------------------
# Core comparison helpers
# ---------------------------------------------------------------------------

def compare_series(
    python_s: pd.Series,
    pine_s: pd.Series,
    name: str = "",
    tolerance: float = 0.01,
    skip_warmup: int = 0,
    verbose: bool = True,
) -> dict:
    """
    Compare a Python-computed series against a Pine reference series.

    Parameters
    ----------
    python_s    : Series from Python port, aligned to the same bar index.
    pine_s      : Series exported from TradingView data window.
    name        : Field name for reporting.
    tolerance   : Acceptable absolute difference per bar.
    skip_warmup : Number of leading bars to exclude (NaN / seed period).
    verbose     : Print a summary.

    Returns
    -------
    dict with keys:
        n_bars, n_compared, n_match, n_drift, max_abs_diff, mean_abs_diff,
        drift_bars (list of index values with diff > tolerance),
        pass (bool)
    """
    py = python_s.copy()
    pi = pine_s.copy()

    # Align
    common = py.index.intersection(pi.index)
    py = py.reindex(common)
    pi = pi.reindex(common)

    if skip_warmup:
        py = py.iloc[skip_warmup:]
        pi = pi.iloc[skip_warmup:]

    # Drop bars where either is NaN
    mask = py.notna() & pi.notna()
    py_c = py[mask]
    pi_c = pi[mask]

    if len(py_c) == 0:
        if verbose:
            print(f"[drift] {name}: NO COMPARABLE BARS (all NaN)")
        return {"n_bars": len(common), "n_compared": 0, "n_match": 0,
                "n_drift": 0, "max_abs_diff": np.nan, "mean_abs_diff": np.nan,
                "drift_bars": [], "pass": False}

    diff = (py_c - pi_c).abs()
    n_match = int((diff <= tolerance).sum())
    n_drift = int((diff > tolerance).sum())
    drift_idx = list(diff[diff > tolerance].index)

    result = {
        "n_bars":        len(common),
        "n_compared":    len(py_c),
        "n_match":       n_match,
        "n_drift":       n_drift,
        "max_abs_diff":  float(diff.max()),
        "mean_abs_diff": float(diff.mean()),
        "drift_bars":    drift_idx,
        "pass":          n_drift == 0,
    }

    if verbose:
        status = "PASS" if result["pass"] else f"DRIFT ({n_drift}/{len(py_c)} bars)"
        print(
            f"[drift] {name:40s}  {status}  "
            f"max={result['max_abs_diff']:.6f}  mean={result['mean_abs_diff']:.6f}"
        )
    return result


def compare_bool_series(
    python_s: pd.Series,
    pine_s: pd.Series,
    name: str = "",
    skip_warmup: int = 0,
    verbose: bool = True,
) -> dict:
    """
    Compare boolean series (exact match expected).
    Returns same structure as compare_series.
    """
    py = python_s.astype(bool)
    pi = pine_s.astype(bool)

    common = py.index.intersection(pi.index)
    py = py.reindex(common)
    pi = pi.reindex(common)

    if skip_warmup:
        py = py.iloc[skip_warmup:]
        pi = pi.iloc[skip_warmup:]

    match = py == pi
    n_match = int(match.sum())
    n_drift = int((~match).sum())
    drift_idx = list(match[~match].index)

    result = {
        "n_bars":      len(common),
        "n_compared":  len(py),
        "n_match":     n_match,
        "n_drift":     n_drift,
        "max_abs_diff": float(n_drift),
        "mean_abs_diff": float(n_drift / max(len(py), 1)),
        "drift_bars":  drift_idx,
        "pass":        n_drift == 0,
    }

    if verbose:
        status = "PASS" if result["pass"] else f"DRIFT ({n_drift}/{len(py)} bars)"
        print(f"[drift] {name:40s}  {status}")
    return result


# ---------------------------------------------------------------------------
# Batch drift report
# ---------------------------------------------------------------------------

def drift_report(
    python_df: pd.DataFrame,
    pine_df: pd.DataFrame,
    fields: Optional[dict] = None,
    skip_warmup: int = 50,
) -> dict:
    """
    Run a batch drift comparison for multiple fields.

    Parameters
    ----------
    python_df   : DataFrame from Python compute() function.
    pine_df     : DataFrame with Pine reference values (same column names).
    fields      : Mapping of {column_name: tolerance}.
                  Defaults to common numeric columns with tolerance 0.05.
    skip_warmup : Bars to skip at the start (indicator warm-up).

    Returns
    -------
    dict mapping column_name → result dict from compare_series().
    """
    if fields is None:
        common_cols = python_df.columns.intersection(pine_df.columns)
        numeric = [c for c in common_cols
                   if pd.api.types.is_numeric_dtype(python_df[c])]
        fields = {c: 0.05 for c in numeric}

    results = {}
    for col, tol in fields.items():
        if col not in python_df.columns:
            warnings.warn(f"drift_report: column {col!r} not in python_df")
            continue
        if col not in pine_df.columns:
            warnings.warn(f"drift_report: column {col!r} not in pine_df")
            continue
        results[col] = compare_series(
            python_df[col], pine_df[col],
            name=col, tolerance=tol, skip_warmup=skip_warmup,
        )

    passed = sum(1 for r in results.values() if r["pass"])
    total  = len(results)
    print(f"\n[drift] Summary: {passed}/{total} fields PASS (skip_warmup={skip_warmup})")
    return results


# ---------------------------------------------------------------------------
# Recommended field tolerances per module
# ---------------------------------------------------------------------------

TOLERANCES_INDICATORS = {
    "ema9":       0.01,
    "ema21":      0.01,
    "ema50":      0.01,
    "sma200":     0.01,
    "atr":        0.005,
    "rsi":        0.05,
    "roc":        0.01,
    "macd_line":  0.005,
    "macd_signal":0.005,
    "macd_hist":  0.005,
    "adx":        0.1,
    "plus_di":    0.05,
    "minus_di":   0.05,
    "chop":       0.1,
}

TOLERANCES_SUPER_SCORE = {
    **TOLERANCES_INDICATORS,
    "vwap":             0.05,   # session reset may cause divergence early
    "bias_score":       0.5,    # integer-rounded on TV; small float diffs ok
    "execution_score":  0.5,
    "smart_money_score":1.0,    # compound score; higher tolerance
    "regime_score":     0.0,    # should be exact (discrete values)
    "score_penalty":    1.0,
}

TOLERANCES_ENSEMBLE = {
    "raw_bull_score": 1.0,
    "raw_bear_score": 1.0,
    "final_score":    1.0,
    "adx":            0.1,
    "rel_vol":        0.02,
}

TOLERANCES_SCALP = {
    "raw_bull_score": 1.0,
    "raw_bear_score": 1.0,
    "adx_val":        0.1,
    "rsi_14":         0.05,
    "rel_vol":        0.05,
    "atr_val":        0.005,
    "macd_hist":      0.005,
    "stoch_k":        0.1,
    "stoch_d":        0.1,
    "cci":            0.2,
    "gap_pct":        0.01,
}

TOLERANCES_SWING = {
    # Indicator basics — daily timeframe, looser than scalp/intraday
    "rsi_14":        0.05,
    "atr_14":        0.05,
    "macd_line":     0.05,
    "macd_signal":   0.05,
    "macd_hist":     0.05,
    "adx_val":       0.1,
    "plus_di":       0.1,
    "minus_di":      0.1,
    "stoch_k":       0.1,
    "stoch_d":       0.1,
    "cci":           0.2,
    "mom_val":       0.05,
    "rel_vol":       0.05,
    # Bollinger
    "bb_upper":      0.05,
    "bb_lower":      0.05,
    "bb_mid":        0.05,
    "bb_width_pct":  0.05,
    # Moving averages
    "sma_50":        0.01,
    "sma_100":       0.01,
    "sma_200":       0.01,
    "ema_21":        0.01,
    "ema_50":        0.01,
    "ema_200":       0.01,
    # Pivot / SAR
    "pivot_classic": 0.01,
    "psar":          0.10,    # SAR initialization differs first ~20 bars
    # v8 risk + momentum override
    "gap_pct":       0.05,
    "swing_mom_rr":  0.10,
    "vix_size_mult": 0.0,     # discrete buckets — should be exact
    "vix_stop_mult": 0.0,
    "daily_dd_pct":  0.05,
    "weekly_dd_pct": 0.05,
}


# ---------------------------------------------------------------------------
# Known differences summary
# ---------------------------------------------------------------------------

KNOWN_DIFFERENCES = """
Known differences between Python port and TradingView Pine output
================================================================

indicators.py
-------------
1. EMA warm-up: Python seeds with SMA(length) then switches to EMA.
   TradingView's engine does the same; however, bar indices differ when
   the chart has fewer bars than history.  Expect exact match after
   3×length bars.

2. ATR/RMA: Wilder smoothing (alpha=1/length).  Same algorithm; difference
   arises only in the first length*3 bars.

3. VWAP: Python vwap_rolling() is a rolling window; Pine resets each session.
   Use vwap_daily() with DatetimeIndex for better accuracy.
   Expect divergence on the first bar of each new trading day.

4. Parabolic SAR: Simplified initialization; first ~20 bars may differ.

super_score_pro_v25.py
----------------------
5. VIX / QQQ / SPY data must be externally supplied.  If the timestamps
   don't align exactly (market close vs bar close), execution_score will
   differ by the VIX/spy penalty terms.

6. Regime detection (ADX + Chop): consistent after ~3×lenChop bars.

7. FVG / OB / Liquidity pool invalidation: var-state is replicated via
   forward-fill loops.  Off-by-one can occur if Pine's evaluation order
   within a bar differs.

8. smartMoneyScore uses liqSweepBull score which is +18 on the sweep bar.
   Ensure prev_swing_low uses shift=1 (Pine high[1]).

webhook_bridge_v8.py
--------------------
9. Pseudo-ADX formula: ``ta.rma(abs(ta.change(high) - ta.change(low)), 14)``
   is NOT standard ADX.  This is replicated faithfully but will diverge from
   any external ADX reference.

10. VWAP: bridge uses ``ta.vwap(close)`` (close, not hlc3).  vwap_rolling()
    approximates this; daily reset will differ.

ensemble_engine_v1.py
---------------------
11. HTF EMA series: must be pre-aligned.  If forward-fill is not done
    correctly (e.g., gaps at market open), counts will differ.

12. Divergence lookback uses ta.lowest(rsi[1], 10) — shift=1.  Ensure
    rsi_higher_low uses the shifted series.

quantum_scalp_strategy_v5.py
-----------------------------
13. Time-of-day volume factor (tod_vol_adj): approximate.  Requires
    accurate bar-of-day calculation from DatetimeIndex.

14. Weekly drawdown tracking: requires consistent new_week detection.
    Use ta.change(time("W")) equivalent (DatetimeIndex.isocalendar().week).

15. strategy.exit trailing stop: not emulated in compute().  Only entry
    signals and exit trigger levels are returned.

16. fill_orders_on_standard_ohlc=false + use_bar_magnifier=true: these
    TradingView execution parameters cannot be replicated server-side.
    Backtest P&L will differ from strategy tester.
"""


def print_known_differences():
    """Print the known differences summary."""
    print(KNOWN_DIFFERENCES)
