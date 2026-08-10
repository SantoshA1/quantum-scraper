# Conclave Brief — QTP is paying an execution tax, and the guard meant to stop it is inverted
**Date:** 2026-08-10 · **Prepared by:** claude-architect for PO (Santosh Adari)
**Status:** DECISION REQUESTED — nothing has been changed. The gate, the entry path and the
HOLD posture are all untouched.
**Bears on:** governance 190 (entry clamp), 195/196/197 (the negative-edge ruling), 198

---

## 1. Headline

**Entry slippage is $1,288.68 of the $1,693.75 realized loss on Gate-K's own sample (now 43
trades) — 76.1%.**
It is not random cost. It is produced by a specific, identifiable defect: the pipeline's
staleness guard measures the wrong price, so it certifies stale signals as fresh.

The guard's own verdicts, against what actually happened:

| guard verdict | n | avg **actual** fill slippage | worst | trades that actually exceeded the guard's own 0.5% line | cost |
|---|---|---|---|---|---|
| **`fresh`** ("within 0.5%, safe") | **45** | **0.2687%** | **2.394%** | **7** | **$1,283.82** |
| `fresh_warn` (">0.5%, caution") | 3 | 0.1047% | 0.449% | **0** | $34.03 |

**The trades the guard flagged as risky had better fills than the ones it cleared.** A guard
whose warnings are anti-correlated with the harm it exists to prevent is not calibrated
badly — it is measuring something other than the thing that matters.

---

## 2. Mechanism

`Alpaca Paper Trade`, block `APT v4.6 TE-C3` ("Fresh-price anchoring + staleness rejection"),
re-anchors the bracket to a freshly fetched price and rejects the trade if the signal looks
stale. Thresholds: `|slip| > 2%` → REJECT, `> 0.5%` → re-anchor + warn, `≤ 0.5%` → re-anchor
silently. The intent is exactly right. The reference price is not:

```js
url: 'https://data.alpaca.markets/v2/stocks/' + ticker + '/trades/latest'
```

That is the **last trade print**, with no `feed` parameter — not the NBBO quote. Two
consequences, both visible in the data:

1. **The comparison is stale-vs-stale.** `intended_entry` in the ledger is byte-equal to the
   TradingView payload price (verified today: WSM `251.75`, WST `353.62`). At the open those
   payload prices sit within **0.13%** of the *previous close* — the scanner is firing on the
   prior bar. The guard then compares that stale number to a last-trade print that is also
   thin and stale, they agree, and the guard reports `fresh`.
2. **The order then routes to the real market.** WST today: guard verdict `fresh`, anchor
   353.62 — filled at **360.00**, **+1.804%**, a **$191.40** cost on one trade at 09:33 ET.

**Probable but not verified:** Alpaca's default data feed on free/basic plans is IEX-only
(~2% of consolidated volume), which would make the last-trade print minutes stale or an
unrepresentative odd lot at the open. That mechanism fits every observation but I cannot check
the account's data-subscription tier from here, and I am not going to assert it as fact. The
finding stands without it: whatever the feed, a guard that clears 45 trades of which 7 breach
its own threshold is not detecting staleness.

---

## 3. Scale, and where it lives

Across 48 entries in 30 days: average slippage **+0.2585%**, total cost **$1,317.85**.

Against a **1.2% clamped stop, a 0.27% entry tax consumes ~22% of the risk budget before the
position has done anything.**

Every one of the ten worst-slipped trades is between **09:33 and 09:40 ET**:

| entry window | n | avg slippage | total cost |
|---|---|---|---|
| **first 10 min (09:30–09:40)** | 16 | **0.6687%** | **$1,135.58** |
| 09:40–10:00 | 1 | 0.9482% | $100.48 |
| after 10:00 | 31 | **0.0245%** | **$81.80** |

**27× worse per trade at the open** — consistent with the mechanism in §2, because that is
exactly when the prior-bar price and the live price diverge most.

On Gate-K's own closed sample, apples-to-apples:

