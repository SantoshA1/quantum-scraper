# QTP Shadow Validator — Phase 6A Manual Candidate Replay Evidence

## Status

`PHASE 6A MANUAL REPLAY COMPLETE — SAFETY GATES PASS — FULL PARITY PAYLOAD PENDING FIRST REAL CANDIDATE`

## Scope

Phase 6A replayed a captured Broad Scanner execution sample through the dry-run n8n fallback validator logic without wiring the Phase 5 nodes into live traffic.

No workflow update was performed during Phase 6A.

## Workflow

- Workflow: `Broad Scanner (Real-Time Agent)`
- Workflow ID: `975pZZEtxeUbzI22`
- Workflow active after check: `true`

## Phase 5 Node Safety Reconfirmed

All four Phase 5 nodes remained:

- Present
- Disabled
- Zero incoming wires
- Zero outgoing wires

Nodes:

1. `Prepare QTP Shadow Payload — DRY_RUN`
2. `QTP Shadow Validator — N8N_CODE_FALLBACK`
3. `Filter QTP Accepted Drift — DRY_RUN`
4. `QTP Shadow Result — Manual Review Only`

## Replay Input

The latest available Broad Scanner execution samples exposed watchlist/cache rows rather than a full BUY/SELL parity payload. The best available captured sample was:

- Execution ID: `212177`
- Execution started at: `2026-05-16T03:55:00.125Z`
- Source node: `Query Supabase Strat Cache`
- Ticker: `EQR`
- Signal source: `null`
- Execution/action/side: `null`

This validates the shadow safety envelope and dry-run transform path. It does not validate full field-level indicator parity because the captured sample did not include a module-specific parity payload.

## Replay Output Snippet

```json
{
  "mode": "SHADOW_ONLY_NO_ROUTING",
  "shadow_status": "PASS_DRY_RUN_OBSERVATION_ONLY",
  "shadow_parity_enabled": true,
  "shadow_parity_mode": "SHADOW_ONLY_NO_ROUTING",
  "module": "unknown",
  "ticker": "EQR",
  "fields_observed": 5,
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

## Required Gates

All required safety gates passed:

- `mode = SHADOW_ONLY_NO_ROUTING`
- `shadow_parity_mode = SHADOW_ONLY_NO_ROUTING`
- `order_intent = NONE`
- `alpaca_side_effects = ZERO`
- `telegram_side_effects = ZERO`
- `supabase_production_writes = ZERO`
- `live_path_impact = ZERO`
- `production_wiring = NONE`

## Side Effects

- n8n workflow updates: `ZERO`
- Alpaca orders: `ZERO`
- Telegram messages: `ZERO`
- Supabase production writes: `ZERO`
- Live trading impact: `ZERO`

## Limitation

The latest available Broad Scanner execution logs did not contain a complete first-candidate parity payload with `signal_source`, `execution`, `ohlcv_recent_bars`, and indicator score fields. Therefore:

- Safety replay: `PASS`
- Full module parity replay: `PENDING_FIRST_REAL_CANDIDATE`

## Next Gate

Do not wire the non-blocking observation branch automatically.

The next valid approval command is:

```text
APPROVE_PHASE6B_NON_BLOCKING_OBSERVATION_BRANCH
```

If the user wants to wait for a complete market-hour payload first, use:

```text
WAIT_FOR_FIRST_REAL_CANDIDATE_PAYLOAD
```

## Verdict

`PHASE 6A COMPLETE — SAFETY VALIDATED — NO LIVE PATH CHANGE`
