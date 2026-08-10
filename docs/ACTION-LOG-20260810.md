# Action log — 2026-08-10
**Session:** execution tax → Conclave ruling → pre-flight falsification → composed fix, shipped
**Governance rows written today:** 201, 202, 203

---

## What changed in production

| gov | when (ET) | what | version before → after |
|---|---|---|---|
| 201 | 12:22 | pre-flight only — nothing deployed, E1 falsified | — |
| **202** | **13:12** | **`Alpaca Paper Trade` v4.8 → v4.9** (EX-C1/C2/C3) | `e5ca4c98…` → `c3fe82bf…` |
| **203** | **13:47** | **`QET Ledger H3 SQL` v1 → v2** (status family + E3 persistence) | `c3fe82bf…` → `82c29abc…` |

Node hashes: `Alpaca Paper Trade` `e9cd909c3e8e96bd` → `1bd58032497568d2` (55,102 bytes) ·
`QET Ledger H3 SQL` `9506fdb98a28bee0` → `3e55fc8b33fda267` (4,990 bytes).
Both verified byte-identical after deploy, then **independently re-verified**, and the
**deployed bytes themselves** were re-run through their suites.

---

## Sequence

1. **Extracted the live node** as the rollback artifact (`alpaca-paper-trade-v4.8-LIVE.js`) and
   confirmed it byte-identical to what was running.
2. **Priced SIP** — Alpaca "Algo Trader Plus" $99/month vs a measured ~$1,289/month slippage
   tax. Written up for the PO; **not purchased — I cannot and did not.**
3. **Derived the cap** from the measured 48-entry distribution → 0.30%.
4. **Probed order state live** (workflow `4rqezpw3kaD4H12u`, execution 545502, archived) because
   two Alpaca behaviours the fix depends on are undocumented, and I had just spent the morning
   watching an undocumented assumption get falsified. Settled both:
   cancelling an unfilled bracket is clean; a stop leg **can** be `PATCH`ed after fill, **and the
   order id changes**. Then checked that the TSM does not read stored leg ids — it does not.
5. **Wrote v4.9** as an auditable patch script against the v4.8 bytes, not a rewrite.
6. **Wrote the spec-mirror and the Maya suite** — 27 checks executing the real bytes against a
   scripted fake broker whose response shapes came from the probe, not from imagination.
7. **Deployed, hash-verified, published.**
8. **Smoke-tested LIVE** — 1 share of F, running the byte-identical deployed code end to end
   against the real broker. Capped limit built and accepted, filled, E2 fired, stop replaced,
   flattened. See below.
9. **Checked that E3 actually reached the database.** It did not — and that check turned up a
   phantom-row defect v4.9 would have created. Fixed and shipped as H3 v2 (gov 203).

---

## PROVEN

- The deployed bytes are the reviewed bytes. Verified three ways.
- **Unfilled bracket cancels cleanly** — parent `canceled`, both legs `canceled`, 0 open orders,
  no position (probe 545502).
- **A bracket stop leg can be replaced atomically after fill** — `PATCH` 200, old leg
  `replaced`, new leg live and still `order_class: bracket`. Never zero live stops.
- **The replace issues a NEW order id.** v4.9 records it; the TSM enumerates live legs from
  `status=all` and treats `replaced` as inactive, so it is unaffected.
- **The real API accepts what the node builds** — live, 1 share of F: `limit` 14.07 =
  14.03 × 1.003, `order_class: bracket`, `time_in_force: day`, filled at 14.03.
- **E2 fires and lands where intended, live** — initial stop 13.86 = **1.2117% of fill, over the
  TSM's 1.20% bar**; `PATCH` → 13.87 = **1.1404%**; the broker's own order record shows the new
  stop live on the leg.
- **The off switch reverts cleanly** (EXE-17, EXE-22).
- **The phantom-row defect was real** — H3-04 runs the old bytes and shows them staging the row.
- **Nothing else regressed** — 23 suites, 341 checks, green.

## NOT PROVEN

- **No production QTP signal has filled under the cap.** Today's signals cluster at the open,
  which had passed before the deploy. **The first real test is tomorrow's open.**
- **72.9% fill rate is a projection from history, not a measurement of this code.**
- **Behaviour at 09:30–09:40 specifically** — the probe and smoke test both ran mid-session in a
  calm book, and the opening auction is the entire problem domain.
- **Whether fixing execution fixes the edge.** It does not. Ex-slippage dollar PF was 0.899,
  still under 1.0. **Nothing here is an argument to relax Gate-K.**

