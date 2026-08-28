# 30-day rejection audit — risk_gate silent failure (2026-05-19 → 2026-05-29)

**Audit date:** 2026-05-29
**Window:** trailing 30 days of `quantum.exec_flow_audit`
**Posture:** pure read-only. No mutations.

## TL;DR

The Quantum Trading Pipeline has produced **0 Alpaca orders** for ~10 days
despite signals flowing normally through SSM, VC Gate, and the MTF Confluence
Engine. The root cause is **not** MTF threshold strictness and **not** SSM
defense layers. It is the downstream **Risk Gate**, which has been silently
returning `risk_gate_decision = 'RISK_UNKNOWN'` on 99.85% of rows for the
past ~10 days.

**Monday's #1 candidate: debug the `Query Supabase Alpaca Risk Gate` node in SSM.**
This is what unlocks the pipeline. MTF threshold, VCRL, and SSM→VCRL changes
should be deferred.

## 30-day funnel (`quantum.exec_flow_audit`)

| Stage                        | Count   | Conversion |
|------------------------------|---------|------------|
| A. Total audit rows          | 15,702  | —          |
| B. Reached VC Gate           | 15,702  | 100.00%    |
| C. VC v2 ≥ 7                 | 12,992  | 82.74%     |
| D. Reached MTF               | 11,692  | 89.99%     |
| E. MTF PASS                  | 1,069   |  9.14%     |
| F. RISK_PASS                 | 14      |  1.31%     |
| G. MTF_PASS ∩ RISK_PASS      | **0**   |  —         |
| H. Alpaca orders             | **0**   |  0.00%     |

## Risk gate signal — the smoking gun

`risk_gate_decision` distribution over the 30-day window:

- `RISK_UNKNOWN`: **15,679 / 15,702 (99.85%)**
- All other values combined: **23 / 15,702 (0.15%)**

All 23 non-`RISK_UNKNOWN` rows occurred on **2026-05-19 between 13:36 UTC and
17:51 UTC**. After 17:51 UTC on 2026-05-19, the gate has returned
`RISK_UNKNOWN` for every single execution, for ~10 days.

## Why this is "silent dead", not "real rejections"

`quantum.position_risk_state` is **fresh** — last updated 19:15 UTC on
2026-05-29 (the audit day). The underlying data is fine. The `Query Supabase
Alpaca Risk Gate` postgres node in SSM is returning 0 rows / a default
unknown, so the gate cannot make a decision and emits `RISK_UNKNOWN`. Pipeline
treats that as "do not advance", hence 0 orders despite valid signals.

Hypothesis: the postgres node configuration (query text, parameter binding,
or credential) was broken or rotated on or around 2026-05-19 17:51 UTC. Needs
direct inspection of the node in SSM, plus a compare against the last known
working query.

## What this disproves

- **SSM is not the bottleneck.** SSM PASS rate over the 30-day window is
  99.99%. The CIEN-style "SSM defense layers blocking strong setups" theory
  is disproved by the data.
- **MTF threshold is not the dominant bottleneck.** MTF reach-rate is 89.99%
  and 9.14% pass MTF. Even if every MTF PASS converted, the risk gate would
  still block them. G22 (this session) was still correct on its own merits
  (removing a redundant double-gate), but does not unlock the pipeline.
- **VCRL / SSM→VCRL edge** changes were also being considered. With 99.85%
  RISK_UNKNOWN, any upstream tuning is invisible until risk_gate is restored.

## MTF score distribution (reach-MTF = 11,692)

| Bucket  | Count  | Share | Note                          |
|---------|--------|-------|-------------------------------|
| 0–49    | 6,353  | 54%   |                               |
| 50–59   | 3,223  | 28%   |                               |
| 60+     | 2,116  | 18%   | Includes all 1,069 PASS rows  |

Threshold changes have trivial additional leverage versus restoring risk_gate.

## Instrumentation issues discovered

These also explain why the failure was silent (no rejection telemetry to alert on):

- `v_rejection_breakdown_7d` — **view does not exist** in `quantum` schema.
- `v_rejection_breakdown_24h` — **view does not exist** in `quantum` schema.
- `quantum.candidate_path_trace_10fc.blocked_stage` — populated as empty
  string on every row (0 / 16,389 with non-empty value).
- `quantum.candidate_path_trace_10fc.blocked_reason` — same as above.

Recommendation: the rejection-breakdown views and `blocked_stage` /
`blocked_reason` instrumentation need a separate ticket. They should have
caught this within hours of 2026-05-19 17:51 UTC, not 10 days later.

## Monday's priority order (proposed, requires approval)

1. **Debug `Query Supabase Alpaca Risk Gate` node** in SSM workflow
   `vaqfCaELhOEWnkdo`. Diff the query, parameters, and credential against
   the last known good state (≤ 2026-05-19 17:51 UTC).
2. Rebuild `v_rejection_breakdown_7d` and `v_rejection_breakdown_24h` views,
   or repoint instrumentation that referenced them.
3. Fix the `blocked_stage` / `blocked_reason` writer in
   `quantum.candidate_path_trace_10fc`.
4. Only after items 1–3 land, revisit Fix #2 (VCRL threshold drift) and
   Fix #3 (SSM→VCRL edge), with fresh data on what's actually blocking
   now that risk_gate emits real decisions.

## Standing rules honored

- Read-only. No `UPDATE`, no `DELETE`, no DDL.
- No real secrets in this document.
- Fail-closed semantics: `RISK_UNKNOWN` correctly prevents orders. The
  defect is upstream visibility/decisioning, not order safety.
