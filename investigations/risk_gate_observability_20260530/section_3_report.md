# Section 3 Report — Audit Builders & The Observability Bug

**Investigation date:** 2026-05-30 (Saturday, market closed)
**Mode:** READ-ONLY
**Bottom line:** The Risk Gate is **functionally healthy**. The 100% RISK_UNKNOWN pattern is an **observability bug** in the early audit builder, which writes a hardcoded sentinel that is then patched downstream only on the narrow happy-path where `Alpaca Paper Trade` runs successfully. Any execution that terminates earlier (regime block, hours gate, VC kill, dedupe) leaves the sentinel intact.

## Three audit-builder nodes

| Node | n8n ID | Purpose |
|---|---|---|
| QTP Early Exec Flow Audit Builder | `7f778122-a6f7-48f8-9342-3ef6aa3cdbc9` | INSERT row into `quantum.exec_flow_audit` (writes RISK_UNKNOWN as sentinel) |
| QTP Late Exec Flow Audit Builder | `bca1b293-1ace-4e7f-b5db-694754a0a1f1` | Optional secondary audit downstream |
| QTP Late Audit Patcher (Risk Gate Verdict) | `a9df56fc-e45f-40ff-983f-d93bac7b97f8` | UPDATE the row's `risk_gate_decision` post-Alpaca |

## The smoking gun — Early Builder L114–L116

```js
// Risk verdict is patched downstream by Late Audit Patcher; sentinel here.
const risk_gate_decision = 'RISK_UNKNOWN';
const risk_status_struct = 'UNKNOWN';
```

This is **deliberate**, but the assumption is broken: the patcher never fires unless `Alpaca Paper Trade` runs. Anything that terminates before Alpaca leaves the sentinel.

## Late Patcher wiring

The patcher node is downstream of `Alpaca Paper Trade` in the SSM workflow topology. Its UPDATE statement (L226) has a defensive WHERE filter:

```sql
... WHERE risk_gate_decision IN ('RISK_UNKNOWN', 'UNKNOWN', '')
```

So it only patches the sentinel. This is good for idempotency, but means:
- ✅ If Alpaca runs → patcher fires → sentinel replaced with real verdict.
- ❌ If anything kills the chain before Alpaca (regime conflict, VC kill, hours gate, dedupe, bias block, pause guard block) → sentinel **never patched**.

## Empirical proof — TXN exec 247388 trace

10-execution sample from n8n executions API (cached at `/tmp/exec_samples/`). For each sample, examined `runData` to identify which nodes fired:

| Outcome | Count | Terminal node |
|---|---|---|
| Postgres Risk Gate node ran | 0/10 | — |
| Alpaca Paper Trade ran | 0/10 | — |
| Late Audit Patcher ran | 0/10 | — |
| Early Builder ran | 10/10 | (varies; see below) |

Termination breakdown:
- `QTP Regime Conflict Filter` — 5/10
- `QTP Extended Hours Mode Gate v1` — 2/10
- `QTP Broad Scanner Attribution Injector v1` — 1/10
- `VC Rejection Logger` — 2/10

Every execution wrote a row to `exec_flow_audit` via Early Builder, all with `risk_gate_decision='RISK_UNKNOWN'`, none reaching Alpaca, none patched.

## Section 2 + Section 3 reconciliation — what about the 2026-05-19 anomaly?

On 2026-05-19 between 13:36–17:51 UTC, 23 executions DID reach Alpaca and DID get patched (see UNKNOWN-4 below for definitive cross-check). After 17:51:12Z something changed — either the patcher node was edited, the wiring rerouted, or Alpaca began rejecting upstream. We do not have ssm_workflow_updates audit coverage for that day. Hypothesis to validate Monday: check git history on the SSM workflow export for changes around that timestamp.

## UNKNOWN-4 cross-reference (full table in `unknown4_findings.json`)

| risk_gate_decision | Audit rows | Matched to `quantum.order_events` |
|---|---|---|
| RISK_PASS (BUY) | 14 | **13/14** (1 dedupe miss on duplicate exec_id) |
| RISK_BLOCK (SELL) | 8 | **0/8** |
| RISK_HOLD (SELL) | 1 | **0/1** |

Every RISK_PASS that day produced a real Alpaca order with a `broker_order_id` and a `PARTIALLY_FILLED` or `FILLED` status. Every RISK_BLOCK / RISK_HOLD blocked correctly. **The Risk Gate was functionally healthy on the only day it was visible.**

## INV-A verdict

**Bug type: (A) observability — pure audit-row defaulting.** No evidence of functional impact on order placement. The trading pipeline is operating correctly; we just stopped recording the verdict.

## Resolved unknowns

- **UNKNOWN-1 (read sites):** Grep across all `jsCode` parameters in SSM workflow JSON for the string `risk_gate_decision`. Hits:
  - Early Builder L136 — reads `d.risk_gate_decision` into `riskStatus`, which feeds dead `riskGateStatus` (L137–L141) that is never returned or persisted. Dead code.
  - Late Patcher L300 — SELECT projection inside the patcher's own UPDATE-with-RETURNING.
  - **Net:** zero trade-flow READs. Fix is safe.

- **UNKNOWN-2 (DB-side consumers):** Queried `information_schema.views`, `pg_matviews`, `pg_proc` (non-aggregate, non-catalog), `pg_rewrite`, `pg_trigger`, `pg_constraint` for any reference to `risk_gate_decision` or `'RISK_UNKNOWN'`. **Zero hits.** Introducing a new `RISK_NOT_REACHED` enum value will break no DB consumer.

- **UNKNOWN-3 (dead riskGateStatus at L137–L141):** Deferred per user instruction. Will fix as a follow-up after primary fix is verified live.

- **UNKNOWN-4 (did blocked rows ever place orders?):** Cross-joined audit rows to `quantum.order_events` on (symbol, side, ts ± window). See table above. **Definitive 1:1 correlation between verdict and order activity on 2026-05-19.**

## Proposed fix risk rating: 2/5

Single node edit in `QTP Early Exec Flow Audit Builder`. See `proposed_audit_builder_fix.diff` for the unified diff. Idempotency is preserved by the Late Patcher's existing WHERE filter (the new `RISK_NOT_REACHED` value falls outside its match set, so the patcher will not overwrite a real upstream-block stamp).

## Monday remediation plan (NOT IN THIS PR)

1. Apply `proposed_audit_builder_fix.diff` to Early Builder via defensive PUT wrapper.
2. Verify in production: open a position, force a regime conflict, confirm the audit row stamps `RISK_NOT_REACHED` / `UPSTREAM_BLOCK`.
3. Re-run the 30-day audit query — expect non-UNKNOWN rate to climb from 0% to ~40% (the rate at which executions actually reach Alpaca).
4. Follow up on UNKNOWN-3 dead-code cleanup at L137–L141.
5. Investigate why 2026-05-19 17:51:12Z was the cutoff point (no ssm_workflow_updates coverage; check git history of any SSM workflow export from that day).
