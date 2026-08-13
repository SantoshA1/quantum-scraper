# PRECOMMIT — Pine strategy scoring run, 2026-08-13

**Written BEFORE any result was computed.** Same discipline as gov 212: the decision rule is
fixed first so the verdict cannot be reverse-engineered from the numbers.

---

## Artifact under test

`AI Super Score Pro v2.5 Universal` — TradingView script `USER;bb09b13b007c4a8193b8298a7ef67da3`,
version 16.0, 611 lines, Balanced profile (thresholds 72 / 82 / 90 BUY, 28 / 18 / 10 SELL).

**Permitted modification — mechanical only:**

1. `indicator(...)` → `strategy(...)` on line 2.
2. Append `strategy.entry()` calls fired by the **identical** conditions the production alert
   uses: `anyBuyAlert` / `anySellAlert`, inside `if barstate.isconfirmed`.

Nothing else changes. No threshold, no gate, no score component is touched. The production
script `AIS` is **not** overwritten — the strategy is saved as a separate script.

## Declared deviations from the live artifact

| | live | this test | why |
|---|---|---|---|
| timeframe | 5-minute | **Daily** | Daily yields hundreds of day-clusters instead of ~64, which is the difference between a test and another power failure. **Recorded as a limitation**: this measures the strategy's daily-bar behaviour, not its 5-minute behaviour. |
| universe | ~14 charts, 90% in 4 names | **31 symbols, deterministic stride sample** | removes the concentration that made the live cohort unjudgeable |

## Universe — fixed before running

Rule: every 18th symbol, alphabetical, among symbols with full bar coverage in
`quantum.scorer_bars_daily`. Mechanical, declared in advance, uncorrelated with returns.

```
AAPL, AKAM, APH, BAC, BX, CFG, COO, CTSH, DIS, EG, EW, FITB, GLW, HON, INTC,
JNJ, LH, MAA, MOS, NDAQ, NVTS, PCG, PPG, RIG, SJM, STX, TJX, TXT, VLTO, WMB, ZBRA
```

None of MU / CRWV / AMD / TSLA — the four names that were 90% of the live cohort — appear.
That is a consequence of the rule, not a choice.

## Method — identical to gov 212

- **Entry convention:** signal confirmed at the close of day D → position entered at the **open
  of D+1**. This is TradingView's strategy default and it matches the scorer's no-look-ahead
  construction exactly.
- **Metric:** signed excess return = `dir_sign × (own_return − equal-weight universe return)`,
  at horizons 1, 3 and 5 days.
- **Statistics:** Fama-MacBeth, day-clustered. Each trading day collapses to one observation.
- **Code:** `lib/analysis/signal_scorer.js`, unchanged, 11/11 tests green.

## Controls — the run is VOID if these fail

- **Oracle** (direction = sign of realised outcome) must return **t > 10**.
- **Random** (direction = md5(symbol+date) parity) must return **|t| < 2**.

If either fails, the instrument is not working on this sample and no verdict may be reported.

## Verdict rule — fixed now

Family size = 2 directions × 3 horizons = **6 tests**.
Family-adjusted bar = `2.0 + 0.6·log₁₀(6)` = **t ≥ 2.47**.

> **EDGE_FOUND** requires ALL THREE, in the same cohort:
> 1. mean excess return **> 0**, and
> 2. day-clustered **t ≥ 2.47**, and
> 3. mean excess **> 0.30%** — the measured one-way execution cost on this system.
>
> **Anything else is KILL.**

Condition 3 is deliberate. Gov 212's best gross slice was smaller than one side of its own
execution cost. A statistically significant edge that cannot pay the toll is not an edge.

## What each outcome means

- **EDGE_FOUND** → the shelved Pine asset is worth reconnecting, and the §6 fork becomes a real
  question answerable with data.
- **KILL** → two independent components, measured on separate samples with the same validated
  instrument, both have no usable edge. That is the shutdown answer, reached by measurement.