---

## The finding nobody was looking for

The entry clamp targets exactly 1.2% and rounds the stop to whole cents. Rounding moves the stop
by up to half a cent in either direction, so **roughly half the time the realized distance lands
outside the TSM's 1.20% bar** — which makes the TSM cancel the bracket stop and force a 0.9%
replacement. Measured on real entries against their signals: ALGN `1.2003%` (over), ZBRA
`1.1990%`, WSM `1.1996%`, WST `1.1990%`. ALGN was over by three ten-thousandths of a percent and
survived only because its fill happened to be favourable.

The live smoke test made it concrete: a **zero-slippage** fill produced a stop at **1.2117% of
the fill**, over the bar, from rounding alone.

The uncomfortable part: **the cap makes fills land at or near the signal price, which removes
the favourable-fill accident that was masking this.** Fixing slippage would have made this bite
*more* often. Targeting 1.15% instead of 1.20% removes it, proven from $0.55 to $1,234.56 in
both directions.

Broker-side corroboration: forced-stop recovery has fired **13 times on 12 symbols in 10 days**
(XPEV, WST, WSM, AEP, AEE, AVB, WMT, DGX, ALLE, WMB, ADSK). Twelve predate the 08-06 entry-stop
clamp; WST 08-10 is the only clearly post-clamp one.

---

## Rollback card

| what | how |
|---|---|
| **cap off, instant, no republish** | n8n variable `QTP_ENTRY_LIMIT_CAP_ACTIVE=0` |
| widen instead of reverting | `QTP_ENTRY_LIMIT_CAP_PCT=0.40` (bounded to 0–2%) |
| APT code rollback | restore version `e5ca4c98-015e-4364-a8c4-4fea6901c563`, node sha `e9cd909c3e8e96bd`, source `docs/execution-fix-20260810/alpaca-paper-trade-v4.8-LIVE.js` |
| H3 code rollback | restore version `c3fe82bf-9d2d-4e96-9869-adbfdceb0d5d`, node sha `9506fdb98a28bee0`, source `docs/execution-fix-20260810/qet-ledger-h3-v1-LIVE.js` |

**FOOTGUN — the mirror image of the Gate-K one.** This block **fails closed**: a missing or
blank variable means the cap is **ACTIVE**. **Deleting `QTP_ENTRY_LIMIT_CAP_ACTIVE` does not
revert it.** It must be set to the literal `0`. Pinned in EXE-18 and stated in the deployed
code's own header.

---

## Discipline notes on this session

- I ran a **live probe before writing the fix**, not after, specifically because the morning's
  pre-flight had falsified a recommendation that rested on an undocumented assumption about this
  same API. Two assumptions in one day would have been a choice.
- I **checked that E3 reached the database** rather than assuming the tag I added was enough. It
  was not, and the check found a second, worse defect.
- I **did not change `risk_amount`'s basis** even though the fill basis is arguably more correct,
  because that would shift the metric Gate-K is currently measuring, mid-rebuild. Recorded both
  and flagged it for the Conclave.
- I **delegated the two 55KB byte transfers** to subagents and then verified the hashes myself
  rather than trusting the report. Transcription is mechanical; verification is not.
- The **live smoke test placed a real order** (1 share of F, ~$14). It is a paper account and the
  position was flat within seconds, but it was a real broker interaction and should be recorded
  as such rather than described as a simulation.

---

## Still open (unauthorised backlog, unchanged today)

AES clamp-floor · orphan classification · C4 regime seed · VC C1–C3/C5 · RCF exemption ·
G17 slippage · 6 MEDIUM + 5 LOW SQL-sweep findings · `VaUQ4J95wyc5CAVP` not MCP-reachable ·
`exec_flow_audit.blocked_stage='UNKNOWN'` on an EXECUTED row · stale v4.2.1 label in
"Format Supabase TSM Result".

## New follow-ups for the Conclave

1. **Normalise the stop in both directions?** Today it only ever tightens. Widening on
   favourable fills would make `risk_amount` a consistent unit, which matters because
   `r_multiple` is measured against it — the same class of problem R3 fixed. It is also an
   unauthorised increase in risk on winning entries. Not mine to decide.
2. **Re-anchor `risk_amount` to the fill?** Both numbers are now recorded. Same reasoning.
3. **Buy SIP?** $99/month, ~13:1 against the measured tax. Recommend deciding after a week of
   capped data, not before.
