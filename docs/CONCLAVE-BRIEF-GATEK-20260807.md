# Conclave Brief — Gate-K total halt: what to do about it
**Date:** 2026-08-07 · **Prepared by:** claude-architect for PO (Santosh Adari)
**Status:** DECISION REQUESTED — nothing has been changed. Gate-K is untouched.
**Bears on:** governance 185 (`CERTIFIED_UNPIN_20260805`), 193, 194

---

## 1. The situation

Gate-K has stopped all trading. Verified by calling the live function, not by replay:

```
public.compute_kelly_gate(...) ->
{ "approved": false, "reason": "negative_measured_edge", "qty": 0, "risk_pct": 0,
  "metrics": { "n_trades": 42, "win_rate": 0.1667, "avg_win_r": 2.937,
               "avg_loss_r": 0.960, "kelly_star": -0.1102 } }
```

Yesterday's H4 exit-sync fix (gov 193) booked four real, already-closed trades the ledger had
been hiding. That took the certified sample **38 → 42**, crossing `p_min_trades = 40`, at which
point the gate stops using probation sizing (which always approves) and starts enforcing the
measured verdict — exactly as gov 185 intended.

**The halt is total and self-locking.** `qtp-main-pipeline` is the only strategy trading in
production, and `negative_measured_edge` returns before any sizing logic, for every symbol and
both directions. Clearing it needs ~5 more average-sized wins; the gate blocks the trades that
would produce them. No natural relief until **2026-10-15**, when the sample ages back under 40.

**The PO's question — "we can't get 5 winning trades if every signal is rejected?" — is correct.
There is no path out of this without a decision.**

Worse: the one no-intervention path makes it *worse*, not better. If all four open positions
closed at today's marks (three are winners), the verdict does not clear:

| | n | win rate | avg win R | kelly★ | breakeven WR |
|---|---|---|---|---|---|
| today | 42 | 16.67% | 2.937 | −0.1102 | 24.64% |
| all 4 open closed at current marks | 46 | 21.74% | 2.206 | **−0.1253** | 30.05% |

The three open winners are *small* (+0.51R, +0.43R, +0.56R). Adding them dilutes `avg_win_r`,
which **raises** the breakeven bar faster than the win rate improves. The formula, as applied,
punishes consistent small wins and rewards fat-tailed lottery wins.

---

## 2. Three things the Conclave did not know on 2026-08-05

Gov 185 unpinned probation so the certified verdict would take over at n ≥ 40. That ruling was
sound on the information available. Three things have surfaced since.

### 2a. The verdict is not statistically significant

| test | result |
|---|---|
| Win rate | 7/42 = 16.67% |
| Wilson 95% CI | **[8.32%, 30.60%]** — contains the 24.64% breakeven |
| Binomial P(≤7 wins \| n=42, p=breakeven) | **0.1533** — cannot reject "at least breakeven" at 5% |
| Bootstrap (20,000 resamples) | kelly★ ≤ 0 in **84.7%** — i.e. ~1 in 7 resamples says *positive* |

84.7% is a lean, not a verdict. The consequence attached to it is a permanent, unrecoverable,
total halt. **The confidence and the consequence are wildly mismatched.**

### 2b. The sample measures a system that no longer exists

| | |
|---|---|
| Trades with a recorded stop width | 40 / 42 |
| Stop width min / median / max | 1.702% / 3.238% / 5.821% |
| Trades taken at the current 1.2% clamp | **0** |
| Trades wider than the TSM's own 1.2% limit | **40 / 40 (100%)** |

Every trade in the sample was taken under the entry-stop defect fixed on 2026-08-06 (gov 190).

**Important caveat — this does NOT mean the clamp will fix the edge, and I want to correct my
own earlier framing to the PO on this point.** In-sample, trades with tighter (≤3%) stops had a
*higher* win rate (26.67%) but a *worse* kelly (−0.2785). Tightening stops also *increases*
stop-out frequency. The honest statement is that the post-fix distribution is **unknown**, not
that it is better.

### 2c. Two measurement-integrity defects — and they make the number WORSE

These are reported precisely because they cut against the case for resuming trading.

| cleaning rule (pre-registered on *provenance*, never on outcome) | n | kelly★ |
|---|---|---|
| A. as-is, what the gate sees today | 42 | −0.1102 |
| B. + exclude quarantined lineage (`RECERT_QUARANTINE_20260805`) | 41 | **−0.3429** |
| C. + exclude entries older than the 90-day window (April legacy) | 40 | **−0.5072** |

- **Quarantine leak.** The short-side leg already filters lineage (`H4_`/`RECERT_` prefixes); the
  main edge calc does not. A trade the Conclave already quarantined (LDOS, +10.2174R) is
  currently the single largest contributor to `avg_win_r`.
- **Entry-date leak.** The window filters on `exit_fill_time` only, so two positions *entered*
  in April (AFL 04-09, LDOS 04-23) leak in from a prior regime.
- **R multiples are not comparable.** Implied risk bases span **$3.60 to $623 (170×)**, median
  $97.44. AFL contributes +3.4778R on **$3.60** of actual risk ($12.52 of profit). `avg_win_r`
  is a plain average of exactly these non-comparable numbers.

**Direction of the error: cleaning the sample takes kelly★ from −0.11 to −0.51. The halt is
directionally correct. What is wrong is its permanence and its confidence, not its sign.**

---

## 3. The finding that actually matters

The strategy is **not uniformly negative**. It is one profitable book and one catastrophic book,
measured together.

