"""
shadow_validator.py — FastAPI service that compares a live Pine alert payload
against the Python compute() output, bar-for-bar.

Shadow / local use only. Not wired into production routing. Operationally this
runs alongside the existing n8n pipeline as a SIDE-CHANNEL: when a TradingView
alert fires and n8n receives the Pine payload, n8n forks a copy to this
service. The service:

  1. Pulls the recent OHLCV window for the alert's ticker (caller supplies it).
  2. Runs the Python port's compute() over the same bars.
  3. Diffs the Pine payload values against the Python computed values at the
     alert bar.
  4. Returns a per-field comparison: PASS / DRIFT / TOLERANCE summary.
  5. Logs the comparison so you can backfill a drift dashboard.

It does NOT route trades, NOT modify n8n state, NOT post to Slack/Telegram.
You can wire those side-channels yourself by reading the response or the
in-memory log.

Endpoints
---------
GET  /health                             — liveness check
POST /shadow-validate                    — compare one alert
GET  /comparisons                        — recent comparisons (in-memory)
GET  /comparisons/{idx}                  — one comparison by index
GET  /modules                            — list supported modules
POST /reset                              — clear in-memory log

Run
---
    pip install fastapi uvicorn pandas numpy
    PYTHONPATH=. uvicorn qtp_server_side.shadow_validator:app --host 0.0.0.0 --port 8088

n8n integration recipe
----------------------
After the existing TradingView Webhook node and BEFORE the trade-routing node:
  1. Add an HTTP Request node (in parallel branch, do NOT block trade routing)
     - URL:     http://your-shadow-host:8088/shadow-validate
     - Method:  POST
     - Body:    JSON, send the Pine alert payload + recent OHLCV window
  2. Optional: add a Slack/Discord node that posts whenever the response
     contains any field with verdict == "DRIFT" and severity == "high".

The shadow service NEVER blocks the n8n trade-routing branch. It is read-only
relative to live execution.
"""

from __future__ import annotations

import datetime as _dt
import json
import threading
from collections import deque
from typing import Any, Optional

import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from . import drift
from . import ensemble_engine_v1
from . import quantum_scalp_strategy_v5
from . import quantum_swing_v83
from . import super_score_pro_v25
from . import webhook_bridge_v8


# ---------------------------------------------------------------------------
# Module registry — same shape as run_drift_manifest.MODULES
# ---------------------------------------------------------------------------

def _compute_pro(ohlcv, cross):
    return super_score_pro_v25.compute(
        ohlcv, super_score_pro_v25.SuperScoreConfig(),
        cross.get("vix"), cross.get("qqq_close"), cross.get("spy_close"),
        qqq_ema21=cross.get("qqq_ema21"), spy_ema21=cross.get("spy_ema21"),
    )

def _compute_ensemble(ohlcv, cross):
    return ensemble_engine_v1.compute(
        ohlcv, ensemble_engine_v1.EnsembleConfig(),
        vix_close=cross.get("vix"),
        market_close=cross.get("spy_close"), market_ema=cross.get("market_ema"),
        leader_close=cross.get("qqq_close"), leader_ema=cross.get("leader_ema"),
        htf_ema_1=cross.get("htf_ema_1"), htf_ema_2=cross.get("htf_ema_2"),
        htf_ema_3=cross.get("htf_ema_3"), htf_ema_4=cross.get("htf_ema_4"),
    )

def _compute_bridge(ohlcv, cross):
    return webhook_bridge_v8.compute_technicals(ohlcv).join(
        webhook_bridge_v8.detect_sweeps(ohlcv), how="left"
    )

def _compute_scalp(ohlcv, cross):
    return quantum_scalp_strategy_v5.compute(
        ohlcv, quantum_scalp_strategy_v5.ScalpConfig(),
        vix_close=cross.get("vix"),
        spy_close=cross.get("spy_close"),
        qqq_close=cross.get("qqq_close"),
    )

def _compute_swing(ohlcv, cross):
    return quantum_swing_v83.compute(
        ohlcv, quantum_swing_v83.SwingConfig(),
        vix_close=cross.get("vix"),
        spy_close=cross.get("spy_close"), qqq_close=cross.get("qqq_close"),
    )

MODULES = {
    "super_score_pro_v25":       (_compute_pro,      drift.TOLERANCES_SUPER_SCORE),
    "ensemble_engine_v1":        (_compute_ensemble, drift.TOLERANCES_ENSEMBLE),
    "webhook_bridge_v8":         (_compute_bridge,   drift.TOLERANCES_INDICATORS),
    "quantum_scalp_strategy_v5": (_compute_scalp,    drift.TOLERANCES_SCALP),
    "quantum_swing_v83":         (_compute_swing,    drift.TOLERANCES_SWING),
}


# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------

class Bar(BaseModel):
    time:   str   = Field(..., description="ISO 8601 UTC timestamp")
    open:   float
    high:   float
    low:    float
    close:  float
    volume: float = 0.0

class CrossAsset(BaseModel):
    """Optional per-bar cross-asset series, aligned to ohlcv.time. Each value
    is a list of floats with the same length as ohlcv."""
    vix:           Optional[list[Optional[float]]] = None
    spy_close:     Optional[list[Optional[float]]] = None
    qqq_close:     Optional[list[Optional[float]]] = None
    qqq_ema21:     Optional[list[Optional[float]]] = None
    spy_ema21:     Optional[list[Optional[float]]] = None
    market_ema:    Optional[list[Optional[float]]] = None
    leader_ema:    Optional[list[Optional[float]]] = None
    htf_ema_1:     Optional[list[Optional[float]]] = None
    htf_ema_2:     Optional[list[Optional[float]]] = None
    htf_ema_3:     Optional[list[Optional[float]]] = None
    htf_ema_4:     Optional[list[Optional[float]]] = None

class ValidateRequest(BaseModel):
    module:       str         = Field(..., description="Module name; see /modules")
    ohlcv:        list[Bar]   = Field(..., description="Recent OHLCV window ending at the alert bar (inclusive)")
    cross_asset:  Optional[CrossAsset] = None
    pine_payload: dict        = Field(..., description="Pine alert payload (the JSON your TradingView alert sends)")
    alert_bar_time: Optional[str] = Field(None, description="If set, validate this specific bar; else last bar")
    fields:       Optional[list[str]] = Field(None, description="Restrict comparison to these fields")

class FieldComparison(BaseModel):
    field:        str
    pine:         Any
    python:       Any
    diff:         Optional[float]
    tolerance:    Optional[float]
    verdict:      str   # "PASS" | "DRIFT" | "MISSING_IN_PINE" | "MISSING_IN_PYTHON"

class ValidateResponse(BaseModel):
    module:       str
    bar_time:     str
    bar_index:    int
    bars_compared: int
    n_pass:       int
    n_drift:      int
    pass_rate:    float
    overall_verdict: str   # "PASS" | "DRIFT" | "NO_OVERLAP"
    fields:       list[FieldComparison]
    server_time:  str


# ---------------------------------------------------------------------------
# In-memory comparison log (last 256 calls)
# ---------------------------------------------------------------------------

_log_lock = threading.Lock()
_log: deque = deque(maxlen=256)


# ---------------------------------------------------------------------------
# Core comparison logic
# ---------------------------------------------------------------------------

def _build_ohlcv_df(bars: list[Bar]) -> pd.DataFrame:
    df = pd.DataFrame([b.model_dump() for b in bars])
    df["time"] = pd.to_datetime(df["time"], utc=True)
    df = df.set_index("time").sort_index()
    return df

def _build_cross_dict(cross: Optional[CrossAsset], idx: pd.DatetimeIndex) -> dict:
    """Convert list-of-floats cross-asset arrays into pd.Series aligned to idx."""
    if cross is None:
        return {}
    out = {}
    for name, vals in cross.model_dump().items():
        if vals is None:
            continue
        if len(vals) != len(idx):
            raise HTTPException(400, f"cross_asset.{name} length {len(vals)} != ohlcv length {len(idx)}")
        out[name] = pd.Series([np.nan if v is None else float(v) for v in vals], index=idx)
    return out

def _flatten_payload(p: dict, prefix: str = "") -> dict:
    """Pine payloads can be nested (ai_super_score.{...}, technicals.{...}).
    Flatten to a dotless dict, dropping the path prefix so leaf names match
    Python compute() output column names."""
    out = {}
    for k, v in p.items():
        if isinstance(v, dict):
            out.update(_flatten_payload(v, prefix=""))
        else:
            out[k] = v
    return out

def _coerce_float(v) -> Optional[float]:
    if v is None:
        return None
    if isinstance(v, bool):
        return 1.0 if v else 0.0
    try:
        f = float(v)
        return f if not np.isnan(f) else None
    except (TypeError, ValueError):
        return None

