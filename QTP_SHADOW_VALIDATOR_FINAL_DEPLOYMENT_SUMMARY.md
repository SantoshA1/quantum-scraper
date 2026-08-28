# QTP Shadow Validator — Final Deployment Summary

## Final Status

`QTP SHADOW VALIDATOR DEPLOYED IN NON-BLOCKING OBSERVATION MODE — LIVE TRADE GATING NOT ENABLED`

## What Is Deployed

The QTP Shadow Validator fallback is deployed as an n8n Code Node observation branch inside:

- Workflow: `Broad Scanner (Real-Time Agent)`
- Workflow ID: `975pZZEtxeUbzI22`

The branch is connected in parallel from:

```text
Scan All Tickers
```

The original production path remains:

```text
Scan All Tickers → Push to Pipeline
```

The shadow observation path is:

```text
Scan All Tickers
  → Prepare QTP Shadow Payload — DRY_RUN
  → QTP Shadow Validator — N8N_CODE_FALLBACK
  → Filter QTP Accepted Drift — DRY_RUN
  → QTP Shadow Result — Manual Review Only
```

The terminal shadow node has no outgoing connections.

## What Is Not Deployed

The following are explicitly not enabled:

- Live trade gating on Python parity verdict
- Any Alpaca order routing from shadow output
- Any Telegram production alerting from shadow output
- Any Supabase production write from shadow output
- Any VC Gate mutation from shadow output
- Any Push-to-Pipeline mutation from shadow output
- Phase 7 cutover

## Safety Controls

The four shadow nodes are configured with:

- Non-blocking observation purpose
- `continueOnFail = true`
- No output edge from the terminal node
- No path to order execution
- No path to production notification
- No path to production database writes

Required output invariants:

```text
mode = SHADOW_ONLY_NO_ROUTING
shadow_parity_mode = SHADOW_ONLY_NO_ROUTING
order_intent = NONE
alpaca_side_effects = ZERO
telegram_side_effects = ZERO
supabase_production_writes = ZERO
live_path_impact = ZERO
production_wiring = NONE
```

## Completed Phases

### Phase 1

Repository branch and draft PR created.

### Phase 2

Offline drift validation completed. Documented known drift treated as accepted, not unexpected failure.

### Phase 3

FastAPI local smoke test accepted under process-bound-only acceptance.

### Phase 4

FastAPI VM deployment replaced with n8n Code Node fallback design because n8n Cloud cannot host a private localhost/systemd service.

### Phase 5

Dry-run fallback nodes added to Broad Scanner as disabled, isolated nodes. Existing production graph remained unchanged.

### Phase 6A

Manual replay validated the safety envelope with no live path impact.

### Phase 6B

Non-blocking observation branch structurally wired and synthetic-smoke validated.

## Synthetic Smoke Coverage

Synthetic rows tested:

- `AAPL | super_score_pro_v25 | BUY`
- `MSFT | webhook_bridge_v8 | SELL`
- `META | ensemble_engine_v1 | BUY`

All passed safety invariants with zero side effects.

Ensemble accepted-drift suppression was validated for:

- `raw_bull_score`
- `raw_bear_score`
- `final_score`

## Telegram Smoke Confirmation

A one-time Telegram message was sent and confirmed received by the user. The temporary sender workflow was deactivated after delivery.

## Pending Runtime Observation

The only pending item is:

```text
FIRST_REAL_CANDIDATE_PARITY_OBSERVATION
```

At the first real market-hour candidate, inspect the Broad Scanner execution and confirm:

1. `Push to Pipeline` still executes normally.
2. All four shadow nodes execute successfully.
3. Shadow output preserves all safety invariants.
4. No shadow output reaches production routing.
5. If a full payload includes `signal_source` and OHLCV/indicator fields, capture parity metrics.

## Rollback

Fast rollback:

1. Remove the edge:

```text
Scan All Tickers → Prepare QTP Shadow Payload — DRY_RUN
```

2. Disable the four shadow nodes.

Full rollback:

Restore the Phase 6B backup:

```text
/home/user/workspace/Broad Scanner Real-Time Agent — pre_phase6b_nonblocking_shadow_branch_20260517_224913.json
```

## Final Verdict

`DEPLOYED FOR SHADOW OBSERVATION ONLY — REAL CANDIDATE PARITY PENDING — PHASE 7 NOT EXECUTED`
