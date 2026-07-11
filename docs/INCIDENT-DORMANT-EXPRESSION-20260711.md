# Dormant-Expression Observability Failure — Incident Read-Out (2026-07-11)

**Status: ROOT-CAUSED AND FIXED.** Amends `05_current_incident.md`. Executed by architect (Claude). This is the missing root cause behind the class of "gate looks broken but is actually blind" misdiagnosis — the same failure mode as the 2026-05-29 `RISK_UNKNOWN` event. Supabase `quantum.candidate_path_trace_10fc` + n8n `vaqfCaELhOEWnkdo`.

## Verdict in one line

**The main pipeline was not under-observed by design — it was blind by typo. Nine Postgres "write" nodes carried n8n expressions missing the leading `=`, so since creation they sent the literal string `{{ $json.xxx }}` to Postgres, errored, and continued silently. The main pipeline wrote ZERO `candidate_path_trace_10fc` rows, ever.**

## Methodology

Full node-by-node read of `vaqfCaELhOEWnkdo` execution stage. Cross-checked against live `quantum.candidate_path_trace_10fc`: 18,784 rows, **`blocked_stage` populated 0/18,784, `blocked_reason` 0/18,784**; 18,782/18,784 rows carry `ssm_action='PASS'`; all existing rows trace to the Signal-Agent writer workflow, none to the main pipeline (execs 370318/370390 wrote nothing).

## Findings

**F1 — The dormant-`=` bug is a family, not a one-off.** Nine nodes affected: `Query Supabase Candidate Trace Insert`, `Query Supabase Bias Filter Drop Update`, `QTP Ingress Guard Insert`, `PF_MARGIN Trade Insert`, `Query Supabase WRO Shadow Insert`, `Query Supabase VC API Health Insert`, `Query Supabase Backtest Audit Insert`, `Query Supabase Early Exec Flow Audit Insert`, `Query Supabase SKIP Exec Flow Audit Insert`. n8n treats a query string without a leading `=` as a literal; `{{ }}` never interpolates; every one silently no-ops with `onError=continueRegularOutput`.

**F2 — This is the likely root of the 05-29 `RISK_UNKNOWN` misdiagnosis.** The 05-29 event read as a Risk Gate breakage (99.85% `RISK_UNKNOWN`) but was diagnosed as an observability artifact. F1 explains the mechanism: the pipeline's own trace/audit writes were dead, so risk state could never be recorded — it wasn't unknown because risk failed, it was unknown because the writer was a literal string. Consistent with ARCH_V59's "seven silent failures" theme and D4's "order-lifecycle events invisible to the audit trail."

**F3 — Terminal-stage attribution was absent even where trace rows would have existed.** Even the Signal-Agent-written rows never recorded WHICH gate terminated a candidate — `blocked_stage` was structurally unwritten. Decision cards' "not reached" honesty and the console's per-stage funnel both depend on this.

## Decisions this forced (all shipped 07-11, governance row 82)

**D1 — Fixed all nine dormant-`=` nodes.** Re-asserted the `=` prefix; the pipeline now actually executes its observability writes.

**D2 — Added terminal-stage stamping.** Four self-guarded side-branch stampers (VC reject → `VC_GATE`, Pause block → `PAUSE_GUARD`, Bias drop → `BIAS_FILTER`, Executor → `ALPACA_EXECUTOR`/route) plus Gate-K reject → `GATE_K`. Correlated by ticker + 20-min window + `blocked_stage`-empty guard (the codebase's own bias-drop precedent). `onError=continue`; execution path untouched.

**D3 — Draft-regression guard.** Publishing the stale draft would have silently un-fixed two working Gate-K nodes (`={{ $json.sql }}` → `{{ $json.sql }}`); re-asserted in the same atomic update.

## Caveats

The 05-29→dormant-`=` causal link is F1-strong but not proven from 05-29 logs directly (those predate this investigation). SSM SKIP candidates still get no trace rows at all — that gap is in the Signal-Agent writer workflow (`qq1mZLLsuUtot0ID`), not `vaqfCaELhOEWnkdo`; it is the W1 follow-up and the last blocker for a fully truthful Tier-1 console funnel. Monday's first runs are the live verification: `SELECT blocked_stage, count(*) FROM quantum.candidate_path_trace_10fc WHERE observed_at > '2026-07-13' GROUP BY 1`.

## Artifacts

Governance row 82 in `quantum.ssm_workflow_updates`; workflow version `77d0ada6` of `vaqfCaELhOEWnkdo`; node list in D1/D2.
