# Gov 218 — QTP has not been trading a 624-name watchlist. Since 23 July it has been trading 25.

**Date:** 2026-08-14, after the close · **Authorized:** PO ("Full restore + make it self-healing")
**Workflows:** Broad Scanner (`975pZZEtxeUbzI22`) version `9763ba13` published · Guard-Liveness Sentinel (`pDzjkktLoyKkxnXE`) version `8221b4e2` published
**Verify offline:** `node tests/test-scanner-universe-20260814.js` (14/14) · `node tests/test-guard-liveness-20260814.js` (11/11)

---

## The question and the answer

> *"650+ tickers and we didn't even execute one single order."*

We never looked at 650. **Today the scanner examined 25 tickers.** It has examined only the
alphabetical head and tail of your watchlist — letters A, B and W, X, Y, Z — for **16
consecutive sessions.** 391 of 622 effective tickers, **63% of the universe, have not been
scanned once since 2026-07-23.**

The blind list is not marginal names. It is:

> **NVDA · MSFT · META · GOOGL · GOOG · TSLA · JPM · LLY · UNH · V · MA · HD · PG · JNJ ·
> NFLX · ORCL · PLTR · MU · QCOM · INTC · IBM · GE · GS · MS · KO · PEP · TMO · MRK · PFE ·
> T · VZ** — every name from `ES` through `WM`.

| era | sessions | distinct symbols signalled | head-of-list coverage | symbols from the middle of the list |
|---|---|---|---|---|
| 2026-06-30 → 07-22 | 17 | **511** | 82.0% | 323 |
| 2026-07-23 → 08-14 | 16 | **83** | 10.7% | **0** |

Same code. Same constants. No edit on either side of that line.

## The mechanism

The 2026-06-30 change raised `SCANNER_BATCH_SIZE` from 125 to 600, with this stated intent
in the deployed comment:

> *"Bulk Alpaca snapshot fetch makes full-universe scan cheap; now every name (incl rare
> MTF-passers like VRSK) is evaluated every 5min run."*

That was true while the watchlist fit inside 600. **On 2026-07-22, 85 tickers were inserted
into `quantum.quantum_watchlist_raw`,** taking the effective universe from 537 to **622**.

From the next session, `622 > 600` re-engaged the rotation cursor in workflow staticData —
but degenerately. It does not rotate through the list; it **flip-flops between two batches
forever**:

- offset 0 → `slice(0, 600)` → indices 0–599 (`A…WEA`) → next offset 600
- offset 600 → `slice(600, 622)` → **22 names** (`WMB…ZTS`) → next offset 0

So half of all scan cycles are spent on 3.5% of the universe. And in the 600-name half,
`MAX_NEW_ENTRIES_PER_CYCLE = 4` breaks the alphabetically-ordered loop as soon as it finds
four signals — which it always does inside the first ~209 names. **The deepest the scanner
has reached in 16 sessions is `ERIE`, index 208.**

A watchlist row insert — not a code change — silently cut the tradeable universe by 80%.
Nothing alarmed, because nothing asserted coverage.

**This also explains today's other finding.** Gov 217 made SSM duplicate-suppression kills
visible for the first time this afternoon, and they immediately dominated the log: WMB, XOM,
AMD, BKR, ALGN, ALB, BE, ASTS, BMNR, ZTS — over and over, every few minutes. That is the
same ~25 names being re-offered every cycle and re-killed by the 25-minute dedup window.
Two symptoms, one cause.

## What was deployed

**Scanner — the batch is now derived from the universe, never a constant the universe can outgrow.**

```js
const SCANNER_MAX_PER_CYCLE = 1000;                                  // runtime ceiling only
const SCANNER_BATCH_COUNT = Math.max(1, Math.ceil(N / SCANNER_MAX_PER_CYCLE));
const SCANNER_BATCH_SIZE  = Math.max(1, Math.ceil(N / SCANNER_BATCH_COUNT));   // EVEN batches
```

- At 622 names: one batch, **all 622 scanned every 5 minutes** — the 06-30 intent, now
  enforced by construction instead of by a number someone has to remember to raise.
- The poisoned cursor sitting in production right now (`quantumWatchlistBatchOffset = 600`)
  **clears itself on the next run.** No manual intervention.
- If the list ever outgrows one cycle it splits **evenly** — 2500 names becomes 834/834/832,
  never 1000/1000/500 and never a starved remainder. A full sweep always completes.
