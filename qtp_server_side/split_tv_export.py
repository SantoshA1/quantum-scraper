"""
split_tv_export.py — convert a single TradingView "Export chart data" CSV
into the (_ohlcv.csv, _reference.csv) pair expected by run_drift_manifest.

Usage
-----
    python -m qtp_server_side.split_tv_export \
        --in   downloads/AAPL_5m_super_score_pro.csv \
        --module super_score_pro_v25 \
        --out-ohlcv     pine-reference/ohlcv/ai_super_score_pro_v25_universal_ohlcv.csv \
        --out-reference pine-reference/outputs/ai_super_score_pro_v25_universal_reference.csv

What it does
------------
1. Reads the TradingView export (timestamp + OHLCV + indicator-plotted columns).
2. Renames columns to match Python module output names using a per-module map
   (TradingView plot titles rarely match the Python column names exactly).
3. Writes the OHLCV slice (time, open, high, low, close, volume).
4. Writes the reference slice (time + every column listed in the rename map's
   right-hand side that is present in the export).
5. Reports any tolerance-listed columns that are missing from the export
   so you can edit the Pine source to expose them and re-export.

You will almost certainly need to edit COLUMN_MAPS below to match the actual
plot titles your Pine scripts emit. Run with --print-headers first to see
what column names TradingView wrote.
"""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Optional

import pandas as pd

# ---------------------------------------------------------------------------
# Per-module column rename maps
#
# Key = column name as TradingView writes it (i.e. the Pine plot's title= arg)
# Val = column name the Python compute() function emits (must match exactly)
#
# These are best-guess starting points. After you run --print-headers once,
# replace these with the actual TV column names from your export.
# ---------------------------------------------------------------------------

