# gov 239 — earnings liveness fixed, and the regime label is right for the wrong reason

**2026-08-24, 11:00 ET.** Both asks answered. The liveness gap is closed and live-verified.
The regime question has a two-part answer, and the second part is the more important
finding of the day.

---

## PART 1 — The earnings-guard liveness gap is closed (deployed, `abc392a9`)

**The hole:** the earnings guard's staleness alarm lived *inside* the nightly workflow. It
could say "the fetch came back empty," but it could never say **"that workflow stopped
running"** — if the schedule broke, the calendar would age, the entry guard would silently
resume failing open, and nothing would tell you. Same guard-can't-fire class as gov 216
(kill-switch cohort filter) and gov 231 (kill-switch case mismatch).

**The fix:** a freshness leg inside the **Dead-Man's Switch** — a workflow that runs
independently at 10:15 ET, so it survives the thing it watches.

The expectation is computed in SQL as **the most recent WEEKDAY 18:10 ET slot**, not a flat
hours threshold. That distinction is the whole point:

| rule | Monday 10:15 after a **failed** Friday run | catches it? |
|---|---|---|
| flat 72h threshold (the guard's own) | 64.7h elapsed → **under budget → "healthy"** | ✗ |
| **most-recent-weekday-slot (gov 239)** | last refresh < Friday 18:10 → **ALARM** | **✓** |

The weekend alone consumes 64 of the 72-hour budget, so the flat rule has a blind window
every Monday morning. The slot rule catches a single missed run the next morning, and the
database itself computed the counterfactual to prove it (witness fixture, `calendar_fresh:
false` when the refresh is shifted 24h earlier).

**Fail-safe, deliberately:** if the freshness probe returns *no verdict at all* — node
failed, query edited, field renamed — that is treated as **UNHEALTHY**, never as silence.
"No news" is precisely how the last three guards failed.

**Live smoke test (execution 635721), green and honest:**
> ✅ Quantum Morning Health — All Systems GO
> Signal Agent: 20 successful runs, 0 errors
> AI Super Score: 20 executions received
> **Earnings Calendar: fresh (64.8h, 1610 forward rows)**
> Railway Scraper: decommissioned (n/a)

Probe returned `expected 2026-08-21 18:10 / actual 2026-08-21 18:10` — it correctly looked
back across the weekend to Friday.

**Suite `tests/test-dms-earnings-liveness-20260824.js` — 12/12, four sabotages all biting**
(force-healthy, silent-probe-passes, unjoin-from-allHealthy, empty-calendar-passes). It
executes the real node body, proves the alarm text names the failure, the cost ("WMT lost
7.9R this way"), and the workflow to check; and proves the Signal Agent and pipeline legs
are byte-intact with `N8N_API_KEY` still read by name.

## PART 2 — Should the weekend flip have been RISK_ON or RISK_OFF?

### The label is CORRECT. RISK_OFF is right.

| | Friday 16:00 (RISK_ON) | Monday 10:30 (RISK_OFF) |
|---|---|---|
| SPY | 762.62 → 765.64 (**+0.40%**) | 765.64 → 762.87 (**−0.36%**) |
| QQQ | 710.93 → 713.41 (**+0.35%**) | 713.41 → 704.21 (**−1.29%**) |
| leadership | broad, 8 sectors up | **XLK −2.19%**, XLP **+1.54%**, XLF **+1.44%** |

Independently confirmed against the market, not just our own feed: Monday's tape is
*"S&P 500, Nasdaq slip as tech stocks sag"*. QQQ underperforming SPY by 0.93pp with tech
down hard and staples/financials bid is a textbook risk-off rotation. **The classifier
called it right, on accurate data.**

One nuance the label hides: **7 of 13 sectors are UP.** This is a *rotation*, not a broad
decline — money leaving growth for defensives. The classifier is index-directional, so it
cannot tell those apart.

### But whether it should GATE trades is now an open question — and the data leans NO

I tested the gate empirically: join every certified trade to the regime label **at its
entry moment**, then compare outcomes.

**Certified longs by regime at entry (90d):**

| regime at entry | n | wins | dollar PF | avg R | net |
|---|---|---|---|---|---|
| CHOP | 14 | 2 | 0.898 | **−0.29** | −$126 |
| **RISK_ON** (the "favorable" one) | **12** | 2 | **0.542** | **−0.829** | **−$878** |
| RISK_OFF (gate blocks these) | 1 | 0 | 0.00 | −0.357 | −$109 |

**Longs entered in the regime the gate calls favorable performed nearly 3× worse per trade
than longs entered in neutral CHOP** (−0.83R vs −0.29R), and lost seven times more money.
The regime gate is currently blocking the bucket we have almost no evidence about, while
freely passing the bucket with the worst realized record.

**Three honest caveats, none of which I'll let you skip:**

1. **The RISK_OFF row is censored — n=1 because the gate blocks them.** We cannot learn how
   RISK_OFF longs would have done from executed trades. That is the whole problem: *the
   gate destroys the evidence that would justify or refute it.*
2. **Small samples.** 12 vs 14 is directional, not decisive.
3. **Confounding.** RISK_ON stretches may cluster with particular dates and names.

Related, and it reframes the short book: **shorts entered in CHOP were the catastrophe** —
n=20, PF 0.013, **−$2,504**, essentially the entire short-side loss. RISK_ON shorts (n=4)
ran PF 0.81. The gov-219 halt is right, but the *reason* may be regime-specific rather than
"shorts don't work."

### What I recommend — and what I am NOT doing

**Not touching the regime gate.** Two-week no-touch stands, the data is censored, and
today's RISK_OFF call is genuinely protective for a momentum engine in a tech selloff. Left
alone, it is doing no harm today.

**The right move is to measure it the way E1 measured exits — E4:** the exit-grid runner
already ingests blocked cohorts and scores them against real bars. Adding
**regime-at-block** as a dimension turns "does the regime gate earn its keep?" into a table
with a PF on it, using the shadow rows we're already accruing, at zero risk. Same
pre-committed-bar discipline. That is the honest way to answer a question the live gate is
structurally incapable of answering about itself.

## Ledger

- **Deployed:** DMS liveness leg (`abc392a9`), 5 nodes, verified live green.
- **Regime verdict:** label correct (RISK_OFF); *gating* value unproven and directionally
  suspect — E4 proposed, not built.
- **D2 (WMT quarantine) still the live decision.** DGX now **+$493**; quarantine + green
  DGX close → PF ≈ 1.13.
- Queued: E4 regime-gate shadow scoring; E1 re-run tomorrow (`e1_20260825`); E3b retro.
- Standing: shorts halted, two-week no-touch on gates.
