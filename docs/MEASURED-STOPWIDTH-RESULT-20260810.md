# Measured: the stop is not the problem — but `r_multiple` is wrong on 30 of 42 trades
**Date:** 2026-08-10 · **For:** PO and Conclave
**Status:** FINDINGS ONLY. Nothing changed. Nothing deployed.
**Supersedes:** the stop-width concern in `docs/CONCLAVE-BRIEF-STOPWIDTH-20260810.md` §2–§3
**Method:** 1-minute bars over each trade's actual holding window, consolidated feed, 41/41 trades measured

---

## Headline

I was wrong about the stop, and finding that out exposed a real defect somewhere else.

1. **The 1.2% stop would not have killed a single winner.** Zero of five. Every winner's worst
   drawdown was under 0.62% — roughly half the stop distance. **The concern I raised this
   afternoon is not supported by the data and I am retracting it.**
2. **`r_multiple` is wrong on 30 of 42 closed trades**, including **all 24 stop exits**. The
   ledger reports the book as **2.7× worse in R terms than it actually was**. Written by one
   backfill, `RECERT_20260805_fills`. The current live writer is correct.
3. **That defect is three trades away from changing a sizing decision.** On today's long-side
   sample the corrupted R gives kelly★ **−0.176**; the true value is **+0.070**. At n=20 that
   is the difference between probation at 0.50% and fractional Kelly.

**Gate-K's halt is unaffected and still correct.** Dollar profit factor — the ratified release
metric — is computed from `net_pnl`, which is right on every row.

---

## 1. The counterfactual: would the live 1.2% stop have killed the winners?

This is the number the earlier brief said was missing. It needed minute bars; here it is.

| | |
|---|---|
| trades measured | **41 / 41** (no gaps) |
| winners | 5 |
| **winners the 1.2% stop would have killed** | **0** |
| winner P&L at risk | **$0.00** of $2,177.13 |
| trades that ever went 1.2% adverse | 11 of 41 — **all 11 were losers** |

Every winner's maximum adverse excursion:

| winner | R | worst drawdown | headroom to the 1.2% stop |
|---|---|---|---|
| RMD | +0.11 | 0.233% | 5.2× |
| ARE | +1.07 | 0.429% | 2.8× |
| WSM | +1.99 | 0.473% | 2.5× |
| ZBRA | +1.77 | 0.556% | 2.2× |
| AKAM | +1.94 | 0.615% | 2.0× |

**Not one comes close.** The winners in this strategy go right almost immediately and barely
retrace. The 1.2% stop sits at roughly 2× the worst drawdown any winner ever suffered.

**This is a positive finding about the current configuration, not a neutral one.** The stop is
well matched to how the winners actually behave. And because sizing is risk-based, the eleven
losers that *did* breach 1.2% would have been closed earlier for the same dollar loss — neutral
at worst.

**I retract the concern.** The evidence does not support widening the stop, and mildly supports
leaving it exactly where it is.

### Bias check
Bars start at the entry timestamp, so the partial bar containing the fill is **excluded**. That
understates excursions and therefore **undercounts** killed winners — it biases against the
hypothesis I was testing. The result survived a test tilted in its favour and still came back zero.

---

## 2. The tier-1 asymmetry: real in magnitude, not a problem in practice

The other half of what I set out to measure.

| | |
|---|---|
| median tier-1 threshold (`1.5 × ATR`, floored at 0.7%) | **4.36%** |
| median maximum favourable excursion | **1.01%** (0.28 ATR) |
| trades reaching tier 1 | **6 of 41 (15%)** |
| **winners reaching tier 1** | **3 of 5 (60%)** |

So the 4.36%-up-versus-1.2%-down asymmetry I flagged is arithmetically real — the median trade
travels less than a quarter of the way to the trail engaging. But it is **not costing anything**,
because the trail engages on the trades that matter: 3 of 5 winners reached it. The typical trade
never gets there because it was never going anywhere.

---

## 3. The defect this uncovered: `r_multiple` is wrong on 30 of 42 trades

Chasing a contradiction — trades marked `exit_reason='stop'` whose measured adverse excursion
never reached their recorded stop — turned this up.

`r_multiple` should be `net_pnl / risk_amount`. Both inputs are correct:
- `risk_amount` = `|intended_entry − intended_stop| × qty` — **exact on every row** (ratio 1.000)
- `net_pnl` = actual price move × qty — **exact on every row**

The quotient is not.

| exit reason | n | agree | **diverge** | avg R recorded | **avg R true** |
|---|---|---|---|---|---|
| **stop** | 24 | **0** | **24** | −1.228 | **−0.537** |
| manual | 10 | 4 | 6 | +0.339 | +0.411 |
| trail | 3 | 3 | 0 | −0.484 | −0.484 |
| time | 4 | 4 | 0 | −0.016 | −0.017 |
| target | 1 | 1 | 0 | +0.375 | +0.375 |
| **all** | **42** | **12** | **30** | **−0.648** | **−0.236** |

Worked example — ADI, 2026-07-17:

```
risk_amount   $463.12   (28 shares × $16.54 stop distance)   ✔ correct
net_pnl       −$97.25   (28 shares × $3.4732 actual move)    ✔ correct
r_multiple    −1.0276   recorded
              −0.2100   net_pnl / risk_amount
```

