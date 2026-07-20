# Delta fe73a421 — RCF_AUDIT_EMIT_v3 (2026-07-20)

Live publish on vaqfCaELhOEWnkdo: c91917bb → a2a419ae (v3) → fe73a421 (builder v1.1 NULL fix).

**Change:** QTP Regime Conflict Filter HARD_VETO drops were silently swallowed
(zero exec_flow_audit trace — EG incident, exec 420673). RCF v3 emits dropped
items flagged `_rcf_dropped=true`; new nodes:
- RCF Drop Router (IF): true→audit branch, false→VC Agent Gatekeeper (pass path byte-equivalent)
- RCF Drop Audit SQL Builder v1.1 (never-throws; num(null)→NULL)
- RCF Drop Audit Insert (postgres, onError=continue)

Row: blocked_stage=REGIME_CONFLICT, audit_status=REJECTED,
kill_stage_attribution=REGIME_CONFLICT_<type>, NOT-EXISTS dedupe.

Governance: quantum.ssm_workflow_updates rows (put_wrapped_update).
Offline harness: rcf-v3-offline-harness.js (5/5). EG row backfilled.
Baseline snapshot _baseline_c91917bb intentionally untouched.