COLUMN_MAPS: dict[str, dict[str, str]] = {
    # Titles below match the actual Pine plot(...title=) strings after applying
    # PINE_PATCHES.md. Confirmed against the .pine source on 2026-05-16.
    "super_score_pro_v25": {
        # already in source — these come from Pro v2.5's existing plots
        "EMA 9":                  "ema9",
        "EMA 21":                 "ema21",
        "EMA 50":                 "ema50",
        "SMA 200":                "sma200",
        "VWAP":                   "vwap",
        # OB zones + BSL/SSL liquidity levels (existing Pine plots; useful
        # for diff_at_bar to compare path-dependent state against Python)
        "BSL":                    "bsl_level",
        "SSL":                    "ssl_level",
        "Bull OB High":           "bull_ob_high",
        "Bull OB Low":            "bull_ob_low",
        "Bear OB High":           "bear_ob_high",
        "Bear OB Low":            "bear_ob_low",
        # added by patch
        "ATR":                    "atr",
        "RSI":                    "rsi",
        "ROC":                    "roc",
        "MACD":                   "macd_line",
        "MACD Signal":            "macd_signal",
        "MACD Histogram":         "macd_hist",
        "ADX":                    "adx",
        "+DI":                    "plus_di",
        "-DI":                    "minus_di",
        "Choppiness":             "chop",
        "Bias Score":             "bias_score",
        "Execution Score":        "execution_score",
        "Smart Money Score":      "smart_money_score",
        "Regime Score":           "regime_score",
        "Score Penalty":          "score_penalty",
        # added by cross-asset-export patch (PINE_PATCHES.md section 6)
        # Captures Pine's actual request.security() values for the full
        # Pro v2.5 history, bypassing CBOE:VIX vs TVC:VIX feed mismatch
        # and the cross-asset coverage gap (standalone CSVs only cover
        # ~300 bars vs Pro v2.5's 2971-bar history).
        "Pro VIX":                "vix_pine",
        "Pro QQQ Close":          "qqq_close_pine",
        "Pro SPY Close":          "spy_close_pine",
        "Pro QQQ EMA21":          "qqq_ema21_pine",
        "Pro SPY EMA21":          "spy_ema21_pine",
    },
    "ensemble_engine_v1": {
        # already in source — note titles do NOT have "Raw" / "Final" prefix
        "Bull Score":             "raw_bull_score",
        "Bear Score":             "raw_bear_score",
        "Ensemble Score":         "final_score",
        "ADX":                    "adx",
        # Pine's existing plot(vix_close, "VIX") — captured as vix_pine so
        # the runner can feed it back to compute() (same trick as Pro v2.5)
        "VIX":                    "vix_pine",
        # added by Rel Vol patch (earlier round)
        "Rel Vol":                "rel_vol",
        # added by cross-asset patch (PINE_PATCHES.md section 7) — captures
        # Pine's exact request.security() output for HTF EMAs and SPY/QQQ refs.
        "Ens HTF EMA 1":          "htf_ema_1_pine",
        "Ens HTF EMA 2":          "htf_ema_2_pine",
        "Ens HTF EMA 3":          "htf_ema_3_pine",
        "Ens HTF EMA 4":          "htf_ema_4_pine",
        "Ens Market Close":       "market_close_pine",
        "Ens Market EMA":         "market_ema_pine",
        "Ens Leader Close":       "leader_close_pine",
        "Ens Leader EMA":         "leader_ema_pine",
        "Ens Volume Score":       "volume_score_pine",
        "Ens Bull Count":         "bull_count_pine",
        "Ens Bear Count":         "bear_count_pine",
    },
    "webhook_bridge_v8": {
        # all added by patch
        "MACD":                   "macd_line",
        "MACD Signal":            "macd_signal",
        "MACD Histogram":         "macd_hist",
    },
    "quantum_scalp_strategy_v5": {
        # already in source
        "Bull Score":             "raw_bull_score",
        "Bear Score":             "raw_bear_score",
        "ADX":                    "adx_val",
        "RSI":                    "rsi_14",
        "RelVol":                 "rel_vol",
        # added by patch
        "ATR":                    "atr_val",
        "MACD Histogram":         "macd_hist",
        "Stoch %K":               "stoch_k",
        "Stoch %D":               "stoch_d",
        "CCI":                    "cci",
        "Gap %":                  "gap_pct",
    },
    "quantum_swing_v83": {
        # Quantum Swing v8.3 — 7 columns from the original source + 17 added by
        # the "Swing-prefixed" plot patch (PINE_PATCHES.md section 5).
        # Prefixes "Swing " on MACD/RSI/ATR/ADX so they don't collide with
        # Pro v2.5 / Phase 1 / Ensemble when those are also on the chart.
        # already in source
        "BB Upper":               "bb_upper",
        "BB Lower":               "bb_lower",
        "BB Mid":                 "bb_mid",
        "SMA 50 (TD pullback)":   "sma_50",
        "SMA 100":                "sma_100",
        "SMA 200":                "sma_200",
        "EMA 21":                 "ema_21",
        # Pine's actual CBOE:VIX value at each bar (plotted by Ensemble v1's
        # plot(vix_close, "VIX") — Pine fetched this via request.security).
        # Captured so the runner can feed it back as the VIX cross-asset
        # input, bypassing the CBOE:VIX vs TVC:VIX symbol mismatch issue.
        "VIX":                    "vix_pine",
        # added by patch (Swing-prefixed where collision risk exists)
        "Swing RSI":              "rsi_14",
        "Swing ATR":              "atr_14",
        "Swing MACD":             "macd_line",
        "Swing MACD Signal":      "macd_signal",
        "Swing MACD Histogram":   "macd_hist",
        "Swing ADX":              "adx_val",
        "Stoch %K":               "stoch_k",
        "Stoch %D":               "stoch_d",
        "CCI":                    "cci",
        "Momentum":               "mom_val",
        "PSAR":                   "psar",
        "Gap %":                  "gap_pct",
        "VIX Size Mult":          "vix_size_mult",
        "VIX Stop Mult":          "vix_stop_mult",
        "Daily DD %":             "daily_dd_pct",
        "Weekly DD %":            "weekly_dd_pct",
        "Momentum R:R":           "swing_mom_rr",
    },
}

