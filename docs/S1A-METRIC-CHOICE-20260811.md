# S1-a — what adopting the ≥3R count as the governing metric would achieve: nothing
**Date:** 2026-08-11 (evening) · **For:** PO and Conclave
**Answers:** the PO's question "if I change S1-a to the ≥3R count, how does it help QTP?"
**Bears on:** the 2026-08-11 Conclave ruling, gov 206, gov 207, `docs/CONCLAVE-S1-ANSWER-20260811.md`

---

## 1. The direct answer, measured

Choosing ≥3R over expectancy changes **no trade, no fill, no signal, no exit**. The 1.2% stop is
already live and both metrics agree it stays (≥3R by preference, expectancy by my S1-c
recommendation). Every dollar lands exactly where it lands today. What changes is the scoreboard —
and here is what that scoreboard does to the two stated goals, accuracy and win rate:

| stop width | win rate | ≥3R exits | expectancy R @1.67 overshoot |
|---|---|---|---|
| 0.8% | **12.2%** | 4 | −0.666 |
| 1.0% | **12.2%** | 4 | −0.564 |
| **1.2% live** | **12.2%** | **4** | **−0.436** |
| 1.7% | **12.2%** | 3 | −0.338 |
| as traded | **12.2%** | 0 | −0.214 |

**Win rate is 12.2% at every width.** The stop cannot move it: winners never retrace past 0.615%,
losers lose at any width. Win rate and accuracy live in the signal, not in this decision.

## 2. The three things adopting ≥3R would actually do

1. **Govern by a corrupted field.** The ≥3R count is denominated in `r_multiple`, wrong on 30 of
   42 closed trades under the Gate-K filters (gov 206).
2. **Install a perverse gradient.** The count holds at 4 down to 0.8% while dollar expectancy
   deteriorates to −0.666R; at 0.6% it starts killing real winners (1 of 5, harvest 5→3). A
   metric that improves while dollars worsen invites tightening for its own sake.
3. **Hide the honest number.** Re-measured with a FROZEN reference unit (R against a fixed width,
   immune to the parameter under test): at the historical 3.22% unit, **0 winners clear 3R** —
   best is 1.62R. At a 1.2% unit, 4 clear it. Same trades, same dollars. The winners' raw moves
   are 0.30%, 4.59%, 5.11%, 5.19%, 5.23% — the strategy produces ~5% moves. Whether that is
   "3R" is purely a choice of denominator.

**Recommendation (unchanged):** expectancy governs. If the Conclave keeps ≥3R as a *monitoring*
metric: fix gov 206 first, and pin the reference unit so the count can never again be moved by
the parameter it judges.

## 3. New evidence since the S1 answer: the first regime-(c) lifecycle closed

AMAT, entered 2026-08-11 10:26 ET under the capped limit, stopped out 11:24 ET. Every subsystem
did its job, and it delivered the exact number the S1 conflict was waiting for:

| | |
|---|---|
| signal 532.51 → limit 534.11 (cap) → fill 533.82 | slippage **+0.246%**, inside the 0.30% cap |
| stop re-anchored to fill (E2) | 527.68 = 1.150% of fill, inside the TSM bar |
| stopped at 527.20 | **overshoot 1.078×** |
| ledger (H4 live writer) | `r_recorded = r_true = −1.3706` — **exact** |

**Overshoot 1.078 versus the historical 1.67.** The 1.67 was measured on market-order entries
with pre-E2 stops; the first fill-anchored stop under the new regime came in near-clean. One
data point — but it is the bridge quantity: at overshoot ≈1.0 the tight stop's expectancy
penalty largely dissolves (0.8% is the *best* fixed width at clean fills), and the two metrics
stop disagreeing. If the clean week confirms low overshoot, the S1 conflict resolves itself.

Note also the risk-basis nuance now visible in a live trade: R against signal-basis risk is
−1.371, against fill-basis risk −1.078. Positive slippage widens the signal-basis loss — the
`risk_amount_at_fill` question already before the Conclave.

## 4. Escalation: the long book is ONE trade from n=20

WSM and AMAT both closed long on 08-11. **The certified long-side count is now 19 of 20.**
The next closed long trade triggers the quadrant evaluation — computed on the corrupted
`r_multiple`, where kelly★ reads −0.176 (recorded) versus +0.070 (true): probation 0.50%
versus fractional Kelly.

The error is conservative (under-sizing, never over-sizing), so nothing unsafe happens either
way — but the gate's first n=20 long-side decision will be made on a field known to be wrong
unless gov 206 M1 (recompute the 30 rows, with a correction trail) is authorized now. The M2
question — whether recomputing mid-rebuild is itself a change of basis — is the only thing
holding it.

Long-side cleaned dollar PF after the two losses: **≈1.19** (2,177.13 / 1,824.46) at n=19.
Q5 watch not triggered; the long side continues.

## 5. Status of the rest, same evening

- Cap fill rate so far: 1 fill (AMAT) of 3 capped signals — WMB and AMP were refused at the cap
  at 09:30/09:35. Far below the 72.9% projection but n=3; watch, don't act.
- Zero error statuses. Zero new forced-stop recoveries. The live writer has produced zero new
  wrong-R rows (both 08-11 exits exact).
- ATR feed shadow, 2nd session: `6/6 understate, meanDiff −7.68%, maxT1delta 0.56pp,
  clampFlips none` — the free `feed=iex` removal remains cleared for ship (task 68).
