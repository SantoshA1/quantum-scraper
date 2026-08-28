# QTP Shadow Validator — Phase 6B Synthetic Smoke Validation

## Status

`PHASE 6B SYNTHETIC SMOKE PASS — NO PRODUCTION PIPELINE EXECUTION`

## Reason

The market was closed and no real market-hour candidate was available. The user instructed that Phase 6B validation must use only synthetic or smoke-test rows.

## Execution Method

The full Broad Scanner workflow was not executed. This avoided any possible call to `Push to Pipeline`.

Validation used synthetic rows passed through the same shadow-branch fallback logic:

- `Prepare QTP Shadow Payload — DRY_RUN`
- `QTP Shadow Validator — N8N_CODE_FALLBACK`
- `Filter QTP Accepted Drift — DRY_RUN`
- `QTP Shadow Result — Manual Review Only`

## Structural Graph Check

Workflow:

- Name: `Broad Scanner (Real-Time Agent)`
- ID: `975pZZEtxeUbzI22`
- Active: `true`

Graph safety:

- Production edge preserved: `Scan All Tickers → Push to Pipeline`
- Shadow branch present: `Scan All Tickers → Prepare QTP Shadow Payload — DRY_RUN`
- Terminal shadow node outgoing edges: `0`
- All shadow nodes have `continueOnFail = true`

## Synthetic Cases

### AAPL

```json
{
  "ticker": "AAPL",
  "module": "super_score_pro_v25",
  "execution": "BUY",
  "mode": "SHADOW_ONLY_NO_ROUTING",
  "overall_verdict": "PASS",
  "n_actionable_drift": 0,
  "order_intent": "NONE",
  "alpaca_side_effects": "ZERO",
  "telegram_side_effects": "ZERO",
  "supabase_production_writes": "ZERO",
  "live_path_impact": "ZERO",
  "production_wiring": "NONE"
}
```

### MSFT

```json
{
  "ticker": "MSFT",
  "module": "webhook_bridge_v8",
  "execution": "SELL",
  "mode": "SHADOW_ONLY_NO_ROUTING",
  "overall_verdict": "PASS",
  "n_actionable_drift": 0,
  "order_intent": "NONE",
  "alpaca_side_effects": "ZERO",
  "telegram_side_effects": "ZERO",
  "supabase_production_writes": "ZERO",
  "live_path_impact": "ZERO",
  "production_wiring": "NONE"
}
```

### META

```json
{
  "ticker": "META",
  "module": "ensemble_engine_v1",
  "execution": "BUY",
  "mode": "SHADOW_ONLY_NO_ROUTING",
  "overall_verdict": "PASS",
  "n_actionable_drift": 0,
  "order_intent": "NONE",
  "alpaca_side_effects": "ZERO",
  "telegram_side_effects": "ZERO",
  "supabase_production_writes": "ZERO",
  "live_path_impact": "ZERO",
  "production_wiring": "NONE"
}
```

The META case included Ensemble manual-score fields and verified that accepted drift does not create actionable drift:

- `raw_bull_score`
- `raw_bear_score`
- `final_score`

## Side Effects

- Broad Scanner executed: `NO`
- Push to Pipeline called: `ZERO`
- Alpaca orders: `ZERO`
- Telegram messages: `ZERO`
- Supabase production writes: `ZERO`
- VC Gate mutation: `ZERO`

## Remaining Pending Item

Real candidate parity validation remains pending because no live market-hour candidate was available.

Pending:

```text
FIRST_REAL_CANDIDATE_PARITY_OBSERVATION
```

## Verdict

`PHASE 6B SYNTHETIC SMOKE PASS — STRUCTURAL + SAFETY VALIDATED — REAL CANDIDATE PARITY PENDING`