| | first 10 min | after 09:40 | **total** |
|---|---|---|---|
| n | 14 | 29 | 43 |
| realized | −$1,174.30 | −$519.45 | **−$1,693.75** |
| slippage paid | **$1,097.47** | $191.22 | **$1,288.68** |
| **P&L ex-slippage** | **−$76.84** | −$328.23 | **−$405.07** |
| dollar PF as-is | 0.330 | 0.826 | 0.643 |
| **dollar PF ex-slippage** | **0.935** | **0.884** | **0.899** |

14 trades — 33% of the sample — produced 69% of the loss, and **93% of that window's loss is
slippage rather than signal** (−$1,174.30 realized, of which $1,097.47 is slippage).

---

## 3b. WST closed while this brief was being written — the whole mechanism in one trade

This is not a counterfactual. Every price below is a recorded fill.

| | |
|---|---|
| signal price (TradingView payload) | **353.62** |
| guard verdict | **`fresh`** — "anchor is current, within 0.5%" |
| actual fill, 09:33 ET | **360.00** — **+1.804%**, a **$191.40** cost |
| bracket stop, set off the signal price | 349.38 = 1.199% below signal, but **2.950% below the fill** |
| TSM sees 2.95% > its 1.2% limit, arms recovery | 14:45:08 CANCEL 349.38 → 14:45:11 NEW **356.76** |
| exit, `trail` | **356.402** at 15:25:37Z |
| **net** | **−$107.94** (−0.8486R) |

**The exit price (356.402) is ABOVE the signal price (353.62).** Had the entry filled where the
signal said, this trade closes at **+$83.46**. It closed at **−$107.94**. The difference is
**$191.40 — exactly the entry slippage.** Slippage alone turned a winner into a loser.

**And it compounds.** The over-wide stop armed the TSM's wide-stop recovery, which correctly
tightened to 356.76 — but that was only **0.25%** below the then-market of 357.67. A stop that
tight is hit by ordinary noise, and it was, 40 minutes later. So the bad fill did not just cost
the entry price: it triggered a chain that force-exited the position early. **The recovery
behaved exactly as designed; it was fed a bad premise.**

