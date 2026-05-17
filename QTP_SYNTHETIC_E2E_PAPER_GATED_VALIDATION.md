# QTP Synthetic-Only E2E Paper-Gated Validation

## Status

`SYNTHETIC_ONLY_E2E_PASS — NO LIVE WORKFLOW EXECUTION — NO SIDE EFFECTS`

## Context

The market was closed. The user approved synthetic-only E2E validation for the current paper-gated QTP server-side parity deployment.

## Hard Boundaries

The validation did not:

- Trigger Broad Scanner
- Trigger Main Trading
- Call `Push to Pipeline`
- Place Alpaca orders
- Send Telegram production messages
- Write to Supabase
- Mutate VC Gate, position state, or audit state

## Pre-Test Baseline

### Alpaca

```json
{
  "base": "https://paper-api.alpaca.markets",
  "account_status": "ACTIVE",
  "trading_blocked": false,
  "paper_mode": true,
  "positions_count": 8,
  "open_orders_count": 8
}
```

### Supabase Row Counts

```json
{
  "exec_flow_audit": 3055,
  "wro_shadow_entry_quality_421": 3016,
  "position_risk_state": 195,
  "audit_trail": 371,
  "order_events": 2443
}
```

### n8n Shadow Branch

```json
{
  "workflow": "Broad Scanner (Real-Time Agent)",
  "active": true,
  "production_edge_preserved": true,
  "shadow_edge_present": true,
  "terminal_has_no_outgoing": true
}
```

## Synthetic Cases

### PASS_AAPL_SERVER_SIDE

Input:

```text
AAPL | server_side | BUY | valid backtest | valid AI confidence
```

Expected:

```text
SYNTHETIC_DRY_RUN_PASS
```

Actual:

```text
SYNTHETIC_DRY_RUN_PASS
```

Gate trace:

- Data Quality Gate: `PASS`
- Backtest Normalizer: `PASS`
- Bias Filter: `PASS`
- VC Gate: `PASS`
- Pause Guard: `EVALUATED_NO_SIDE_EFFECT`
- Protected Position Check: `EVALUATED_NO_SIDE_EFFECT`
- Alpaca Router: `NOT_CALLED`
- Supabase Audit Writer: `NOT_CALLED`
- Telegram Sender: `NOT_CALLED`

### BLOCK_BACKTEST_MISSING

Input:

```text
MSFT | server_side | BUY | strat_total_trades=0 | strat_profit_factor=0
```

Expected:

```text
DRY_RUN_BLOCK_BACKTEST
```

Actual:

```text
DRY_RUN_BLOCK_BACKTEST
```

Gate trace:

- Data Quality Gate: `PASS`
- Backtest Normalizer: `BLOCK`
- Bias Filter: `SKIP`
- VC Gate: `SKIP`
- Alpaca Router: `NOT_CALLED`
- Supabase Audit Writer: `NOT_CALLED`
- Telegram Sender: `NOT_CALLED`

### BLOCK_LOW_AI_CONFIDENCE

Input:

```text
META | server_side | BUY | ai_confidence=5 | ai_action=HOLD
```

Expected:

```text
DRY_RUN_BLOCK_ENTRY_QUALITY
```

Actual:

```text
DRY_RUN_BLOCK_ENTRY_QUALITY
```

Gate trace:

- Data Quality Gate: `PASS`
- Backtest Normalizer: `PASS`
- Bias Filter: `BLOCK`
- VC Gate: `SKIP`
- Alpaca Router: `NOT_CALLED`
- Supabase Audit Writer: `NOT_CALLED`
- Telegram Sender: `NOT_CALLED`

## Server-Side Parity Field Survival

All cases preserved the required parity fields:

- `signal_source`
- `ticker`
- `symbol`
- `timeframe`
- `execution`
- `bias_score`
- `ai_confidence`
- `strat_total_trades`
- `strat_profit_factor`
- `backtest_data_quality`
- `chart_image_url`
- `chart_vision_enabled`
- `chart_vision_status`
- `chart_vision_score`
- `chart_vision_confidence`
- `chart_vision_trend`
- `paper_only`
- `dry_run`

## Post-Test Baseline

### Alpaca

```json
{
  "base": "https://paper-api.alpaca.markets",
  "account_status": "ACTIVE",
  "trading_blocked": false,
  "paper_mode": true,
  "positions_count": 8,
  "open_orders_count": 8
}
```

Recent order IDs were unchanged before vs. after validation.

### Supabase Row Counts

```json
{
  "exec_flow_audit": 3055,
  "wro_shadow_entry_quality_421": 3016,
  "position_risk_state": 195,
  "audit_trail": 371,
  "order_events": 2443
}
```

All checked Supabase row-count deltas were `0`.

## Side Effects

```json
{
  "broad_scanner_triggered": false,
  "main_trading_triggered": false,
  "push_to_pipeline_called": false,
  "alpaca_order_api_called": false,
  "supabase_write_called": false,
  "telegram_called": false
}
```

## One-Command Validation Checklist

```text
QTP_SYNTHETIC_E2E_VALIDATE_PASS:
1. Confirm market-closed synthetic-only mode.
2. Confirm Broad Scanner shadow branch is terminal-only.
3. Confirm Alpaca base is paper-api.alpaca.markets.
4. Capture Supabase row counts for exec_flow_audit, wro_shadow_entry_quality_421, position_risk_state, audit_trail, order_events.
5. Run synthetic AAPL valid server_side payload.
6. Run synthetic MSFT missing-backtest block payload.
7. Run synthetic META low-AI-confidence block payload.
8. Confirm parity field survival in all cases.
9. Confirm Data Quality, Backtest, Bias, VC, Pause, Protection, Alpaca, Supabase, and Telegram gate statuses.
10. Confirm Alpaca order IDs unchanged.
11. Confirm Supabase row-count deltas = 0.
12. Confirm no Telegram production message.
13. Mark PASS only if all side-effect gates remain ZERO.
```

## Rollback

Fast rollback:

```text
Remove edge:
Scan All Tickers → Prepare QTP Shadow Payload — DRY_RUN
```

Then disable:

```text
Prepare QTP Shadow Payload — DRY_RUN
QTP Shadow Validator — N8N_CODE_FALLBACK
Filter QTP Accepted Drift — DRY_RUN
QTP Shadow Result — Manual Review Only
```

Full rollback:

```text
Restore:
/home/user/workspace/Broad Scanner Real-Time Agent — pre_phase6b_nonblocking_shadow_branch_20260517_224913.json
```

## Verdict

`SYNTHETIC_ONLY_E2E_PASS — PAPER-GATED SAFETY CONFIRMED — REAL_CANDIDATE_PARITY_PENDING`
