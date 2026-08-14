# Gov 215 — The cumulative kill-switch is back in service, on real money, un-maskable

**Date:** 2026-08-14 10:02 ET · **Authorized:** PO ("go ahead with the one hour repair")
**Workflow:** `QTP Expansion Kill-Switch Monitor` (`awDk3AQesvO3SpQs`), version `66d8471b` published
**Verify offline:** `node tests/test-kscum-repair-20260814.js` (7/7) · fixtures sha256-pinned in `docs/kscum-20260814/`

---

## What was broken (three defects, one node)

1. **Dark sensor.** The cumulative leg summed `quantum.v_expansion_cohort_pnl`, whose P&L source
   (`quantum.trade_log.net_pnl`) is zero on all 1,403 rows — `0 <= -2500` never true. Dark since 07-14.
2. **Fail-open on missing config.** A missing threshold made the comparison NULL → never trips.
3. **Maskable trip.** A trip row wrote `checked_at = now()`; the pause reader takes the single
   newest unexpired row and `qtp_afto_monitor` inserts NOMINAL every 15 minutes — so even a
   successful trip would have been silently un-paused within 15 minutes.

## What was deployed

- **Real money:** cum leg now reads `public.trade_ledger` — `strategy='qtp-main-pipeline'`,
  `mode='paper'`, closed trades only — baselined at **`killswitch_cum_baseline_epoch`**
  (gate_config, gov-215 row) = **2026-08-14 13:37:37Z, the gov-214 re-enable moment**. The PO
  explicitly elected to continue past the breached historical stop, so the ratified −$2,500
  budget restarts from the re-enable: it now guards the *next* −$2,500, which includes the
  runoff of the six open positions and all new entries.
- **Fail-closed both ways:** missing baseline → `'epoch'` → counts all history (wider window,
  more likely to trip); missing threshold → `0` → any cumulative loss trips.
- **Un-maskable trips:** trip rows now write `checked_at = expires_at` (30 days for the
  cumulative halt, 16:30 ET for day/stop trips), so the latest-row reader returns the halt for
  its entire life regardless of AFTO's inserts.
- **Honest alert:** Telegram copy reads the live threshold from the query
  (`cum_threshold_usd`) instead of a hardcoded "-2500".
- **Untouched:** the day-P&L leg (Alpaca portfolio-history, −2.5% of equity) and the
  consecutive-stop-outs leg — byte-identical, pinned by `KS-07`.

## Verification chain

1. **Pre-deploy semantic check** (SQL run against live data): baseline-anchored cum = **$0.00,
   0 trades → no trip** (trading stays on per gov-214); counterfactual missing-baseline =
   −$2,196.30 all-history (fail-closed direction confirmed). *Bookkeeping note: −$3,064.22 was
   the cohort-since-07/15 figure; strategy all-history is −$2,196.30 (pre-cohort trades +$868).
   Neither is what the repaired sensor tracks — its budget starts at gov-214.*
2. **Count-asserted patch** — every substitution asserted to occur exactly once; day/stop legs
   proven byte-identical.
3. **Published and live-fired.** First production run (exec `575439`, 10:00:00 ET, 2-min cron):
   `cohort_cum_net=0, cohort_trades=0, cum_threshold_usd=-2500, cum_trip=false` ·
   day leg `-323.92 vs -2647.97` · stop leg `0 vs 4` · `pause_rows_written=0`. The sensor that
   was dark for a month is measuring real dollars every two minutes of RTH.
4. **Maya suite 7/7** on sha256-pinned before/after bytes.

## What this means operationally

If the book loses **$2,500 net from this morning's re-enable**, the monitor writes an
`EXPANSION_CUMULATIVE_HALT` that (a) actually fires, (b) cannot be masked, (c) blocks only new
entries — stops and exits keep working — and (d) tells you the truth on Telegram. That is the
brake you ratified on 07-14, working for the first time.

Remaining from the pre-trading fix list: the AFTO/reader pair for *manual* halts (my gov-213 row
used the same anti-masking trick, so this is now convention rather than defect), and the
guard-input liveness assertion — the systemic fix for the seven dead-input guards found this week.