# Required columns drift will actually compare against (tolerance keys present
# in the Python output). If any of these are missing post-rename, drift cannot
# validate them.
REQUIRED_REFERENCE_COLS: dict[str, list[str]] = {
    "super_score_pro_v25": [
        "ema9", "ema21", "ema50", "sma200", "atr", "rsi", "roc",
        "macd_line", "macd_signal", "macd_hist", "adx", "plus_di",
        "minus_di", "chop", "vwap", "bias_score", "execution_score",
        "smart_money_score", "regime_score", "score_penalty",
        # Pine cross-asset (not diff'd directly — fed back into compute())
        "vix_pine", "qqq_close_pine", "spy_close_pine",
        "qqq_ema21_pine", "spy_ema21_pine",
        # OB/BSL state for diff_at_bar (compared against Python's internal state)
        "bsl_level", "ssl_level",
        "bull_ob_high", "bull_ob_low", "bear_ob_high", "bear_ob_low",
    ],
    "ensemble_engine_v1": [
        "raw_bull_score", "raw_bear_score", "final_score", "adx", "rel_vol",
        # Pine cross-asset (not diff'd directly — fed back into compute())
        "vix_pine",
        "htf_ema_1_pine", "htf_ema_2_pine", "htf_ema_3_pine", "htf_ema_4_pine",
        "market_close_pine", "market_ema_pine",
        "leader_close_pine", "leader_ema_pine",
        "volume_score_pine", "bull_count_pine", "bear_count_pine",
    ],
    "webhook_bridge_v8": [
        "macd_line", "macd_signal", "macd_hist",
    ],
    "quantum_scalp_strategy_v5": [
        "raw_bull_score", "raw_bear_score", "adx_val", "rsi_14", "rel_vol",
        "atr_val", "macd_hist", "stoch_k", "stoch_d", "cci", "gap_pct",
    ],
    "quantum_swing_v83": [
        # Original source plots
        "bb_upper", "bb_lower", "bb_mid",
        "sma_50", "sma_100", "sma_200",
        "ema_21",
        # Added by the v8.3 plot patch
        "rsi_14", "atr_14",
        "macd_line", "macd_signal", "macd_hist",
        "adx_val",
        "stoch_k", "stoch_d", "cci", "mom_val", "psar",
        "gap_pct", "swing_mom_rr",
        "vix_size_mult", "vix_stop_mult",
        "daily_dd_pct", "weekly_dd_pct",
        # vix_pine is passed through to the runner as the cross-asset VIX
        # input (not diff'd directly). Listed here so the splitter writes it
        # into the reference CSV.
        "vix_pine",
    ],
}


# ---------------------------------------------------------------------------
# Splitter
# ---------------------------------------------------------------------------

OHLCV_COLS = ["open", "high", "low", "close", "volume"]


def _normalize_time(df: pd.DataFrame) -> pd.DataFrame:
    """Find the timestamp column, parse to UTC, and set as a 'time' column.
    Handles TradingView's two export formats:
      - Unix seconds (numeric, e.g. 1406208600)
      - ISO 8601 strings (e.g. '2014-07-24T13:30:00Z')
    """
    candidates = [c for c in df.columns if c.lower() in ("time", "date", "datetime", "timestamp")]
    if not candidates:
        candidates = [df.columns[0]]
    tcol = candidates[0]

    if pd.api.types.is_numeric_dtype(df[tcol]):
        # Unix seconds — TradingView's default for "Export chart data"
        parsed = pd.to_datetime(df[tcol], unit="s", utc=True, errors="coerce")
    else:
        parsed = pd.to_datetime(df[tcol], utc=True, errors="coerce")

    df = df.drop(columns=[tcol])
    df.insert(0, "time", parsed)
    return df.dropna(subset=["time"])


