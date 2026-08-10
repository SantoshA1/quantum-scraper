# Order-state probe — what Alpaca actually does, measured rather than assumed
**Date:** 2026-08-10 · **Probe workflow:** `4rqezpw3kaD4H12u` (archived) · **Execution:** 545502
**Why it exists:** the composed execution fix depends on two Alpaca behaviours that the public
documentation does not state. The pre-flight of the same morning had just falsified a
recommendation that rested on an assumption about this same API surface. Assuming twice in one
day would have been a choice, not an oversight.

**Security:** run inside n8n. Credentials referenced via `$vars` by name only — no credential
value was read, logged, exported or returned. `qty` was hard-pinned to `1`, the symbol (`F`,
never traded by QTP — verified: 0 rows in `trade_ledger`) had to be flat before anything was
submitted, and the position was flattened in the same execution. Cost of the experiment: one
share, one round trip, `FLAT: true`, `open_orders_left: 0`.

---

## Q1 — Can an UNFILLED bracket entry be cancelled cleanly?

This is the `SKIPPED_NO_FILL_WITHIN_CAP` path. If cancelling a bracket left orphan legs or a
phantom position, the whole limit-with-cap pivot would be trading one failure mode for a worse one.

Submitted a bracket buy 20% below the bid — unfillable by construction — then `DELETE`d the parent.

| | measured |
|---|---|
| parent at submit | `pending_new`, legs `f3463272` (limit) and `a28c3791` (stop), both `held` |
| `DELETE /v2/orders/{parent}` | **200** |
| parent after | `canceled`, `filled_qty` **0** |
| both child legs after | **`canceled`** |
| open orders on the symbol | **0** |
| position | **none** |

**Answer: yes, cleanly.** Cancelling the parent takes the whole group with it. Nothing is
orphaned and no position is created. The zero-fill cancel path is safe.

---

## Q2 — Can a bracket's stop_loss leg be replaced after the parent fills?

This is E2. The Conclave's condition was "order-state safety proven" — specifically, no naked
window. `PATCH` is atomic where cancel-then-place is not, so everything depended on whether
`PATCH` is permitted on a child leg. The docs do not say. The one public report on the subject
([alpaca-py #412](https://github.com/alpacahq/alpaca-py/issues/412)) shows an error
(`order parameters are not changed`) that is ambiguous between "not allowed" and "you sent the
same price".

Submitted a marketable bracket, let it fill, then `PATCH`ed the stop leg's `stop_price`.

| | measured |
|---|---|
| entry | filled at **14.04** on the first poll (1.5s) |
| legs after fill | TP `eb32bf46` `limit` status **`new`**; SL `accceeb1` `stop` status **`held`** |
| `PATCH /v2/orders/{slLeg}` `stop_price 12.63 → 12.74` | **200** |
| returned order | id **`71ef267e`**, `stop_price` **12.74**, `status` `held`, `order_class` **`bracket`** |
| **`ID_CHANGED`** | **`true`** |
| old leg re-read | `status` **`replaced`**, `replaced_by` `71ef267e` |
| protection during | continuous — the replacement is one operation, never zero live stops |

**Answer: yes — and the order id changes.**

### The part that matters operationally

`PATCH` is a *replace*, not an *edit*. The old leg becomes `replaced` and a **new id** is
issued. Any id stored at submit time — `state._bracketOrders[sym].slId`, `alpaca_sl_id` in the
payload, anything downstream reading either — is **stale the moment the re-anchor succeeds**.

v4.9 records the returned id. Two consumers were checked before relying on this:

- **Trailing Stop Manager** — safe. It enumerates live legs from
  `/v2/orders?status=all&limit=500&nested=true` and classifies by status; its active list is
  `['new','accepted','pending_new','held','partially_filled','pending_replace']`. `replaced`
  is not in it, so the old leg is correctly ignored and the new one correctly counted. The TSM
  never reads a stored `slId`.
- **The node's own static data** — updated to the new id in the same block.

### A second finding, incidental but worth writing down

`GET /v2/orders?status=open` returned **only the take-profit leg**. The stop leg sits in
`held` and is invisible to that query. QTP already knows this — it is the reason
`QTP_TSM_HELD_BRACKET_STOP_VISIBILITY_v4.2.6` fetches `status=all` — but any *new* code that
enumerates protective stops the obvious way would conclude every bracketed position is naked.

---

## What this probe did NOT settle

- **Cancelling a *partially* filled bracket entry.** Not tested, because constructing a
  reliable partial fill on demand is not something a probe can guarantee. It does not need to
  be settled: v4.9 never cancels a partially filled bracket, which is safe under either
  behaviour. Alpaca's own documentation is explicit that cancelling one order in a group
  cancels the rest, and the conservative reading is the one that protects filled shares.
- **Behaviour at the open.** The probe ran mid-session. Fill rates in the 09:30–09:40 window —
  which is where the strategy's signals cluster and where the whole slippage problem lives —
  are the thing the cap's 72.9% projected fill rate is really a claim about, and that claim is
  a projection from history, not a measurement of the new code.

---

## Reproducing

The probe body is checked in at `docs/execution-fix-20260810/probe-order-state.js` (the v1
source; v2, which fixed 404 detection after `e.statusCode` proved unpopulated in this n8n
runtime, is the version that produced execution 545502 and differs only in that detection and
in extra error capture). Recreate as a manual-trigger Code node, run once, archive.
