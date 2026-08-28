# QTP Shadow Validator — Phase 6 Monitoring Design

## Status

`PHASE 6 SHADOW MONITORING DESIGN COMPLETE — NO LIVE TRAFFIC ENABLED`

## Scope

Phase 6 is a monitoring design for the n8n Code Node fallback validator. It does not enable the disabled nodes created in Phase 5 and does not connect them to the live Broad Scanner path.

The Phase 5 nodes remain:

- Disabled
- Isolated
- Unconnected
- Manual-review only
- Non-routing

## Safety Contract

The monitoring phase must preserve the following invariants:

- Alpaca side effects: `ZERO`
- Telegram production side effects: `ZERO`
- Supabase production writes: `ZERO`
- Push-to-Pipeline side effects: `ZERO`
- VC Gate mutation: `ZERO`
- Live trade-path gating: `ZERO`
- Existing n8n production connections changed: `ZERO`

## Current Deployment State

Workflow:

- Name: `Broad Scanner (Real-Time Agent)`
- ID: `975pZZEtxeUbzI22`

Dry-run nodes present:

1. `Prepare QTP Shadow Payload — DRY_RUN`
2. `QTP Shadow Validator — N8N_CODE_FALLBACK`
3. `Filter QTP Accepted Drift — DRY_RUN`
4. `QTP Shadow Result — Manual Review Only`

Required current state before any monitoring run:

- All four nodes present
- All four nodes disabled
- All four nodes have zero incoming wires
- All four nodes have zero outgoing wires
- Existing workflow graph unchanged from pre-Phase-5 baseline

## Monitoring Activation Model

Because this is the n8n fallback design rather than the FastAPI sidecar, monitoring should be activated in two controlled sub-phases only after explicit approval:

### Phase 6A — Manual Candidate Replay

Use one captured candidate payload from Broad Scanner execution logs. Manually execute the isolated fallback node chain with pinned input data.

Rules:

- Manual execution only
- No incoming wire from Broad Scanner
- No outgoing wire to production nodes
- No Supabase production write
- No Telegram production notification
- No Alpaca order path
- Output reviewed in n8n execution UI only

Success criteria:

- Output contains `mode = SHADOW_ONLY_NO_ROUTING`
- Output contains `order_intent = NONE`
- Output contains `alpaca_side_effects = ZERO`
- Output contains `telegram_side_effects = ZERO`
- Output contains `supabase_production_writes = ZERO`
- Output contains `live_path_impact = ZERO`
- Accepted drift is suppressed for `ensemble_engine_v1` fields:
  - `raw_bull_score`
  - `raw_bear_score`
  - `final_score`

### Phase 6B — Non-Blocking Observation Branch

Only after Phase 6A passes, optionally wire a non-blocking branch for observation.

Required wiring pattern:

```text
Broad Scanner candidate source
        ├── existing production path unchanged
        └── shadow branch only
              Prepare QTP Shadow Payload — DRY_RUN
              → QTP Shadow Validator — N8N_CODE_FALLBACK
              → Filter QTP Accepted Drift — DRY_RUN
              → QTP Shadow Result — Manual Review Only
```

Hard requirements if Phase 6B is ever approved:

- `Continue On Fail = true` on each shadow branch node where n8n supports it
- No output from the shadow branch to production nodes
- No order placement nodes reachable from the branch
- No Telegram production alert node reachable from the branch
- No Supabase production write node reachable from the branch
- Existing production connections must remain byte-equivalent

## Metrics to Watch

For each manually replayed or observed candidate:

- `ticker`
- `module`
- `timeframe`
- `overall_verdict`
- `fields_observed`
- `n_actionable_drift`
- `accepted_drift_count`
- `mode`
- `order_intent`
- `live_path_impact`
- Node execution latency
- Node error state

## Acceptance Thresholds

For exact-parity modules:

- `super_score_pro_v25`: expected pass rate `>= 99%`
- `webhook_bridge_v8`: expected pass rate `>= 99%`

For documented-drift modules:

- `ensemble_engine_v1`: accepted drift only for manual-score fields
- `quantum_swing_v83`: accepted drift only for documented PSAR / weekly drawdown gaps
- `quantum_scalp_strategy_v5`: no production assertion until TradingView fixture/source is fully active

## Stop Conditions

Immediately stop monitoring and restore the Phase 5 isolated state if any of the following occurs:

- Any shadow node becomes connected to Alpaca
- Any shadow node becomes connected to Telegram production
- Any shadow node becomes connected to Supabase production writes
- Any shadow node becomes connected to Push to Pipeline or VC Gate mutation
- Existing production workflow graph changes unexpectedly
- Any shadow node error propagates into the production path
- Any alert latency degradation is observed on the production path
- Any order is generated from shadow output

## Rollback

Fast rollback:

1. Disable all four shadow nodes.
2. Remove any shadow branch wires if Phase 6B was enabled.
3. Confirm production path still executes normally.

Full rollback:

1. Restore the Phase 5 backup:
   `/home/user/workspace/Broad Scanner Real-Time Agent — pre_phase5_shadow_fallback_dry_run_20260517_224325.json`
2. Verify workflow is active.
3. Verify Broad Scanner executions succeed.
4. Verify no Alpaca / Telegram / Supabase side effects came from shadow nodes.

## Next Approval Gate

Do not execute monitoring automatically.

The next valid approval command is:

```text
APPROVE_PHASE6A_MANUAL_CANDIDATE_REPLAY
```

No Phase 6B branch wiring is allowed unless the user separately approves:

```text
APPROVE_PHASE6B_NON_BLOCKING_OBSERVATION_BRANCH
```

## Current Verdict

`PHASE 6 DESIGN ONLY — SHADOW MONITORING RUNBOOK READY — LIVE PATH UNCHANGED`
