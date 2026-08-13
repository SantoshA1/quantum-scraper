# Both answers: what the scanner was for, and why the Pine strategy still can't be scored
**Date:** 2026-08-13 · **For:** PO · **Answers the two questions you picked**
**Reproduce:** `quantum.scorer_pine_raw` (new), `quantum.scorer_fwd`, `quantum.scorer_mkt`

---

## Q1 — Was the Broad Scanner meant to BE the strategy, or to reimplement the Pine logic?

**Neither. The record says it was a parallel breadth generator that became the sole source by
attrition.**

Three pieces of evidence:

1. **The scanner predates the cutover by three months.** n8n workflow `975pZZEtxeUbzI22` was
   created **2026-03-31**, with version history going back to 2026-04-01. It was not built to
   replace anything in May.
2. **Both sources ran in parallel for six weeks.** Classifying every recorded signal by whether
   it carried a real ADX (TradingView) or `'N/A'`→0 (scanner):

   | week | total signals | TradingView-sourced |
   |---|---|---|
   | 2026-04-20 | 3,819 | 289 (8%) |
   | 2026-05-04 | 4,737 | 759 (16%) |
   | **2026-05-11** | 4,747 | **2,352 (50%)** |
   | 2026-05-18 | 3,056 | 1,471 (48%) |
   | 2026-05-25 | 675 | 80 (12%) |
   | 2026-06-01 | 175 | **1** |
   | 06-08 → today | 400–750/wk | **0** |

3. **When TradingView went, volume collapsed ~85%** — from ~4,700 signals/week to 400–750 — and
   the scanner was what remained. Nothing was rebuilt to take its place.

The governance log begins 2026-05-26, after the cutover, and contains no entry describing it.
The scanner's own version history has no descriptive entries in that window either. **The intent
was never written down**; what the data shows is a decommission without a migration of the
consumers, which is exactly the orphaned-filter state documented in `SIGNAL-SOURCE-TRUTH`.

Practical consequence: `shadow_parity_promoted: true` and the `shadow_modules` array are labels
from a parity exercise, **not** a claim that the scanner reimplemented the Pine logic — it never
did, and was never built to.

## Q2 — Scoring the Pine strategy: attempted, and it cannot be concluded

Good news first: **I did not need TradingView to attempt this.** The Pine strategy's live output
is already in the database — every signal carrying a real ADX came from it. I rebuilt the scorer
at raw-signal grain (my earlier dedup to symbol/date/direction had collapsed the Pine rows
against scanner rows and left only 64) and tagged each signal by source.

**The result, same method, same controls, day-clustered:**

| cohort | days | signals | 1d | 3d | 5d | oracle control |
|---|---|---|---|---|---|---|
| **PINE / TradingView** | 23 | **272** | −0.547% (t −0.89) | +0.478% (t 0.32) | +0.261% (t 0.12) | +2.44%, **t 5.2** ✔ |
| Broad Scanner | 77 | 8,399 | +0.044% (t 0.92) | +0.019% (t 0.17) | −0.113% (t −0.91) | +1.46%, t 41.1 ✔ |

The oracle control clears t = 5.2 even on the small Pine cohort, so the instrument is still
working at that sample size. **But no verdict is possible on the Pine strategy, and here is the
reason:**

| symbol | signals | share |
|---|---|---|
| MU | 102 | 37% |
| CRWV | 91 | 33% |
| AMD | 32 | 12% |
| TSLA | 19 | 7% |
| *other 10 symbols* | 28 | 10% |

**272 signals, 14 symbols, 23 trading days — and 90% of it is four stocks over six weeks.**
That is not a test of a strategy; it is four names in one market regime. Every t-statistic is
below 1. The 1-day number is negative and the 3/5-day numbers positive, which on this
concentration is one or two large moves in MU and TSLA, not a pattern.

**This is a power failure, not a negative result.** Nothing here argues the Pine strategy works
or doesn't. It argues that TradingView alerts were only ever configured on ~14 charts, so the
strategy's live footprint is too small and too concentrated to judge.

## What it would actually take to score it

The live record is exhausted. To get a real answer you need **generated** history, not recorded
history. Two routes:

1. **TradingView-side (highest fidelity).** Convert AI Super Score Pro v2.5 to a `strategy()`
   and use TradingView's backtester, or pull `data_get_study_values` for the composite score
   across a symbol list via the bridge. Reproduces the real logic exactly — including order
   blocks, FVG and liquidity sweeps, which are the parts that don't port. Cost: slow through the
   bridge, and it needs the Mac awake; realistically a day for ~30–50 symbols.
2. **Offline reimplementation.** Rebuild the composite score against the bars already staged
   (`quantum.scorer_bars_daily`) and score it with the existing harness. Fast and repeatable,
   but the structural gates approximate rather than reproduce, so a null result would be
   ambiguous — you would not know whether you tested the strategy or your copy of it.

**Route 1 is the honest one.** Route 2 risks answering a question about the wrong artifact,
which is the exact failure mode the last four months already paid for.

## Where this leaves the picture

- The **Broad Scanner is killed** on 8,399 signals over 77 days — that verdict is solid and
  unchanged (gov 212).
- The **Pine strategy is untested**, not disproven. Its live footprint is 272 signals on 14
  symbols; the sample never existed to judge it.
- **Nothing is broken operationally** — stack green, stops alive, zero errors.

So the shutdown question narrows precisely: you are not deciding whether "QTP works." You are
deciding whether to spend one more day generating a real sample for the one component that has
never been measured — with an instrument that is already built, already validated, and now
demonstrably sensitive enough to detect an edge at n=272 if a large one were there.