- Coverage is written to staticData every cycle and printed in the scan log.
- **Untouched:** `MAX_NEW_ENTRIES_PER_CYCLE`, the 25-minute dedup, and every risk constant
  (`MAX_DAILY_LOSS_PCT`, `MAX_MARGIN_PCT`, `MAX_POSITIONS`, `MAX_EXPOSURE`). Your 5-per-day
  and 8-concurrent entry caps still bind. This widens what QTP may *choose from*; it does
  not widen what QTP may *risk*.

**Sentinel — a 12th check, so this class of failure can never again go three weeks unseen.**
`scanner_universe_coverage` counts distinct symbols signalled in the last 5 days whose index
falls in the **middle 50%** of the watchlist, and ALARMs at zero during RTH. Measured
counterfactual: the healthy era 25–30 days ago reads **159**; right now it reads **0**. This
check would have fired on **2026-07-28** — twelve sessions before anyone noticed.

## Verification chain

1. Root cause reproduced from the deployed bytes: the old code, executed offline against a
   622-name list, produces exactly the observed `[600, 22]` split (SU-04, SU-05).
2. Count-asserted patch; the diff is the two intended blocks and nothing else — proven by
   reconstructing the original file byte-for-byte from the patched one (SU-02).
3. Pushed byte-exact (sha256 `7e453413…` verified on the deployed node), exactly 1 node
   changed, connections and node count unchanged, then published.
4. Maya suite 14/14 — the real bytes are *executed*: full coverage at 622, the live poisoned
   cursor self-heals, ten consecutive cycles all scan 100%, even splits at 1001 and 2500, and
   no starved batch at any size from 1 to 3000.
5. Sentinel published and fired once (`gls-20260814211720`): 12 checks, `0 of 622`, `OK`
   — RTH-gated, so it stays quiet over the weekend.

## What to expect Monday

- **09:30–09:45 ET: one ALARM from the sentinel is expected and correct.** Its 5-day lookback
  still contains only the broken era. It should clear within a cycle or two as the repaired
  scanner emits its first mid-universe signals. **If it does not clear by ~10:15, the fix did
  not take** — that is exactly the signal it exists to give.
- Signal volume should rise materially — the funnel goes from ~25 candidates/day to a 622-name
  universe. Entries stay capped at 5/day, 8 concurrent, so exposure does not change.
- The duplicate-suppression flood in `exec_flow_audit` should fall sharply, because the scanner
  will stop re-offering the same two dozen names every cycle.

## Today's second finding, for the record

Marked to today's close at the real $10,655 average position size, with the real 1.2% stop,
**every candidate the gates killed today would have been +$609** — while the book made +$30.
But under QTP's own 5-per-day cap the first five signals of the day (WRB, WMB, WSM, WRD, AMP —
all pre-lift `ENTRY_PAUSE` kills) come to **−$228**. So the gates did not cost money today
under the rules as written.

One kill does deserve naming. **AMD LONG at 09:45, killed by `REGIME_CONFLICT`, closed +3.17%
(+$338) — the single best trade of the day.** In `FUNNEL-20260814.md` this morning I wrote that
this filter had *"earned its kill"* on that exact name, citing its options-flow and dark-pool
evidence. The close says otherwise. That claim was wrong, and n=1 does not overturn the filter
either — which is why the PO's instruction is to shadow-measure `REGIME_CONFLICT` over the real
~5.6-day holding period for 3–4 weeks before touching it. **That measurement harness is the
next build.** No data is lost by starting it Monday: the kills are already in `exec_flow_audit`
with timestamps, and prices can be fetched retroactively.

## Ledger

- **Next build:** the `REGIME_CONFLICT` shadow scorer — score every kill at +5.6 days against
  consolidated prices, market-neutralised, for 3–4 weeks. PO-authorized.
- **Open (MEDIUM, needs PO word):** the Polygon API key rides in the signal payload
  (`_polygon_key`) into n8n execution logs. Verified not persisted to Supabase. ~15 min.
- **Open (LOW):** `MAX_NEW_ENTRIES_PER_CYCLE = 4` breaks an alphabetically-ordered loop, so
  within any batch the head is systematically favoured. Harmless at 1 batch of 622 with 78
  cycles a day, but it is a real ordering bias and worth ranking-before-truncating later.
- **Open (LOW):** `quantum.quantum_watchlist_raw.scraped_at` is NULL on all 624 rows — the
  watchlist has no freshness signal at all.
