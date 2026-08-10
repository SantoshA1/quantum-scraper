# Execution fix — shipped, tested, live
**Date:** 2026-08-10 · **For:** PO and Conclave · **Governance:** 202
**Ruling actioned:** the 2026-08-10 Conclave ruling, items 1–4
**Live as of:** 13:12 ET · workflow `vaqfCaELhOEWnkdo` version `c3fe82bf-9d2d-4e96-9869-adbfdceb0d5d`
· node `Alpaca Paper Trade` sha256 `1bd58032497568d2…` (55,102 bytes)

---

## The short version

QTP was paying **$1,288.68 of a $1,693.75 realized loss** in entry slippage — 76.1% — and the
guard meant to prevent it was measuring a price that does not exist on this account's data
feed. The Conclave's approved fix was falsified before shipping. The fallback it had
pre-authorised is now live: **QTP no longer sends market orders.** Every entry is a limit
order that will not pay more than **0.30%** above the signal price, and the protective stop is
now anchored to the price actually paid rather than the price we hoped for.

All four items are closed. **Item 3 is the one thing I cannot close for you** — it is a $99/month
purchase and it is yours to make.

---

## Item 1 — the falsification is ratified; E1-as-swap is retired

**Retired.** The pre-flight (gov 201) measured this account's feed: `sip_available: false`,
every quote and print stamped exchange `V` = IEX, and **7 of 10 probed symbols unusable** —
including every mid-cap QTP actually trades, at 5–12% spreads with last prints up to 36 minutes
old. Swapping `/trades/latest` for `/quotes/latest` would have replaced a guard that waved
everything through with one that rejected WST, WSM, ZBRA, ALGN, DGX and ALLE on essentially
every signal, permanently, on noise.

The old block is not deleted — it is **demoted to telemetry**. It still records
`alpaca_fresh_price` and `alpaca_slip_pct` (the slippage analysis reads those columns), but it
no longer moves the price the order is built from and no longer rejects anything. Its verdict
label changed from `fresh` / `fresh_warn` to `signal_capped` / `signal_capped_warn`, so no one
reading the ledger next month mistakes a telemetry note for a safety verdict.

---

## Item 2 — the pivot's parameters

### Cap: 0.30%

Derived from the measured 48-entry / 30-day distribution, not chosen:

| cap | fills | fill rate | slippage paid on the filled book | P&L of what it turns away |
|---|---|---|---|---|
| 0.25% | 33/48 | 68.8% | −$78.56 | −$1,018.88 |
| **0.30%** | **35/48** | **72.9%** | **−$20.00** | **−$915.65** |
| 0.40% | 39/48 | 81.3% | +$117.45 | −$312.04 |
| 0.50% | 41/48 | 85.4% | +$212.23 | +$4.50 |

0.30% is where the filled book pays about nothing net while what the cap refuses is still
clearly loss-making. Tunable live via `QTP_ENTRY_LIMIT_CAP_PCT`, bounded to (0, 2%].

**What this table is not.** It is not a promise of recovered P&L. The right-hand column is what
those trades did *after* filling at a price we would now refuse — a limit that does not fill
earns zero, not the counterfactual. The brief said this and it is still true.

### Order type and TIF: marketable limit, `day`

`order_class: 'bracket'` permits **only `day` or `gtc`** — IOC and FOK are not available, so
"fill now or not at all" cannot be expressed directly. `day` plus an explicit cancel is the
correct emulation; `gtc` would leave a stale order to fill hours later at a price nobody
decided on. Verified live: Alpaca accepted `limit` + `day` + `bracket` + `stop_loss` +
`take_profit` in one submission.

### The unfilled-order path — the genuinely new failure mode

This is the part the Conclave flagged as new, and it is where most of the engineering went.

| outcome | action | why |
|---|---|---|
| **zero fill** | cancel the entry | proven clean: probe 545502 cancelled an unfilled bracket, both child legs went to `canceled`, zero open orders, no position |
| **partial fill, bracket** | **do NOT cancel** | Alpaca: *"if any one of the orders is canceled, any remaining open order in the group is canceled"*. Cancelling the remainder would take the stop and target down with it and leave the already-filled shares naked. Leaving it working is also better on the merits — TIF is `day`, so any further fill is still bounded by the same capped limit |
| **partial fill, volatile path** | **cancel** | the opposite, deliberately: that path has no bracket, just a standalone limit, so there is no group to damage — and a later fill would sit unprotected until the next 15-minute TSM sweep. The trailing stop is sized to the filled quantity, not the requested one |
| **already terminal** | do nothing | the broker already ended it; a cancel would only produce a spurious error |
| **unreadable** | **touch nothing, report `ERROR_FILL_STATE_UNKNOWN`** | see below |

