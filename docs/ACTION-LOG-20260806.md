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

## Deployed (afternoon 2): naked-window RCA — the day's real money bug — gov 190/191/192

**"No orders after 10:55 ET" RCA found the flow quiet for market reasons (morning movers all
deduped, no fresh ±0.7% qualifiers) — but exposed that BOTH of the day's entries were
destroyed minutes after fill by a three-part interaction:** entry brackets born 3–4% wide
(raw ATR×mult) → TSM wide-stop recovery cancels the working stop BEFORE knowing the
tightened replacement is placeable → price already through the level → Alpaca 422 → naked →
scalp watcher market-dumps it. WRB 13:46Z −$143.60 · APA 14:30Z −$47.68. Both TSM failure
cycles also lost their audit batches to the (since-fixed) escaping bug — the evidence was
recovered from execution records.

| Fix | Where | Version | Rollback | Proof |
|---|---|---|---|---|
| **Entry stop clamp v1** — `stopDist = min(ATR×SL_MULT, price×1.2%)`; entry and TSM finally agree; qty (%-of-portfolio) unaffected; TP untouched | main pipeline "Alpaca Paper Trade" | active `10a5a6a5` | `94fd764e` | suite 7/7 (real WRB/APA/AKAM numbers; 60-case sweep ≤1.2%); byte-identical `e9cd909c` |
| **Trail Stops v4.3.1** — validity guard BEFORE any cancel (unplaceable → `KEPT_EXISTING`, wide stop stays, TG review) + re-protect fallback stop at market∓0.5% after any cancel; never naked | TSM "Trail Stops" (98KB node byte-ferried via subagent) | active `cec40297` | `5faacd55` | suite 8/8 (WRB 72.40-vs-72.085, APA 35.58-vs-35.51 replays → KEEP_EXISTING); **new pin `5f22eddd175bfdc3`** (retires `b6bf74f0`); live cycle 526088 17:00Z green |
| **Scalp watcher scope v1.1** — entry `client_order_id` attribution; `qet-` (main pipeline) → `SKIP_MAIN_PIPELINE_SCOPE`; unattributed → `SKIP_UNATTRIBUTED_NOT_SCALP`; genuine scalps still close | scalp watcher (2 nodes) | active `30adf8f3` | `92c4745e` | suite 7/7 executing actual node bytes (zero broker calls on skips); **live 16:26/16:28Z: ALLE + DGX real qet- coids → SKIP** |

Full Maya gate after all three: **18/18 suites, 233 checks**. Note: code comments citing
"gov 189" correspond to governance rows **190/192** (id 189 was taken between drafting and
insert). Watcher context window quirk (pre-existing): only entries ≤3 days old are fed to
the watcher (AES/XPEV outside it — never at its risk). Deployed live/fixed pairs archived
in `docs/naked-window-20260806/`.

## Deployed (evening): H4 ledger-sync SELECT-completeness gap — gov 193

**PO reported "no new executions" after the naked-window fixes went live. RCA of that
report found the quiet tape itself benign** — every actionable candidate since 14:06Z
was correctly rejected by pre-existing, untouched gates (`PAPER_SECONDARY` on APA 18:15Z:
VC score 9 sits one point under the hardcoded `vcScore >= 10` paper-secondary bar from
Conclave 2026-07-08, and neither relaxed leg saves it — volume_ratio 1.12 vs the 1.25
strict cutoff, cross_asset NEUTRAL; `REGIME_CONFLICT`/`BROAD_SCANNER_BIAS_PATH`/
`SESSION_OR_NEUTRAL_FILTER` on everything else). Today's 5/30 pass-rate and 2 blocked
`PAPER_SECONDARY` count both sit inside the last 7 days' normal range — **not a
regression, nothing here touches code changed today.**

**But the same investigation surfaced a real, separate, standing bug.** `quantum.position_risk_state`
showed WMT/AEP/WRB/APA broker-truth `CLOSED_NO_POSITION` while `trade_ledger` still had
all four `status='open'` — a phantom-open desync hiding real realized losses from every
downstream reader (Gate-K's certified-trade count, the PO's own view of exposure/P&L).
RCA on the "QET H4 Exit-Fill Sync" workflow (5-min schedule, 229+ green runs/day) found
two independent, silent defects, both live since the v2 rewrite on 2026-08-04:

1. **"Get Open Ledger Rows" never `SELECT`ed `qty`.** The account-scan exit matcher
   (`QTP_H4_EXIT_RESOLUTION_v2_20260804`) requires `Math.abs(filled_qty - r.qty) < 1e-9`;
   `Number(undefined)` is `NaN`, and any comparison against `NaN` is `false` in JS — so
   the match the 08-04 fix was built for could never succeed. The existing 22/22 Maya
   suite (`tests/test-h4-exit-updates.js`) tested the matcher in isolation with `qty`
   always present in its fixtures and stayed green throughout — it never caught that the
   real upstream query didn't supply it. Silent no-op every 5 minutes for 3 days.
