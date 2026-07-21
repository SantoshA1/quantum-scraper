# Delta audit_status_finalizer (2026-07-20, live 62910ab8)

**Bug:** audit_status is finalized only by the Late Exec Flow Audit Builder on the
risk-gate branch. Bias-filter-drop rows (AI_CONFLICT/PAPER_SECONDARY/MTF/BACKTEST)
and SKIP-branch rows (TICKER_BLOCKLIST/FAST_ONLY) terminate before it, so they kept
audit_status=PENDING despite a real blocked_stage/kill_stage. Console + funnel
under-counted rejects.

**Fix (source, 2 nodes):**
- qtp-bias-filter-drop-sql-builder-v1.4.js — UPDATE SET adds
  `audit_status = (CASE WHEN audit_status='EXECUTED' THEN audit_status ELSE 'REJECTED' END)`
- qtp-skip-branch-exec-flow-audit-builder-v1.1.js — INSERT adds audit_status col =
  'REJECTED' (28-col parity verified offline)

Pure observability (Kelly caps count EXECUTED only). Backfilled 1295 historical rows.
Governance: quantum.ssm_workflow_updates #130.

**RESIDUE:** ~42 SM-passed signals/day still die PENDING with NO attribution and
never reach the risk gate — separate silent-path class, next trace.
