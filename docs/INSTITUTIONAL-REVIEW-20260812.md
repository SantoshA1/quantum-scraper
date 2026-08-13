# What a Citadel or Renaissance senior architect would say about QTP
**Date:** 2026-08-12 · **For:** PO and Conclave · **Method:** their standard first question, answered against QTP's own rows
**Contains a retraction of my own 15-day contract, written yesterday, killed today by arithmetic.**

---

## 0. The one number they would compute before saying anything else

They would not open the P&L. They would compute the **information rate per bet**:

| | |
|---|---|
| mean $ per trade (certified longs, n=20, corrected field) | **+$8.76** |
| standard deviation per trade | **$284.10** |
| **per-trade Sharpe (edge ÷ noise)** | **0.0308** |
| **observed t-statistic at n=20** | **0.14** |

**t = 0.14.** The threshold for "distinguishable from luck" is |t| > 2.

Then the follow-up, which is the sentence that reorganises this entire project:

> **At this per-trade Sharpe, you need 4,206 trades to know whether the edge is real.
> At QTP's measured rate of 0.52 trades per trading day, that is 32 years.**

Everything else below follows from that one line.

## 1. What it means — three consequences, all uncomfortable

**(a) Every conclusion drawn from the P&L so far is noise, in both directions.**
The −$2,092 is not evidence the strategy fails. The PF of 1.0889 is not evidence it works.
Bootstrap on the 20 certified longs: **PF 95% CI = [0.204, 3.054], P(PF < 1) = 46.3%.** A coin
flip. Remove the single best trade and PF falls 1.0889 → **0.8023**; remove two → **0.5205**.
The entire "positive" reading rests on two trades out of twenty.

**(b) The daily red days you are reacting to contain essentially zero information.**
One day is ~0.5 trades. At t = 0.14 over *twenty* trades, a single day's P&L is pure noise being
paid for in stress. This is the honest answer to "I can't keep losing money every day": the
daily number is not telling you anything — you have been charged emotionally for a signal that
does not exist at that resolution.

**(c) My 15-day certification contract — written yesterday — is a slot machine. I retract it.**
Simulated 100,000 times in a world with **exactly zero edge**, at the measured trade rate
(15 trading days ≈ 8 trades):

| verdict my contract would return, given NO edge whatsoever | probability |
|---|---|
| **"CONTINUE → begin real-money prep"** (PF ≥ 1.15) | **41.3%** |
| floor hit (≤ −$1,500) | 1.3% |
| ambiguous | 57.5% |

A rule that green-lights real money 4 times in 10 on a strategy with no edge is worse than no
rule — it launders noise as governance. It was well-engineered and statistically illiterate.
Kill it.

And the deeper problem: **PF ≥ 1.15 is a broken decision statistic at any reachable sample
size** on this payoff shape (20% win rate, fat right tail). The false-continue rate decays
glacially — 39% at n=20, 33% at n=60, **still 19% at n=250.** No achievable amount of paper
trading rescues that test.

## 2. What Renaissance would say: your problem is breadth, not edge

RenTec's thesis has never been big edges. It is **thousands of tiny, weakly-predictive bets**,
because the Sharpe of a strategy scales with the square root of the number of independent bets
(the fundamental law of active management: `IR ≈ IC × √breadth`).

Run QTP's *own, unchanged* per-trade edge through that law:

| trade rate | annualised Sharpe if the edge is real | time to know (t = 2) |
|---|---|---|
| **0.52/day (today)** | **0.35** | **32 years** |
| 5/day | 1.09 | 3.3 years |
| 20/day | 2.19 | **0.8 years** |

**Same signal. Same edge. Same risk per trade. The only change is how many bets you take.**
QTP is architected backwards: few, large, conviction-weighted positions (0.5% risk each, 25%
concentration cap, 7 open names) on a signal that has never earned conviction. RenTec would
say: cut position size hard, raise the number of names by 10×, and let the law of large
numbers do the work it exists to do. That change alone moves the decision from "unknowable in
your lifetime" to "answerable this year."

## 3. What Citadel would say: you have no simulator, and that is the actual bug

Their reflex on being shown this repo: **"Where is the backtest?"** Verified — there isn't one.

Every artifact in `analysis/` is a replay of *the same 41–46 executed trades*: the stop sweep,
the excursion counterfactual, the r_multiple forensics, the K3 replay, even the pending
"ratchet backtest." All excellent work, all drawing from a well containing 46 buckets of water.
**QTP has been learning exclusively by executing one trade at a time — the slowest and most
expensive learning method available.** No historical signal replay, no walk-forward, no
out-of-sample harness exists in the codebase.

