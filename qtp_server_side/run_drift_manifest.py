"""
run_drift_manifest.py — one-command QTP Pine parity drift runner.

Shadow / local use only. Not connected to n8n or production workflows.

Usage:
    PYTHONPATH=/home/user/workspace python -m qtp_server_side.run_drift_manifest \
      --manifest /home/user/workspace/pine-source/manifest.json \
      --ohlcv-dir /home/user/workspace/pine-reference/ohlcv \
      --reference-dir /home/user/workspace/pine-reference/outputs \
      --out /home/user/workspace/qtp_server_side/drift_report.json

Expected CSV naming convention when manifest entries do not include explicit
CSV paths:
    <pine_stem>_ohlcv.csv
    <pine_stem>_reference.csv

Each OHLCV CSV must contain open, high, low, close, volume. The first column is
used as a DatetimeIndex when possible. Reference CSV columns should match the
Python output columns you want to compare.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Callable

import pandas as pd

from . import drift
from . import ensemble_engine_v1
from . import quantum_scalp_strategy_v5
from . import quantum_swing_v83
from . import super_score_pro_v25
from . import webhook_bridge_v8


def _compute_pro(df, cross):
    """Pro v2.5 — prefer Pine's exported per-bar cross-asset values when
    available (captured by the splitter from "Pro VIX" / "Pro QQQ Close" /
    "Pro SPY Close" / "Pro QQQ EMA21" / "Pro SPY EMA21" plot patches).
    Falls back to standalone --vix-csv / --qqq-csv / --spy-csv feeds for
    close prices, and falls back to recomputing EMA21 locally when the
    Pine EMA21 isn't available.

    Why this matters: Pine's `request.security(..., ta.ema(close, 21))`
    accesses full QQQ/SPY history. A local export covering only ~300 bars
    can't reproduce that EMA21 on the first ~50 bars (unconverged), which
    flips qqq_bias_bull/bear and propagates into mtf_score → bias_score
    → execution_score. Bug confirmed via diff_at_bar on 2025-05-19.
    """
    vix = cross.get("vix_pine")       if cross.get("vix_pine")       is not None else cross.get("vix")
    qqq = cross.get("qqq_close_pine") if cross.get("qqq_close_pine") is not None else cross.get("qqq")
    spy = cross.get("spy_close_pine") if cross.get("spy_close_pine") is not None else cross.get("spy")
    qqq_e21 = cross.get("qqq_ema21_pine")
    spy_e21 = cross.get("spy_ema21_pine")
    return super_score_pro_v25.compute(
        df, super_score_pro_v25.SuperScoreConfig(),
        vix, qqq, spy,
        qqq_ema21=qqq_e21, spy_ema21=spy_e21,
    )

def _compute_ensemble(df, cross):
    """Ensemble v1 — prefer Pine-exported HTF EMAs and market/leader refs
    when available (captured by splitter from 'Ens HTF EMA 1/2/3/4',
    'Ens Market Close/EMA', 'Ens Leader Close/EMA' plot patches). Falls
    back to standalone VIX/SPY/QQQ CSVs and locally-computed EMAs when
    Pine-exported values aren't present.

    The HTF EMAs are critical: Pine fetches them via request.security on
    higher timeframes (15m/60m/240m/D EMA21/50). They can't be reproduced
    from same-timeframe local data — without supplying them, mtf_bull_score
    / mtf_bear_score are always 0, costing ~25 points of score per bar.
    """
    vix = cross.get("vix_pine") if cross.get("vix_pine") is not None else cross.get("vix")
    market_close = cross.get("market_close_pine") if cross.get("market_close_pine") is not None else cross.get("spy")
    leader_close = cross.get("leader_close_pine") if cross.get("leader_close_pine") is not None else cross.get("qqq")
    return ensemble_engine_v1.compute(
        df, ensemble_engine_v1.EnsembleConfig(),
        vix_close=vix,
        market_close=market_close,
        market_ema=cross.get("market_ema_pine"),
        leader_close=leader_close,
        leader_ema=cross.get("leader_ema_pine"),
        htf_ema_1=cross.get("htf_ema_1_pine"),
        htf_ema_2=cross.get("htf_ema_2_pine"),
        htf_ema_3=cross.get("htf_ema_3_pine"),
        htf_ema_4=cross.get("htf_ema_4_pine"),
    )

def _compute_bridge(df, cross):
    return webhook_bridge_v8.compute_technicals(df).join(
        webhook_bridge_v8.detect_sweeps(df), how="left"
    )

def _compute_scalp(df, cross):
    return quantum_scalp_strategy_v5.compute(
        df, quantum_scalp_strategy_v5.ScalpConfig(),
        vix_close=cross.get("vix"),
        spy_close=cross.get("spy"),
        qqq_close=cross.get("qqq"),
    )

def _compute_swing(df, cross):
    """Quantum Swing v8.3 — SHADOW_ONLY_DAILY. Cross-asset closes are
    fed through directly; SPY/QQQ prev/sma20/ema50 derivatives are computed
    on-the-fly when only close is provided.

    VIX precedence: if the reference CSV has a ``vix_pine`` column (Pine's
    actual per-bar request.security("CBOE:VIX") value, captured by the
    splitter), it is preferred over the standalone --vix-csv feed. This
    bypasses the CBOE:VIX vs TVC:VIX symbol mismatch — TradingView's free
    end-of-day TVC:VIX can diverge from CBOE:VIX by 5-8 points during
    volatility spikes (April 2025 tariff event for example).
    """
    spy = cross.get("spy")
    qqq = cross.get("qqq")
    spy_prev   = spy.shift(1) if spy is not None else None
    spy_sma20  = spy.rolling(20).mean() if spy is not None else None
    spy_ema50  = spy.ewm(span=50, adjust=False).mean() if spy is not None else None
    qqq_prev   = qqq.shift(1) if qqq is not None else None
    qqq_sma20  = qqq.rolling(20).mean() if qqq is not None else None
    qqq_ema50  = qqq.ewm(span=50, adjust=False).mean() if qqq is not None else None

    # Prefer Pine's exported VIX over the standalone CSV when available.
    vix_pine = cross.get("vix_pine")
    vix_series = vix_pine if vix_pine is not None else cross.get("vix")

    return quantum_swing_v83.compute(
        df, quantum_swing_v83.SwingConfig(),
        vix_close=vix_series,
        spy_close=spy, spy_prev=spy_prev, spy_sma20=spy_sma20, spy_ema50=spy_ema50,
        qqq_close=qqq, qqq_prev=qqq_prev, qqq_sma20=qqq_sma20, qqq_ema50=qqq_ema50,
    )

MODULES: dict[str, tuple[str, Callable, dict]] = {
    "ai_super_score_pro_v25_universal.pine":            ("super_score_pro_v25",       _compute_pro,      drift.TOLERANCES_SUPER_SCORE),
    "ai_super_score_ensemble_engine_v1.pine":           ("ensemble_engine_v1",        _compute_ensemble, drift.TOLERANCES_ENSEMBLE),
    "ai_super_score_webhook_bridge_v8.pine":            ("webhook_bridge_v8",         _compute_bridge,   drift.TOLERANCES_INDICATORS),
    "quantum_scalp_strategy_v5.pine":                   ("quantum_scalp_strategy_v5", _compute_scalp,    drift.TOLERANCES_SCALP),
    "quantum_swing_v83_adaptive_multi_ticker.pine":     ("quantum_swing_v83",         _compute_swing,    drift.TOLERANCES_SWING),
}


def _load_close(path: Path | None) -> pd.Series | None:
    """Load a CSV's close column with a DatetimeIndex, suitable for cross-asset feed.
    Returns None if path is None or missing.
    """
    if path is None or not path.exists():
        return None
    df = _read_csv(path)
    if "close" not in df.columns:
        return None
    return df["close"].astype(float)


def _read_csv(path: Path) -> pd.DataFrame:
    """Read a CSV with a best-effort DatetimeIndex on the first column.
    Handles TradingView's two export formats: Unix seconds (numeric) or ISO strings.
    """
    df = pd.read_csv(path)
    if not df.empty:
        first = df.columns[0]
        try:
            if pd.api.types.is_numeric_dtype(df[first]):
                parsed = pd.to_datetime(df[first], unit="s", utc=True, errors="coerce")
            else:
                parsed = pd.to_datetime(df[first], utc=True, errors="coerce")
            if parsed.notna().sum() >= max(1, len(df) // 2):
                df = df.drop(columns=[first])
                df.index = parsed
        except Exception:
            pass
    return df


def _resolve_csv(entry: dict, key: str, default_dir: Path, suffix: str) -> Path:
    if entry.get(key):
        return Path(entry[key])
    stem = Path(entry["file"]).stem
    return default_dir / f"{stem}_{suffix}.csv"


def run(manifest: Path, ohlcv_dir: Path, reference_dir: Path, out: Path, skip_warmup: int,
        vix_csv: Path | None = None, spy_csv: Path | None = None, qqq_csv: Path | None = None) -> dict:
    manifest_data = json.loads(manifest.read_text())

    # Load cross-asset close series once; per-module they're reindexed to the ohlcv index
    cross_master = {
        "vix": _load_close(vix_csv),
        "spy": _load_close(spy_csv),
        "qqq": _load_close(qqq_csv),
    }
    cross_summary = {k: (None if v is None else f"{len(v)} bars {v.index.min()}..{v.index.max()}")
                     for k, v in cross_master.items()}

    report = {
        "manifest": str(manifest),
        "skip_warmup": skip_warmup,
        "cross_asset": cross_summary,
        "modules": [],
    }

    for entry in manifest_data.get("files", []):
        pine_file = entry.get("file")
        if pine_file not in MODULES:
            continue

        module_name, compute_fn, tolerances = MODULES[pine_file]
        ohlcv_csv = _resolve_csv(entry, "ohlcv_csv", ohlcv_dir, "ohlcv")
        reference_csv = _resolve_csv(entry, "reference_csv", reference_dir, "reference")

        module_report = {
            "pine_file": pine_file,
            "module": module_name,
            "ohlcv_csv": str(ohlcv_csv),
            "reference_csv": str(reference_csv),
        }

        if not ohlcv_csv.exists():
            module_report.update({"status": "SKIPPED", "reason": "missing_ohlcv_csv"})
            report["modules"].append(module_report)
            continue
        if not reference_csv.exists():
            module_report.update({"status": "SKIPPED", "reason": "missing_reference_csv"})
            report["modules"].append(module_report)
            continue

        ohlcv = _read_csv(ohlcv_csv)
        reference = _read_csv(reference_csv)
        # Reindex cross-asset series to this module's OHLCV index (forward-fill,
        # leave leading NaN for bars before the cross-asset data begins).
        cross = {
            k: (None if v is None else v.reindex(ohlcv.index, method="ffill"))
            for k, v in cross_master.items()
        }
        # Auto-expose every column named *_pine from the reference CSV into
        # the cross dict. Splitter writes these when Pine plotted a
        # request.security() output. Per-module adapters prefer these over
        # standalone CSV feeds. Works for any future module without code
        # changes — just add the columns to COLUMN_MAPS in split_tv_export.
        for pine_col in [c for c in reference.columns if c.endswith("_pine")]:
            cross[pine_col] = reference[pine_col].astype(float)
        python_df = compute_fn(ohlcv, cross)
        fields = {k: v for k, v in tolerances.items() if k in python_df.columns and k in reference.columns}
        results = drift.drift_report(python_df, reference, fields=fields, skip_warmup=skip_warmup)
        module_report.update({
            "status": "PASS" if all(r["pass"] for r in results.values()) else "DRIFT",
            "fields_tested": len(results),
            "field_results": results,
        })
        report["modules"].append(module_report)

    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2, default=str))
    return report


def main() -> int:
    ap = argparse.ArgumentParser(description="Run QTP Pine parity drift tests from manifest.json.")
    ap.add_argument("--manifest", required=True, type=Path)
    ap.add_argument("--ohlcv-dir", required=True, type=Path)
    ap.add_argument("--reference-dir", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--skip-warmup", type=int, default=50)
    ap.add_argument("--vix-csv", type=Path, default=None, help="Optional VIX 1D CSV (close column used)")
    ap.add_argument("--spy-csv", type=Path, default=None, help="Optional SPY 1D CSV (close column used)")
    ap.add_argument("--qqq-csv", type=Path, default=None, help="Optional QQQ 1D CSV (close column used)")
    args = ap.parse_args()

    report = run(args.manifest, args.ohlcv_dir, args.reference_dir, args.out, args.skip_warmup,
                 vix_csv=args.vix_csv, spy_csv=args.spy_csv, qqq_csv=args.qqq_csv)
    passed = sum(1 for m in report["modules"] if m.get("status") == "PASS")
    drifted = sum(1 for m in report["modules"] if m.get("status") == "DRIFT")
    skipped = sum(1 for m in report["modules"] if m.get("status") == "SKIPPED")
    print(json.dumps({"PASS": passed, "DRIFT": drifted, "SKIPPED": skipped, "out": str(args.out)}, indent=2))
    return 1 if drifted else 0


if __name__ == "__main__":
    raise SystemExit(main())
