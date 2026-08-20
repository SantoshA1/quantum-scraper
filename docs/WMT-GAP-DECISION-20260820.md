# gov 234 — WMT earnings gap-through: report verified, two PO decisions framed (2026-08-20, 10:45 ET)

**The pasted 30-min-post-open report is CONFIRMED on every number I could recompute, with
one correction and one thing it couldn't know.** Read-only this morning; nothing changed
without the PO's word.

## 1 · Verification against primary sources

| claim | ledger/DB says | verdict |
|---|---|---|
| WMT stop 113.79 (1.15% wide), set at entry | entry 115.1176 (08-12 10:21), intended_stop 113.79 = 1.153% | ✓ |
| gapped through, filled 104.97, −8.8% / −7.93R / −$933 | exit 08-20 09:34 @ 104.9728, r −7.9256, net −$933.32, reason 'stop' | ✓ |
| PF 0.68 over n=26 | exact live predicate: n=26, gw 2,145.27, gl 3,132.55, **PF 0.6848** (WMT is the entire delta) | ✓ |
| tail canary = 14 (threshold) | WMT is the 14th consecutive certified-long close without a ≥3.6% winner since WSM 08-04 | ✓ |
| regime RISK_OFF, gate blocking longs | regime_state 10:30: RISK_OFF / NORMAL | ✓ |
| "same pattern as the WMT trade quarantined under gov-222" | **correction: gov-222 quarantined SHW** (07-23 gap-through, −2.13R). Same PATTERN, wrong ticker | ✗→corrected |

**Cause, independently confirmed:** Walmart reported Q2 CY2026 earnings the morning of
08-20; the stock sank ~8.9% despite beating forecasts (Investing.com earnings-call
coverage). QTP held a long through a scheduled earnings print with a 1.15% stop. **No
earnings-awareness exists anywhere in the pipeline** — and notably, BOTH catastrophic
gap-throughs in the book's history (SHW 07-23, WMT 08-20) look like earnings-window gaps.

## 2 · What the report couldn't know: the rebuilt guards worked

- **The gov-231 kill-switch stop leg counted its first real fill:** the live predicate
  reads `stop_fills_today = 1` this morning — a number that would have been **0 forever**
  on the pre-fix bytes. 1 < 4 → correctly no trip; zero false pause rows. First live proof
  on real data.
- Day-P&L leg: realized −$933 vs unrealized +$796 (DGX +$380, XPEV +$463, WMB −$47) —
  nowhere near the −2.5% trip. Correct silence.
- **Cumulative kill switch is now 64% consumed:** cohort net −$1,599.72 of the −$2,500
  ratified stop (the WMT loss counts here in full — quarantine does not touch this leg).
  One more ≈−$900 day trips a 30-day pause + Conclave reconvene. Working as designed;
  distance worth knowing.

## 3 · Decision 1 — formally halt the long side?

**Recommendation: no new mechanism — the halt is already double-locked.** Every bullish
candidate now dies twice over: Gate-K `negative_measured_edge` (PF 0.6848 « 1.0, n=26 ≥ 20,
no probation path) AND the regime gate (`counter_regime_bullish_in_downtrend`, RISK_OFF).
A formal halt row would be redundant with two independent mechanical locks — the same
ruling as gov 228, now with more force. Q5 and the tail-canary-14 rejection are formally
on the record as of this doc.

## 4 · Decision 2 — quarantine the fresh WMT loss from the edge sample?

The gov-222 SHW doctrine, PO-authorized 08-17, says verbatim: *"a stop that cannot bind
overnight is an execution/risk-model defect, and judging SIGNAL quality on it is a
category error."* WMT-08-20 fits it almost word for word: the stop was sized to −1R; there
was no tradeable price between 113.79 and the ~104.97 open; the realized −7.93R measures
the risk model's overnight blindness, not the signal (which was +$68 green the prior
midday).

- **If quarantined:** the edge sample returns to exactly **n=25, PF 0.9755** — yesterday's
  knife-edge. The loss REMAINS in P&L, in the cumulative kill switch, and in every report
  (as with SHW; the tag only removes it from `compute_kelly_gate`'s edge math).
- **The honest counter-argument:** unlike SHW, this loss post-dates the gov-226
  overnight-gap measurement — the system *knowingly* retained overnight exposure ("keep
  overnight holds, size to p99 = 3.06%"). An 8.8% earnings gap is beyond p99, but the
  category "overnight gap risk" was measured and accepted. Quarantining a second one
  without fixing the exposure rule starts to look like grading our own homework.
- **My recommendation: quarantine, but ONLY paired with the structural fix decision** —
  consistency with ratified doctrine on the measurement side, plus an actual rule change
  so there is no third one. PO's call; on authorization I apply the lineage tag in the
  gov-222 audit-trail format (full rationale on the row).

## 5 · The structural point — this morning is E1's thesis, live

The 2-day time exit certified by E1 yesterday (PF > 1.2 on both cohorts at every stop
width) **would have exited WMT at the 08-14 close — six days and one earnings report
before the gap.** A 2-night maximum hold structurally caps event exposure. Add the now-
concrete E3 candidate: an **earnings-calendar guard** (no new entry within N days of a
scheduled print / force-exit before print) — cheaply measurable against history, and both
catastrophic gap-throughs on record appear to be earnings windows.

## RESOLUTION ADDENDUM (11:05 ET) — XPEV closed ahead of Monday's print, verified clean

The earnings-calendar check on the open book found **XPEV reporting Q2 on Monday 08-24**
(DGX next mid-October; WMB already reported) — the same failure class as this morning's
WMT, on the short side, two sessions out. PO closed the short manually in Alpaca at 10:51
ET. Verified end-to-end: the GTC protective stop was **CANCELED first** (10:51:25, zero
filled — no orphaned order that could open a phantom long on Monday's gap), market
buy-to-close **FILLED 858 @ 11.91** (10:51:26), the 11:00 reconcile reads
`CLOSED_NO_POSITION`, and the ledger healed within minutes: exit_reason `manual`,
**+$437.58 realized, +1.09R** on a 17-day legacy short (entered 08-03, pre-halt).

Effects: the open book is now **DGX (+$411) and WMB (−$63) only — zero earnings exposure
until mid-October**; the cumulative kill switch improves from 64% to **46% consumed**
(−$1,162.14 of −$2,500); the certified short sample gains its first winner (negligible
against the release bar). A one-glance orphan hazard existed and did not materialize —
noted as a machinery gap regardless: nothing in QTP watches for open orders on symbols
with NO position (reconcile is position-keyed). Queued as a small sentinel extension.

## Ledger

- PO decisions open: D1 formal halt (rec: unnecessary), D2 WMT quarantine (rec: yes,
  paired with structural fix). E3 earnings-calendar guard awaiting build authorization.
- Watch: cumulative switch at 46%; DGX +$411 open (trail-managed); E1 fresh-data re-run
  ~Friday (run_id e1_20260821).
- Backlog: drop `&feed=iex` from the TSM's bars calls (shadow-certified safe); orphan-order
  sentinel (orders with no position).
