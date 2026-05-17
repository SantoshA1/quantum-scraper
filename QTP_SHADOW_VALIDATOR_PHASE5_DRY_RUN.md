# QTP Shadow Validator — Phase 5 Dry-Run Fallback Evidence

## Status

`PHASE 5 N8N FALLBACK BRANCH DRY-RUN COMPLETE — LIVE PATH UNCHANGED`

## Workflow

- Workflow: `Broad Scanner (Real-Time Agent)`
- Workflow ID: `975pZZEtxeUbzI22`
- Mode: n8n Code Node fallback, dry-run only
- Production routing impact: none

## Backup

- Backup exported before accepted update:
  `/home/user/workspace/Broad Scanner Real-Time Agent — pre_phase5_shadow_fallback_dry_run_20260517_224325.json`

Earlier rejected update attempts were API-schema validation failures only and were not accepted by n8n.

## Nodes Added

The following nodes were added as disabled, isolated, unconnected dry-run nodes:

1. `Prepare QTP Shadow Payload — DRY_RUN`
2. `QTP Shadow Validator — N8N_CODE_FALLBACK`
3. `Filter QTP Accepted Drift — DRY_RUN`
4. `QTP Shadow Result — Manual Review Only`

## Safety Verification

- Existing workflow graph unchanged: `true`
- Workflow active after update: `true`
- Before node count: `14`
- After node count: `18`
- New nodes present: `true`
- New nodes disabled: `true`
- New node incoming wires: `0`
- New node outgoing wires: `0`
- Alpaca side effects: `ZERO`
- Telegram side effects: `ZERO`
- Supabase production writes: `ZERO`
- Live path impact: `ZERO`

## Recent Execution Check

Latest inspected Broad Scanner executions remained successful with no error nodes. The added dry-run nodes are disabled and unconnected, so they do not execute on live trigger traffic.

## Rollback

Restore the pre-change n8n backup JSON listed above or remove the four isolated dry-run nodes. Because no existing connections were changed, rollback does not require trade-path rewiring.

## Next Gate

Phase 6 should not proceed automatically. It requires explicit user approval and a separate decision on whether to enable a non-blocking/manual shadow path for observation.
