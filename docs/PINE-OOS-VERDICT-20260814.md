# Pine OOS confirmation — the pattern replicates everywhere except in real prices. NO-GO for real money.

**Date:** 2026-08-14 01:40 ET · **For:** PO · **Rule:** precommitted in `PINE-OOS-PRECOMMIT-20260813.md` before any number existed
**Ordered by PO:** *"fix the pine issues... do not stop till ready to trade"* — this is the measurement that answers whether trading it would be honest.

---

## 0. A retraction first

Mid-run I messaged that OOS shorts "invert" (−1.46%, t = −3.8). **That was my own sign bug** —
the exporter fed direction-adjusted short returns into a formula expecting price returns. The
corrected numbers are below; shorts replicate fine. The bug also proves the pipeline gets
audited: it was caught by re-deriving every number offline from the saved ledgers.

## 1. Leg 1 — out-of-sample cross-section: PASSED

30 fresh symbols (`rn % 18 == 10`, zero overlap with the afternoon 31), same artifact, same
convention, same instrument. 912 signals, 849 day-clusters, 1970→2026:

| cohort | mean 5d excess | clustered t | gate |
|---|---|---|---|
| **ALL** | **+1.61%** | **9.58** | ≥2.47 ✔ · >0.30% ✔ |
| LONG (n=654) | +1.48% | 8.38 | |
| SHORT (n=258) | +1.90% | 5.09 | |
| oracle control | +3.67% | 29.58 | >10 ✔ |
| random control | +0.004% | 0.23 | <2 ✔ |

27/30 symbols positive, 63.8% hit rate. Versus the afternoon run (+2.10%, t 12.1): the effect
replicates on names the strategy never saw. **Within TradingView data, this is not overfitting.**

## 2. Leg 2 — second-source repricing: FAILED, decisively

Every signal from BOTH runs since 2020-07-27 (Alpaca IEX history floor; the 2016 target was
unreachable — SIP history needs the legal-entity ticket), repriced trade-for-trade on Alpaca
daily bars, identical convention (enter next open, exit open 5 sessions later), excess vs the
symbol-year mean 5-day return from the same Alpaca bars:

| | matched trades | mean excess | clustered t |
|---|---|---|---|
| **TradingView prices** (same subset) | 283 | **+1.87%** | **6.31** |
| **Alpaca prices, open-to-open** | 283 | **−0.03%** | **−0.10** |
| **Alpaca prices, close-to-close** (diagnostic) | 283 | +0.08% | 0.21 |

Per-trade agreement: median |TV − Alpaca| = **224 bps** (precommitted acceptance: < 30),
p90 = 639 bps, correlation 0.689.

**The same trades, over the same dates, carry a large edge in TradingView's bars and no edge at
all in the broker's bars — at the open and at the close.** The close-to-close diagnostic
eliminates the "IEX opens are just thin" excuse: if the move were real, it would appear in
closes; it does not.

## 3. Verdict — per the rule fixed before the run

> *"Leg 1 passes, Leg 2 fails → the effect is a data artifact of TradingView history.
> Treated as KILL for go-live purposes."*

**NO-GO for real money.** The leading explanation: AI Super Score keys on displacement bars,
gaps and volume spikes as seen in TradingView's Cboe BZX single-venue feed; in that feed the
following days look systematically favourable, in the consolidated-market-proxied broker data
they do not. A 45-year "edge" that never decays was always more consistent with a feed artifact
than with the most durable anomaly in market history — and this measurement is that suspicion
confirmed in the only era where two sources exist.

It also retro-explains the live record: the 272 real 5-minute Pine signals traded against real
prices — and measured −0.55% (t −0.89). Live trading was the third source all along, and it
agreed with Alpaca, not with TradingView.

## 4. The one honest way this verdict flips

Alpaca IEX is itself one venue (~2–3% of tape). The discriminating dataset is **SIP/consolidated
history**, which unlocks the moment the **Alpaca legal-entity support ticket** (your open action
item since the SIP/NBBO block) is resolved. The day it lands: rerun this exact repricing
(everything is staged — `quantum.scorer_pine_reprice`, `quantum.scorer_bars_oos`, the SQL in
this doc's history). If SIP agrees with TradingView, the edge revives and we re-open the door.
If SIP agrees with Alpaca — and two-of-three sources already do — the question is closed
permanently. Until then, putting real money on a pattern visible only in one chart vendor's
feed would be exactly the mistake this week was spent unwinding.

## 5. Answering your question: what is holding quality execution

Your words: *"whem you said the system is in great shape compared to other products what is
holding the Quality execution of the trades."* Precisely, in order:

1. **Signal, not execution.** The execution stack (brackets, GTC stops, trails, ledger, gates)
   works — gov 211's fix survived every overnight since. What has been missing all four months
   is a signal with real edge to execute: the scanner measured as a coin flip (gov 212), and
   Pine's edge just measured as a data artifact. No execution quality can rescue a signal that
   pays a 0.30% toll to flip a coin.
2. **Data quality — the SIP/NBBO block.** Every mark, volume ratio and now validation runs on
   2–3% of the tape. That one legal-entity ticket gates: true relative volume, honest marks,
   real slippage measurement, and the tiebreaker in §4. **This is the single highest-leverage
   unblock, and it is a PO action.**
3. **Guards that fail open.** Six now (ADX, MTF, PF filter, backtest cache, vix, cumulative
   kill-switch) plus the pause-row masking bug. Repairs are scoped in `ENTRIES-OFF-20260813.md`
   §6 — items 1–3 are the pre-conditions for whatever trades next.
4. **Timeframe/architecture mismatch.** The strategy was designed on charts and deployed on a
   5-minute webhook path where even its own vendor data shows nothing.

## 6. State as of 01:40 ET

- Entry halt live (gov 213), exits/stops untouched; six positions run off per QTP rules as you
  ordered. Live pause confirmation lands with the first signal ~09:30 ET.
- TradingView: OOS temp script and layout **deleted, verified** — your 8 scripts and 18 layouts,
  `AIS` untouched at v16.0.
- Temp ingest workflow archived immediately after its single run (security convention);
  no credential value was ever read or logged.
- New datasets kept for the SIP rerun: `scorer_bars_oos` (89,900 bars), `scorer_pine_reprice`
  (494 signals), OOS ledger in `analysis/`.

**Bottom line: QTP is operationally ready to trade and empirically forbidden to — by its own
precommitted rules, on its third independent measurement. The path to "ready with real money"
runs through the Alpaca ticket, not through more code.**
