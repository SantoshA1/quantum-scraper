# Gov 214 — Entries re-enabled by PO order, 2026-08-14 09:37 ET

**Order:** *"reenable trading now"* — executed immediately, verified live.

## What was done

The gov-213 halt row (`po_halt_20260813_entries_off`) was **expired, not deleted** —
`expires_at = now()`, reason annotated with the lift order — so the governance record
survives in `quantum.entry_pause_control`.

## Verification

1. **Deployed reader, run verbatim post-lift:** returns `pause_new_entries=false,
   status=NOMINAL` (latest AFTO row). Kelly-gate preconditions clean: `position_risk_state`
   fresh (09:30 today, no EXPANSION_PRS_STALE), 0/5 daily cap used, cohort caps armed.
2. **Live before/after on real signals:**
   - 09:30 (halt on): WMB passed the whole state machine `PASS/FULL`, then pause guard →
     `KILLED/SKIP — "New entry paused by QTP-10FC: PO-ordered halt … gov 213"`.
   - 09:45 (halt lifted): ALGN, AMD → `REGIME_CONFLICT_CONTRA_BOTH`; AVGO → `AI_CONFLICT` —
     signals once again reaching and dying at the **normal** filter stack, downstream of the guard.

The halt mechanism worked in both directions on live traffic within one session: blocked at
09:30, restored to normal flow at 09:45. Entries will fill whenever a candidate clears the
stack (historical base rate ≈ 0.5/day at a 99.5% rejection rate — zero-fill mornings remain normal).

## Standing risk state the PO is trading with (explicit)

- Both signal sources are **measured-dead** (scanner: gov 212; Pine: four-witness artifact
  closure). This re-enable resumes trading on those measurements' losing side, at the PO's
  explicit instruction. Paper account.
- The ratified **−$2,500 cumulative stop is already breached (−$3,064) and its automated
  sensor remains dark** (reads `quantum.trade_log`, all zeros). Nothing automated halts on
  cumulative losses. Working legs: day-loss −2.5% of equity (Alpaca-direct) and
  4-consecutive-stopouts. Caps armed: 5 entries/day, 8 concurrent, sell caps.
- Repair of the cumulative leg (point at `public.trade_ledger`, ~1h) remains the top offered
  fix, awaiting PO word.
