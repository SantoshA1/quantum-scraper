# My advice on the §6 fork: neither branch. And I'm retracting the question.

**Date:** 2026-08-13 · **For:** PO · **Asked:** *"What do you advise on §6 fork"*
**Refers to:** `SIGNAL-SOURCE-TRUTH-20260813.md` §6 — *"Was the Broad Scanner meant to replace
the strategy, or to reimplement it server-side?"*
**Status:** assessment only. **No production change made.** Two changes recommended in §5 need
your word.

---

## 1. The answer: neither — and the fork was the wrong question

I posed §6 as an archaeology question: *what did you intend in May?* **The decision does not
turn on what you intended.** Both branches assume you keep placing orders from the Broad
Scanner, and gov 212 already measured that signal as indistinguishable from a coin flip on
8,289 live-recorded predictions with validated controls (oracle t = 26.9, random t = −0.69).

- **"Replace" branch** → half a day repairing the ADX gate, MTF_CONFLUENCE, the PF filter, the
  stale backtest gate. That work changes *which* coin flips reach the broker. Gov 212's funnel
  test already showed the survivors were **worse at 5 days** than the candidates thrown away.
  It cannot create edge.
- **"Reimplement" branch** → a week building a server-side copy of a strategy whose live
  footprint is 272 signals, 90% in four names. **Building before measuring is the exact failure
  mode the last four months already paid for.**

Both branches spend effort downstream of a question nobody has answered.

## 2. The decomposition that dissolves the fork: recording ≠ trading

Every orphaned consumer — ADX > 20, MTF_CONFLUENCE, the PF filter, the backtest gate — gates
**execution only**. None of them affects whether a signal gets *recorded*.

So the fork only matters if you are placing orders. **Stop the orders and the whole question
becomes moot**, at zero cost to the thing that actually has value: the live-recorded signal
stream. Those 8,289 rows are the cleanest evidence QTP will ever have precisely because they
were written before their outcomes existed. Keep accruing them for free.

**Mechanism, and it is already governed:** `quantum.gate_config` →
`EXPANSION.expansion_cohort_active`, currently `1`, set by `po_flip_20260715_market_open`. It
is read by `QET Kelly SQL Build` / `QET Kelly Gate Check` in the main pipeline. Setting it to
`0` is one row, reversible, with precedent. *I have not tested the flip and I have not made it.*

## 3. What I found while checking that mechanism — the −$2,500 kill switch cannot fire

Traced end to end today:

| step | finding |
|---|---|
| guard | `QTP Expansion Kill-Switch Monitor` (`awDk3AQesvO3SpQs`), node `Evaluate Trip + Write Pause` |
| cumulative leg | `SELECT coalesce(sum(net_pnl),0) FROM quantum.v_expansion_cohort_pnl` |
| that view's P&L source | `quantum.trade_log.net_pnl` / `.notional` |
| **`quantum.trade_log`, last 90 days** | **1,403 rows · 1,402 non-null net_pnl · 0 non-zero · notional non-zero on 1 of 1,403** |
| so `cohort_cum_net` | **always 0** → `0 <= -2500` is false on every 2-minute cycle |
| real cohort P&L (`public.trade_ledger`, qtp-main-pipeline, 51 entries since 07-17) | **−$3,064.22** |

**You are $564 past your own precommitted stop line and the system never told you.** The guard
you ratified on 2026-07-14 — *"kill-switch + cumulative -2500 guards live"* — has been dark the
entire time.

Two secondary notes: the trip branch would write `EXPANSION_CUMULATIVE_HALT` with a 30-day
expiry, so it was meant to be the serious one; and `Alert On Trip Or Blind` hardcodes `-2500`
in its Telegram copy, so the alert text would not track a `gate_config` change.

**The other two legs are healthy** — day P&L reads Alpaca `/v2/account/portfolio/history`
directly (now −2.5% of equity, not a fixed −$500), and consecutive stop-outs read
`quantum.order_events`. Only the cumulative leg is dead.

## 4. The pattern — this is the actual finding

| guard | dead input |
|---|---|
| ADX > 20 confidence gate | `adx` ≡ 0 since 2026-06-08 |
| MTF_CONFLUENCE (913+ kills) | `mtf_confluence_score` ≡ 0 |
| PF filter | written `_pf < 0.0`, comment says `< 1.0` — unreachable |
| backtest enforcement | cache 78 days stale vs a 60-day limit |
| `vix < 30` term in the BUY rule | `vix` hardcoded 24 |
| **cumulative −$2,500 kill switch** | **`trade_log.net_pnl` never written** |

Six independent controls, six dead inputs, **six fail-open**. That is not six bugs. It is one
missing practice: **nothing in this system asserts that a guard's input is alive.**

That is what §6 should have asked. Not *"what did you intend"* but *"why does every control
here read a field nobody writes?"*

## 5. What I would do, in order

1. **Flip `expansion_cohort_active` → 0.** Stops new entries. One row, reversible, precedented.
   Gov 212 says those entries have no measurable edge, and you are past your own stop line.
   **Needs your word.**
2. **Leave the Broad Scanner running.** Signals keep recording; the ground-truth stream keeps
   growing; costs nothing.
3. **Let the 6 open positions run to their stops.** They are protected — gov 211 GTC stops
   verified alive at 04:00 ET today, 0 unprotected positions.
4. **Repair the cumulative kill switch anyway** — point it at `public.trade_ledger`, or fix the
   `trade_log` writer. Not because you trade tomorrow, but because a dark guard is *how you got
   here*, and whatever runs next needs it working. **Needs your word.**
5. **Then score the Pine strategy** (Route 1, TradingView-side — needs you at your desk). It is
   the only open question left with information value.
6. **Only after (5)** does the §6 fork become a real question — and then you answer it with a
   measurement instead of a memory.

## 6. What would change this advice

If one of the `shadow_modules` (`super_score_pro_v25`, `ensemble_engine_v1`,
`webhook_bridge_v8`, `quantum_scalp_v5`) actually *was* reimplemented somewhere I did not look.
I read the scanner workflow; in it they are static strings. If that is wrong, the "reimplement"
branch changes shape and I want to know.

## 7. One honesty note about the money

**Do not let the drawdown carry the argument.** Per-trade sd is $284; across ~20 exits the
1-sd band is roughly ±$1,270. −$3,064 over 51 entries is about 1.5 sd — suggestive, **not
decisive on its own.**

The evidence is the **8,289-signal null with validated controls**, not the losses. The losses
are simply what a coin flip looks like when it pays a 0.30% toll each way.

And to be precise about what "stop entries" means: it is not shutting QTP down. The execution
stack, the risk gates, the ledger integrity work, the governance discipline and the scorer all
survive and stay warm. It stops paying the toll while the one unmeasured component gets
measured.
