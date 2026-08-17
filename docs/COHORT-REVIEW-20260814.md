# Gov 219 — Q5 named the wrong leg. The short side is halted.

**Date:** 2026-08-14, after the close · **Authorized:** PO ("Halt shorts, keep longs")
**Workflow:** main pipeline (`vaqfCaELhOEWnkdo`) versions `3958a638` (halt) and `d8826c29` (audit stage) published
**Verify offline:** `node tests/test-short-halt-20260814.js` (14/14) · `node tests/test-audit-writeback-20260814.js` (17/17)

---

## The finding

The Q5 revert trigger fired correctly and pointed at the wrong leg. My reconstruction of the
certified cohort lands one trade off the published figure (n=23, PF 0.9813 vs n=22, 0.9756 —
same population), so the filter is right. Split by side, since 2026-07-15:

| side | n | winners | net | dollar PF |
|---|---|---|---|---|
| **LONG** | 23 | 5 | **−$41.17** | 0.9813 |
| **SHORT** | 25 | **2** | **−$2,279.73** | **0.2802** |

The long side is flat. **The short side is essentially the entire −$3,064.22 breach that
triggered the gov-213 halt.** Q5 recommended halting the leg that lost $41 while the leg that
lost $2,280 kept running.

Cut at the 2026-07-23 universe collapse (gov 218) and it sharpens:

| era | side | n | winners | net | PF |
|---|---|---|---|---|---|
| since 07-23 | LONG | 20 | 4 | **+$482.85** | **1.290** |
| since 07-23 | SHORT | 10 | **0** | **−$1,874.03** | **0** |

Ten consecutive short losers. SPY rose **+2.33%** over the cohort window, so beta explains
roughly a tenth of the damage; the rest is signal or execution. At any plausible win rate,
2 winners in 25 sits near the 1% significance level.

**Why the long PF reads below 1.0: one trade.** SHW — entered 07-22 12:55, stop at 314.31
(−2.10%), exited 307.30 the next morning at 09:32 with `exit_reason='manual'`, −4.28%, −2.13R.
It gapped through its stop overnight. **Ex-SHW the long book is PF 1.24, +$413.** Q5's window
reaches back past the collapse to pick up that trade and two other pre-collapse ones; the 20
trades that follow are the ones the current system actually produced.

Also note *what* the 23 long trades were: **20 of them entered on or after 07-23, and every
one came from the head or tail slice the broken scanner could still see.** Zero from the blind
zone. That statistic was never a sample of the strategy — it was a sample of a broken sampler.

## The third thing, which neither report caught

**The stop is not holding.** Five of 46 closed trades exited more than 0.30% beyond their
intended stop, worst 2.23% beyond. Those five carry **−$1,896 of the −$3,189 total — 59% of
all losses from 11% of trades.** QTP holds 5.6 days on average, so every position eats
multiple overnight gaps that a stop order cannot cover. A 1.2% clamp that only binds intraday
is not a 1.2% risk limit. **PO ruling: measure it before changing sizing or hold rules.**

## What was deployed

**gov 219 — short-side halt, inside the pause guard.**

- New short entries are blocked. The check runs **after** `isClosingOrProtective()`, so
  covers, closes, stops and trailing stops on existing short positions are never blocked —
  the same ordering the gov-213 pause has already run on in production. Stranding a live
  short with no way out is the one unacceptable failure mode, and SH-06/SH-07 pin it.
- **Fail-safe:** blocked unless `QTP_SHORT_ENTRIES_ENABLED` is exactly `'true'`. Missing,
  empty, malformed, or a `$vars` object that throws on access → blocked. No variable was
  created, so the halt is live by default. Re-enable from n8n Variables; no deploy needed.
- Side detection deliberately ignores `order_intent`, because the Broad Scanner's descriptive
  `sell_short_or_close_per_downstream_state` is exactly the OR-clause the 2026-05-26 parse fix
  exists to keep out of side detection.
- Longs are byte-for-byte unchanged (SH-09), and the gov-213 entry pause still works (SH-10).
- The node's `onError` is unset (`stopWorkflow`), so the `$vars` read is `typeof`-guarded and
  wrapped — SH-13 proves it cannot throw on hostile or empty input.

**gov 217 v1.2 — the halt gets its own audit stage.** The write-back classifier tested
`_pause_guard_live_order_allowed === false` before the action string, so every gov-219 block
would have been filed as `ENTRY_PAUSE` — conflating a permanent strategy halt with a temporary
manual pause in any `blocked_stage` rollup. Now `SHORT_SIDE_HALT`, carrying the reason text.

## On the 5%/month goal

5% on this book is ~$5,250 a month, ~$250 a trading day. The cohort currently runs about
−$105/day. Nothing in the evidence supports promising that number: gov 212 still stands that
the funnel's survivors did not historically beat its rejects, and the long side's +$483 over
20 trades is *not losing*, which is not the same as an edge.

What the evidence does support, in order of expected value:

1. **Stopping the shorts** — on the last three weeks that is the difference between −$2,321
   and −$447. Done.
2. **Holding the stops** — 59% of losses came from five gap-throughs. Measure, then fix.
3. **Measuring on the repaired universe** — for the first time since 07-23, the sample will be
   drawn from 622 names instead of 25.

Those three get the book to roughly flat with the risk actually bounded. An edge worth 5% a
month is a separate problem, and it starts from a clean measurement, not from tuning gates.

## The other two recommendations in the report

- **Remove `&feed=iex` from the TSM's four bars calls** — endorsed. Four full sessions, 357
  rows, `clampFlips=none` on every row, `maxT1delta` never above 0.63pp. Ready when you are.
- **Log `cooldown_hours` on GATE_K rejections** — endorsed, cheap. Right now K3 can be
  confirmed from config and from the absence of violations, but the tag on a live rejection
  cannot be read back, so the check is inferred rather than verified.
- **No fill-rate change** — agreed, zero entry attempts today means no rate to judge.

## Ledger

- **Next build:** overnight-gap exposure measurement (PO-authorized), then the
  `REGIME_CONFLICT` shadow scorer.
- Q5's window should be reset at the gov-218 universe fix; its current sample mixes two
  different samplers and one execution failure.
- Open (MEDIUM, needs PO word): the Polygon key rides in the signal payload into n8n logs.
- Open (LOW): `MAX_NEW_ENTRIES_PER_CYCLE` breaks an alphabetically-ordered loop.
- Open (LOW): `quantum_watchlist_raw.scraped_at` is NULL on all 624 rows — no freshness signal.
