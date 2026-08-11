# S1 answered — and the Conclave's own two metrics disagree about it
**Date:** 2026-08-11 · **For:** Conclave and PO · **Governance:** 207
**Actions the ruling ordered:** S3 SHIPPED · S2 PINNED · S4 HONOURED · S1 MEASURED
**Bears on:** the Conclave ruling of 2026-08-11, gov 190, 195/196/197, 202/203/204, 206

---

## 0. Read this first: the ruling was made on a superseded brief

The Conclave ruled on `docs/CONCLAVE-BRIEF-STOPWIDTH-20260810.md`. That brief was superseded the
same day it was written. Two things the council could not have known:

1. **The minute-bar measurement it commissions in S4.3 already ran** — probe `DBlNKVkMum20ja5o`,
   execution 546937, 41/41 trades. Its stated decisive read is already answered.
2. **`r_multiple` is corrupted on 30 of 42 closed trades** (gov 206, found 2026-08-10 after the
   brief). This matters directly to the ruling: **its kill metric is denominated in R.**

Neither changes the ruling's structure. S3, S2 and S4 are executed as written. S1 now has an
answer, and it is more interesting than either side of the argument anticipated.

---

## 1. What shipped (S3, S2, S4)

| item | status |
|---|---|
| **S4** — change nothing about the stop or the TSM classifier | **HONOURED.** Both untouched. `Trail Stops` sha `5f22eddd175bfdc3`, unchanged. |
| **S3** — `stop_regime` tag in `sizing_meta`, now | **SHIPPED**, gov 207. Additive only. |
| **S2** — entry cap ↔ TSM classifier as one coupled parameter | **PINNED** as an executable invariant, `tests/test-stop-coupling-invariant.js` (6/6). |
| **S1** — rule on the stop width | **MEASURED.** §2–§4 below. |

**S3 detail.** `Alpaca Paper Trade` v4.9.1 emits the three facts only it knows — the clamp
constant in force, whether the clamp actually bound on this trade, and the raw ATR stop distance
it overrode. `QET Ledger H3 SQL` v3 assembles `sizing_meta.stop_regime` with the label
(A/B/C), the width in **both** percent-of-signal and percent-of-fill, and an ATR normalisation
**explicitly stamped `atr_source: 'tradingview_payload'`** — because that is the ATR available at
entry and it is *not* the consolidated daily ATR-14 the analysis uses (measured: the payload ATR
runs ~74% of daily ATR-14). An unlabelled ATR field would have rebuilt the same measurement trap
under a new name. Pinned in test H3-18.

**S2 detail.** The invariant now fails a build if `MAX_ENTRY_STOP_PCT` and
`MAX_PROTECTIVE_STOP_PCT` ever diverge, if either is renamed, if the fill-anchored re-anchor
target stops sitting inside both with cent-rounding margin, or if the forced-recovery stop ever
becomes wider than the classifier that triggers it (which would make recovery re-arm itself).

---

## 2. S1 — the ruling's decisive read: the tight stop is DEFENSIBLE

The ruling set the test precisely:

> *"if 0.41 ATR stops out the winners the TSM actually harvested, the clamp is destroying the only
> exit path that ever paid — widen it. If it doesn't, the tight stop is defensible."*

**It doesn't.**

| at the live 1.2% (0.41 ATR) | |
|---|---|
| real winners stopped out | **0 of 5** |
| TSM-harvest survivors | **5** (vs 6 as-traded) |
| worst drawdown among the 5 winners | **0.615%** — the stop has 2.0× headroom on the tightest |

And the harvest floor is real but lower than feared: at **0.8%** still zero winners die; at
**0.6%** one winner dies and harvest survivors fall from 5 to 3. **The cliff is near 0.8%, not
1.2%.** The clamp sits comfortably above it.

---

## 3. S1 — but expectancy says the opposite, and it says it clearly

Realized frozen-dollar-R expectancy, which the ruling also asked for:

| stop width | stop-out rate | win rate | **expectancy R** | ≥3R exits | winners killed |
|---|---|---|---|---|---|
| 0.8% | 73.2% | 12.2% | **−0.666** | 4 | 0/5 |
| 1.0% | 43.9% | 12.2% | **−0.564** | 4 | 0/5 |
| **1.2% — LIVE** | **26.8%** | **12.2%** | **−0.436** | **4** | **0/5** |
| 1.4% | 22.0% | 12.2% | −0.381 | 4 | 0/5 |
| 1.7% | 17.1% | 12.2% | −0.338 | 3 | 0/5 |
| **as traded (3.22% median)** | **9.8%** | — | **−0.214** | **0** | **0/5** |

**The live clamp roughly doubles the loss rate per trade** — −0.436R versus −0.214R as traded —
and wider is monotonically better across the whole replayable range.

### The model, and the back-check that validates it

