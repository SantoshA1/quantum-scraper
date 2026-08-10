# PRE-FLIGHT RESULT — the Conclave's gate fired, and it falsified E1
**Date:** 2026-08-10 · **For:** Conclave + PO
**Status:** STOPPED AT THE GATE. E1 not shipped. E2 and E3 not shipped. Nothing changed.
**Bears on:** the 2026-08-10 execution ruling (PRE-FLIGHT → E3+E1 → E2)

---

## 1. Verdict

The Conclave made the reference-feed check a hard pre-ship gate and named two branches:

> (a) last-trade print / IEX-stale → E1 as written is correct
> (b) already NBBO/consolidated → §2 falsified, pivot to marketable-limit-with-cap

**Neither is what is actually there. There is a third branch, and it falsifies E1 as specified.**

**Measured, live, mid-session (2026-08-10 16:19Z / 12:19 ET), via a temporary probe workflow
run inside n8n so no credential value was ever read or exported:**

| symbol | IEX bid | IEX ask | **spread** | quote age | last IEX trade | **trade age** | usable as a reference? |
|---|---|---|---|---|---|---|---|
| AAPL | 305.24 | 305.28 | **0.013%** | 0s | 305.26 | 1s | ✔ |
| AES | 14.72 | 14.73 | **0.068%** | 41s | 14.725 | 152s | ✔ |
| XPEV | 12.02 | 12.03 | **0.083%** | 1s | 12.025 | 88s | ✔ |
| MSFT | 490.00 | 512.00 | **4.391%** | 1s | 510.60 | 5s | ✗ |
| ALGN | 175.34 | 184.91 | **5.313%** | 83s | 175.14 | **2,149s (36 min)** | ✗ |
| ALLE | 165.36 | 174.92 | **5.619%** | 23s | 165.56 | 163s | ✗ |
| ZBRA | 355.87 | 379.08 | **6.316%** | 2s | 378.69 | 324s | ✗ |
| WSM | 246.20 | 264.60 | **7.204%** | 6s | 251.32 | 332s | ✗ |
| WST | 339.66 | 375.08 | **9.911%** | 7s | 355.38 | **1,174s (19.6 min)** | ✗ |
| DGX | 222.39 | 250.00 | **11.689%** | 99s | 237.24 | 583s | ✗ |

Every quote and every trade carries exchange code **`V` = IEX**, both sides. A direct
`?feed=sip` request returned **`sip_available: false`** — there is no consolidated tape on this
account's data tier.

**Seven of ten symbols have unusable quotes. Every single mid-cap QTP actually trades — WST,
WSM, ZBRA, ALGN, DGX, ALLE — sits at a 5–12% spread.**

---

## 2. Why E1 as written must not ship

The ruling anticipated an IEX-only feed and judged the swap safe anyway:

> "Even if the feed is IEX-only, an IEX NBBO is a live, two-sided obligation — still strictly
> better than a stale print — so E1 is directionally correct under all plausible feed states."

**That reasoning is falsified by measurement.** Applying E1's own rule to WST's real signal:

```
signal price 353.62   vs   IEX ask 375.08   =   +6.07% apparent slip
E1 rule: |slip| > 2%  ->  REJECT
```

WST, WSM, ZBRA, ALGN, DGX and ALLE would be rejected on essentially every signal, permanently.
That is not "the guard working" — it is the guard being handed a 5–12% wide quote and halting
the strategy on noise. It would look like a working guard while being just as wrong as the one
it replaced, in the opposite direction.

**An 11.7% two-sided quote is not "strictly better" than a stale print. It is differently
useless, and more dangerous, because it fails loud and stops the book.**

---

## 3. What the evidence actually shows

The root cause is one level deeper than the brief said, and it is not fixable by choosing a
different endpoint.

**IEX does not trade these symbols often enough to price them.** WST's last IEX print was
**19.6 minutes old** at midday on an ordinary session. ALGN's was **36 minutes old**. No
endpoint on this data tier repairs that: `/trades/latest`, `/quotes/latest`, `/bars/latest` and
`/snapshot` all read the same thin venue.

This closes the last open question from the brief. The guard reported `fresh_price` **exactly
equal** to the signal price on WST (353.62) and ALGN (173.70), with `slip_pct` of exactly `0`.
That was never a coincidence and it was not the guard misreading a live number — **IEX simply
had not traded those names since before the signal fired**, so "the latest trade" was a stale
print that happened to match the equally stale scanner bar. Two stale numbers agreeing, and a
guard declaring the agreement to be freshness.

---

## 4. Where this leaves the three recommendations

| | ruling | status now |
|---|---|---|
| **E1** — swap to `/quotes/latest` | approve, ship after pre-flight | **FALSIFIED — must not ship.** The pre-flight branch the ruling wrote for this outcome is "pivot to marketable-limit orders with a hard slippage cap." |
| **E2** — anchor the entry clamp to the fill | approve, "ships regardless" | **Still valid, and now more important.** If bad fills cannot be prevented at the source, stopping them from corrupting the stop geometry is the remaining defence. |
| **E3** — mark the rebuild sample | approve, "ships regardless" | **Still valid.** Deliberately held only to avoid touching the Alpaca node twice on a money path — see §5. |

---

## 5. Why I stopped here rather than improvising

The ruling pre-authorises the pivot in principle ("marketable-limit orders with a hard slippage
cap") but does not specify its parameters, and they are consequential in ways a reference-price
swap is not:

- **cap size** — too tight and nothing fills at the open, which is where the strategy's
  signals cluster; too loose and it is the status quo with extra steps
- **unfilled-order handling** — a limit that does not fill leaves a bracket with no position.
  That is a new failure mode this pipeline has never had, and it interacts with the TSM, the
  H4 exit sync and the ledger
- **order type and TIF** — marketable limit vs limit-at-ask vs IOC each behave differently at
  the open, which is exactly the window that matters
- **it changes fill *selection*, not just fill *quality*** — the same selection-shift trap the
  ruling itself flagged against E1, now applying to its own fallback

E3 is unconditional and I could have shipped it alone. I did not, for one reason: it modifies
the same Alpaca Paper Trade node the real fix will modify. Deploying twice to a live money path
in one session doubles the deploy risk for no measurement gain — the trades E3 would tag between
now and the real fix are trades taken under the defect anyway. **Bundle E3 with whatever E1
becomes.**

---

## 6. What I recommend the Conclave rule on

1. **Ratify the falsification** and formally retire E1-as-swap.
2. **Rule on the pivot's parameters** — cap size, order type, TIF, and above all the
   unfilled-order path, which is a genuinely new failure mode.
3. **Consider the cheaper structural option first:** a paid consolidated (SIP) data
   subscription would restore a real reference price and make the original E1 correct as
   written. That is a purchasing decision, not an engineering one, and it may dominate every
   code change on this list. It should be priced before the pivot is built.
4. **E2 + E3 bundled** with whichever path is chosen.

---

## 7. Reproducing this
Temporary probe workflow `gJuKEOBoPr7BP4WL`, executed manually three times (executions 545276,
545282, 545290) and **archived immediately after** — it is not left running. It used the
existing `Alpaca-PAPER` credential and `$vars` inside n8n; no credential value was read,
logged, or exported at any point. Production workflows were not touched. The probe called
`/v2/stocks/{sym}/quotes/latest`, `/trades/latest`, and `/quotes/latest?feed=sip` for the ten
symbols above and reported only derived statistics.
