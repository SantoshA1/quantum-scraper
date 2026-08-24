# gov 238 — the recurring "can't verify Gate-K" blocker is fixed, and the proxy alarm was false

**2026-08-24, 10:40 ET.** Your scheduled check has now reported the same blocker two
mornings running — *"can't verify Gate-K metrics, `verify-gatek.sql` is on your Mac"* — and
this time it went one step further and produced a proxy that **hinted your tail winners had
dropped**. Both the blocker and the hint are wrong, and the blocker is now impossible to
repeat.

---

## 1 · The authoritative numbers (no repo needed, ever again)

| metric | bullish (certified longs) | bearish |
|---|---|---|
| n_trades | **27** | 26 |
| wins / win rate | 4 / **14.81%** | 2 / 7.69% |
| gross win / gross loss | $2,145.27 / $3,258.05 | $469.44 / $3,254.71 |
| **dollar PF** | **0.6585** | 0.1442 |
| avg win R / avg loss R | 1.8945 / 0.9539 | 0.5955 / 0.5259 |
| kelly★ | **−0.2943** | −1.4038 |
| meets sample bar (n≥20) | ✓ | ✓ |
| **meets PF bar (>1.0)** | **✗** | ✗ |

**Tail canary: 15 consecutive since the last ≥3.6% winner; 5 tail winners of 28.**

## 2 · Two corrections to the scheduled report

**(a) The proxy's hint was wrong — winners went UP, not down.** Baseline was **4 of 20**;
the real current figure is **5 of 28**. No drop. The check was right to distrust its proxy
and right not to alarm — but the record should say plainly that the tail-winner count has
*improved* by one since the baseline. (The count of *consecutive losers* is the metric in
alarm at 15, and that one is real.)

**(b) The "known 1.089 baseline" has no provenance.** I grepped every governance doc in the
repo: **no document records a 1.089 PF.** The check was comparing its proxy against a
number that exists nowhere, then distrusting the proxy for disagreeing with it. The real
certified-long PF has moved 1.229 (post-gov-222) → 0.9755 → 0.6848 → **0.6585** as WMT and
WMB closed. If a stale or invented baseline is wired into the scheduled prompt, it should
be replaced with a live read (below).

## 3 · The root-cause fix: metrics are now database objects

The predicate was never in `verify-gatek.sql` — that file *exercises* the gate; the
predicate lives in **`compute_kelly_gate`'s own body**. So I mirrored it into two views any
session can read with one line, no filesystem involved:

```sql
select * from quantum.v_gatek_certified_metrics;  -- n, PF, kelly★, bars, per direction
select * from quantum.v_gatek_tail_canary;        -- consecutive misses, winners, threshold
```

**Live parity proven side by side:** the view returned n=27 / PF 0.6585, and
`compute_kelly_gate` invoked in the same breath reported `n_trades: 27, dollar_pf: 0.6585,
reason: negative_measured_edge` — **MATCH true**.

**Suite `tests/test-gatek-metrics-view-20260824.js` — 10/10, four sabotages all biting.**
It checks all twelve gate predicates clause-by-clause against the view (GV-02), proves the
function actually uses them rather than assuming (GV-03), proves the view adds **no** extra
filter that could quietly narrow the sample (GV-04), and recomputes PF, win-rate and kelly★
from their own parts (GV-07). The sabotage that matters most: **S4 sneaks a
`net_pnl > -500` filter into the view — a change that would silently flatter the PF — and
the suite catches it.**

One documented, tested difference: the view omits the gate's `user_id = p_user_id` clause.
**GV-05 proves that cannot change a number today** — exactly one account exists in the
certified window and it is the gate's own. If a second ever appears, GV-05 fails and the
view must gain the clause.

**Harness field lesson (ratcheted into the suite header):** three checks failed on the
first run — all *harness* bugs (the normaliser strips `::interval`; the WHERE-splitter ate
a column name), not view defects. Because live parity had already MATCHED, a red result was
evidence about the harness first. A parity suite must be validated against a known-good
subject before its failures are believed.

## 4 · Why zero trades today — regime, not edge

49 audit rows by 10:30. Short halt 14, **GATE_K 11**, shadow 10, bias path 7, other 7.
Zero entries, zero exits, **0 AUTH_FAILED**, **0 EARNINGS_WINDOW**.

The important nuance: **today's Gate-K kills are REGIME kills, not edge kills.** The regime
flipped back over the weekend — Friday closed RISK_ON, today is **RISK_OFF/LOW** — and in
`compute_kelly_gate` the regime check fires *before* the edge check. A live probe confirms
it: reason `counter_regime_bullish_in_downtrend`. So longs are **double-locked again**,
exactly as they were Thursday. Friday's single-lock window closed on its own.

**The earnings guard closed its loop today:** XPEV reports **2026-08-24 — today** — exactly
as the calendar predicted last Thursday, and the position is flat because you closed it on
Thursday. That is the whole feature working end to end. One candidate today (IREN) sits
within 3 days of a print and will meet `EARNINGS_WINDOW` if it ever reaches the gate.

## 5 · New finding — the earnings guard has a liveness blind spot

The calendar is **64.4h old** (Friday 18:10 refresh; threshold is 72h, so healthy). But the
staleness alarm lives *inside* the nightly workflow — so it can report "fetch returned
nothing," and it can **never** report *"this workflow stopped running."* If the schedule
silently breaks, the calendar ages past 72h, the entry guard fails open, and **nothing
alarms** — the same guard-can't-fire class as gov 216 and gov 231.

Fix is small and the natural home already exists: add an earnings-calendar freshness leg to
the **Dead-Man's-Switch monitor** (which already runs independently and pings Telegram).
Queued, not built — say the word.

## Ledger

- **D2 (WMT quarantine) still the live decision.** Quarantine → PF 0.9228; quarantine +
  DGX green at its current **+$493.20** mark → **PF ≈ 1.13**. Still the only near-term
  unlock, and DGX has gained every session since Thursday.
- Scheduled-check prompt should read `quantum.v_gatek_certified_metrics` and
  `quantum.v_gatek_tail_canary` directly and drop the repo dependency + the 1.089 baseline.
- Queued: earnings-calendar liveness leg; E1 Monday re-run (`e1_20260825`); E3b retro.
- Standing: shorts halted, two-week no-touch on gates.
