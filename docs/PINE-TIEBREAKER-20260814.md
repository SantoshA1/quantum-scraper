# The tiebreaker ran tonight, free. The Pine edge is a TradingView artifact — question CLOSED.

**Date:** 2026-08-14 ~02:00 ET · **For:** PO
**Trigger:** *"Alpaca cannot patch legal entity account. Find an alternative or use the basic plan. see if you can use TradingView"*

---

## 1. The dead ticket didn't matter — the tiebreaker needed history, not a subscription

The SIP question never required Alpaca's $1,089/yr Algo Trader Plus or the blocked legal-entity
fix. It required *historical consolidated daily bars*, which are free. Fetched tonight via a
temp n8n workflow (archived after its single run, no credentials involved): **Yahoo consolidated
dailies — 168,453 bars, 61/61 symbols, 2015-01-02 → 2026-08-13.** (Stooq was attempted first and
is rate-limited from the shared n8n egress IP today; workflow archived too.)

## 2. The three-way adjudication — same 283 trades, three price sources

| comparison | median per-trade |Δ| | correlation |
|---|---|---|
| **Yahoo vs Alpaca** (two independent real-market sources) | **23 bps** | **0.880** |
| Yahoo vs TradingView | 221 bps | 0.598 |
| Alpaca vs TradingView (yesterday) | 224 bps | 0.689 |

The two sources with no stake in the question agree with each other almost perfectly.
**TradingView's feed is the outlier by an order of magnitude.**

And the edge, per source, same trades, same convention:

| priced on | window | mean 5d excess | clustered t |
|---|---|---|---|
| TradingView | matched (2020-07+) | +1.87% | **6.31** |
| Alpaca IEX | matched | −0.03% | −0.10 |
| **Yahoo consolidated** | matched | **−0.22%** | **−0.73** |
| **Yahoo consolidated** | **all 494 post-2016 signals** | **−0.34%** | **−1.48** |

The post-2016 full-coverage run is the exact test the OOS precommit originally specified and
Alpaca's history floor prevented. On official consolidated prices the strategy is not flat —
it is slightly negative.

## 3. Final tally — four witnesses

1. Alpaca IEX repricing: no edge (t −0.10)
2. Yahoo consolidated repricing: no edge (t −1.48 over 2016→2026)
3. **Live QTP trading itself** — 272 real 5-min Pine signals at real prices: −0.55% (t −0.89)
4. TradingView bars: +1.9%, t 6.3 — alone

**Verdict: the AI Super Score edge exists only inside TradingView's single-venue feed. CLOSED.**
No further data purchase can reopen it — the consolidated data has now spoken, twice.

## 4. Direct answers to your three questions

- **"Find an alternative":** found and already used. Free consolidated dailies (Yahoo; Stooq as
  backup from a non-shared IP) settled the SIP-history question tonight and remain available for
  any future strategy validation — the harness + a temp n8n fetch is a repeatable one-hour loop.
- **"Or use the basic plan":** yes — and buy nothing. **Do not purchase Algo Trader Plus.**
  $1,089/yr buys real-time SIP, which matters only when there is a validated edge to execute at
  scale. There is not. Basic (paper + IEX real-time) fully covers the current state.
- **"Use TradingView":** it cannot make this real. The profits exist only in TV's bars, and
  orders fill at market prices, not chart prices — the live record already proved that
  (witness 3). TV stays what it is: a good authoring and charting tool, not a data authority.

## 5. Where QTP actually stands now

- **Entry halt live (gov 213)**, exits/stops untouched; six positions run off per QTP rules.
  Live pause confirmation due at the first signal ~09:30 ET.
- **Both signal sources measured dead**: Broad Scanner (gov 212, 8,289 live signals) and Pine
  (four-witness closure above). This is not a system failure — **the measurement infrastructure
  built this week is the first part of QTP that provably works**, and it just prevented real
  money from chasing a mirage twice.
- **The honest path to trading again:** a new signal idea → scored against consolidated data by
  the existing harness (days, free) → only survivors get wired to execution behind repaired
  guards (`ENTRIES-OFF-20260813.md` §6 items 1–3). The expensive lesson is already paid for;
  the loop that prevents repeating it is built, tested, and cheap.
