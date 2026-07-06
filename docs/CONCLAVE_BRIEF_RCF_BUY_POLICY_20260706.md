# Conclave Review Request — Regime Conflict Filter BUY-side policy (2026-07-06)

Self-contained brief for Quantlys Conclave. Paste as-is.

## Context

An automated intraday trading pipeline (paper) filters scanner signals through serial gates. A diagnostic backtest (189 episodes, May 20–Jul 2) found: blocked signals overall earned +15bp/1h gross (t=2.3); BUY-side blocked signals earned +45bp/1h (t=3.0) vs +8bp for SELLs; the scanner emits ~70–80% SELLs. Live behavior confirmed today (Jul 6): the pipeline's Regime Conflict Filter (RCF) killed 4/4 BUY candidates; all pipeline entries today were shorts. (Separate account-level long entries came from another path at the open.)

RCF mechanism (deployed code, verified): the upstream LLM analyst (Grok) rarely outputs "BUY" — on every BUY candidate today it said "HOLD". HOLD counts as AI opposition against a directional signal. A "soft-allow" escape requires ALL of: VC score = 10/10, bias ≥ 60, valid backtest record, secondary confirmation, and strong SPY/QQQ cross-asset alignment. At VIX ~24 with bias 56 and missing backtest records, this is unmeetable — so every Grok-HOLD BUY dies. SELLs also die at RCF sometimes, but Grok says "SELL" far more often than "BUY" (it echoes the bearish-skewed enrichment), so in practice RCF deletes the BUY side — which per the backtest is the higher-alpha side (6×).

Also relevant: RCF drops signals silently (no audit row — fixed today with observability logging, no behavior change), and the LLM's structured output (AIJSON action/confidence) only began being parsed on Jul 2 — historical "HOLD" behavior was never measured.

## Questions for the council

1. **Is Grok-HOLD-as-opposition sound for BUYs?** "HOLD" from an LLM fed bearish-skewed enrichment is weak evidence against a long. Options: (a) HOLD = neutral (no opposition count) for both sides; (b) HOLD = neutral for BUYs only (asymmetric, justified by measured BUY alpha — or is that overfitting one 6-week regime?); (c) keep HOLD = opposition but lower the soft-allow bar; (d) keep as-is until ≥100 RCF-dropped BUYs have measured forward returns via the new observability log.
2. **Soft-allow bar**: VC=10 AND bias≥60 AND valid backtest AND secondary confirmation AND cross-asset alignment — five ANDed conditions. Is a conjunctive bar this high distinguishable from a hard veto? Should it be a scored threshold (e.g., 3 of 5) instead?
3. **Sequencing**: does this change belong in the MTF v8 shadow evaluation batch (candidates A/B/C already approved for shadow design), or is it independent enough to shadow separately? Note the platform's standing rule: no gate policy changes without diagnostic evidence; the new RCF drop-log provides that evidence stream starting today.
4. **Risk of acting vs waiting**: each week of status quo discards ~15–25 BUY candidates (the measured +45bp/1h cohort — gross, one regime, n=35). Each week of waiting adds observability data. Recommend a decision date or evidence threshold.

Rank the top 3 risks of loosening HOLD-opposition for BUYs, and give a verdict: change now (which option), shadow first (how long / what promotion bar), or keep as-is pending Phase-0-style replay of RCF-dropped signals.
