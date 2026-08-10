> ## ⚠️ SUPERSEDED IN PART — read `docs/MEASURED-STOPWIDTH-RESULT-20260810.md` first
>
> The measurement this brief asked for was run the same day, at 1-minute resolution over all
> 41 trades. **It falsified the concern.** Zero of five winners would have been closed by the
> 1.2% stop; every winner's worst drawdown was under 0.62%. **§2–§3 below are retracted.**
>
> Worse, §2's claim that *"avg R on stops is −1.228 — worse than −1.0, meaning stops are
> overshooting"* was reading a **corrupted field**. `r_multiple` is wrong on 30 of 42 closed
> trades (all 24 stop exits), written by the `RECERT_20260805_fills` backfill. True average R
> on stop exits is **−0.537**. That defect is the real finding of this line of work.
>
> What survives: the clamp does tighten the stop from 1.13 to 0.41 ATR on 41 of 41 trades, no
> closed trade has been taken under it, and the entry cap is pinned to the TSM's 1.20%
> classifier. What does not survive is the inference that any of that is costing money.

# Conclave Brief — the stop was cut to a third of an ATR to fix a plumbing bug, and nobody checked what that does to the strategy
**Date:** 2026-08-10 · **Prepared by:** claude-architect for PO (Santosh Adari)
**Status:** DECISION REQUESTED. Nothing changed. The 1.2% clamp is live and untouched.
**Bears on:** governance 190 (entry stop clamp), 195/196/197 (the negative-edge ruling), 202/203 (today's execution fix)

---

## 1. Headline

On 2026-08-06 at 12:16 ET the entry stop was clamped to **1.2% of price**, to stop wide ATR
stops arming the TSM's recovery and producing naked windows. It fixed that. It was the right
call and I am not asking to undo it.

But measured against **consolidated ATR-14 on the actual symbols traded**, that clamp is not a
small adjustment:

| | median | range |
|---|---|---|
| consolidated ATR-14 as % of entry | **2.91%** | 1.69% – 4.97% |
| stop distance **as actually traded** (41 closed trades) | **1.13 ATR** | 0.49 – 2.22 |
| stop distance **under the 1.2% clamp** | **0.41 ATR** | 0.24 – 0.71 |
| target distance | 1.90 ATR | — |

**The clamp tightens the stop on 41 of 41 trades, by a median factor of 2.69×.**

And because Gate-K sizes by risk (`qty = risk_amount / stop_distance`), a 2.69× tighter stop is
also a **2.69× larger position** for the same dollar risk. Same dollars lost per stop-out — but
the stop now sits inside the noise, so there are far more of them.

**Zero closed trades have been taken under this configuration.** Every one of the 41 trades in
Gate-K's sample was entered at a ~1.13 ATR stop. **The edge measurement currently gating the
entire system describes a strategy configuration that no longer exists.**

---

## 2. What the 41 closed trades actually say

At the *old* stop width — 1.13 ATR, nearly 3× looser than what is live now — **24 of 41 (59%)
exited on a stop**, for −$3,496.91. Only one trade in the whole sample ever reached its target.

The interesting question is whether those stops were catching real adverse moves or ordinary
noise. Measuring price action **strictly after the exit session** (see §5 for why that
qualifier matters):

| after being stopped, did price trade back through the ENTRY price? | of 24 |
|---|---|
| within the next **1 session** | **11 (46%)** |
| within the next 3 sessions | 11 (46%) |
| within the next **5 sessions** | **16 (67%)** |
| went on to reach the **original target** within 5 sessions | **4 (17%)** |

| | loss |
|---|---|
| stops where price recovered within 3 sessions | **−$1,255.94** |
| stops where price never recovered within 5 | −$1,614.43 |

**Roughly half the stop-outs were reversed within one session, at a 1.13 ATR stop.** That is the
behaviour of a stop already sitting close to the noise floor. The live configuration puts it at
**0.41 ATR** — a third of the distance.

One more number, offered with its caveat attached: winners had a *tighter* median stop (0.78
ATR) than losers (1.17 ATR). That is survivorship, not evidence for tightening — winners are
definitionally the trades that were not stopped, so their stop width never bound.

---

## 3. Why this cuts both ways, honestly

Tightening the stop is not automatically worse, and I want the counter-argument on the record
because it is real:

- **Reward:risk improves.** Target 1.90 ATR against a 0.41 ATR stop is **4.6:1**, versus 1.68:1
  before. Each winner is worth far more R.
- **Dollar risk per stop-out is unchanged**, because sizing scales inversely with stop distance.
- A tight stop plus a trailing manager is a coherent design — you accept a low win rate and let
  the TSM harvest the runners. Notably, **every winner in this sample was harvested by the TSM
  (`manual` exits), not by the target.**

Against that:

- At 1.13 ATR the win rate was already **12%** (5 of 41), and dollar PF 0.643 — 0.899
  ex-slippage. Moving the stop to 0.41 ATR must raise the stop-out rate; the question is only
  by how much, and there is no measurement.
- The 4.6:1 ratio is nominal, not realised. **The target was hit once in 41 trades.** Improving
  a reward:risk ratio you never collect does not improve expectancy.
- Position size goes up 2.69×, so any slippage, spread or gap cost is also multiplied — on the
  very names the pre-flight showed have 5–12% quoted spreads.

**I do not know which way this nets out, and I am not going to pretend I do.** What I am
confident about is that it was never asked as a risk question. It was a side effect of a
correct plumbing fix, and it is now the largest unmeasured variable in the system.

---

## 4. What I recommend the Conclave rule on

**S1 — Rule on whether 1.2% is a risk decision or an accident.** It is currently 0.41 ATR by
arithmetic, not by intent. If the intent is "a tight stop with TSM harvesting", say so and it
becomes a deliberate design. If not, the natural alternatives are an ATR-relative floor (e.g.
`max(1.2%, 0.8 × ATR14)`) or simply a wider cap.

**S2 — Note the constraint this collides with.** The TSM classifies any protective stop wider
than 1.20% from entry as `UNPROTECTED_STOP_TOO_WIDE` and forces a 0.9% replacement. **So the
1.2% entry cap is not independently choosable — it is pinned to the TSM's classifier.** Widening
the entry stop without moving that bar would simply hand every trade to the recovery path, which
is the WST failure chain. Any ruling on S1 has to move both, together.

**S3 — Rule on the measurement, not just the parameter.** Gate-K's sample is now three distinct
regimes: (a) wide stop + market orders, (b) 1.2% stop + market orders — one closed trade, WST,
(c) 1.2% stop + capped limits — zero closed trades. The 20-trade long-book bar will be met
under (c). **Comparisons across those regimes are not apples to apples**, and R3 exists
precisely to stop that kind of mixing. E3's `exec_regime` tag now makes (c) separable in
`sizing_meta`; there is no equivalent tag for the stop regime.

**S4 — Sequencing.** My view: change nothing about the stop until the capped-limit execution fix
has produced a clean week. Two simultaneous changes to the entry path would make both
unmeasurable, which is the argument the Conclave itself made on 08-07 when it put R3 first.

---

## 5. Method, and one correction I made to my own work

Every figure comes from **consolidated daily bars** — measured today to be what Alpaca's default
feed serves on this account for historical data (`default_matches_sip` true on all 8 probed
symbols; `feed=iex` returns different, thinner bars). ATR-14 is computed over the 14 sessions
**ending the day before entry**, so it is information available at signal time.

**The correction:** my first pass measured "did price recover through the entry" including the
**exit session itself**, and reported 79% same-session recovery. That number is not sound — a
daily bar cannot say whether the session's high came before or after the stop fired, so for a
trade entered at 09:33 and stopped at 14:45 the high may well predate the stop. I re-ran with
the recovery window starting **strictly after the exit session**, which can only understate the
effect. **Every number in §2 is from the corrected pass.** The 79% figure should be disregarded.

Trades with insufficient subsequent sessions are counted `unknown`, never as a `no`; in this
sample there were none.

**What this does not measure:** intraday path. Daily bars cannot tell how *close* a trade came
to its stop before recovering, so I cannot say how many of the 17 non-stopped trades would have
been stopped at 0.41 ATR. That is the number that would settle S1, and it needs minute bars — a
day's work, and worth doing if the Conclave wants a quantitative answer rather than a judgement.

**Reproducing:** `docs/execution-fix-20260810/probe-stop-width.js`, run as a manual-trigger n8n
Code node (read-only; no orders; credentials referenced via `$vars` by name only). Trade set:
`analysis/trades_20260810.json`, pulled from `public.trade_ledger` under the same R3 filters
Gate-K uses.

---

## 6. What would change my mind

- **Toward leaving 1.2% alone:** if the capped-limit week produces a win rate at or above the
  old 12% with materially smaller losses per stop, the tight stop is working as designed and the
  R:R gain is real.
- **Toward widening urgently:** if the stop-out rate jumps above ~75% in the first clean week.
- **Toward a bigger conclusion:** if the stop-out rate is unchanged, the stop was never the
  binding constraint and the problem is signal quality — which is where gov 195/196/197 already
  pointed.
- **Evidence that would NOT move me:** any single day, and any argument from the 4.6:1 nominal
  reward:risk that does not also account for the target having been reached once in 41 trades.
