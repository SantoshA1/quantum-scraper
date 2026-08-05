# QTP Deploy 2026-08-04 (23:00 ET) — Rollback Card

Two live n8n workflows changed. Both published. Paper-only. **One-step rollback each.**
Governance rows **173** and **174** in `quantum.ssm_workflow_updates`.

## Rollback — copy/paste

| Workflow | ID | Roll back to | Was |
|---|---|---|---|
| QET H4 Exit-Fill Sync | `bBIAbsClonHP94hk` | `f26312e7-76ea-43c7-a84b-9fc90797ba5e` | now `778c02d3-fea5-4c85-84c8-308e7f380257` |
| Trailing Stop Manager v2.0 | `vFnPjyx8srnzcYgV` | `0fbaef0c-02a5-43cc-844a-838d757d5d97` | now `b2b62c99-bf44-4bb6-8835-a1e8d4ff2099` |

n8n → open workflow → Version history → select the "roll back to" id → Publish.
Nothing else needs undoing; neither change touched schema, credentials, or orders.

## What changed

**H4 — `QTP_H4_EXIT_RESOLUTION_v2_20260804`**
- New node `Fetch Closed Orders` (httpRequest 4.4, `executeOnce`, `onError=continueRegularOutput`,
  retry 3, `Alpaca-PAPER`), GET `/v2/orders?status=closed&limit=500&direction=desc&nested=false&after=<7d>`
- Rewired `Fetch Order Status → Fetch Closed Orders → Build Exit Updates`
- `Build Exit Updates` jsCode replaced: keeps the nested-bracket path, adds an account-level
  match on symbol + opposite side + filled + after entry + **exact qty**
- Attribution fixed: trail vs stop decided by stop **movement** vs intended stop;
  `intended_exit` now gets the **actual** stop price

**TSM — `QTP_TSM_BARS_WINDOW_v1_20260804`**
- One block inside `Trail Stops`, replacing the two lines that fetched daily bars
- Adds explicit `start` (~52d), universe-scaled `limit`, `adjustment=all`, `next_page_token`
  paging, fail-closed on token loop / page budget
- `feed=iex` preserved — **the repo copy said `sip`; live is `iex`.** Pasting the repo block
  verbatim would have switched the data feed. Corrected before upload.

## Why both are safe to leave running

Each degrades into pre-existing behaviour on failure:
- H4: if `Fetch Closed Orders` errors, `onError=continue` → the code's try/catch yields an
  empty pool → v1 bracket-leg behaviour. It can only close **more** rows than v1, never fewer.
- TSM: any throw in the new block lands in the **pre-existing** `catch`, which logs
  "Bars fetch failed, using 2% proxy ATR" — i.e. exactly today's behaviour.

## Verified before publishing

| | |
|---|---|
| H4 manual exec **513741** | `Fetch Closed Orders` returned real broker data (incl. `d31fa51e` @71.56, `64bd14e2` @245.31 → credential works). `Build Exit Updates` → `action: none`, **0 closes** on 3 genuinely-open rows. Audit row 22:53:45. |
| H4 pre-flight | 0 false-close candidates for AES/WMT/XPEV (no opposite-side exact-qty fill after entry) |
| TSM manual exec **513819** | success 3.4s, **zero orders placed**, verdicts byte-identical to scheduled exec at 23:00:11 on the old version |
| TSM upload | sha256 round-trip `b6bf74f0f301d0e6…` — byte-exact, 96,225 bytes |
| Post-deploy | recon **CLEAN**, 3 open rows, 0 unprotected, `ALLOW_WITH_NORMAL_GATES`, 08-04 realized **+$36.15** |
| Repo | CI **21/21** suites, commits `c195a35` / `947ed4c` / `d3f1af9` |

## NOT verified live — check these at the open

1. **The `[QTP BARS v1]` canary is a `console.log`** and is not queryable from SQL. On the
   first market-hours TSM run, open the execution in n8n and read the `Trail Stops` node log.
   Expect `N req · X/X symbols >=15 bars · skip-rate 0%`. **Anything else → roll back.**
   Everything proving the bars fix works is offline (24 + 9 checks against Alpaca's documented
   paging semantics). Alpaca honouring its own docs is the one untested link.
2. **H4 v2 has not yet closed a real trade** — it correctly closed nothing tonight because
   nothing was closable. Its first true test is the next TSM-managed exit. Watch for
   `lineage_source='H4_EXIT_RESOLUTION_v2'`.

## Still open — your call

- **`QTP_NAKED_FLATTEN_ON` is NOT armed.** The n8n MCP has no variable-management tool, so
  this must be set in the n8n UI (Settings → Variables). Confirmed live flag names:
  `QTP_NAKED_FLATTEN_ON` (default off), `QTP_NAKED_FLATTEN_OVERSHOOT_PCT` (default 0.5).
  WMB cost −$341 through a 15-minute naked window today; second occurrence in six days.
- **Do not arm `QTP_TSM_REAL_ATR_ON`.** CLAMP-01 confirmed on live data: AES real ATR 0.358%
  is below the 0.40% A2 clamp, so it would silently stop trailing that name.
  (Note the live flag is `QTP_TSM_REAL_ATR_ON`, not `..._v1` as the repo spec-mirror implies.)

## Repo drift introduced by this deploy

`docs/tsm-bars-patch-block.js` in the repo still says `feed=sip`; **live is `feed=iex`.**
That file is now wrong relative to production and should be corrected before anyone pastes
from it again. The deployed code is correct — only the repo copy drifted.

## Post-market-open checks

```sql
select * from quantum.v_ledger_recon_health;   -- want CLEAN
select symbol, exit_reason, lineage_source, net_pnl, exit_slippage_bps
from public.trade_ledger where lineage_source = 'H4_EXIT_RESOLUTION_v2';
select reason from public.audit_log
where workflow_name='qet-h4-exit-sync' order by timestamp desc limit 3;
```