| | n | win rate (95% CI) | kelly★ | realised P&L | **profit factor** |
|---|---|---|---|---|---|
| **LONGS** | 17 | 29.4% [13.3–53.1] | **+0.0014** | **+$693.92** | **1.474** |
| **SHORTS** | 25 | 8.0% [2.2–25.0] | −0.0997 | **−$2,279.73** | **0.280** |
| blended (what the gate sees) | 42 | 16.7% [8.3–30.6] | −0.1102 | −$1,585.81 | 0.658 |

Profit factor is measured in **dollars**, so it is immune to the R-comparability defect in §2c.

**Robustness** (the short-side conclusion is about as solid as n=25 permits):

| | longs | shorts |
|---|---|---|
| Jackknife — drop any single trade | PF > 1.0 in **17/17** cases (range 1.088–2.136) | PF < 1.0 in **25/25** cases (range 0.010–0.348) |
| Delete the 3 worst losses / best win | still profitable, **PF 1.088** | still losing, **PF 0.469** |
| Bootstrap P(PF > 1) | **70.9%** | **3.6%** |

**Gate-K measures edge blind to direction.** It already classifies `v_direction` and already
applies direction-specific logic (stop-out cooldown, regime filter, short-risk multiplier) — but
the edge measurement itself pools both sides. So 25 bad shorts veto 17 decent longs.

This is consistent with what the Conclave already suspected: gov 185 recorded *"week 2026-07-06
evidence: counter-regime shorts cost −485 USD realized"* and added the v2.4 short-risk
multiplier. **The data now says that multiplier was far too weak a remedy.**

---

## 4. Recommendation

### R1 — Escalate the existing short-side rule from a 0.5× multiplier to a block

The rule already exists and the Conclave already ratified it (v2.4, 2026-08-05, item 2):
release shorts when `n ≥ 20 AND PF > 1.0` on certified lineage. Queried with the gate's own
filter, verbatim:

```
short_n_certified = 25   gross_win = $887.26   gross_loss = $3,166.99
pf_certified = 0.280     meets_sample_bar = TRUE     meets_pf_bar = FALSE
```

The sample bar the Conclave set has been **met**; the PF bar has been **decisively failed**.
Change only the *consequence* — `risk × 0.5` becomes block. Same rule, same thresholds, same
release condition. Shorts are −$2,279.73 of the −$1,585.81 total; the book is profitable
without them.

### R2 — Scope the edge measurement to direction

Scope `m` in `compute_kelly_gate` to `v_direction`, using the **20** the Conclave already
ratified for the short leg (not a new number chosen to get an answer). Result:

- **SHORT** — n=25 ≥ 20 → judged → kelly★ −0.0997 → **blocked** (consistent with R1)
- **LONG** — n=17 < 20 → `probation_sizing_insufficient_sample` → **approved at 0.50% risk**

Note carefully: the long side clears because the sample is small, **not** because a positive
edge has been demonstrated. Small sample → small size is the gate's own designed conservatism,
and it is the right outcome here. This also rebuilds the sample honestly, which is the only
real exit from the deadlock.

⚠️ **R2 must not ship without R1.** Direction-scoping alone would send *both* sides to probation
(both n < 40) and quietly re-enable the catastrophic short book. This was caught in testing and
is the single most dangerous way to implement this change.

### R3 — Fix the two measurement-integrity defects (§2c)

Filter quarantined lineage out of the main edge calc (consistent with the short leg), and bound
the window on entry as well as exit. These make the measured edge **worse**, not better. They
should be fixed anyway, so that whatever the Conclave rules, it rules on honest numbers.

### Explicitly NOT recommended

| | why not |
|---|---|
| Re-pin `p_min_trades` | Reverses gov 185 without addressing why; resumes trading blind |
| Shorten `p_lookback_days` | Data torture — picking a window until it gives the wanted answer |
| Re-label the strategy to reset the sample | Indistinguishable from cherry-picking |
| "The 1.2% clamp will fix the edge" | **Not supported by the data** (§2b). I put this to the PO this morning and I was wrong to lean on it. |

---

## 5. Why this needs the Conclave

1. It **reinterprets gov 185**. That ruling deliberately let the certified verdict take over at
   n ≥ 40. It was made one day before the entry-stop defect was found and two days before the
   measurement-integrity defects. The Conclave chose to trust a measurement without knowing what
   the measurement was of. That is material new information going to the basis of the ruling.
2. **R1 changes a consequence the Conclave itself set** (v2.4 short multiplier).
3. R1+R2 together decide **which book QTP is allowed to trade** — a strategy decision, not an
   engineering one.

## 6. What is already done and needs no ruling

- **Gate-K stop parity (gov 194, shipped today).** Gate-K was screening and sizing off a raw
  uncapped 1.5×ATR stop while the order carried the 1.2% clamp — 18 good signals killed in 21
  days on a stop that would never be placed. Fixed, byte-verified, published. This is a
  correctness fix and does **not** resume trading.
- **No Gate-K change has been made.** The halt stands until the Conclave rules.

## 7. Reproducing every number here

- Live gate verdict: call `public.compute_kelly_gate` (STABLE, read-only) — see §1
- Short-side release query: §4 R1, reproduced verbatim from the function body
- Statistics, subsets, jackknife, bootstrap: `analysis/gatek_edge.py`, `cleaned.py`,
  `subsets.py`, `robust.py` (deterministic, `random.seed(20260807)`)
- The 42-row sample is embedded in the scripts exactly as the gate selects it
