# Where the losses are actually coming from — 2026-08-10
**Prepared for:** PO · **Status:** FINDINGS ONLY — nothing changed, HOLD posture intact
**Bears on:** the Conclave's 2026-08-07 negative-edge ruling (gov 195/196/197)

---

## 1. Today: the book is green, the *day* is red

Two different numbers are being compared. Both are correct; they measure different things.

| | |
|---|---|
| P&L **since entry** across all 8 open positions | **+$575.35** ← "most orders are green" |
| P&L **today** (vs Friday's close — what a dashboard shows) | **−$57.38** ← "red day" |

Nothing closed today. Two new entries (WST, WSM), zero exits, so **realized P&L today is $0** —
the entire day figure is mark-to-market movement.

| symbol | today | since entry | note |
|---|---|---|---|
| ALLE | **−$165.44** | +$31.04 | a *winner* giving back — one position = 2.9× the whole day's loss |
| DGX | **−$71.55** | +$87.30 | also a winner giving back |
| WST | **−$69.90** | −$69.90 | opened today, underwater from the fill (see §2) |
| AES | $0.00 | −$51.17 | flat |
| WSM | +$26.60 | +$26.60 | |
| ALGN | +$38.13 | +$120.48 | |
| ZBRA | +$51.80 | +$53.48 | |
| XPEV | +$132.99 | +$377.52 | |
| **net** | **−$57.38** | **+$575.35** | today's losers −$306.89 vs winners +$249.51 |

So the day isn't red because the strategy is losing broadly — it's red because the two largest
*movers* today happened to be givebacks on positions that are still profitable overall.

---

## 2. The real finding: entry slippage, and it is systemic

**WST today** is the clean example. Signal price **353.62**, filled at **360.00** — paid
**1.804% above the signal**, a **$191.40** cost on one trade at 09:33 ET.

WST is currently −$69.90. Had it filled at the signal price it would be **+$121.50**.
**Without that single fill's slippage, today is +$134.02 — green.**

### Across 48 entries in 30 days

| | |
|---|---|
| average entry slippage | **+0.2585%** (paying worse than signal) |
| total slippage cost | **$1,317.85** |
| trades over 1% slippage | 4 |
| worst | ARE +2.394% ($254.61) |

### Every one of the ten worst is in the first ten minutes of the session

Times of the top-10 slippage trades, ET: **09:36, 09:35, 09:33, 09:33, 09:40, 09:36, 09:33,
09:36, 09:36, 09:34.** Not one outside 09:33–09:40.

| entry window | n | avg slippage | total cost |
|---|---|---|---|
| **first 10 min (09:30–09:40)** | 16 | **0.6687%** | **$1,135.58** |
| 09:40–10:00 | 1 | 0.9482% | $100.48 |
| **after 10:00** | 31 | **0.0245%** | **$81.80** |

**27× worse per trade in the opening window.** The pipeline is firing market orders into the
opening auction and paying the spread for it.

---

## 3. What this does to the Conclave's edge assessment

Measured on Gate-K's *own* 42-trade sample, apples-to-apples:

| | |
|---|---|
| realized P&L | **−$1,585.81** |
| entry slippage paid | **$1,097.28** |
| P&L if every fill had been at the signal price | **−$488.53** |
| **slippage share of the total loss** | **69.2%** |

Split by window:

| window | n | realized | slippage | ex-slippage | dollar PF as-is | dollar PF ex-slippage |
|---|---|---|---|---|---|---|
| first 10 min | 13 | −$1,066.36 | $906.07 | **−$160.30** | 0.351 | **0.864** |
| after 09:40 | 29 | −$519.45 | $191.22 | −$328.23 | 0.826 | 0.884 |

**The honest reading — and the caveat matters as much as the headline:**

- Slippage is the single largest identifiable cost in the book: **$1,097 of a $1,586 loss.**
- It is overwhelmingly concentrated in the opening window: 13 trades (31% of the sample)
  produced 67% of the loss, and **85% of that window's loss is slippage**, not signal.
- **But fixing slippage alone would not make the strategy profitable.** Ex-slippage, dollar PF
  is still **0.864** and **0.884** — both under 1.0. The strategy would go from losing $1,586
  to losing $489. Better, not solved.
- The Conclave's ruling that the halt's *sign* is correct still stands on this evidence. What
  changes is the **attribution**: a large, fixable execution cost sits on top of a smaller
  genuine edge problem, and it has been contaminating every edge measurement taken so far.

**Confounder I cannot rule out from this data:** opening-window signals may be a genuinely
different (gappier, more momentum-driven) population, so not all of the difference is
execution quality. Ex-slippage PF is 0.864 vs 0.884 — nearly identical — which argues the two
populations have *similar* underlying quality and the gap really is execution. That is
suggestive, not conclusive, at n=13.

---

## 4. Secondary finding: the entry clamp is applied to the signal price, not the fill

WST's stop was set at **1.199% below the signal price** — the clamp did exactly its job on the
price it was handed. But the fill came in 1.804% higher, so the stop that actually protects
the position sits **2.950% below the fill** — 2.5× the intended cap.

| trade | slippage | stop vs signal | stop vs **fill** |
|---|---|---|---|
| ZBRA | −0.149% | 1.199% | 1.052% ✔ |
| ALGN | −0.087% | 1.200% | 1.114% ✔ |
| WSM | −0.359% | 1.200% | 0.844% ✔ |
| **WST** | **+1.804%** | 1.199% | **2.950%** ✗ |

Favourable fills tighten the realized stop; adverse fills widen it past the cap by exactly the
slippage. The clamp is only as good as the price it is anchored to.

**The TSM caught it, and this is the first adverse live test of the Friday fix.** WST's 2.95%
stop exceeded the TSM's 1.2% limit, which armed the wide-stop recovery — the same machinery
that went naked on WRB and APA on 08-06. This time:

```
14:45:08.406  CANCELED  stop 349.38
14:45:11.052  NEW       stop 356.76      <- 3 seconds later, placed successfully
15:00:02      FULLY_PROTECTED, 30/30 covered, 0 unprotected
```

Cancel → replace succeeded, no naked window. **gov 192 (Trail Stops v4.3.1) worked exactly as
designed on its first real adverse case.**

---

## 5. Options — none taken, HOLD still in force

Ordered by evidence strength, not by ease:

1. **Delay or limit-price entries in the first 10 minutes.** Highest-value, best-evidenced
   change available: the window costs 0.67% per entry vs 0.02% after 10:00. Options range from
   a hard "no market orders before 09:40" to marketable-limit orders with a slippage cap.
   *Trade-off: some fills will be missed entirely — the counterfactual "P&L at signal price"
   above assumes every trade still fills, which a limit order does not guarantee.*
2. **Anchor the entry clamp to the fill, not the signal.** Place the bracket stop after the
   fill is known, so the 1.2% cap is enforced against the price actually paid. Removes the WST
   class of over-wide stop and stops the TSM recovery being armed unnecessarily.
3. **Re-measure the edge ex-slippage** once (1) is live, so the Conclave is judging signal
   quality rather than signal quality plus a 0.26% execution tax.

**Recommendation:** these are worth doing, but not today. The gate has been live for one
session, ZBRA/ALGN/WSM are behaving, and the HOLD exists so the next measurement is clean.
(1) and (2) are also *entry-path* changes that would confound the long-book rebuild the
Conclave is currently watching. My advice is to take this to the Conclave as an execution
finding, and sequence it deliberately rather than reacting to one red day.

---

## 6. Reproducing this
All figures from `public.trade_ledger` (`intended_entry` vs `entry_fill_price`, direction-
adjusted) and `quantum.position_risk_state.raw_position_json` (Alpaca's own
`unrealized_intraday_pl` / `unrealized_pl` / `lastday_price`). No estimates, no modelled
fills — every number is a recorded price.