The last row is the one I would point at if you only read one line. If every order-status read
fails, we do not know whether the entry filled. "It did not fill" and "we could not find out"
demand opposite actions, so they do not share an outcome: nothing is cancelled (the bracket is
protective if it *did* fill) and nothing is reported as a skip (reporting a skip would put a
real position outside the ledger — precisely the divergence class H4/H5 exists to catch).
Same for a cancel that fails: the node re-reads the order and reports
`SKIPPED_NO_FILL_CANCEL_FAILED` with `needs_reconciliation` rather than claiming a clean skip
it did not achieve.

---

## Item 3 — SIP data: priced, and it is your call

**Alpaca "Algo Trader Plus" — $99/month.** Full consolidated (SIP) real-time data from all US
exchanges, unlimited API calls, full websocket symbol access. The free tier QTP is on is
IEX-only (~2% of consolidated volume), 15-minute delayed on the historical API, 200 calls/min,
30 websocket symbols.

Against a measured slippage cost of roughly **$1,289/month**, the ratio is about **13:1**.

**But it does not replace what shipped today, and I want to be exact about why.** A consolidated
feed tells you *whether* a signal is still worth acting on. A capped limit bounds *what you
pay*. They answer different questions and the second one is the one that was costing money.
With SIP you would still want the cap; without the cap, SIP alone would have let WST fill at
360.00 exactly as it did.

What SIP would additionally buy:

- a real reference price, which makes a *staleness* guard possible again (the falsified E1
  becomes correct as written)
- the ability to distinguish "this signal is stale" from "this signal is fine but the market
  moved", which the cap cannot do — the cap treats both as "do not pay more than 0.30%"
- better fill-rate diagnostics, because you could see the actual NBBO your limit is resting against

**Recommendation:** buy it, but not as an alternative to today's fix and not urgently. Let the
cap run for a week first. If fill rates land near the projected 72.9% and slippage collapses as
the model says, SIP becomes an optimisation rather than a rescue — and you will have a week of
clean data to judge it against. **I cannot make this purchase; it needs you.**

