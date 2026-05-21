# QTP Changelog

Date: 2026-05-17

## Server-side parity package

- Added or synced Python parity modules:
  - `super_score_pro_v25.py`
  - `ensemble_engine_v1.py`
  - `webhook_bridge_v8.py`
  - `quantum_scalp_strategy_v5.py`
- Synced canonical helpers:
  - `payload.py`
  - `indicators.py`
  - `drift.py`
  - `run_drift_manifest.py`
  - `README.md`
- Synced `qtp_server_side_scanner_v55.py`.

## Broad Scanner production paper-gated payload

The live Broad Scanner n8n workflow now emits additive metadata:

```text
signal_source=server_side
qtp_go_live_version=QTP_GO_LIVE_SERVER_SIDE_PAYLOAD_v5.5_20260516
qtp_deployment_mode=PRODUCTION_PAPER_GATED
qtp_trading_env=paper
alpaca_env=paper
qtp_live_trading_allowed=false
shadow_parity_promoted=true
chart_image_url=<dynamic TradingView URL>
chart_vision_enabled=false
```

No VC Gate, Bias Filter, Pause Guard, Risk Gate, Paper Guard, or position-protection checks were bypassed.

## Main Trading Alpaca hardening

Added defense-in-depth marker:

```text
QTP_ALPACA_SMOKE_TEST_HARD_SKIP_v5.5_20260516
```

Synthetic and smoke-test payloads are hard-skipped inside `Alpaca Paper Trade` even if they accidentally reach that node.

## Supabase Health Monitor schedule

Changed:

```text
QTP Supabase Health Monitor — 15m
```

To:

```text
QTP Supabase Health Monitor — 8:00 AM ET Weekdays
```

Current schedule expression:

```text
0 12 * * 1-5
```

This represents 8:00 AM Eastern during the current EDT market season.

## Quantum Swing v8.3

Included attached Pine source:

```text
Quantum-Swing-v8.3-Adaptive-Multi-Ticker.pine
```

Status: pending Python parity port and drift integration.