2. **"Fetch Closed Orders" only looked back 7 days**, but Alpaca's `after` filters order
   *submission* time, not fill time. WMT's qualifying replacement stop was submitted
   2026-07-30T13:45:11Z — ~5h15m before the 7-day cutoff at the 19:00:35Z run — so it
   would have stayed invisible to the account scan even after fix 1.

| Fix | Where | Proof |
|---|---|---|
| Add `qty, entry_fill_time` to the SELECT | "Get Open Ledger Rows" node | matcher can now succeed at all |
| Widen `after` 7d → 14d | "Fetch Closed Orders" node | WMT's submit time now inside the window, ~5d margin |

Both nodes updated in one `update_workflow` call, byte-verified against
`docs/h4-ledger-sync-fix-20260806/*`, published — active `498085c4` (rollback `778c02d3`).
New suite `tests/test-h4-ledger-select-gap.js` **8/8** on the real captured rows (not
synthetic): reproduces the actual 0-closed outcome from live execution 527111, proves the
qty fix alone unblocks AEP/WRB/APA while WMT still correctly stays open (proving the
window bug is independent, not just a restatement of the qty bug), proves the 14-day
window recovers WMT too, and adds a completeness guard (`GAP-05`) that fails loudly if
`Build Exit Updates` ever reads a ledger field this SELECT doesn't supply — the class of
gap that let this ship in the first place. Full gate re-run after: **19/19 suites, 241
checks.**

**Live-fired immediately** (`execute_workflow`, production mode, execution `527316`) rather
than waiting on the next cron tick — independently re-confirmed against `trade_ledger`
directly (not just the workflow's own `RETURNING`): all four now `status='closed'`,
`lineage_source='H4_EXIT_RESOLUTION_v2'`.

| Symbol | Held | Realized net P&L | R | Exit reason |
|---|---|---|---|---|
| WMT | 07-30 → 08-06 (stop, 7d) | **-$136.80** | -0.39R | trail |
| AEP | 08-05 → 08-06 (stop) | **-$110.35** | -0.21R | trail |
| WRB | 08-06 → 08-06 (naked-window panic-close) | **-$157.66** | -0.87R | manual |
| APA | 08-06 → 08-06 (naked-window panic-close) | **-$45.15** | -0.12R | manual |
| **Total newly booked** | | **-$449.96** | | |

**Correction to gov 190/191/192:** those rows cited WRB "13:46Z −$143.60" and APA "14:30Z
−$47.68" as the naked-window losses. Those were `position_risk_state` *unrealized*
snapshots taken seconds before each panic-close filled, not the realized exit — the real
numbers are -$157.66 and -$45.15 respectively, per the actual broker fill (71.99 and
35.748456). Directionally the same story, WRB slightly worse than reported. AES/ALLE/DGX/
XPEV were never affected by either bug — broker-truth confirms they're genuinely still
open and `FULLY_PROTECTED`.

## Notes
- Main-pipeline sink columns `candidate_path_trace_10fc.raw_payload` and
  `vc_gate_forensics_shadow.raw_payload_json` turned out to be **TEXT** (not jsonb) — the
  legacy corruption there was content-level, not statement-kill. The new `safe_jsonb(...)`
  values assignment-coerce jsonb→text cleanly (proven live in a rollback txn 15:20Z: canonical
  JSON stored, `$3` real, quotes intact, `::jsonb` round-trip green). Strictly better data.
  The 15:15Z webhook signals stopped at the ingress guard (dedupe) — full-route live proof
  arrives with the next routed signal.
- Supabase MCP token expired mid-task (~14:35Z), re-authorized by PO (~14:48Z); recovery + gov 187
  landed after re-auth. Deployment itself was unaffected.
- "Format Supabase TSM Result" node still echoes a hardcoded `v4.2.1` label in its own output
  (cosmetic; the DB round-trip row correctly reports v4.2.2). Fix with next routine TSM touch.
- New standing rule (transfer hygiene): n8n jsCode with NUL/U+FFFD is built via
  `String.fromCharCode(...)` so node source stays pure ASCII through every JSON/export layer.

## Rollback pointers
TSM audit builder: republish `09b85df5` (v4.2.1 behavior) · `quantum.safe_jsonb` is additive
(safe to leave) · recovery rows removable by `run_id='524111' AND raw_payload ? '__recovered_from_exec'`.
H4 Exit-Fill Sync: republish `778c02d3` (pre-fix behavior — reverts to the silent no-op,
NOT recommended) · the four ledger closes are real broker fills newly booked, not
speculative; reverting the workflow does not un-book them, and reverting the ledger rows
themselves would re-hide real realized losses — do not roll those back without PO sign-off.
