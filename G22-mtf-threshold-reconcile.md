# G22: MTF threshold reconcile in QTP Bias Filter

**Date deployed:** 2026-05-29 17:24:46 UTC
**Audit row:** `quantum.ssm_workflow_updates` id=44
**Workflow:** SSM `vaqfCaELhOEWnkdo` (TradingView AI Super Score → Perplexity → Telegram)
**Post-deploy versionId:** `3ce6edb0-c0b2-43ac-a98d-472739e044f1`
**Node touched:** `QTP Bias Filter` (id `1733e2a2-c812-4007-99ce-d58b37afaedb`) — single line in `jsCode`

## Problem

The `QTP Bias Filter` was double-gating the MTF Confluence Engine result:
the engine itself enforces an MTF score floor, but the Bias Filter then re-checked
`mtfScore >= 65 && aiMtfScore >= 65`. When AI Judge skipped a candidate, `aiMtfScore`
came through as `None`, which silently flipped `finalMtfPass` to `false` even when
the engine had already issued `FINAL_MTF_CONFLUENCE_PASS`. Result: legitimate engine
PASSes were being dropped at the Bias Filter (e.g. SNAP exec 246822).

## Fix (single-line)

`QTP Bias Filter` `jsCode` line 140:

```js
// Before
const finalMtfPass = mtfEngineSeen && finalMtfDecision === 'FINAL_MTF_CONFLUENCE_PASS' && mtfScore >= 65 && aiMtfScore >= 65;

// After
const finalMtfPass = mtfEngineSeen && finalMtfDecision === 'FINAL_MTF_CONFLUENCE_PASS';
```

Engine remains authoritative on score; Bias Filter no longer re-applies a redundant
floor against a value (`aiMtfScore`) that can be `None` for legitimate reasons.

## Deploy

Used `qtp_tools/n8n_safe_update.py` defensive PUT wrapper. Steps executed:

1. **A** — Read MTF Confluence Engine threshold (pre-flight, confirmed engine floor).
2. **B** — Build single-line `jsCode` modifier (`/tmp/g22_mtf_reconcile_modifier.py`).
3. **C** — Pre-PUT verification: JS syntax OK, single-node touch (only `QTP Bias Filter`
   modified), graph SCC unchanged, 99/99 nodes preserved.
4. **D** — Defensive PUT; new versionId `3ce6edb0-c0b2-43ac-a98d-472739e044f1`;
   re-GET confirmed `active=true`, `executionTimeout=120`.
5. **E** — Audit row inserted (id=44) into `quantum.ssm_workflow_updates`
   with `recovery_ms`, `version_id_before`/`version_id_after`,
   `triggering_action='g22_mtf_threshold_reconcile'`.
6. **G** — Spot-check on SNAP exec 246822:
   pre-G22 `finalMtfPass=false` (because `aiMtfScore=None`),
   post-G22 same inputs → `finalMtfPass=true`. **G22 syntactically proven.**
7. **F** — Live MTF-PASS verification: no MTF-PASS arrived between 17:24Z and
   20:00Z market close (see funnel below). Closed via STEP G + 30-day audit.

## Post-deploy session funnel (17:24Z → 20:00Z, 2026-05-29)

**Total post-G22 execs: 11.** Reached MTF: 2. MTF-PASS: 0. Alpaca orders: 0.

| EID    | Ticker | Bias | MTF det / ai | Engine | Bias Filter ran |
|--------|--------|------|--------------|--------|-----------------|
| 247047 | CMI    | 70   | 48.8 / 48.8  | BLOCK  | yes             |
| 247068 | GM     | 61   | —            | —      | no              |
| 247078 | —      | —    | —            | —      | no              |
| 247081 | MRNA   | 69   | —            | —      | no              |
| 247138 | —      | —    | —            | —      | no              |
| 247143 | IFF    | 60   | —            | —      | no              |
| 247155 | SHOP   | 75   | —            | —      | no              |
| 247201 | NEM    | 62   | —            | —      | no              |
| 247293 | CIEN   | 82   | —            | —      | no              |
| 247373 | MDT    | 62   | —            | —      | no              |
| 247388 | TXN    | 75   | 51.85 / 51.85| BLOCK  | yes             |

MTF scores observed: 48.8, 51.85 — both legitimately blocked by the MTF Confluence
Engine (threshold 65). **0 Alpaca orders today; system gating accurately.**

## Related audit rows (`quantum.ssm_workflow_updates`)

| id | when (UTC)              | triggering_action                                |
|----|-------------------------|--------------------------------------------------|
| 41 | (earlier)               | `manual_fix_loop_break`                          |
| 42 | 2026-05-29 15:36:48     | `timeout_raise_post_loop_fix` (60→120s)          |
| 43 | 2026-05-29 16:58:27     | `vc_gate_slot0_telegram_rewire` (Fix #1)         |
| 44 | 2026-05-29 17:24:46     | `g22_mtf_threshold_reconcile` (this change)      |

## Standing rules honored

- Single-node, single-line edit. No other nodes, edges, or settings touched.
- Backup taken (`n8n_backups/20260529T172408Z_safe_update_vaqfCaELhOEWnkdo/`).
- Defensive PUT wrapper used; audit row inserted; active + timeout re-verified.
- Fail-closed semantics preserved: engine remains authoritative; Bias Filter
  defers to engine decision rather than overriding.
- No real secrets in this commit.

## Not touched (deferred)

- G19 PR / DAG validator.
- G21 diamond collapse.
- Fix #2 (VCRL threshold drift <68 vs gate ≥65).
- Fix #3 (SSM→VCRL edge removal).
- G23 (AI judge calibration drift on bear signals).