Sources: [alpaca.markets/data](https://alpaca.markets/data) ·
[Market Data API docs](https://docs.alpaca.markets/us/docs/about-market-data-api)

---

## Item 4 — E2 and E3, bundled and shipped

### E2 — the stop is anchored to the fill

WST on 08-10: stop 1.199% below the **signal**, **2.950% below the fill**. The TSM classifies
anything past 1.20%-from-entry as `UNPROTECTED_STOP_TOO_WIDE`, cancels it, and forces a 0.9%
stop — which sat 0.25% under the market and was hit by ordinary noise 40 minutes later. The bad
fill did not just cost the entry price; it triggered a chain that force-exited a position whose
exit price was **above its own signal price**.

v4.9 recomputes the stop from the actual fill and replaces the leg with `PATCH` — an atomic
replace, so unlike cancel-then-place there is no naked window. **Only ever tightens**: a
favourable fill leaves the stop closer than the cap, and widening it back out would be an
unauthorised increase in risk on a good entry.

### A defect this uncovered that nobody was looking for

The target is **1.15%**, not 1.20%, and the reason turned out to matter more than expected.

The entry clamp targets exactly 1.2% and then rounds the stop to whole cents. Rounding moves
the stop by up to half a cent — in either direction. **Roughly half the time it lands *outside*
the TSM's 1.20% bar.** Measured on real entries: ALGN `1.2003%`, ZBRA `1.1990%`, WSM `1.1996%`,
WST `1.1990%` against their signals. ALGN was over the line by three ten-thousandths of a
percent and escaped only because its fill happened to be favourable.

The live smoke test made this concrete: a **zero-slippage** fill at $14.03 produced a stop at
$13.86 — **1.2117% from the fill, over the bar**, from rounding alone.

That interaction is the uncomfortable one: **the cap makes fills land at or near the signal
price, which removes the favourable-fill accident that was masking the rounding problem.**
Fixing slippage would have made this bite more often. Targeting 1.15% removes it — proven
across every price from $0.55 to $1,234.56, both directions, in the test suite.

Wide-stop recovery has fired **13 times on 12 symbols in 10 days** (XPEV, WST, WSM, AEP, AEE,
AVB, WMT, DGX, ALLE, WMB, ADSK). Twelve of those predate the 08-06 entry-stop clamp, which
addressed the gross 3–6% cases. WST is the only clearly post-clamp instance — and it was
slippage, not a wide ATR stop. Post-cap, rounding would have become the dominant trigger.

### E3 — regime marking

Every payload — filled, skipped, blocked, unknown — now carries `alpaca_exec_regime:
'EXEC_V49_LIMIT_CAP'` and `alpaca_exec_cap_pct`. The long-book rebuild can be measured pre- vs
post-fix without guessing at dates.

### Two things fixed in passing

`alpaca_notional` was computed as `qty × fresh_price`. `fresh_price` is `null` whenever the data
fetch fails, so those rows silently recorded a notional of **0**. Now uses the price actually
paid, falling back to the anchor.

`exec_flow_audit.blocked_stage` and the stale v4.2.1 label in "Format Supabase TSM Result" were
**not** touched — still on the backlog, still cosmetic.

---

## The defect this nearly shipped with — and how it was caught

E3's whole purpose is that the regime is *queryable*. So before calling it done I went and
checked that the tag actually reaches the database. It did not, and worse, checking turned up a
second problem that v4.9 would have created.

`QET Ledger H3 SQL` decides whether to stage a `trade_ledger` row. Its "no trade happened"
test was an **exact-match list of four statuses**, written when there were exactly four. v4.9
introduces four more, and an exact-match list **fails open** on every one of them.

Three of the four were caught anyway — by the downstream `qty`/`entry` guards, by accident
rather than by design. **`ERROR_FILL_STATE_UNKNOWN` was not.** It carries a full quantity and a
stop price, so it would have staged a `trade_ledger` row for a trade whose fill state the node
had *explicitly declared unknown*. That phantom open row would then have fed H4, the divergence
detector, and Gate-K's edge sample — exactly the contamination R3 was created to prevent.

This is demonstrated rather than asserted: test **H3-04** runs the *old* bytes against that
payload and shows `h3: 'staged'`, then the new bytes and shows `h3: 'skipped'`.

And the regime itself: `sizing_meta` carried a fixed key set that did not include it, so E3
would have existed only inside the n8n execution payload. The pre- vs post-fix comparison the
Conclave asked for could not have been run from the ledger at all.

Both fixed and shipped as `QET Ledger H3 SQL v2` (**gov 203**, node sha256
`3e55fc8b33fda267`, 13/13 checks). `sizing_meta` now carries `exec_regime`, `exec_cap_pct`,
`limit_price`, `fill_price`, `poll_outcome`, `partial_fill`, `stop_reanchored`,
`stop_price_initial` and `risk_amount_at_fill`. The status test now matches on family, so the
*next* new status is caught too.

**`risk_amount` itself is deliberately unchanged** — still computed from `intended_entry`, not
from the fill. Changing the risk basis mid-rebuild would mix two bases inside one Gate-K
sample. `risk_amount_at_fill` is recorded alongside it so the Conclave can rule on that
question rather than discover it later. Pinned in test H3-09.

---

## What is proven, and what is not

### PROVEN

| | evidence |
|---|---|
| the deployed bytes are the reviewed bytes | sha256 `1bd58032497568d2…` verified after deploy, independently re-verified, and the **deployed bytes themselves** re-run the full suite 27/27 |
| unfilled bracket cancels cleanly | probe 545502 — parent `canceled`, both legs `canceled`, 0 open orders, no position |
| a bracket stop leg can be replaced after fill, atomically | probe 545502 — `PATCH` 200, new leg live, old leg `replaced`, never zero live stops |
| the replace issues a NEW order id | probe 545502 — `ID_CHANGED: true`; v4.9 records it; the TSM was checked and does not read stored ids |
| the real API accepts what the node builds | **live smoke test on 1 share of F, running the byte-identical deployed code** — limit 14.07 = 14.03 × 1.003, `bracket`, `day`, filled at 14.03 |
| E2 fires and lands where intended, live | same test — initial stop 13.86 (`1.2117%` of fill, over the TSM bar) → `PATCH` → 13.87 (`1.1404%`), and the broker's own order record shows the new stop live on the leg |
| the off switch reverts cleanly | `QTP_ENTRY_LIMIT_CAP_ACTIVE=0` restores the v4.8 market/gtc order, the TE-C3 re-anchor and the >2% reject — asserted in test EXE-17/EXE-22 |
| nothing else regressed | full repo suite, 22 files, 328 checks, green |

### NOT PROVEN

- **No production QTP signal has filled under the cap yet.** Today's signals cluster at the
  open, which had passed before the deploy. The first real test is tomorrow's open.
- **The 72.9% fill rate is a projection from history, not a measurement of this code.** If the
  real rate comes in materially lower, the cap is turning away more than the model says and
  `QTP_ENTRY_LIMIT_CAP_PCT` should widen toward 0.40%.
- **Behaviour at the open specifically.** The probe and smoke test both ran mid-session, in a
  calm book. 09:30–09:40 is a different market and is exactly where this all lives.
- **Whether fixing execution fixes the edge.** It does not, and was never going to. Ex-slippage
  dollar PF was 0.899 — still under 1.0. This removes a large, fixable cost sitting on top of a
  smaller genuine edge problem. **Nothing here is an argument to relax Gate-K.**

---

## Rollback

| what | how | effect |
|---|---|---|
| **instant, no republish** | set n8n variable `QTP_ENTRY_LIMIT_CAP_ACTIVE=0` | market orders return; no poll-cancel, no re-anchor; TE-C3 restored exactly |
| widen the cap instead | `QTP_ENTRY_LIMIT_CAP_PCT=0.40` | more fills, more slippage; bounded to (0, 2%] |
| full code rollback | restore version `e5ca4c98-015e-4364-a8c4-4fea6901c563` (node sha256 `e9cd909c3e8e96bd`, checked in at `docs/execution-fix-20260810/alpaca-paper-trade-v4.8-LIVE.js`) | v4.8 |

**The footgun, and it is the mirror image of the Gate-K one.** This block **fails closed**: a
missing or blank variable means the cap is **ACTIVE**. **Deleting `QTP_ENTRY_LIMIT_CAP_ACTIVE`
does not revert it.** It must be set to the literal `0`. Pinned in test EXE-18 and stated in
the deployed code's own header.

---

## What to watch tomorrow

Run `docs/execution-fix-20260810/verify-exec-fix.sql`. In plain terms:

1. **Fill rate.** If far below ~70%, the cap is too tight — widen to 0.40% before concluding
   anything about the strategy.
2. **Realized slippage on filled entries.** Should collapse toward zero. If it does not, the
   cost is genuine market impact and the conclusion is a much bigger one.
3. **`SKIPPED_NO_FILL_WITHIN_CAP` rows.** These are the trades the cap refused. Every one is a
   real decision, not an error.
4. **Any `ERROR_FILL_STATE_UNKNOWN` or `SKIPPED_NO_FILL_CANCEL_FAILED`.** Both mean reconcile
   by hand. Both should be rare; neither should ever be ignored.
5. **Any new `qtp_widestop_*` client order ids.** If E2 is working these should stop appearing
   on new entries.

---

## Follow-ups deliberately NOT taken

- **Normalising the stop in both directions** (widening on favourable fills, not just
  tightening). There is a real argument for it: `r_multiple` is computed against
  `|entry − intended_stop|`, so a realized stop distance that varies 0.84%–2.95% means R is
  measured in inconsistent units, which is the same class of problem R3 was created to fix.
  It is also an unauthorised increase in risk on winning entries. **This belongs to the
  Conclave, not to me.**
- **Re-anchoring the take-profit to the fill.** Under a 0.30% cap the TP shifts by at most
  0.30% against a 3–5% target — noise. The stop is a safety device; the TP is not. Not worth a
  second API call and a second failure mode.
- **Anything touching Gate-K.** Untouched, and this document should not be read as support for
  touching it.
