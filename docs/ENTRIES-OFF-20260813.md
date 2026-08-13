# Gov 213 — New entries halted. The flip you ordered would not have done it; here is what did.

**Date:** 2026-08-13 16:50 ET · **Authorized by:** PO ("flip expansion_cohort_active … goal: stop losing money")
**Executed by intent, not by letter — the letter was unsafe, proven from deployed bytes below.**
**Verify offline:** `node tests/test-entries-off-20260813.js` (6/6) · fixtures sha256-pinned in `docs/entries-off-20260813/`

---

## 1. Why the literal flip was refused

The deployed Kelly SQL (`QET Kelly SQL Build`, sha256 `773b65bf…`, workflow `vaqfCaELhOEWnkdo`):

```sql
WHEN exp.is_on AND exp.exec_today   >= exp.cap_daily      THEN block  -- daily cap 5
WHEN exp.is_on AND exp.concurrent_open >= exp.cap_concurrent THEN block  -- concurrent cap 8
WHEN exp.is_on AND ... sell caps / PRS-stale ...          THEN block
ELSE public.compute_kelly_gate(...)                                  -- normal approval
-- is_on := (expansion_cohort_active = 1)
```

Every blocking clause requires `exp.is_on`. **Setting the flag to 0 makes `is_on` false, which
bypasses all five caps and falls through to the normal approval path.** Trading would have
continued with *fewer* guardrails — the exact opposite of the order's intent. Pinned as `EO-02`
so it cannot be re-litigated. (My 08-13 advice doc recommended this flip; that recommendation
was wrong, and this corrects it.)

## 2. What was actually shipped

One row in `quantum.entry_pause_control` — the mechanism the pipeline's own pause guard enforces:

| field | value |
|---|---|
| control_id | `po_halt_20260813_entries_off` |
| status | `EXPANSION_CUMULATIVE_HALT` (the ratified kill-switch status, fired manually) |
| pause_new_entries | **true** |
| trading_blocked | **false** — exits, stops, trails, covers untouched |
| checked_at | **now + 30 days** (deliberate — see §3) |
| expires_at | now + 60 days |

This is the −$2,500 cumulative halt you ratified on 07-14, executed by hand, because its sensor
is dark (reads `quantum.trade_log`, which is all zeros) while the real book sits at **−$3,064.22**.

**Verified against the deployed reader** (`Prepare Supabase Pause Guard Query` run verbatim):
returns `pause_new_entries=true, status=EXPANSION_CUMULATIVE_HALT`. The guard node
(`QTP-10FC New Entry Pause Guard`, sha256 `79a0a171…`) turns that into `_sm_route='SKIP'` for
every new-entry intent and **bypasses** every protective/closing intent (`TRAILING_STOP`,
`SELL_TO_CLOSE`, `BUY_TO_COVER`, `reduce_only`, …) — pinned in `EO-03/EO-04/EO-05` by executing
the live node code against fixtures.

**Live confirmation pending one real signal:** the halt went in at 16:50 ET, after the last
signal of the day (14:35 ET). The first signal tomorrow ~09:30 must audit as
`New entry paused by QTP-10FC: … EXPANSION_CUMULATIVE_HALT …`. Check that before trusting the day.

## 3. Why the halt row has a future timestamp — the fifth dead guard

The deployed reader takes **the single newest unexpired row**:

```sql
FROM quantum.entry_pause_control WHERE expires_at > CURRENT_TIMESTAMP
ORDER BY checked_at DESC LIMIT 1
```

`qtp_afto_monitor` (workflow `AaaQOrBVEXwJkOyz`) **unconditionally inserts a fresh NOMINAL row
every 15 minutes** — it never reads the table it writes (verified: the table name appears exactly
once in that workflow, inside its INSERT). So any halt row stamped `now()` is out-sorted and
silently un-paused within 15 minutes.

**This means the automated kill-switch's own trip row — 30-day expiry and all — would hold for
at most 15 minutes.** Guard #5 reading a dead assumption. The future `checked_at` on my row wins
the sort for 30 days under the current reader; `EO-06` pins the reader shape so if anyone fixes
it, the suite flags the weird row for normalisation.

## 4. TradingView cleanup — done, verified

Script `QTP_SCORE_TEST_AIS_v25_TEMP` deleted (facade returned ok; list shows the original 8
scripts, correct titles — `AIS` v16.0 untouched, `AISuper_Ensemble_Engine` restored at v9.0).
Layout `QTP SCORE TEST (temp)` (id 200549933) deleted; 18 layouts remain, temp absent.

## 5. The book that remains (runoff, protected)

At 08-12 closes (last bars staged): AES −$37 · DGX +$133 · WMB +$5 · WMT +$84 · XPEV +$571 ·
ZBRA +$53 ≈ **+$809 unrealized**. Every position has a live stop; absolute worst case if every
stop is hit from entry ≈ **−$1.2k**, less from current marks, and trails ratchet gains. These
six exits are the only remaining way to "lose money like today" — that is the stops working,
not a defect. **Flatten-now is available on your word** if you prefer zero further variance.

## 6. Open items, ranked

**Before any resumed trading (needs your word):**
1. **Repair the cumulative kill-switch leg** — point it at `public.trade_ledger` (1h). Dark since 07-14.
2. **Fix the pause-control reader/writer pair** — reader should honor any unexpired halt, or AFTO
   must carry halts forward; then normalise my future-dated row. This is what makes ANY halt durable.
3. **Guard-liveness assertion** — one scheduled check that alarms when a guard input is constant/stale
   (ADX≡0, MTF≡0, trade_log≡0, backtest cache stale, vix≡24 — five instances of one disease).

**Housekeeping (low risk, needs your word):**
4. `signal_ts` written as ET-in-UTC (562/562 rows exactly 4h off) — one-line scanner fix.
5. ARM-style pre-audit kills invisible in `exec_flow_audit` — add an audit write on the
   extreme-volatility SKIP path.
6. Kill-switch Telegram copy hardcodes “-2500” — read from gate_config.

**Moot while entries are halted (retire with the scanner, per gov 212):** MTF_CONFLUENCE on a
constant, dead PF filter (`< 0.0`), 78-day-stale backtest gate, 600/24 universe rotation,
hardcoded `vix=24`.

**Parked:** Alpaca legal-entity ticket (PO action, blocks SIP/NBBO), breakeven-ratchet backtest,
task 68 `feed=iex` removal, M3 r_multiple writer invariant.

## 7. The path back to "continue to trade" — measured, not hoped

Gov 212 killed the scanner signal on 8,289 live records. Today's Pine run found the opposite
shape on daily bars — +2.10%/5d, t=12.1, all controls passing — but I do not yet believe its
magnitude. The gate between here and trading again:

1. **OOS confirmation** (half a day): same test script, disjoint ~30 symbols from the remaining
   515, plus second-source repricing of post-2016 fills against Alpaca bars.
2. **If it survives:** design daily-timeframe execution behind the repaired guards (items 1–3),
   sized against the 0.30% cost floor, entries re-enabled by removing the halt row — one delete,
   your word.
3. **If it dies:** you have two measured KILLs and a clean shutdown decision.

No further production change was made beyond the single halt row.
