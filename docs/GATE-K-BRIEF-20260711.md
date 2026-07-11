# Gate-K — Risk Manager Brief (2026-07-11)

**Status: LIVE, PAPER.** New canon doc. Executed by architect (Claude). Names and specifies the productized risk manager that the ARCH_V59 "fail-closed risk gate" and the D5 milestone gate lineage matured into this week. Note on naming: **"Gate-K" is the implementation name; in ARCH_V59 canon this is the fail-closed risk gate (Safety plane) + the calibration-gated D5 milestone.** No prior doc used the "Gate-K" token — this brief pins it.

## Verdict in one line

**Sizing and admission are now separated from decision-making, sized off MEASURED edge in `public.trade_ledger`, and every rejection is deterministic and logged. This is the fix for the exact loss class the 07-06→10 week produced: ~70% of realized losses were protection/regime defects, not bad picks.**

## What Gate-K is

A single Postgres function, `public.compute_kelly_gate` (18-arg, v2.1), called immediately before order submission on both the QET path (H2 workflow) and the legacy pipeline (`vaqfCaELhOEWnkdo`, shim inserted 07-10, governance row 79). It returns a jsonb verdict; the workflow acts on it verbatim. It can only ever TIGHTEN the legacy pipeline's sizing, never loosen it.

## Checks, in cost order (each with the week's evidence)

**K1 — Regime filter.** Reads `quantum.regime_state`; rejects counter-regime entries (bearish in UP-trend, bullish in DOWN). Evidence: counter-regime shorts cost −$485 realized the week of 07-06 vs an up-tape. Degrades gracefully (skips + flags) if regime is stale >90 min. Shadow mode available.

**K2 — Born-protected stop sanity.** Rejects stops on the wrong side of entry, and widths > 5%. Evidence: WDAY ran −4.4% *unstopped* (the stop-width-as-protection bug); ASML entered naked. Enforces at admission what TSM previously repaired post-hoc.

**K3 — Stop-out cooldown.** Same symbol+direction stopped out within 24h → reject. Evidence: WDAY/ASML/CBRE were all re-traded within a day of stopping out. Armed for legacy flow by the H3-legacy ledger tap (governance row 80).

**K4 — Fractional-Kelly sizing + concentration cap.** Risk-normalized qty from measured edge (probation 0.50% until n≥40 closed trades/strategy; quarter-Kelly capped at 1% Gate-1 ceiling; drawdown de-lever ×1/×0.6/×0.35; HALT at 12% DD). Notional capped at `portfolios.concentration_limit_pct` (legacy 10%, hard ceiling 25%). Evidence: flat ~$3,800 notional meant WDAY risked 4.4% while CBRE risked 0.01% — uncontrolled per-trade risk.

## Ties to canon doctrine

- **Cost-truth (COST_MODEL v0, −13.2bp/side, ~−20bp round-trip):** Gate-K sizes off `r_multiple` computed net of measured slippage + fees in `trade_ledger`, not gross. The D5 "effect-size floor ≥25bp" belongs upstream (signal admission); Gate-K enforces the survival half — no position sized so its cost exceeds its edge budget.
- **Filter/Guard doctrine:** K1–K3 are Filters (admission), K4 is a Guard (sizing). All measured-first: the gate refuses to size off backtests, only off live `trade_ledger`.
- **MTF Phase-0 (READOUT 07-02):** the MTF confluence score is anti-predictive (score↔r60 = −0.137; deep-reject 40–50 band outperforms 65+). Gate-K does NOT trust MTF score for sizing — it is orthogonal to the score, gating on regime/protection/measured-R only. Console must render MTF as under-recalibration, never as a trusted admit.

## Verification

Maya fixture battery 7/7 (wrong-side, insane-width, cooldown reject + opposite-direction pass, counter-regime reject + aligned pass + shadow-records-violation); concentration cap exact (25%→qty capped to $25k notional; legacy 10%→$10k); e2e webhook proof through H2. Migrations `qet_kelly_gate`, `_v2`, `_v2_1`. Governance rows 79–80.

## Caveats

Live edge is n<40 per strategy → sizing is in probation, NOT yet Kelly-driven; the "measured edge" claim is **cost-observed, not yet cost-survived** (t-stat has not cleared 2). Volatile-ticker trailing-stop exits are not yet polled by H4 (H4 v1.2 follow-up) so those ledger rows stay open. Legacy signals the shim can't parse fail OPEN (unsized, legacy sizing retained) by design.

## Artifacts

`public.compute_kelly_gate` (v2.1); migrations `qet_kelly_gate{,_v2,_v2_1}`; governance rows 79–80; H2 workflow `vc3nTeFEaaXAAEAb`; weekly post-mortem (`26. Weekly loss post-mortem`).
