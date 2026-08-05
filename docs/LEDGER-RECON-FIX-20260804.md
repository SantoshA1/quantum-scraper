# Ledger / Broker Reconciliation Break — Read-Out + Fix (2026-08-04)

**Status: ROOT-CAUSED, DATA REPAIRED, DETECTOR LIVE, LOGIC FIX SPEC'D (not yet published to n8n).**
Executed by architect (Claude). Supabase `qtp_prod` migrated; n8n untouched.

## Verdict in one line

**`qet-h4-exit-sync` resolves a position's exit through the ENTRY order's nested bracket legs, but
TSM cancels those legs and places standalone replacement orders — so every TSM-managed exit is
invisible to H4, and the ledger silently disagrees with the broker until the 02:00 H5 heal.**

## What was actually wrong

At 21:30 ET, `public.trade_ledger` showed **6 open rows**; the broker snapshot showed **3
positions**. AEE, WSM and WMB had all closed earlier the same day and none had been written back.
`qet-h4-exit-sync` ran **306 times** during the session, reporting `0 closed` on every run.

| | entry order | bracket stop | what actually filled | fill |
|---|---|---|---|---|
| AEE | `ce4330db` | `6be4434b` CANCELED 08-03 09:45:14 | `e562f3bb` (TSM replacement) | 08-04 09:40:27 @ 108.0017 |
| WSM | `e98efeb5` | `5ca1bfa0` CANCELED 08-04 09:46:01 | `64bd14e2` (standalone market) | 08-04 09:46:04 @ 245.3100 |
| WMB | `dec5732d` | `f2c52de9` CANCELED 08-04 09:45:12 | `d31fa51e` (re-stop) | 08-04 11:06:48 @ 71.6000 |

Every original bracket leg was CANCELED with `filled_quantity = 0`. There was never anything for
H4 to find. **H5 is not at fault** — at its 02:00 run all three were still genuinely open, so
`0 stale open rows` was correct at the time.

## Why it matters more than three rows

`public.edge_metrics_by_strategy` is what **Gate-K sizes from**. Between a broker close and the
next 02:00 heal — up to ~16 hours — that view is computed on an incomplete trade set. Today the
missing rows included a **+$484.65 winner** (WSM, +1.97R), so the live scoreboard understated both
n and expectancy for the whole session.

Second-order: the H5 heal hard-codes `exit_reason = lastFill >= 19:29 ? 'time' : 'stop'`. Every
healed trail-ratchet exit is therefore filed as a plain `stop`. That is why `v_learning_summary`
shows `exit_reason='trail'` at **n=2** while trail is the **only profitable exit bucket**
(+$868, avg 6.69R). The exit attribution, not the strategy, was wrong.

## What shipped

**1. Data repair (3 rows).** Sourced entirely from `quantum.order_events`; no price inferred.
`trade_ledger_derive` computed P&L, R and slippage.

| | exit reason | net | R | entry slip | exit slip |
|---|---|---|---|---|---|
| AEE | `trail` | −107.36 | −0.242 | −50.15 bp | +12.79 bp |
| WSM | `target` | **+484.65** | **+1.969** | −2.13 bp | +9.37 bp |
| WMB | `stop` | −341.14 | −2.110 | +36.65 bp | +5.59 bp |

Net **+$36.15** realized on 2026-08-04. Tagged `lineage_source='H4_GAP_REPAIR_20260804'` so the
repair is reversible and auditable. `edge_metrics_by_strategy` moved 34 → **37 trades**, and
`avg_exit_slip_bps` is populated for the **first time ever** (9.25 bp) because `intended_exit`
had never previously been written — half of G17's cost truth was silently absent.

**2. Divergence detector (live).** Migration `qtp_ledger_broker_divergence_20260804`:
- `quantum.v_ledger_broker_divergence` — per-symbol `PHANTOM_OPEN` / `UNLEDGERED_POSITION` /
  `QTY_DIVERGENCE` / `OK`, with `open_hours` and broker-snapshot staleness.
- `quantum.v_ledger_recon_health` — one row; `status='CLEAN'` is the invariant. A stale broker
  snapshot can never report CLEAN.

Reads **CLEAN** after the repair (3/3 symbols OK).

**3. Spec-mirror + Maya guard.** `lib/recon/ledger_divergence.js` + `tests/test-ledger-divergence.js`
(**20/20**), fixtured on the real 08-04 order-event stream:
- `resolveExitOld` (bracket-leg identity) finds nothing for all three — the bug, reproduced.
- `resolveExit` (symbol + opposite side + FILLED + after entry + exact qty) finds all three.
- Attribution: AEE stop ratcheted 105.05 → 108.14 = `trail`; WMB short re-stopped 70.69 → 71.56
  (away from entry) = `stop`, never a trail; WSM within 10 bp of target = `target`.
- `ATTR-04` pins that the live H5 rule disagrees with the truth — the mislabelling is now a
  failing-if-regressed assertion.

Gate: `npm run ci` → **20/20 suites**.

## Also surfaced by the same stream

**WMB was unprotected for 15 minutes.** Protective stop canceled 09:45:12, replacement not placed
until 10:00:23, then re-stopped **3.13% away** at 71.56 and taken out for −$341. This is the BA
07-30 pattern repeating — and `QTP_NAKED_FLATTEN_ON` is still default OFF. Pinned as `NAKED-01`.

## Not done — needs PO

**The H4 workflow itself is unchanged.** The fix is spec'd and test-pinned but publishing is
PO-gated, and per `docs/CANONICAL-SOURCE.md` the repo is stale against live, so this needs
reconcile-then-publish. Until H4 is patched the break will recur on the next TSM-managed exit;
the detector will now catch it and H5 will still heal it overnight (with the wrong `exit_reason`).

Required H4 change: replace bracket-leg lookup with the `resolveExit` rule, and adopt
`classifyExitReason` in both H4 and the H5 heal.

## Artifacts

Migration `qtp_ledger_broker_divergence_20260804` ·
`docs/202608042200_qtp_ledger_broker_divergence.sql` ·
`lib/recon/ledger_divergence.js` · `tests/test-ledger-divergence.js` (20) ·
repair tag `H4_GAP_REPAIR_20260804`.