**4.9× too negative.** Every stop exit is like this.

### It is one writer, and it is not the live one

| writer | rows | wrong | avg drift |
|---|---|---|---|
| **`RECERT_20260805_fills`** | 36 | **30** | −0.69 on stops |
| `H4_EXIT_RESOLUTION_v2` (live) | 5 | **0** | 0.0000 |
| `backfill_symbol_time_v1` | 1 | 0 | 0.0000 |

The 08-05 recert backfill — the one whose stated job was to recompute `r_multiple` from actual
fills — got it wrong, and only for exits it classified `stop` (plus 6 `manual`). The writer that
has been live since 08-06 is correct on all five of its rows.

**I have not found the faulty formula.** I can prove the output is wrong and attribute it to that
backfill; I have not read its code and I am not going to guess at the arithmetic.

---

## 4. What this does and does not affect

### Does NOT affect: the halt. It stands.

`compute_kelly_gate` references `net_pnl` 11 times and `r_multiple` 6 times. Dollar profit
factor — the **ratified release metric** — comes from `net_pnl`, which is correct on every row.
**The negative-edge verdict and the short-side block are unaffected and remain correct.**

Short side: dollar PF **0.0101**, kelly★ −9.01 recorded vs −9.06 true. Blocked either way.

### DOES affect: kelly★, and it is three trades from mattering

The gate computes `b = avg(R | R>0)`, `a = |avg(R | R≤0)|`, then `kelly = p/a − (1−p)/b`. An
inflated `a` drives kelly★ down.

**Long side, n=17:**

| | recorded | true |
|---|---|---|
| dollar PF | 1.3648 | 1.3648 *(unaffected)* |
| avg loss, R | 0.8495 | **0.4964** |
| avg win, R | 1.6895 | 1.8945 |
| **kelly★** | **−0.1756** | **+0.0703** |

The corruption **flips the sign of kelly★ on the long book.**

Right now that changes nothing, because at n=17 the sample-size condition dominates and the
ratified table puts the long side on probation either way. But at **n = 20 — three trades away**:

| | quadrant | sizing |
|---|---|---|
| with corrupted R (kelly★ < 0) | PF>1, kelly<0, n≥20 | **probation 0.50%** |
| with true R (kelly★ > 0) | PF>1, kelly>0, n≥20 | **fractional Kelly** |

**Caveat that matters:** those three trades will move the averages too. I cannot claim the true
kelly★ stays positive — only that the two numbers currently sit on opposite sides of zero, and
that the boundary is imminent.

### The error has been conservative

Losses inflated → kelly★ too negative → sizing biased **down**. Under the ratified table kelly★
only ever downgrades sizing and never vetoes, so the worst case has been under-sizing. **Nothing
unsafe has happened because of this.** That is why it has gone unnoticed.

---

## 5. What I recommend the Conclave rule on

**M1 — Find and fix the backfill's formula, then recompute the 30 rows** with a correction trail,
before the long side reaches n=20. This is measurement integrity in exactly R3's sense: the gate
is being fed a number that does not mean what it says.

**M2 — Rule on whether recomputing mid-rebuild is itself a change of basis.** R3's principle was
"fix the measurement before ruling on it." The counter-argument is that changing R across a
sample the gate is actively accumulating is the kind of mid-flight edit R3 was written to
prevent. My view: correcting an arithmetic error is not a change of basis, it is the removal of
a defect — but it is the Conclave's call, and I would rather it be made deliberately than by
default.

**M3 — Add a ledger invariant.** `|r_multiple − net_pnl/risk_amount| < 0.01` should be asserted
by any writer that touches `r_multiple`, and checked by the divergence detector. This defect was
invisible for five days and only surfaced because a measurement contradicted it.

**M4 — Drop the stop-width question.** Measured, unsupported, retracted. Leave the 1.2% clamp.

---

## 6. Corrections to my own earlier work, on the record

Two, both in `docs/CONCLAVE-BRIEF-STOPWIDTH-20260810.md`:

1. **"avg R on stops is −1.228 — worse than −1.0, meaning the stops are being overshot."**
   That was reading the corrupted field. True average R on stop exits is **−0.537**. Stops are
   not overshooting; they close at roughly half a risk unit, consistent with the TSM tightening
   them before the original stop is reached.
2. **The implication that the 1.2% clamp is likely harmful.** Measured and falsified. §1 above.

The brief's structural observations survive: the clamp does tighten the stop from 1.13 to 0.41
ATR on 41 of 41 trades, no closed trade has yet been taken under it, and the entry cap is pinned
to the TSM's 1.20% classifier so the two can only move together. What does **not** survive is the
inference that this is costing money.

---

## 7. Reproducing

- Probe: `docs/execution-fix-20260810/probe-excursion-counterfactual.js` — read-only, manual
  trigger, consolidated feed, credentials via `$vars` by name only. Run 546937, archived.
- Spec-mirror: `lib/analysis/excursion.js` · Suite: `tests/test-excursion-counterfactual.js` (16/16)
- Per-trade output: `analysis/excursion-result-20260810.json`
- `r_multiple` divergence is reproducible directly in SQL — see `analysis/verify-r-multiple.sql`.
