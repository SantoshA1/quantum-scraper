# The Pine strategy has been scored. The rule says EDGE_FOUND. I don't believe the size of it.

**Date:** 2026-08-13 · **For:** PO and Conclave
**Decision rule:** precommitted in `PINE-SCORE-PRECOMMIT-20260813.md`, written before any number existed
**Artifact:** `AI Super Score Pro v2.5 Universal` (`USER;bb09b13b…`, v16.0), logic unmodified
**Evidence:** 934 signals · 31 symbols · 884 day-clusters · 1970-01-15 → 2026-08-04
**Reproduce:** TradingView script `QTP_SCORE_TEST_AIS_v25_TEMP` (`USER;58d9a66e…`) on the daily chart

---

## 1. The result

Signed 5-day excess return vs the symbol's own era-matched baseline, day-clustered (Fama-MacBeth):

| cohort | day-clusters | signals | mean excess | clustered t |
|---|---|---|---|---|
| **ALL signals** | 884 | 934 | **+2.10%** | **12.10** |
| LONG | 628 | 659 | +2.04% | 10.69 |
| SHORT | 265 | 275 | +2.20% | 6.05 |
| **oracle control** (knows the answer) | 884 | 934 | +3.94% | **29.70** ✔ |
| **random control** (coin flip) | 884 | 934 | −0.006% | **−0.03** ✔ |

Both controls pass their precommitted gates (oracle t > 10, |random t| < 2), so the instrument is
working on this sample and the run is valid.

Against the precommitted rule — mean > 0, **and** t ≥ 2.47, **and** mean > 0.30% execution cost —
**all three conditions are met. The rule returns EDGE_FOUND.**

## 2. It is not an artifact of concentration, outliers, or one era

Every robustness cut I could think of, run before writing this:

| cut | result |
|---|---|
| **30 of 31 symbols** individually positive | only EG (n=16) is negative |
| drop the single best symbol | +2.05%, t = 11.94 |
| drop the **top 3** symbols | +1.95%, t = 11.51 |
| winsorise every signal at ±5% | +1.38%, t = 13.52 |
| median excess (not mean) | **+1.64%** |
| directional hit rate | **68%** |
| 1970s–80s (n=261) | +1.95%, t = 6.48 |
| 1990s (n=147) | +2.29%, t = 5.34 |
| 2000s (n=149) | +2.90%, t = 5.22 |
| 2010s (n=226) | +1.56%, t = 4.99 |
| 2020s (n=151) | +2.13%, t = 5.15 |

Five decades, five independent confirmations, none weaker than t = 4.99.

## 3. The execution convention — hand-verified on real bars, not assumed

**Long, AAPL:** signal confirmed at the close of **2026-04-30** (close 271.50). Fill price
**270.55** = the **open of 2026-05-01**. Exit **285.17** = the **open of 2026-05-08**. Five
sessions, both legs at an open nobody could know when the signal was written.

**Short, DIS:** signal **2025-11-13**. Fill **108.87** = open of 2025-11-17. Cover **105.11** =
open of 2025-11-21. Price fell, the short gained — sign convention correct.

**There is no look-ahead in the fill.** I checked this by hand precisely because I did not
believe the headline number.

## 4. The placebo — half the edge lives in the first day, half does not

Identical signals, order placed **one bar later**:

| | mean excess | t | as % of oracle |
|---|---|---|---|
| baseline (enter next open, hold 5) | +2.10% | 12.10 | **53%** |
| placebo (enter a bar later, hold 4) | **+0.96%** | **6.97** | **32%** |

Delaying entry by one session removes 54% of the excess — but **+0.96% at t = 6.97 survives**,
still far above the 0.30% cost bar. *Caveat: the placebo also shortens the hold from 5 bars to 4,
so it is not a clean isolation of the delay alone. It brackets the answer rather than settling it.*

## 5. Why I am not telling you to act on this

**A strategy capturing 53% of perfect foresight, with a 68% directional hit rate, stable across
45 years, is not a credible finding.** If it were real and this durable, it would be the
best-documented anomaly in public markets. Two specific things I could not rule out:

1. **Deep-history data quality.** Daily bars back to 1970 are reconstructed and
   split/dividend-adjusted. The strategy keys on displacement bars, gaps and volume spikes —
   exactly the events where adjustment artifacts live. Verifying two fills by hand does not
   clear 45 years of reconstruction.
2. **In-sample parameter fitting.** The thresholds (72/82/90, the penalty magnitudes, the grade
   cutoffs) were tuned by somebody looking at charts. I tested the already-tuned artifact.
   *Partial defence:* the 31 symbols were picked by a mechanical stride rule and are mostly names
   QTP never traded (AKAM, MAA, MOS, RIG, SJM, TXT, VLTO…), and nobody tuned anything on 1970s
   data — so this is substantially out-of-sample in the cross-section and in time. That argues
   against fitting, but does not eliminate it.

Also not modelled: transaction costs, slippage, short borrow, and the fact that TradingView may
have silently rejected entries when capital ran out.

## 6. The finding that matters most — it is the timeframe

Same strategy, two timeframes, measured with the same instrument:

| | timeframe | signals | result |
|---|---|---|---|
| live QTP alerts (recorded) | **5-minute** | 272 | −0.55% at 1d, **t = −0.89** — nothing |
| this test | **Daily** | 934 | +2.10% at 5d, **t = 12.10** |

**AI Super Score v2.5 was wired to production on 5-minute charts, which is the one configuration
where it measures as worthless.** Whatever the true magnitude on daily bars, that contrast is the
most actionable thing this session produced.

## 7. What this does and does not change

- **Gov 212 stands, untouched.** The Broad Scanner KILL was measured on a different signal
  generator, on live-recorded signals. Nothing here rehabilitates it.
- **The §6 fork stays retracted.** This does not argue for finishing the scanner migration.
- **The shelved asset is no longer untested** — and it is the opposite of the scanner.

## 8. What I recommend now

1. **Do not restart trading on this.** One run, however clean, is not a mandate.
2. **Run the out-of-sample test that settles it — it is cheap.** Same script, a *disjoint*
   symbol set from the remaining ~515 names in `quantum.scorer_bars_daily`, and a hard split at
   a date the parameters could not have seen. If the effect holds there at anything like this
   size, it is real. Half a day.
3. **Independently reprice the fills against a second data source** (Alpaca daily, 2016+) for the
   post-2016 subset. That closes the deep-history-artifact hole for the era that matters.
4. **If both survive** — then the question becomes daily-timeframe execution, and the existing
   risk stack, Gate-K and ledger work all become relevant again rather than sunk.
5. **The `expansion_cohort_active` → 0 recommendation stands regardless.** Nothing here says
   keep trading the scanner.

## 9. Housekeeping on your TradingView account

- `AIS` (v2.5 Universal): **untouched**, v16.0.
- `AISuper_Ensemble_Engine`: I overwrote it and **restored it** from v7.0; now v9.0, verified
  byte-identical to the original 19,946-char source.
- **New, left in place for reproducibility:** script `QTP_SCORE_TEST_AIS_v25_TEMP` and layout
  `QTP SCORE TEST (temp)`. The script currently holds the **baseline** (5-bar hold) version.
  Say the word and I will delete both.