Two things worth crediting, because they worked: the TSM cancel→replace completed in 3 seconds
with no naked window (gov 192's first adverse live test), and `H4_EXIT_RESOLUTION_v2` booked the
close correctly and immediately (gov 193). Neither of those would have happened a week ago.

---

## 4. What this does and does not do to gov 195/196/197

**Does not overturn it.** Ex-slippage, dollar PF is **0.935** and **0.884** — both still under
1.0, total **0.899**. Removing the entire execution tax takes the book from −$1,693.75 to
−$405.07. Better, not solved. **The Conclave's finding that the halt's sign is correct survives this brief intact,
and nothing here should be read as an argument to relax Gate-K.**

**Does change the attribution, and the confidence.** A large, fixable, systematic execution
cost has been sitting on top of a smaller genuine edge problem and contaminating every edge
measurement taken so far — including the 42-trade sample as it stood when it triggered the
total halt on 08-07 (43 now, with WST closed), and
including the long-book rebuild currently in progress.

**Confounder I cannot fully exclude:** opening-window signals may be a genuinely different
(gappier, momentum-driven) population, so not all of the difference is execution quality.
Against that: ex-slippage PF is 0.935 (open) vs 0.884 (rest) — near-identical, and the opening
window is now marginally *better* — which argues the two populations have similar underlying
quality and the gap really is execution. Suggestive, not conclusive, at n=14.

---

## 5. The sequencing problem — and why "wait" is the expensive option

On 08-07 I recommended a HOLD, and the PO accepted it, to keep the long-book rebuild's
attribution clean. That reasoning now cuts the other way and I want to be explicit that I am
arguing against my own prior advice.

The long book sits at **n=16 of the 20** it needs before Gate-K will judge it. Every trade
added between now and then is taken under the broken guard and carries the ~0.27% tax. **Waiting
does not preserve a clean measurement — it guarantees a contaminated one**, and the Conclave
will then be asked to rule on the long side using exactly the kind of data R3 was created to
eliminate.

This is the same argument the Conclave itself made on 08-07 when it moved R3 ahead of R1/R2:
fix the measurement before ruling on it. R1 below is a measurement-integrity fix in that
identical spirit, and it belongs first for the identical reason.

---

## 6. Recommendations

### E1 — Anchor the freshness guard to the NBBO quote, not a last-trade print → **ship first**
Replace `/v2/stocks/{sym}/trades/latest` with `/v2/stocks/{sym}/quotes/latest`, and compare the
signal price against the side actually being crossed — **ask for buys, bid for sells** — not a
midpoint and not a print. Keep the existing 2% / 0.5% thresholds unchanged; they were never the
problem, and changing them now would be inventing numbers to get an answer. This is a
correctness fix: it makes an existing guard measure the thing it already claims to measure.
*Expected effect: the guard starts rejecting the trades it currently waves through.* It may
reduce trade count. That is the guard working, not a regression.

### E2 — Enforce the entry clamp against the fill, not the signal → ship second
WST's stop is 1.199% below the signal but **2.950% below the actual fill**; adverse slippage
widens the realized stop past the cap by exactly the slippage. Anchor the bracket stop to the
fill price once known. This also stops the TSM's wide-stop recovery being armed unnecessarily.

| trade | slippage | stop vs signal | stop vs **fill** |
|---|---|---|---|
| ZBRA | −0.149% | 1.199% | 1.052% ✔ |
| ALGN | −0.087% | 1.200% | 1.114% ✔ |
| WSM | −0.359% | 1.200% | 0.844% ✔ |
| **WST** | **+1.804%** | 1.199% | **2.950%** ✗ |

### E3 — Mark the rebuild sample, do not silently mix regimes → ship with E1
Tag trades taken after E1 so the long-book rebuild can be measured pre- vs post-fix. Without
this the Conclave cannot tell whether a change in the long book is the fix or the strategy.
Purely additive; no behaviour change.

**Not recommended, and I want these on the record as rejected:**

| | why not |
|---|---|
| Ban trading in the first 10 minutes | Treats the symptom. If E1 works, the guard rejects genuinely stale signals at *any* hour and permits good ones at 09:31. A blanket time ban also silently discards a signal population that is marginally the BETTER of the two ex-slippage (PF 0.935 vs 0.884). |
| Widen the 0.5% / 2% thresholds | Backwards. The guard is already too permissive *in effect*; loosening it certifies more bad fills. |
| Treat "P&L at signal price" as recoverable money | **It is not.** That counterfactual assumes every trade still fills at the signal price, which a limit order does not guarantee. It measures the cost of the current method, not a refund. Any projection built on recovering the full $1,288.68 is wrong. |
| Relax Gate-K because "the edge is really fine" | Ex-slippage PF is still below 1.0 on both windows. This brief does not support resuming anything. |

---

## 7. What would change this conclusion

- **Toward E1 being wrong:** if the guard's reference price is already NBBO-based on this
  account's feed, the mechanism in §2 is wrong and the cost is genuine market impact — in which
  case the answer is marketable-limit orders with a slippage cap, not a reference-price fix.
  **This is the first thing to check and it is a one-line test.**
- **Toward doing nothing:** if post-E1 fill quality is unchanged, the tax is real market impact
  on thin names and the strategy simply cannot be traded at this size at the open.
- **Toward a bigger conclusion:** if ex-slippage PF stays below 1.0 across the rebuilt post-fix
  sample, the edge problem is genuine and independent of execution — a strategy finding, not a
  plumbing one.
- **Evidence that would NOT move me:** any single day's P&L, including today's. Today (−$57.38
  on the day, +$575.35 since entry) is the illustration that prompted this, not the evidence
  for it. The evidence is 30- and 90-day.

---

## 8. Reproducing every number here
`public.trade_ledger` — `intended_entry` vs `entry_fill_price`, direction-adjusted, with
`sizing_meta->>'anchor'` for the guard verdict. `quantum.position_risk_state.raw_position_json`
for Alpaca's own `unrealized_intraday_pl` / `unrealized_pl` / `lastday_price`. Guard logic is in
the `Alpaca Paper Trade` node, block `APT v4.6 TE-C3`. Full working:
`docs/SLIPPAGE-FINDING-20260810.md`. No modelled fills, no estimates — every figure is a
recorded price.
