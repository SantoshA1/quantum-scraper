# QTP ACTION LOG — 2026-08-06
**Session:** claude-architect + PO · **Governance rows:** 186–187 · **Market open throughout**

## Deployed today

| # | Change | Version / Where | Proof | Gov |
|---|---|---|---|---|
| 1 | **ATR telemetry observer** — isolated parallel branch off the TSM trigger; per-cycle row in `quantum.tsm_atr_telemetry` (flag state, bars health, per-symbol ATR model + clamp verdict, flip consequences). Corrected two prior claims: `QTP_TSM_REAL_ATR_ON` was already **ON** (not off), and ORPHAN_ELIGIBLE does **not** bypass the tier ladder. Bars fix delivering (33/symbol). AES 0.27% < 0.4% floor → `SKIP_BELOW_FLOOR` exposed. | TSM workflow, nodes "ATR Telemetry Observer" + "Write ATR Telemetry"; migration `qtp_tsm_atr_telemetry_20260806`; Trail Stops untouched (`b6bf74f0f301d0e6`) | First cycle exec 524246 14:00Z: `real_atr_flag=TRUE`, `bars_fix_healthy=true`; suite 12/12 | 186 |
| 2 | **Audit-escaping RCA + fix (v4.2.2)** — exec 524111 13:45Z: v4.2.1 `esc()` doubled backslashes (valid only under `standard_conforming_strings=off`; prod is **on**), so any payload string containing `"` corrupted the jsonb literal → `22P02` → the WHOLE 6-row audit batch lost (WRB's embedded Alpaca 422 body killed XPEV's tier-1 event). Fix: quotes-only esc + NUL strip; `safeJson` deep-clean (NUL/lone surrogates → U+FFFD); every payload via `quantum.safe_jsonb()` — one bad row can never kill a batch again. | TSM node "Prepare Supabase TSM Audit SQL" → active `5faacd55`; migration `qtp_safe_jsonb_20260806`; deployed jsCode byte-identical to `docs/tsm-audit-sql-v4.2.2.js` (`b2309bf14bb7e4f9`) | `tests/test-tsm-audit-sql.js` **15/15** (repro byte-anchored to captured SQL); legacy SQL reproduced exact `Token "code" is invalid` on live DB; fixed batch 6/6 in rollback txn, WRB 422 round-trip byte-perfect; **live cycle 524688 14:45Z wrote its batch under v4.2.2** | 187 |
| 3 | **Lost-batch recovery** — exec 524111's 6 rows re-inserted with original `audit_id`/idempotency keys, `event_ts` pinned `13:45:22.906Z`, payload marker `__recovered_from_exec:"524111"`, `WHERE NOT EXISTS` guarded (no unique index exists on `quantum.audit_trail`). XPEV tier-1 (atr 0.53, 4.27% REAL) restored to the audit trail. | one-shot SQL, archived `docs/qtp-audit-524111-recovery-applied-20260806.sql` | post-insert: 6 rows, 0 `__jsonb_parse_error`, marker + 422 body verified | 187 |

## Fleet sweep (read-only, subagent) — `docs/SQL-BUILDER-SWEEP-20260806.md`

20 workflows audited for the same defect class: **2 CRITICAL** (Scalp Exit Watcher — exact 524111
clone incl. one-string order_events batch; main-pipeline 10FC Candidate Trace — same esc family),
**5 HIGH** (three main-pipeline jsonb sinks *inline in the signal path with onError=stop* — a
hostile payload kills the trade cycle, not just audit; Order Lifecycle Ingestor — poison order
re-kills every 10-min cycle and darkens the heartbeat; Daily Thesis — LLM prose into jsonb),
6 MEDIUM, 5 LOW. 11 clean. `VaUQ4J95wyc5CAVP` unreachable via MCP (not swept). **Fixes not yet
authorized — PO decision pending.**

## Deployed (afternoon): fleet escaping-class remediation — gov 188

PO authorized **CRITICALs + HIGHs** from the sweep. One canonical helper set
(`QTP_SAFE_PG_v1_20260806`, `lib/sql/safe_pg.js`) embedded verbatim in each node: quotes-only
escaping + NUL strip · deep-clean of NUL/lone surrogates · **real `$` preserved in jsonb via
the JSON unicode escape** (no literal `$` reaches SQL text — pg-param safe AND the "USD 3"
corruption is dead) · oversize re-wrap (never mid-JSON slices) · every jsonb literal through
`quantum.safe_jsonb()`. Suite `tests/test-safe-pg.js` **13/13** + poison sandbox smoke **6/6**.

| Workflow | Node(s) | Version | Rollback |
|---|---|---|---|
| Scalp Exit Watcher `IzTXfM9G0TM2wt0U` | Build Supabase Scalp Exit Watch Audit SQL → **v1.4** | active `92c4745e` | `2968be9d` |
| Order Lifecycle Ingestor `n31KzRDp6wR5BlFb` | Fetch Order Lifecycle → **v1.3** | active `06d72744` | `68d6a224` |
| MAIN PIPELINE `vaqfCaELhOEWnkdo` | 10FC Trace **v4.2.3** · VC Gate Audit **v4.2.2** · PF_MARGIN **v1.1** · Persist Grok Verdict → `safe_jsonb` (**grok-sig-v4.4**) | active `94fd764e` | `1a5c5ee9` |
| Daily Thesis `pvSiSm1JxsCLH4Qm` | Prepare Insert → **v1.1** | active `e42cefe1` | `d327daf0` |

**Live-proven same hour:** ingestor 15:10Z heartbeat note `v1.3` (order_events landing);
scalp 15:12Z row stamped `v1.4_20260806`; **zero** `__jsonb_parse_error` fallbacks anywhere.
All deployed jsCode byte-verified against `docs/sql-builders-20260806/*` (live + fixed pairs
archived there). Watch: main pipeline on next TradingView signal; thesis 08:30 ET 08-07.
Unswept: `VaUQ4J95wyc5CAVP` (not MCP-reachable — PO to enable). MEDIUM/LOW findings open.

## Notes
- Supabase MCP token expired mid-task (~14:35Z), re-authorized by PO (~14:48Z); recovery + gov 187
  landed after re-auth. Deployment itself was unaffected.
- "Format Supabase TSM Result" node still echoes a hardcoded `v4.2.1` label in its own output
  (cosmetic; the DB round-trip row correctly reports v4.2.2). Fix with next routine TSM touch.
- New standing rule (transfer hygiene): n8n jsCode with NUL/U+FFFD is built via
  `String.fromCharCode(...)` so node source stays pure ASCII through every JSON/export layer.

## Rollback pointers
TSM audit builder: republish `09b85df5` (v4.2.1 behavior) · `quantum.safe_jsonb` is additive
(safe to leave) · recovery rows removable by `run_id='524111' AND raw_payload ? '__recovered_from_exec'`.