def _compare_one_bar(python_row: pd.Series, pine_payload_flat: dict,
                     tolerances: dict, field_filter: Optional[list[str]] = None
                     ) -> list[FieldComparison]:
    results: list[FieldComparison] = []
    candidates = (field_filter
                  if field_filter is not None
                  else [k for k in pine_payload_flat
                        if (k in python_row.index) and (k in tolerances or _coerce_float(pine_payload_flat[k]) is not None)])
    for f in candidates:
        if f not in python_row.index:
            results.append(FieldComparison(
                field=f, pine=pine_payload_flat.get(f), python=None,
                diff=None, tolerance=None, verdict="MISSING_IN_PYTHON"))
            continue
        if f not in pine_payload_flat:
            results.append(FieldComparison(
                field=f, pine=None, python=_coerce_float(python_row[f]),
                diff=None, tolerance=None, verdict="MISSING_IN_PINE"))
            continue
        p_v = _coerce_float(pine_payload_flat[f])
        py_v = _coerce_float(python_row[f])
        tol = float(tolerances.get(f, 0.05))
        if p_v is None or py_v is None:
            results.append(FieldComparison(
                field=f, pine=pine_payload_flat[f], python=python_row[f],
                diff=None, tolerance=tol, verdict="MISSING_IN_PYTHON" if py_v is None else "MISSING_IN_PINE"))
            continue
        d = abs(p_v - py_v)
        verdict = "PASS" if d <= tol else "DRIFT"
        results.append(FieldComparison(
            field=f, pine=p_v, python=py_v, diff=d, tolerance=tol, verdict=verdict))
    return results


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

app = FastAPI(
    title="QTP Shadow Validator",
    description=__doc__,
    version="0.1.0",
)


@app.get("/health")
def health():
    return {"status": "ok", "modules": list(MODULES.keys()), "log_size": len(_log)}


@app.get("/modules")
def list_modules():
    return {"modules": list(MODULES.keys())}


@app.post("/shadow-validate", response_model=ValidateResponse)
def shadow_validate(req: ValidateRequest):
    if req.module not in MODULES:
        raise HTTPException(400, f"unknown module {req.module!r}; available: {list(MODULES)}")
    compute_fn, tolerances = MODULES[req.module]

    if not req.ohlcv:
        raise HTTPException(400, "ohlcv is empty")

    ohlcv = _build_ohlcv_df(req.ohlcv)
    cross = _build_cross_dict(req.cross_asset, ohlcv.index)

    python_df = compute_fn(ohlcv, cross)

    # Locate the alert bar
    if req.alert_bar_time:
        target = pd.to_datetime(req.alert_bar_time, utc=True)
        try:
            idx = int(python_df.index.get_indexer([target], method="nearest")[0])
        except Exception as e:
            raise HTTPException(400, f"alert_bar_time {req.alert_bar_time!r} not locatable: {e}")
    else:
        idx = len(python_df) - 1

    if idx < 0 or idx >= len(python_df):
        raise HTTPException(400, f"resolved bar index {idx} out of range")

    bar_time = str(python_df.index[idx])
    pine_flat = _flatten_payload(req.pine_payload)
    comparisons = _compare_one_bar(python_df.iloc[idx], pine_flat, tolerances, req.fields)

    n_pass  = sum(1 for c in comparisons if c.verdict == "PASS")
    n_drift = sum(1 for c in comparisons if c.verdict == "DRIFT")
    bars_compared = n_pass + n_drift
    pass_rate = (n_pass / bars_compared) if bars_compared else 0.0
    overall = "PASS" if (bars_compared > 0 and n_drift == 0) else (
              "DRIFT" if bars_compared > 0 else "NO_OVERLAP")

    resp = ValidateResponse(
        module=req.module,
        bar_time=bar_time,
        bar_index=idx,
        bars_compared=bars_compared,
        n_pass=n_pass,
        n_drift=n_drift,
        pass_rate=pass_rate,
        overall_verdict=overall,
        fields=comparisons,
        server_time=_dt.datetime.now(_dt.timezone.utc).isoformat(),
    )

    with _log_lock:
        _log.append(resp.model_dump())

    return resp


@app.get("/comparisons")
def list_comparisons(limit: int = 50):
    with _log_lock:
        items = list(_log)[-limit:]
    return {"count": len(items), "comparisons": items}


@app.get("/comparisons/{idx}")
def get_comparison(idx: int):
    with _log_lock:
        items = list(_log)
    if idx < 0 or idx >= len(items):
        raise HTTPException(404, "index out of range")
    return items[idx]


@app.post("/reset")
def reset_log():
    with _log_lock:
        cleared = len(_log)
        _log.clear()
    return {"cleared": cleared}
