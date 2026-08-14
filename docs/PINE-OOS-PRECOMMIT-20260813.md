# PRECOMMIT — Pine daily OOS confirmation run, 2026-08-13 evening

**Written BEFORE any OOS number was computed.** PO-ordered ("fix the pine issues now").
This is the gate between the halt and re-enabled trading.

---

## What is being tested

The same artifact as this afternoon (`AI Super Score Pro v2.5 Universal`, v16.0, logic
unmodified, same two mechanical strategy edits), same daily timeframe, same 5-bar hold,
same next-open entry convention, same scorer method (signed excess vs same-symbol era-matched
baseline, day-clustered) — on a **disjoint universe the afternoon run never touched**.

## Leg 1 — out-of-sample cross-section

Universe rule, fixed now: same full-coverage pool, alphabetical row number, **rn % 18 == 10**
(the afternoon run used rn % 18 == 1; disjoint by construction):

```
ADP, AMGN, ATO, BKNG, CB, CMCSA, CRL, DDOG, DUK, EQIX, FAST, GD, GWW, HUM, IT,
KLAC, LRCX, MET, MSI, NOW, ON, PKG, Q, ROST, SOUN, TAP, TRV, UPS, WAB, XEL
```

Zero overlap with the afternoon's 31. Symbols that fail to resolve on TradingView are skipped
and reported — no substitution.

**Decision rule (identical to the afternoon precommit):** EDGE_CONFIRMED requires ALL of
mean excess > 0, day-clustered **t ≥ 2.47**, and mean excess **> 0.30%** (one-way cost).
Controls gate the run: oracle t > 10, |random t| < 2, else VOID.

## Leg 2 — second-source repricing (kills the data-artifact hole for the era that matters)

Every signal dated **≥ 2016-01-01** from BOTH runs (afternoon 31 + OOS 30) is repriced against
**Alpaca daily bars** (independent source from TradingView): entry = open of first session
after signal date, exit = open 5 sessions later, excess vs the symbol's own mean rolling 5-day
return in the same calendar year computed from the same Alpaca bars.

**Acceptance, fixed now:** (a) median |TV return − Alpaca return| < 30 bps per trade on matched
signals; (b) the Alpaca-repriced signed excess on the post-2016 subset is positive with
clustered t ≥ 2.0 (smaller subset — uncorrected bar, declared); (c) aggregate sign does not flip.

Pre-2016 signals cannot be repriced (no Alpaca history); the defence for that era remains the
decade-by-decade consistency, and this is stated as a residual limitation, not hidden.

## What the outcomes mean — committed now

- **Both legs pass → EDGE_CONFIRMED.** The ready-to-trade package is assembled (guard repairs +
  re-enable steps) and handed to the PO. Entries still do not resume without the PO removing
  the gov-213 halt.
- **Leg 1 fails →** the afternoon result was sample-specific. Two measured KILLs; shutdown
  decision is clean.
- **Leg 1 passes, Leg 2 fails →** the effect is a data artifact of TradingView history.
  Treated as KILL for go-live purposes.

No threshold, symbol, or horizon may be changed after numbers appear.
