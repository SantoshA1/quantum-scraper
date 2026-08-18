# gov 226 — cancel ≠ execution, and the two authorized measurements are live

**Date:** 2026-08-18, afternoon session · **Deployed:** main pipeline `ce492738` (Late Builder
v4.1), RCF scorer `88750896` (v2), new workflow `5RJRTLukKqKZDLp9` (Overnight Gap Exposure)
**Data changes:** 15-row audit relabel; `rcf_shadow` +6d schema; new `overnight_gap_exposure` table
**Suites:** `test-cancel-not-execution-20260818.js` 10/10 · `test-rcf-gap-measurements-20260818.js`
13/13 — negative controls run on every axis. **104/104 lifetime across eight suites.**

---

## 1 · Cancel-counts-as-execution — fixed at the writer, the counter, and the history

The Late Builder's finalize CASE branded anything without a blocking stage `EXECUTED`. A
cancelled entry rides the executor path with `blocked_stage='UNKNOWN'` — and even carries an
`alpaca_order_id` (placed, then cancelled), so the old `final_outcome` logic called it
`FILLED_OR_NEW`. The Gate-K wrapper counts `EXECUTED` rows into `exec_today`/`sell_today`, so
every ghost burned a daily-cap slot.

**Scale, measured before fixing:** 15 modern-era non-fills wore `EXECUTED` — 4 twelve-second
cancels (`SKIPPED_NO_FILL_WITHIN_CAP`: ECL today, WMB/AMP 08-11, AEE 08-12), 10 executor skips
(TE-C4 position-held, mostly WMT/WMB on days they were already open), 1 risk-gate block.
**Eight of the last 18 "executions" were not executions.**

**v4.1 (`ce492738`):** a broker outcome matching `^(SKIPPED|BLOCKED|EXT_HOURS)` now lands
`REJECTED` with a named stage — `ENTRY_CANCELLED_NO_FILL` / `ENTRY_SKIPPED_EXECUTOR` /
`ENTRY_BLOCKED_EXECUTOR` — via both the stage column and an explicit CASE leg (belt and
braces, since `UNKNOWN` is a non-blocking stage). Real fills are byte-identical (CE-06). The
Finalizer sweep was verified unable to undo it (PENDING→REJECTED only). All 15 historical rows
relabeled with an audit token; `exec_today` dropped 4 → **3, the true fill count.**

## 2 · REGIME_CONFLICT scorer — it existed, it went blind, and its verdict flips at the real horizon

The measurement PO-authorized on the 14th had been running since **07-27**
(`QTP RCF-Blocked-BUY Forward-Return Shadow`), and nobody had read it. Three defects fixed
in v2 (`88750896`):

1. **Blind since gov 221.** Ingest filtered `blocked_stage='REGIME_CONFLICT'` strictly; the
   08-17 rename to `REGIME_CONFLICT_SHADOW` made every new row invisible, and the 30-day
   window was quietly aging the shadow evidence out. Now an IN-list, with `src_stage`
   provenance (241 hard-era / 58 shadow-era / 88 pre-retention rows).
2. **A hardcoded Polygon API key literal** sat in the code node — replaced by Alpaca daily
   bars with `$vars.ALPACA_API_KEY` by name. The literal survives in n8n version history
   (`bf5285f3`) and was redacted from the repo fixture: **rotate that Polygon key.**
3. **Silent fetch catch** could drop a trading day from the calendar, shift every +1d/+2d
   index onto the wrong dates, and freeze the wrong numbers forever under COALESCE. Fetch
   failures now throw loud; pending rows simply retry next night.

Plus the horizon that was actually authorized: **+6d close and a walk-forward 1.0%-stop
simulation over d1..d6** (`ss6_ret_10`), matching the real ~5.6-day mean hold. First run:
387 rows scored, execution green.

**The verdict, n≈330 blocked BUYs (v_rcf_shadow_verdict):**

| horizon | n | mean ret | win % | PF |
|---|---|---|---|---|
| +1d | 336 | +0.12% | 55.7 | 1.13 |
| +2d | 324 | +0.50% | 51.9 | 1.40 |
| **+6d (real hold)** | 287 | **+0.03%** | **48.1** | **1.02** |
| **+6d with 1% stop (live discipline)** | 334 | **−0.37%** | **14.4** | **0.70** |

The AMD +3.17% anecdote and the 2-day drift (PF 1.40) were **horizon illusions**. At the
holding period QTP actually trades, with the stop QTP actually uses, the blocked population
is a net loser — worse than the PF 1.10 book that got traded. And the filter's best save is
now on record: **AEHR, killed 08-17 at bias 99, −16.2% the next day.**

**Caveats before acting on this:** the hard-era rows are mostly broken-universe alphabet-head
names (sample bias gov 224 just ended); entry is the block-day close (no intraday timing); the
sim has no trail/target. **Recommendation: keep the shadow running through the authorized
3–4-week window** — the 58 shadow-era rows mature their 6d horizon from ~08-25 and
`rcf_shadow_verdict_daily` now snapshots all four horizons nightly, so the era-split answer
arrives on its own. But the burden of proof has moved: the early evidence says gov 221 should
eventually be **reversed**, not celebrated.

## 3 · Overnight-gap exposure — measured, and smaller than feared

New nightly workflow (16:40 ET, fail-loud, idempotent) backfilled the 95-day book on first
run: **97 position-nights across 31 multi-night trades** (24 same-day round-trips contribute
zero, by construction).

| metric | value |
|---|---|
| mean adverse gap / night | long **+0.01%**, short **+0.13%** |
| mean gap *when* adverse | 0.86% |
| p95 / p99 adverse gap | **1.75% / 3.06%** |
| nights the open landed beyond the stop | **3 of 97 (3.1%)** — SHW −3.88% (breach 2.14%), ADSK (1.68%), ALGN (0.04%) |
| total cost beyond intended stops, 90d | **≈ $412** |

So the SHW-class tail is real but rare and now quantified: roughly one night in 32 gaps
through a stop, and the 90-day cost beyond stops is ~$412 — against ~$3.2k of total losses.
The earlier "59% of losses" figure conflated gap-throughs with the losses those trades would
largely have taken anyway; the *incremental* overnight cost is the $412. **Per the PO's
"measure first, then decide": the measurement argues for keeping overnight holds and NOT
paying the cost of day-only exits, while sizing so a p99 (~3%) adverse gap on any single
position stays inside the daily loss budget.** The table now grows nightly; revisit at ~300
nights.

## 4 · The suite caught my own harness lying — field lesson

The first version of `test-rcf-gap-measurements-20260818.js` ran async checks through a
non-awaiting `check()`: seven promises were stamped ✅ unread, and `process.exit()` buried the
rejections — a sabotage run "passed" checks it should have failed. Maya doctrine V2-8 ("green
means RAN") applied to my own harness. `check()` is now async-aware, every call awaited, and
the sabotage matrix re-run: re-blind the ingest → 2 fail; break the gap-through fill math →
RG-09 bites; flip short-side gap direction → RG-11 bites. The lesson is in the suite header
so it ratchets.

## Ledger

- **Rotate the Polygon key** (in n8n version history `bf5285f3`). Needs PO action.
- Shadow-era 6d verdict matures ~08-25; era-split query is one SELECT on `src_stage`.
- `overnight_gap_exposure` accrues nightly; decision review at ~300 nights.
- Carried: strat-cache backfill (85 tickers, next big item), sentinel distinct-symbol floor,
  5 MCP-blocked workflows, `vc_paper_secondary_bar` unwired, `signal_ts` defect,
  `scraped_at` NULL, stale scanner node notes.
