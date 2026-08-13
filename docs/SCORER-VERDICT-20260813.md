# The signal scorer has run. The answer is KILL.
**Date:** 2026-08-13 · **For:** PO and Conclave · **Decision rules:** precommitted in `ROADMAP-20260813.md` §2, *before* any number was computed
**Evidence:** 8,289 live-recorded signals · 546 symbols · 78 trading days · 2026-04-22 → 08-12
**Reproduce:** `node tests/test-signal-scorer.js` (11/11) · `analysis/scorer-daily-ALL-20260813.json` · `quantum.scorer_signal_scores`

---

## 1. The result

Signed excess return versus the equal-weighted universe, day-clustered (Fama-MacBeth, 78 clusters):

| horizon | mean excess per signal | clustered t | verdict |
|---|---|---|---|
| 1 day | +0.096% | **1.21** | not significant |
| 3 days | +0.172% | **0.85** | not significant |
| 5 days | +0.081% | **0.36** | not significant |
| **oracle control** (knows the answer) | **+1.512%** | **26.89** | ← the instrument works |
| **random control** (coin flip) | −0.053% | −0.69 | ← indistinguishable from QTP |

**QTP's signal sits with the coin flip, not with the oracle.** Nothing clears t = 2 at any
horizon. By slice — GAP/LONG, GAP/SHORT, NONE/LONG, NONE/SHORT, MOMENTUM_SURGE — across three
horizons, that is 15 tests; the family-adjusted bar is t ≈ 2.7 and **no slice reaches even the
uncorrected 2.0** except MOMENTUM_SURGE/LONG at 3 days (t = 2.14, from 44 signals over 10 days,
and *negative* at 1 day with t = −1.70). One t = 2.14 out of 15 tests is what chance produces.
Pinned as a test so it cannot be re-litigated: `SCR-10`, `SCR-11`.

## 2. Why you can trust it — the controls came first

A measurement that cannot detect an edge that exists cannot be trusted to report its absence.
Both controls run on the *identical rows, same code path*:

- **Oracle** (direction = sign of the realised outcome): +1.51%/day, t = 26.9. The instrument
  screams when there is something to scream about.
- **Random** (direction = md5(symbol+date) parity): −0.05%, t = −0.69. It stays quiet when
  there is not.

The separation between them is a factor of ~39 in t. QTP's signal lands on the quiet side.

Three more things were done specifically to avoid fooling ourselves:

1. **No look-ahead is possible by construction.** Entry is the OPEN of the first bar *strictly
   after* the signal date — a price nobody could know when the signal was written. And unlike
   any historical backtest of an LLM, these 8,289 predictions were recorded live, before their
   outcomes existed. This is the cleanest evidence QTP will ever have.
2. **The market was subtracted.** The universe returned +0.0176%/day over the window — the same
   order of magnitude as the effects being tested. Un-neutralised, a long book in a rising tape
   looks skilled.
3. **Days were clustered, not signals.** ~106 signals land each morning and move together.
   Pooling them as 8,289 independent facts inflates t more than two-fold (pinned in `SCR-05`).
   The clustered numbers above are the honest ones.

## 3. The two follow-up questions, both answered

**Does confidence predict?** No, and it is mildly inverted. The 80–100 confidence bucket
(n = 695) returns −0.135% at 1 day; the *lowest* bucket, 30–39 (n = 1,117), is the only positive
one at +0.090%. There is no monotonic relationship anywhere in the confidence dimension.

**Does the funnel select?** No. The pipeline rejects **99.5%** of candidates — 106 generated per
day, 0.52 executed:

| cohort | n | excess 1d | excess 5d |
|---|---|---|---|
| EXECUTED (passed every filter) | 60 | +0.113% (t 0.49) | **−1.115%** (t −1.82) |
| REJECTED (killed by the funnel) | 8,229 | −0.027% (t −1.13) | −0.128% (t −2.00) |

The survivors are indistinguishable at 1 day and **worse at 5 days** than the ones thrown away.
Months of filter engineering — MTF confluence, VC scoring, bias filters, backtest enforcement,
the Grok judge — are not selecting winners from the candidate pool.

## 4. The cost sentence

Even the most favourable slice, GAP/LONG, is +0.175% per signal at 1 day (t = 1.83, not
significant). Measured one-way execution cost on this system is up to the **0.30% cap**, with
+0.246% actually observed on AMAT. **The best gross number in the entire study is smaller than
one side of the execution cost it would have to pay.** There is no version of this where the
current signal, sized and executed as it is, produces money.

## 5. Verdict against the precommitted rules

> *"No slice shows signed excess return > 0 at clustered t > 2 → **KILL**. Shut down with
> 8,820-sample evidence, not exhaustion."*

**That condition is met. The verdict is KILL — on the signal as it currently exists.**

To be precise about what has and has not been shown:

- **Shown:** the QTP signal generator, over 4 months and 8,289 live predictions, has no
  detectable ability to predict direction at 1, 3 or 5 days — and neither its confidence score
  nor its 99.5%-rejection funnel improves on that.
- **Not shown:** that no signal could ever work, or that the effort was wasted. The execution
  stack, the risk gates, the ledger integrity work, and this scorer are all reusable and were
  the things that made this answer reachable at all.

## 6. What I recommend now

1. **Stop new entries.** Not from despair — because the measurement is in, and continuing to
   place trades from a signal now demonstrated to be a coin flip only converts time and
   attention into noise. Existing positions can be managed to their stops as normal.
2. **Do not put real money in.** This was already blocked on SIP/NBBO; it is now blocked on the
   thing that actually matters.
3. **Keep, don't delete.** The 26,467-row signal log, the scorer, the risk framework, the
   governance discipline — these are the assets. Any future strategy gets tested by this harness
   *first*, in a day, before a dollar or a month is spent on it.
4. **If you want to continue building** — and that is entirely your call — the honest next
   question is not "which filter should we tune" but "is there any feature in this data with
   predictive content at all?" That is a research question the scorer can now answer cheaply:
   test candidate features against the same 8,289-row ground truth before wiring anything into
   a pipeline. Days per idea, not months.

The system worked. It told you the truth about itself. That is what it was built to do.
