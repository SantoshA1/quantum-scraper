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
from . import super_score_pro_v25
from . import webhook_bridge_v8


MODULES: dict[str, tuple[str, Callable[[pd.DataFrame], pd.DataFrame], dict]] = {
    "ai_super_score_pro_v25_universal.pine": (
        "super_score_pro_v25",
        lambda df: super_score_pro_v25.compute(df),
        drift.TOLERANCES_SUPER_SCORE,
    ),
    "ai_super_score_ensemble_engine_v1.pine": (
        "ensemble_engine_v1",
        lambda df: ensemble_engine_v1.compute(df),
        drift.TOLERANCES_ENSEMBLE,
    ),
    "ai_super_score_webhook_bridge_v8.pine": (
        "webhook_bridge_v8",
        lambda df: webhook_bridge_v8.compute_technicals(df).join(
            webhook_bridge_v8.detect_sweeps(df), how="left"
        ),
        drift.TOLERANCES_INDICATORS,
    ),
    "quantum_scalp_strategy_v5.pine": (
        "quantum_scalp_strategy_v5",
        lambda df: quantum_scalp_strategy_v5.compute(df),
        drift.TOLERANCES_SCALP,
    ),
}


def _read_csv(path: Path) -> pd.DataFrame:
    """Read a CSV with a best-effort DatetimeIndex on the first column."""
    df = pd.read_csv(path)
    if not df.empty:
        first = df.columns[0]
        try:
            parsed = pd.to_datetime(df[first], utc=True)
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


def run(manifest: Path, ohlcv_dir: Path, reference_dir: Path, out: Path, skip_warmup: int) -> dict:
    manifest_data = json.loads(manifest.read_text())
    report = {
        "manifest": str(manifest),
        "skip_warmup": skip_warmup,
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
        python_df = compute_fn(ohlcv)
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
    args = ap.parse_args()

    report = run(args.manifest, args.ohlcv_dir, args.reference_dir, args.out, args.skip_warmup)
    passed = sum(1 for m in report["modules"] if m.get("status") == "PASS")
    drifted = sum(1 for m in report["modules"] if m.get("status") == "DRIFT")
    skipped = sum(1 for m in report["modules"] if m.get("status") == "SKIPPED")
    print(json.dumps({"PASS": passed, "DRIFT": drifted, "SKIPPED": skipped, "out": str(args.out)}, indent=2))
    return 1 if drifted else 0


if __name__ == "__main__":
    raise SystemExit(main())
