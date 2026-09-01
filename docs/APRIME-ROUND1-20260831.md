# A′ round 1 — first results under the gov-246 charter (2026-08-31, late)

Three PO-authorized tests; every one pre-registered before running.

## A′-1 — Overnight vs intraday decomposition (prereg `71e7e58`) — **the map of the day**

| slice | universe (221d) | SPY |
|---|---|---|
| overnight (close→open) | **+34.0% · 13.6 bps/day · Sharpe 2.60** | +14.5% · 6.3 bps/day · Sharpe 1.81 |
| intraday (open→close) | **+0.3% · 0.4 bps/day · Sharpe 0.09** | −0.7% · −0.1 bps/day |
| full (close→close) | +34.3% (identity ✓) | +13.7% |

Paired day-block bootstrap on the universe ON−ID spread: **13.15 bps/day,
p(Δ≤0)=0.038 — the statistical gate PASSES** (first gate ever passed in the
program). The frozen economic gate FAILS exactly as pre-declared: harvesting
overnight-only costs ~10 bps/day of round trips, leaving ~3.6 bps/day net vs
15.5 bps/day for simply holding. **Verdict: mapped, statistically real, not
tradeable as daily churn.**

The corollary is the epitaph for the old design: intraday — where the retired
QTP placed entries, paid spreads, and ran tight stops — carried a Sharpe of
0.09. Essentially ALL return in this data lives overnight, which the old
machine either slept through or was stopped out of. Any future construction
must be long overnight by default; day-trading this universe fights the entire
return stream.

## A′-3 — Scoring the retired AI research thesis (prereg in `A3-PREREG`) — loop closed

40 pre-market SPY calls (07-06→08-31), frozen keyword classifier, same-session
scoring: **24 directional calls, 9 hits (37.5%)**, binomial p≈0.31 — not
significant at this n, but descriptively inverted: SPY averaged **−9 bps on
its bullish days, +12 bps on its bearish days, and +16 bps when it shrugged
NEUTRAL**. No evidence of value; idling it (gov 246c) was correct. No
graduation possible or claimed at n=40; curiosity closed.

## A′-2 — PEAD backfill LAUNCHED (`wBrXu1obTo8ws7ZS`, published `6165c2cb`)

Free-tier Alpha Vantage earnings-surprise history for the 591-symbol universe:
batches of 4, 13s pacing, six runs per evening (24 requests/day + the calendar
guard's 1 = the 25/day cap; fail-soft rate-limit handling retries tomorrow —
the mini-suite's PD-04 caught and fixed a bug where a rate-limited symbol
would have been marked done forever). First batch verified live: 4 symbols,
20 quarters incl. real surprise data. ~25 evenings to completion; a single
Telegram fires when done, then the PEAD study gets its own pre-registration.
Build note: v1 hit the ~60s Code-node runner cap (execution 699876) — pacing
now lives across scheduled runs instead of inside one node.

## Standing

The desk spends nothing on AI, trades nothing on its own, and is now quietly
accumulating the strongest-prior dataset in the literature while the PO
decides what QTP becomes next. Suites: pead 9/9. Tables:
`quantum.a1_daily_20260831`, `earnings_history`, `pead_backfill_progress`.
