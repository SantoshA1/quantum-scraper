# QTP Shadow Validator — FastAPI Service

Compares live Pine alert payloads against the Python port's `compute()` output on the same OHLCV window. Per-field PASS/DRIFT verdicts logged to in-memory ring buffer + returned to caller. **Does not route trades.** Reads only.

## Run locally

```bash
cd "/Users/santoshadari/Documents/Claude/Projects/Quantlys Engine"
pip install fastapi pydantic uvicorn pandas numpy
PYTHONPATH=. uvicorn qtp_server_side.shadow_validator:app --host 0.0.0.0 --port 8088
```

Then visit `http://localhost:8088/docs` for the interactive Swagger UI.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness check + module list + log size |
| GET | `/modules` | List supported modules |
| POST | `/shadow-validate` | Compare one alert payload — main endpoint |
| GET | `/comparisons?limit=50` | Recent comparisons from in-memory ring buffer |
| GET | `/comparisons/{idx}` | One comparison by index |
| POST | `/reset` | Clear the in-memory log |

Supported `module` values: `super_score_pro_v25`, `ensemble_engine_v1`, `webhook_bridge_v8`, `quantum_scalp_strategy_v5`, `quantum_swing_v83`.

## Request shape

```json
POST /shadow-validate
{
  "module": "super_score_pro_v25",
  "ohlcv": [
    {"time": "2026-05-01T13:30:00Z", "open": 200, "high": 202, "low": 199, "close": 201, "volume": 12345678},
    ... // ~250+ bars recommended for full indicator warmup
  ],
  "cross_asset": {
    "vix":       [13.5, 13.8, ...],
    "spy_close": [580.1, 581.2, ...],
    "qqq_close": [490.4, 491.1, ...],
    "qqq_ema21": [488.9, 489.5, ...],
    "spy_ema21": [578.6, 579.3, ...]
    // ensemble_engine_v1 additionally accepts:
    // htf_ema_1, htf_ema_2, htf_ema_3, htf_ema_4, market_ema, leader_ema
  },
  "pine_payload": {
    "ticker": "AAPL",
    "price": 201.0,
    "bias_score": 47,
    "execution_score": 33,
    "smart_money_score": 0,
    "regime_score": -12,
    "score_penalty": 14
    // ... any field the Pine alert emits; flattened nested objects supported
  },
  "alert_bar_time": "2026-05-15T13:30:00Z"
}
```

Cross-asset arrays must be the same length as `ohlcv`. If missing, the validator falls back to whatever the Python `compute()` defaults to (typically NaN inputs, which propagate into score components).

## Response shape

```json
{
  "module": "super_score_pro_v25",
  "bar_time": "2026-05-15 13:30:00+00:00",
  "bar_index": 220,
  "bars_compared": 9,
  "n_pass": 9,
  "n_drift": 0,
  "pass_rate": 1.0,
  "overall_verdict": "PASS",
  "fields": [
    {"field": "bias_score", "pine": 47, "python": 47, "diff": 0.0, "tolerance": 0.5, "verdict": "PASS"},
    ...
  ],
  "server_time": "2026-05-17T22:14:33Z"
}
```

`overall_verdict` is `PASS` only if every compared field is within tolerance; `DRIFT` if any field drifts; `NO_OVERLAP` if no field names matched between Pine payload and Python output.

## n8n integration recipe

This service is a **side-channel** — it doesn't gate trade routing. Your existing n8n workflow that consumes TradingView alerts should fork the alert into a parallel branch that calls this service:

```
TradingView Webhook
        │
        ├── [existing trade-routing branch — unchanged]
        │       Alpaca / Telegram / Supabase
        │
        └── [new shadow-validation branch — non-blocking]
                ↓
            HTTP Request node
                URL:    http://<shadow-host>:8088/shadow-validate
                Method: POST
                Body:   JSON
                {
                  "module": "{{ $json.signal_source }}",
                  "ohlcv": {{ $json.ohlcv_recent_250 }},
                  "cross_asset": {{ $json.cross_asset }},
                  "pine_payload": {{ $json }},
                  "alert_bar_time": "{{ $json.timestamp }}"
                }
                ↓
            IF node: $json.overall_verdict == "DRIFT"
                ↓ true
            Slack/Discord node — post the drift summary
                ↓ false
            (no-op)
```

Two things you'll need to add to your TradingView alert payload (if not already there):
1. **`signal_source`** field with one of the 5 module names — already in the Pine `payload.py` constants, just make sure your alerts pass it through.
2. **Recent OHLCV window** — either include it in the alert payload (heavy) or have the n8n branch fetch it from your existing data provider (TradingView Webhook → fetch bars from Polygon/Tiingo/Alpaca → then call shadow-validate).

For the easiest deployment, run this service on the same host as your n8n instance — localhost calls have ~1ms latency, well under any alert-processing budget.

## What this service does NOT do

- **Does not block live trades.** The trade-routing branch in n8n is untouched. Drift detected here is logged, not enforced.
- **Does not write to Supabase / Alpaca / Telegram.** The in-memory ring buffer (256 entries) is the only persistence. If you want durable logging, add a downstream node that writes the response to your existing log store.
- **Does not authenticate.** Bind to localhost only or put a reverse proxy with auth in front. The service itself trusts the caller.
- **Does not auto-discover OHLCV.** The caller must supply the bars. This keeps the service stateless and avoids tight coupling to a data vendor.

## Tested

Smoke-tested via direct function call and HTTP layer (uvicorn → curl /health) on 2026-05-17. End-to-end validation against existing Pro v2.5 fixtures returned **9/9 PASS** on a real bar with cross-asset data threaded through. App imports cleanly, all 10 routes resolve, all 5 modules registered.

## Deployment status

**Local only.** This is one file (`qtp_server_side/shadow_validator.py`) plus this doc. To deploy:

1. `git add qtp_server_side/shadow_validator.py SHADOW_VALIDATOR.md && git commit && git push`
2. Provision a small container/VM with Python 3.10+, `pip install fastapi pydantic uvicorn pandas numpy`, clone repo, run uvicorn (or use a process manager like systemd / pm2 / supervisord).
3. Add the n8n branch above.
4. Optional: stick a reverse proxy with HTTP auth in front of the port.

Nothing about the existing n8n / Alpaca / Supabase / Telegram setup needs to change to run the validator in parallel.
