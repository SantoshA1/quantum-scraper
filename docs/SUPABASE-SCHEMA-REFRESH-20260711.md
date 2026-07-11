# Supabase Schema — Canon Refresh (2026-07-11)

**Status: VERIFIED LIVE.** Reconciles the schema section of canon (frozen ~2026-05-18) against `qtp_prod` (`vdmtwmwpxvohodyrdlon`) `information_schema` as queried 2026-07-11. Executed by architect (Claude). Supersedes the schema assertions in the prior canon and in the Conclave's Operations-Console review, both of which predate the QET spine built 07-09/07-10.

## Verdict in one line

**The drift is real but inverted: canon did not lag reality by omission — a new `public`-schema QET spine was built 07-09/07-10 and now coexists with the canonical `quantum` schema. The review's claim that "`public` is empty" is STALE.**

## The two schemas, both live

`quantum` (canonical, unchanged) — all referenced tables verified present: `audit_trail`, `trade_log`, `exec_flow_audit`, `daily_pnl`, `position_risk_state`, `regime_state`, `candidate_path_trace_10fc`, `vc_shadow_score_observations`, `vc_gate_forensics_shadow`, `order_events`, `ssm_workflow_updates`, `gate_registry`, `gate_config`.

`public` (NEW — the QET spine) — verified present: tables `portfolios`, `signals`, `positions`, `audit_log`, `pnl_snapshots`, `trade_ledger`; view `edge_metrics_by_strategy`. **10 RLS policies exist on `public`** (contra canon's "empty"). Live row counts at verification: `trade_ledger` 46, `audit_log` accumulating since 07-10.

## Findings

**F1 — Provenance is governed and dated.** The spine arrived via six applied migrations (`qet_bootstrap_canonical_schema`, `qet_edge_ledger`, `qet_kelly_gate`, `qet_edge_ledger_security_hardening`, `qet_kelly_gate_v2`, `qet_kelly_gate_v2_1`) with governance rows 72–82 in `quantum.ssm_workflow_updates`. Nothing here is aspirational; every object is in `information_schema`.

**F2 — The two schemas have distinct roles.** `quantum.*` is the legacy pipeline's forensic + execution store (written by `vaqfCaELhOEWnkdo`). `public.*` is the measurement spine: `trade_ledger` (intent-vs-fill per trade, cost-survived R), `edge_metrics_by_strategy` (win rate, E[R], PF, t-stat, annualized Sharpe, Kelly f* per strategy), and the Gate-K function library. Legacy fills now also write `public.trade_ledger` via the H3-legacy tap (governance row 80).

**F3 — `candidate_path_trace_10fc` is now instrumented.** As of 07-11 (governance row 82) `blocked_stage`/`blocked_reason` are stamped at every terminal gate; previously 0/18,784 rows populated. See the companion incident refresh.

## Decisions this forces

**D1 — Console reads BOTH schemas.** The Operations-Console facade (`qtp_console_views`, SECURITY DEFINER) must normalize across `quantum.*` (Tier-1 SSM funnel, forensics) and `public.*` (Tier-2 committee, edge scoreboard). Panel→table map is in the reconciliation artifact.

**D2 — Canon's schema doc is replaced by this, not patched.** The `03_supabase_schema.md` numbered canon (if it still exists in the Conclave store) is 7 weeks stale on the `public` spine and the RLS posture. Treat this dated refresh as the current source of truth until the numbered doc is regenerated.

## Caveats

Row counts are point-in-time (paper mode). `public` RLS policy count (10) was read from `pg_policies`; the per-table policy audit lives in the QET-supabase skill references, not re-verified line-by-line here. `quantum.*` table set was checked against the review's named list, not exhaustively enumerated.

## Artifacts

`qtp-console-schema-reconciliation.md` (panel→verified-column map), governance rows 72–82 in `quantum.ssm_workflow_updates`, six migration names above.
