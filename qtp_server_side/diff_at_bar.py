"""
diff_at_bar.py — Per-bar Pine vs Python parity diagnostic.

Shadow / local use only.

The drift_report.json tells you which columns drift overall. This script zooms
into a single bar and prints a side-by-side comparison of every Pine reference
value vs every Python compute() output, plus the Python-internal intermediate
scoring components that aren't plotted on the Pine side. The intent: find the
*first* component in the scoring chain that disagrees so you know exactly which
piece of porting math to fix.

Usage
-----
Locate a bar by absolute index:
    PYTHONPATH=. python -m qtp_server_side.diff_at_bar \
        --module super_score_pro_v25 --bar 200

Locate a bar by timestamp (UTC, parsed loosely):
    PYTHONPATH=. python -m qtp_server_side.diff_at_bar \
        --module super_score_pro_v25 --time "2025-04-09"

Auto-locate the worst-drift bar for a specific field:
    PYTHONPATH=. python -m qtp_server_side.diff_at_bar \
        --module super_score_pro_v25 --worst-of bias_score

You can pass standard cross-asset flags identical to run_drift_manifest:
    --vix-csv FILE --spy-csv FILE --qqq-csv FILE
When the reference CSV already contains Pine-exported cross-asset (vix_pine etc.),
those are preferred automatically — same fallback chain as the drift runner.

Output (stdout)
---------------
1. Bar metadata: timestamp, bar index, OHLCV, cross-asset inputs.
2. Side-by-side table of every column present in both Pine and Python — with
   the diff and a verdict marker.
3. Python-only intermediate columns (the scoring components Pine doesn't plot).
4. A "scoring chain" section that builds bias_score / execution_score from
   their components, so you can eyeball which component made the score wrong.
5. A one-line "first divergence" hint.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Optional

import numpy as np
import pandas as pd

from . import drift
from . import run_drift_manifest as rdm


# ---------------------------------------------------------------------------
# Module-specific intermediate column groupings, surfaced in the chain view
# ---------------------------------------------------------------------------

SCORE_CHAIN: dict[str, dict[str, list[str]]] = {
    "super_score_pro_v25": {
        "bias_score components": [
            "trend_score", "mtf_score", "mom_score", "vol_score",
            "bb_score", "price_action_score", "smart_money_score", "regime_score",
        ],
        "smart_money_score flags": [
            "smart_bull_flow", "smart_bear_flow",        # ±10 weight
            "bull_displacement", "bear_displacement",    # ±8 weight
            "in_bull_ob", "in_bear_ob",                  # ±8 weight
            "in_bull_fvg", "in_bear_fvg",                # ±6 weight
            "bsl_swept", "ssl_swept",                    # ±8 weight
            "liq_sweep_bull", "liq_sweep_bear",
            "bull_sweep_score", "bear_sweep_score",      # variable bonus
            "bull_blocked_by_bear_ob", "bear_blocked_by_bull_ob",
            "valid_bull_location", "valid_bear_location",
        ],
        "OB / liquidity state (path-dependent)": [
            "bsl_level", "ssl_level",
            "bull_ob_high", "bull_ob_low",
            "bear_ob_high", "bear_ob_low",
        ],
        "score_penalty components": [
            "vol_penalty", "regime_penalty", "ob_penalty",
            "vix_penalty", "vwap_penalty", "location_penalty",
        ],
        "regime detection": [
            "is_trending", "is_choppy", "is_bull_trend", "is_bear_trend",
        ],
        "execution_score derivation": [
            "raw_bias_score", "bias_score", "score_penalty", "execution_score",
        ],
    },
    "ensemble_engine_v1": {
        "raw scores": [
            "raw_bull_score", "raw_bear_score", "final_score",
        ],
        "component scores": [
            "manual_bull_score", "manual_bear_score",
            "mtf_bull_score", "mtf_bear_score",
            "regime_score", "volume_score",
            "momentum_bull_score", "momentum_bear_score",
            "location_bull_score", "location_bear_score",
            "market_bull_score", "market_bear_score",
            "divergence_bull_bonus", "divergence_bear_bonus",
        ],
        "gates": [
            "bull_mtf_gate", "bear_mtf_gate",
            "bull_market_gate", "bear_market_gate",
            "bull_location_gate", "bear_location_gate",
            "bull_confirm_gate", "bear_confirm_gate",
            "bull_hard_ok", "bear_hard_ok",
            "bull_ready", "bear_ready",
        ],
    },
    "quantum_swing_v83": {
        "signals": [
            "mr_long_signal", "mr_short_signal",
            "td_long_signal", "td_short_signal",
            "swing_momentum_long", "swing_momentum_short",
            "long_signal", "short_signal", "swing_is_momentum",
        ],
        "engine selection": [
            "is_mr", "is_td", "eff_engine",
        ],
        "v8.3 fresh breakouts": [
            "td_fresh_breakout", "td_fresh_breakdown",
        ],
        "vix-adaptive": [
            "vix_size_mult", "vix_stop_mult",
            "eff_mr_size_adj", "eff_td_size_adj",
        ],
    },
    "quantum_scalp_strategy_v5": {
        "raw scores": ["raw_bull_score", "raw_bear_score"],
        "indicators": ["adx_val", "rsi_14", "atr_val", "macd_hist", "stoch_k", "stoch_d", "cci", "rel_vol", "gap_pct"],
    },
    "webhook_bridge_v8": {
        "macd": ["macd_line", "macd_signal", "macd_hist"],
        "sweep": ["bull_sweep", "bear_sweep", "swing_high", "swing_low"],
    },
}


# ---------------------------------------------------------------------------
# Locator: resolve --bar / --time / --worst-of into a positional index
# ---------------------------------------------------------------------------

def _resolve_bar_index(
    pine_df: pd.DataFrame,
    drift_results: Optional[dict],
    bar: Optional[int],
    time_str: Optional[str],
    worst_of: Optional[str],
    python_df: Optional[pd.DataFrame] = None,
) -> int:
    if bar is not None:
        if bar < 0 or bar >= len(pine_df):
            raise ValueError(f"bar {bar} out of range [0, {len(pine_df)})")
        return bar

    if time_str is not None:
        target = pd.to_datetime(time_str, utc=True)
        # Find nearest bar by index (DatetimeIndex)
        if not isinstance(pine_df.index, pd.DatetimeIndex):
            raise ValueError("--time requires a DatetimeIndex on the reference; got positional index")
        idx = pine_df.index.get_indexer([target], method="nearest")[0]
        if idx < 0:
            raise ValueError(f"time {time_str!r} could not be located")
        return int(idx)

    if worst_of is not None:
        if drift_results is None or worst_of not in drift_results:
            raise ValueError(f"--worst-of {worst_of!r}: no drift result for that field in drift_report.json")
        r = drift_results[worst_of]
        if r["n_drift"] == 0:
            print(f"[note] {worst_of} has no drifting bars — picking last bar instead")
            return len(pine_df) - 1
        # drift_bars is a list of index labels (timestamps if DatetimeIndex)
        # Find the bar whose drift magnitude is the max
        bar_labels = r["drift_bars"]
        return _find_worst_label(pine_df, bar_labels, worst_of, python_df=python_df)

    raise ValueError("must supply one of --bar / --time / --worst-of")


def _find_worst_label(pine_df: pd.DataFrame, labels: list, field: str,
                      python_df: Optional[pd.DataFrame] = None) -> int:
    """Given drift_bar labels and a field, return the positional index of the
    bar with the LARGEST |Pine - Python| diff for that field. Requires
    python_df to evaluate magnitudes; if not supplied, returns the first
    label (still in the drift set, just not necessarily the worst).
    """
    if not labels:
        return 0
    if not isinstance(pine_df.index, pd.DatetimeIndex):
        return 0
    label_idx_map = []
    for lbl in labels:
        try:
            t = pd.to_datetime(lbl, utc=True)
            pos = int(pine_df.index.get_indexer([t], method="nearest")[0])
            if pos >= 0:
                label_idx_map.append(pos)
        except Exception:
            continue
    if not label_idx_map:
        return 0
    if python_df is None or field not in python_df.columns or field not in pine_df.columns:
        return label_idx_map[0]
    best_pos, best_diff = label_idx_map[0], -1.0
    for pos in label_idx_map:
        try:
            d = abs(float(pine_df[field].iloc[pos]) - float(python_df[field].iloc[pos]))
        except Exception:
            d = -1.0
        if d > best_diff:
            best_diff = d
            best_pos = pos
    return best_pos


# ---------------------------------------------------------------------------
# Side-by-side formatting
# ---------------------------------------------------------------------------

def _fmt(v) -> str:
    if v is None or (isinstance(v, float) and np.isnan(v)):
        return "    nan "
    if isinstance(v, (bool, np.bool_)):
        return f"{bool(v)!s:>9s}"
    if isinstance(v, (int, np.integer)):
        return f"{int(v):>9d}"
    if isinstance(v, (float, np.floating)):
        if abs(v) >= 1000:
            return f"{v:9.2f}"
        if abs(v) >= 1:
            return f"{v:9.4f}"
        return f"{v:9.6f}"
    return f"{str(v):>9s}"


def _diff_marker(p, q, tol: float) -> str:
    try:
        if p is None or q is None: return "?"
        if isinstance(p, (bool, np.bool_)) or isinstance(q, (bool, np.bool_)):
            return "ok" if bool(p) == bool(q) else "✗"
        if np.isnan(float(p)) or np.isnan(float(q)):
            return "·"
        d = abs(float(p) - float(q))
        return "ok" if d <= tol else "✗"
    except Exception:
        return "?"


def _print_table(rows: list[tuple], header: str):
    if not rows:
        return
    print(f"\n  ── {header} ──")
    print(f"  {'column':<26s}  {'Pine':>9s}  {'Python':>9s}  {'|diff|':>10s}  v")
    print(f"  {'-'*26}  {'-'*9}  {'-'*9}  {'-'*10}  -")
    for col, pine_v, py_v, tol in rows:
        try:
            d = abs(float(pine_v) - float(py_v)) if (pd.notna(pine_v) and pd.notna(py_v)) else float("nan")
        except Exception:
            d = float("nan")
        mark = _diff_marker(pine_v, py_v, tol)
        d_str = f"{d:10.4f}" if not np.isnan(d) else "      nan "
        print(f"  {col:<26s}  {_fmt(pine_v)}  {_fmt(py_v)}  {d_str}  {mark}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def _load_drift_results(report_path: Path, module: str) -> Optional[dict]:
    if not report_path.exists():
        return None
    d = json.loads(report_path.read_text())
    for m in d.get("modules", []):
        if m.get("module") == module:
            return m.get("field_results")
    return None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--module", required=True,
                    choices=[m for m, _, _ in rdm.MODULES.values()])
    ap.add_argument("--manifest", type=Path, default=Path("pine-source/manifest.json"))
    ap.add_argument("--ohlcv-dir", type=Path, default=Path("pine-reference/ohlcv"))
    ap.add_argument("--reference-dir", type=Path, default=Path("pine-reference/outputs"))
    ap.add_argument("--drift-report", type=Path, default=Path("qtp_server_side/drift_report.json"))
    ap.add_argument("--vix-csv", type=Path, default=None)
    ap.add_argument("--spy-csv", type=Path, default=None)
    ap.add_argument("--qqq-csv", type=Path, default=None)
    bar_grp = ap.add_mutually_exclusive_group(required=True)
    bar_grp.add_argument("--bar", type=int, help="positional bar index")
    bar_grp.add_argument("--time", help="timestamp like '2025-04-09'")
    bar_grp.add_argument("--worst-of", help="field name; pick worst-drift bar from drift_report.json")
    args = ap.parse_args()

    # Resolve the module entry
    pine_file = next(p for p, (m, _, _) in rdm.MODULES.items() if m == args.module)
    _, compute_fn, tolerances = rdm.MODULES[pine_file]

    # Load manifest + fixtures
    manifest = json.loads(args.manifest.read_text())
    entry = next(e for e in manifest["files"] if e["file"] == pine_file)
    stem = Path(entry["file"]).stem
    ohlcv_csv = args.ohlcv_dir / f"{stem}_ohlcv.csv"
    reference_csv = args.reference_dir / f"{stem}_reference.csv"
    if not ohlcv_csv.exists() or not reference_csv.exists():
        print(f"[error] missing fixtures: {ohlcv_csv.exists()=}, {reference_csv.exists()=}")
        return 1

    ohlcv = rdm._read_csv(ohlcv_csv)
    pine = rdm._read_csv(reference_csv)

    # Build cross-asset dict (standalone CSVs + reference Pine-exported)
    cross_master = {
        "vix": rdm._load_close(args.vix_csv),
        "spy": rdm._load_close(args.spy_csv),
        "qqq": rdm._load_close(args.qqq_csv),
    }
    cross = {
        k: (None if v is None else v.reindex(ohlcv.index, method="ffill"))
        for k, v in cross_master.items()
    }
    # Auto-pick up every *_pine column from the reference CSV — same pattern
    # as run_drift_manifest, so diff_at_bar's compute() call sees the same
    # cross-asset inputs that the real drift runner uses.
    for pine_col in [c for c in pine.columns if c.endswith("_pine")]:
        cross[pine_col] = pine[pine_col].astype(float)

    python_df = compute_fn(ohlcv, cross)

    # Locate the bar
    drift_results = _load_drift_results(args.drift_report, args.module)
    idx = _resolve_bar_index(pine, drift_results, args.bar, args.time, args.worst_of,
                              python_df=python_df)

    label = pine.index[idx]
    print(f"\n═══ diff_at_bar — {args.module} — bar {idx} ═══")
    print(f"  label:   {label}")
    print(f"  module:  {args.module}")
    print(f"  pine_file: {pine_file}")
    print(f"  total bars: {len(pine)}")

    # OHLCV row
    o_row = ohlcv.iloc[idx]
    print(f"\n  OHLCV:")
    for k in ("open", "high", "low", "close", "volume"):
        if k in o_row:
            print(f"    {k:8s} = {_fmt(o_row[k])}")

    # Cross-asset inputs at this bar
    cross_at = {}
    for k, v in cross.items():
        if v is None: continue
        if hasattr(v, "iloc") and len(v) > idx:
            cross_at[k] = v.iloc[idx]
    if cross_at:
        print(f"\n  cross-asset @ bar:")
        for k, val in cross_at.items():
            print(f"    {k:18s} = {_fmt(val)}")

    # ── Side-by-side for every column that exists in BOTH pine and python_df ──
    pine_row = pine.iloc[idx]
    py_row   = python_df.iloc[idx]
    common = [c for c in pine.columns if c in python_df.columns]
    drifted_rows = []
    matched_rows = []
    for col in common:
        tol = tolerances.get(col, 0.05)
        p = pine_row[col]; q = py_row[col]
        try:
            d = abs(float(p) - float(q)) if (pd.notna(p) and pd.notna(q)) else float("nan")
            is_drift = (not np.isnan(d)) and d > tol
        except Exception:
            is_drift = True
        (drifted_rows if is_drift else matched_rows).append((col, p, q, tol))

    print(f"\n  ╔══ {len(drifted_rows)} drifted / {len(matched_rows)} matched / {len(common)} compared ══╗")
    _print_table(drifted_rows, f"DRIFTING — Pine ≠ Python")
    _print_table(matched_rows, f"matched (within tolerance)")

    # ── Python-only intermediates from SCORE_CHAIN ──
    chain = SCORE_CHAIN.get(args.module, {})
    if chain:
        print(f"\n  ╔══ Python intermediates (Pine doesn't plot these — Python-only diagnostic) ══╗")
        for group_name, cols in chain.items():
            present = [(c, py_row[c]) for c in cols if c in python_df.columns]
            if not present: continue
            print(f"\n  ── {group_name} ──")
            for c, v in present:
                # If the same name exists in Pine too, also show Pine value
                pine_v = pine_row[c] if c in pine.columns else None
                pine_str = f"  (pine={_fmt(pine_v)})" if pine_v is not None else ""
                print(f"    {c:26s} = {_fmt(v)}{pine_str}")

    # ── First-divergence hint ──
    if drifted_rows:
        first_drift = sorted(drifted_rows, key=lambda r: -(abs(float(r[1]) - float(r[2])) if (pd.notna(r[1]) and pd.notna(r[2])) else 0))[0]
        col, p, q, tol = first_drift
        try:
            d = abs(float(p) - float(q))
        except Exception:
            d = float("nan")
        print(f"\n  ★ largest divergence at this bar: '{col}'  pine={_fmt(p)}  python={_fmt(q)}  diff={d:.4f}  (tol {tol})")
        print(f"    investigate: the Python code path that derives '{col}' is the next place to look")
    else:
        print(f"\n  ✓ no drift at this bar — all compared columns within tolerance")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