Sizing is risk-based, so `qty = riskDollars / (W × entry)` and therefore **R = move / W**, with a
stop-out costing −1R × overshoot. Only two measured inputs are needed: maximum adverse excursion
(does the stop fire?) and the realized signed move (if it doesn't).

**Back-check:** replayed at the widths the trades actually had, the model returns **−0.2137R**
against an independently computed truth of **−0.2134R**. It reproduces the past to 0.0003R. That
is the only reason I am willing to report the counterfactual at all, and it is pinned in test
SWP-01.

### A flaw I found in my own first pass, and fixed

My first sweep modelled every stop-out as exactly −1R. **That is wrong and it flatters tight
stops.** The four trades that really breached their stop lost **1.351R, 1.579R, 1.697R and
2.040R** — mean overshoot **1.67×** — because stops gap rather than filling at the stop price.
And the bias is asymmetric: at a 2.69× larger position the same dollar gap costs 2.69× more R.

The flat −1R version gives −0.148R as-traded, which does **not** reproduce the observed −0.213R.
The overshoot-calibrated version does. Every number in §3 uses the calibrated version, and the
full sensitivity across overshoot 1.0 / 1.3 / 1.67 / 2.0 is in
`analysis/s1-stop-sweep-20260811.json`. **The wider-is-better ordering holds at every realistic
overshoot** (SWP-15).

### Refusing to guess

Tightening is exactly replayable — the minute path up to the real exit is fully observed.
**Widening is not**, because a wider stop means the trade would not have exited when it did and
the path afterwards was never recorded. Any width above a trade's real stop returns
`NOT_REPLAYABLE`, never an estimate (SWP-07/08). The live 1.2% is replayable on **41 of 41**,
because every real stop was wider — so the question actually asked is exactly answerable.

---

## 4. The finding the council needs: its two metrics disagree

| | ≥3R exits (the ruling's kill metric) | expectancy R |
|---|---|---|
| 1.2% live | **4** | **−0.436** |
| as traded | **0** | **−0.214** |

**Tightening the stop improves the kill metric and worsens expectancy, simultaneously and
mechanically.** Because `R = move / W`, a tighter stop converts the same price move into more R.
The five winners' moves (up to 5.8%) divided by 1.2% give up to 4.36R; divided by 3.22% they give
1.8R and nothing clears 3R.

So the ruling's own instrument — *"the long book's ≥3R-exit count in frozen dollar-R must not
degrade"* — **would have flagged widening as the dangerous move**, while expectancy says
widening is the better one. That conflict is not resolvable by measuring harder; it is a
question about which metric governs. **The council has to pick.**

My reading, offered as a recommendation and not as a finding: **expectancy governs.** A ≥3R count
that rises purely because the denominator shrank is the same class of error as the 4.6:1 nominal
reward:risk the ruling already rejected — arithmetic, not edge.

---

## 5. The overarching result

**Expectancy is negative at every width tested** — from 0.8% through as-traded, at every
overshoot assumption. The best case in the entire sweep is **−0.214R**.

**No stop width makes this strategy profitable.** That is the ruling's own third precommitted
trigger, reached by measurement rather than by waiting:

> *"stop-out rate unchanged → stop was never the binding constraint, problem is signal quality
> (back to gov 195/196/197)."*

The stop is not the binding constraint. The ATR-relative floor `max(1.2%, k × ATR14)` does not
help either — k of 0.2 to 0.5 all land at −0.26 to −0.27R, no better than the flat cap (SWP-16).

**Nothing here relaxes the halt.** It removes an excuse: the stop-width hypothesis is now
measured and it does not explain the losses.

---

## 6. One thing the ruling could not account for: its kill metric is corrupted

The ruling's standing kill metric is the long book's **≥3R-exit count in frozen dollar-R**.
`r_multiple` in the ledger is wrong on **30 of 42 closed trades**, including **all 24 stop
exits** — written by `RECERT_20260805_fills` (gov 206). Recorded mean R is −0.648 against a true
−0.236.

**Every number in §3–§5 sidesteps this**: the sweep computes R from measured price paths and
never reads `r_multiple`. But any *other* R-denominated metric in the ruling — including the kill
metric as it would be computed from the ledger today — is running on a corrupted field until
gov 206 M1 is actioned. The long side is at n=17 against a bar of 20.

---

## 7. What I recommend the Conclave now rule on

**S1-a — Which metric governs stop width: expectancy or the ≥3R count?** They disagree, and the
disagreement is mechanical, not statistical. Nothing further can be measured until this is
settled. My recommendation: expectancy.

**S1-b — If expectancy governs, the evidence supports widening** toward 1.7% or beyond, coupled
atomically with the TSM classifier per S2. But note what that buys: −0.338R instead of −0.436R.
It reduces the rate of loss; it does not create an edge. **It is not worth spending the
measurement window on** while the clean week is accruing.

**S1-c — My recommendation: leave the clamp where it is and stop spending Conclave time on it.**
The decisive read says defensible, the harvest cliff is far below, and the expectancy gain from
widening is a second-order improvement to a negative number. The finding that matters is §5 — the
stop was never the binding constraint. Redirect to gov 195/196/197 and to gov 206.

**S1-d — Fix `r_multiple` (gov 206 M1) before the long side hits n=20.** Three trades away when
measured on 08-10. This is now the highest-value open item in the system.

---

## 8. Reproducing

- `lib/analysis/stop_sweep.js` — the replay arithmetic, with the overshoot sensitivity
- `tests/test-stop-sweep.js` — 18/18, including the back-check against the observed past (SWP-01)
- `tests/test-stop-coupling-invariant.js` — 6/6, the S2 invariant, reads the deployed bytes
- `tests/test-h3-exec-regime.js` — 21/21, the S3 tag, run against the deployed bytes
- `analysis/s1-stop-sweep-20260811.json` — the full sweep, all widths × all overshoots
- `analysis/excursion-rows-20260810.json` · `analysis/actual-stop-pct-20260810.json` — inputs
- Minute-bar source: probe `DBlNKVkMum20ja5o`, execution 546937 (archived), 41/41 trades