def _normalize_ohlcv(df: pd.DataFrame) -> pd.DataFrame:
    rename = {}
    for c in df.columns:
        cl = c.strip().lower()
        if cl in ("open", "o"):     rename[c] = "open"
        elif cl in ("high", "h"):   rename[c] = "high"
        elif cl in ("low", "l"):    rename[c] = "low"
        elif cl in ("close", "c"):  rename[c] = "close"
        elif cl in ("volume", "v"): rename[c] = "volume"
    return df.rename(columns=rename)


def split(
    in_csv: Path,
    module: str,
    out_ohlcv: Path,
    out_reference: Path,
    column_map: Optional[dict[str, str]] = None,
) -> dict:
    if module not in COLUMN_MAPS:
        raise ValueError(f"Unknown module {module!r}. Known: {list(COLUMN_MAPS)}")

    df = pd.read_csv(in_csv)
    df = _normalize_time(df)
    df = _normalize_ohlcv(df)

    cmap = dict(COLUMN_MAPS[module])
    if column_map:
        cmap.update(column_map)

    # Rename indicator columns; leave unknowns alone
    df = df.rename(columns=cmap)

    # OHLCV CSV — fill any missing column (most commonly 'volume') with 0
    # so downstream compute() doesn't KeyError. Drift on volume-derived fields
    # will then DRIFT and should be ignored.
    missing_ohlcv = [c for c in OHLCV_COLS if c not in df.columns]
    for c in missing_ohlcv:
        df[c] = 0
    ohlcv_cols = ["time"] + OHLCV_COLS
    out_ohlcv.parent.mkdir(parents=True, exist_ok=True)
    df[ohlcv_cols].to_csv(out_ohlcv, index=False)

    # Reference CSV
    target_cols = REQUIRED_REFERENCE_COLS[module]
    present  = [c for c in target_cols if c in df.columns]
    missing  = [c for c in target_cols if c not in df.columns]
    ref_cols = ["time"] + present
    out_reference.parent.mkdir(parents=True, exist_ok=True)
    df[ref_cols].to_csv(out_reference, index=False)

    return {
        "module": module,
        "in_csv": str(in_csv),
        "rows": len(df),
        "ohlcv_csv": str(out_ohlcv),
        "ohlcv_missing": missing_ohlcv,
        "reference_csv": str(out_reference),
        "reference_present": present,
        "reference_missing": missing,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--in",      dest="in_csv", required=True, type=Path,
                    help="TradingView combined export CSV")
    ap.add_argument("--module",  required=True, choices=list(COLUMN_MAPS),
                    help="Which Python module this export will validate")
    ap.add_argument("--out-ohlcv",     required=True, type=Path)
    ap.add_argument("--out-reference", required=True, type=Path)
    ap.add_argument("--print-headers", action="store_true",
                    help="Print the column names from the TV export and exit. "
                         "Use this first to discover the actual plot titles, "
                         "then update COLUMN_MAPS in this file.")
    args = ap.parse_args()

    if args.print_headers:
        df = pd.read_csv(args.in_csv, nrows=2)
        print("\n".join(df.columns))
        return 0

    result = split(args.in_csv, args.module, args.out_ohlcv, args.out_reference)
    print("--- split summary ---")
    for k, v in result.items():
        print(f"{k:18s}: {v}")
    if result["ohlcv_missing"]:
        print(f"\nWARNING: OHLCV columns missing from export: {result['ohlcv_missing']}")
    if result["reference_missing"]:
        print(f"\nWARNING: reference columns NOT in export "
              f"(drift cannot validate these): {result['reference_missing']}")
        print("Edit the Pine source to plot these as `display=display.data_window` "
              "with a matching title, re-export, and re-run.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