Citadel's second observation would be sharper: **the signal is an LLM verdict** (`Grok AI
Analysis` → `Grok Signal Analyzer` → `QTP MTF AI Judge (Perplexity/Grok)`). That is a
structural problem, not a tuning problem — an LLM asked about a 2024 chart already knows what
happened next, so any naive historical backtest of it is contaminated by look-ahead and will
produce a beautiful, fake equity curve. This must be designed around, not discovered later.

Their third: **"Your risk system is better than your alpha, by a wide margin."** Byte-verified
deploys, fail-closed governance flags, an append-only correction trail, adversarial self-tests,
a coupling invariant that fails the build — that is genuinely institutional plumbing, better
than most retail and some funds. But weeks of engineering have gone into brakes for a car whose
engine has never been on a dyno. They would reallocate ~90% of effort to the alpha question
tomorrow morning.

## 4. What they would actually do — the plan that replaces my contract

**Stop using paper P&L as the decision instrument.** Keep trading (it is the only
*uncontaminated* out-of-sample evidence for an LLM signal — that is real and worth preserving),
but demote it: no daily verdicts, no reacting to red days, no shutdown decisions from an
8-trade window. Its verdict arrives at n ≈ 250+, and only if §5 raises the rate.

**Then, in strict priority order:**

1. **Build the simulator (Phase 0 — the highest-value item in the entire system).** Historical
   bars → replay the *deterministic* half of QTP: entries at a given price, the 1.2% clamp, the
   TSM tiers, K3, sizing, and the measured cost model we now own precisely (1.67× stop
   overshoot, the 0.30% cap, real slippage of +0.246%/−0.017%/+0.041%). This answers every exit
   and risk question in hours instead of quarters — including the ratchet, which currently waits
   on 41 trades of evidence.
2. **Separate the two questions the P&L currently conflates.** Run the execution/risk stack on
   **random entries** over the same universe and period. If random entries bleed at a similar
   rate, the problem is structural (costs, exits, gaps) and no signal will save it. If random
   bleeds much worse, the plumbing is adding value and the question is purely signal quality.
   This is the single cleanest experiment available and it needs no new alpha.
3. **Falsify the signal against baselines** — random entry, buy-and-hold, a 2-line momentum
   rule — on identical execution. A signal that cannot beat a 2-line rule is not an edge,
   whatever its narrative. (Design carefully around LLM look-ahead: prefer forward-only or
   feature-frozen tests.)
4. **Raise breadth, cut size** (§2). This is the change that makes the forward test finish.
5. **Decide on a t-statistic, never on PF or a calendar date.** Precommitted replacement gate:
   **CONTINUE if t > 1.5 over ≥ 250 trades AND the signal beats the random-entry baseline in
   simulation. SHUTDOWN if the signal loses to random-entry, or if the tail canary fires
   (harvest destroyed), or on any breach of the account drawdown halt.**

## 5. The bottom line on shutdown vs. real money

- **Real money: still no.** Unchanged and now doubly clear — the hard prerequisites (SIP data,
  NBBO guard, unresolved Alpaca account issue) are unmet, and there is no statistical basis
  whatsoever for sizing a live bet. t = 0.14.
- **Shut it all down: not supported either — but "keep grinding paper daily and watching P&L"
  is also finished.** That path was never going to answer the question; at 0.52 trades/day it
  answers in 32 years. Both of the options you framed are wrong because they share a false
  premise: that live paper P&L is the instrument that decides. It isn't. It never was.
- **The real decision in front of you is not continue-vs-shutdown. It is whether to spend the
  next two weeks building the simulator instead of trading.** That is the fork a Citadel or
  RenTec architect would put in front of the PO, and their recommendation would be unanimous:
  build it. If the simulator says the signal cannot beat random entry on its own execution
  stack, you get your shutdown answer in days, with statistical power, and months of effort
  are honourably concluded rather than abandoned in frustration. If it beats random, you have
  the first real evidence this project has ever produced — and *then* the forward test, at
  raised breadth, is worth running to completion.

**Months of effort built a genuinely institutional risk system. What it never built was the
one thing that can tell you if the strategy is real. That is the gap. It is buildable in about
two weeks, and it is the only work that changes the answer.**

## 6. Reproduce

- `analysis/sample-adequacy-20260812.js` — bootstrap CI, concentration, power, decidability
  (seeded, deterministic; run from repo root)
- Trade rate/breadth: 46 closed trades, 37 distinct symbols, 18 active entry days → 0.52
  trades per trading day
- Backtest gap: no walk-forward/out-of-sample harness exists in `lib/`, `analysis/`, or
  `tests/`; signal stage is `Grok AI Analysis` / `QTP MTF AI Judge` in `vaqfCaELhOEWnkdo`
- Superseded by this document: `docs/DECISION-CONTRACT-20260812.md` §3 (the 15-day window)
