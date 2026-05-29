# Session summary — 2026-05-29

## Deploys (in order)

| Time (UTC)  | Audit id | Action                                                                 |
|-------------|----------|------------------------------------------------------------------------|
| (earlier)   | 41       | `manual_fix_loop_break` — removed back-edge `Merge MTF AI Verdict → QTP Early Exec Flow Audit Builder` |
| 15:36:48    | 42       | `timeout_raise_post_loop_fix` — SSM `executionTimeout` 60 → 120s        |
| 16:58:27    | 43       | `vc_gate_slot0_telegram_rewire` (Fix #1) — verified on exec 246987 (FOX) |
| 17:24:46    | 44       | `g22_mtf_threshold_reconcile` — single line in `QTP Bias Filter`        |

Post-G22 SSM state: versionId `3ce6edb0-c0b2-43ac-a98d-472739e044f1`,
99 nodes, `executionTimeout=120`, `active=true`.

## Other work today

- G18 keep-earliest cleanup: 216 rows deleted.
- G19 DAG validator: branch `g19/dag-validator` (DO NOT PR yet).
- STEP G spot-check on SNAP exec 246822: G22 syntactically proven
  (pre `finalMtfPass=false` → post `finalMtfPass=true` for same inputs).

## Post-G22 session funnel (17:24Z → 20:00Z)

Total post-G22 execs: 11. Reached MTF: 2 (CMI 48.8, TXN 51.85, both engine BLOCK).
MTF-PASS: 0. Alpaca orders: 0. **System gating accurately.**

See `../../G22-mtf-threshold-reconcile.md` for the full table.

## 30-day rejection audit (BLOCKBUSTER)

Pure read-only over 30 days of `quantum.exec_flow_audit`. Identified
**risk_gate** as the silently-dead bottleneck since 2026-05-19 17:51 UTC:
99.85% `RISK_UNKNOWN` over the window, only 23 non-`RISK_UNKNOWN` rows
(all on 2026-05-19 between 13:36 and 17:51 UTC). SSM PASS rate is 99.99%;
MTF threshold has trivial leverage; the bottleneck is downstream of MTF.

See `../../AUDIT-2026-05-29-risk-gate-silent-failure.md`.

## Files in this folder

- `g22_mtf_reconcile_modifier.py` — the modifier used for the G22 defensive PUT.
- `audit-row-44.sql` — the row inserted into `quantum.ssm_workflow_updates`.

## Not committed (intentionally)

- Live SSM JSON snapshot — contains real credentials in node parameters
  (Telegram bot token, API keys). Standing rule: do not commit real secrets.
  Local backup at `n8n_backups/20260529T172408Z_safe_update_vaqfCaELhOEWnkdo/`.

## Active crons

- `962cae7a` — weekday 13:40 UTC TradingView pipeline check.
- `ef7d50bc` — hourly SSM activation watchdog (backstop to the primary
  watchdog n8n workflow `k8hnZKRccdGz2VTi`).

## Pending / deferred (NOT to touch without approval)

- Monday #1: debug `Query Supabase Alpaca Risk Gate` postgres node in SSM.
- G19 PR.
- G21 diamond collapse.
- Fix #2 (VCRL threshold drift).
- Fix #3 (SSM→VCRL edge removal).
- G23 (AI judge calibration drift on bear signals).
- Rebuild `v_rejection_breakdown_7d` / `v_rejection_breakdown_24h` views.
- Repair `quantum.candidate_path_trace_10fc.blocked_stage` / `blocked_reason`
  writer (currently emits empty strings for all rows).
