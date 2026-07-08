# LLM Analyst Decision Memo — Grok, alternatives, and the RCF questions resolved (2026-07-06)

> **RATIFIED by Quantlys Conclave 2026-07-06 — with binding amendments.** The amendments below SUPERSEDE the corresponding clauses in the body:
>
> **A1 (supersedes Q4's quorum):** Auto-promote is calibration-gated, NOT bp-gated. Promotion of HOLD→neutral requires ALL of: n≥50 RCF-dropped BUYs with forward returns; Brier calibration improvement vs baseline; expectancy positive with t≥2; shadow window includes calmer-VIX days (not solely a VIX~24 regime). Deadline unchanged (review at n≥50 or 2026-07-20). The raw "+20bp/1h at n=50" trigger is VOID.
>
> **A2 (amends bake-off):** the HOLD>60% kill-criterion fires only at n≥30 gate-passing signals per model — no model dies on noise.
>
> **A3 (thesis dependency):** hot-path thesis consumption must be a single pre-computed-row read (direct Postgres, not PostgREST — immune to the recurring PGRST002/G10 cold-cache bug; still include fail-open if the read errors), with an explicit p95 latency budget (≤500ms) inside `vaqfCaELhOEWnkdo`; thesis-staleness alerting attaches to an EXISTING dead-man's-switch monitor, not a new one; any future thesis-schema migration includes an explicit schema-reload step.
>
> **Integration mandate:** RCF shadow analysis shares the MTF counterfactual harness — drop cohorts are cross-tabulated with MTF state (15m/1h/4h) + forward returns; no parallel observability silo.
>
> **Architectural decision (council lean, adopted):** the daily thesis IS the advocate. The separate Bull/Bear/Judge debate stage stays deferred until RCF evidence and the v8 score are both in hand.
>
> Everything remains column-additive and shadow-only until the evidence quorum AND a clean two-week attribution window are satisfied; live promotions are single-version republishes; one live promotion at a time.

Architect resolution of the Conclave brief (`CONCLAVE_BRIEF_RCF_BUY_POLICY_20260706.md`) plus the model-selection question, per IDSD. Everything live-touching remains shadow-first.

## The core diagnosis: it's the harness, not the model

Before debating Grok vs anything else, look at what Grok is *given* and *asked*. Today's NDSN packet fed it "zero bull score, bear conviction 57, −18.98% net backtest, 43.7% win rate" — and the prompt permits HOLD. Any competent model answers HOLD to that packet; a different model fed the same prosecution-only case file will produce the same abstention. Three harness defects dominate any model difference:

1. **Bear-skewed evidence packet.** The enrichment carries bear conviction scores and (often invalid) backtest negatives; there is no symmetrical bull-case field. The analyst never sees an argument FOR the trade — the exact "no advocate" asymmetry the TradingAgents analysis identified in July's OODA.
2. **Abstention is free.** HOLD costs the model nothing and reads as prudence. Best practice for a *directional pipeline* is forced-choice with confidence: "You must output BUY or SELL plus confidence 0–100; output ABSTAIN only with a reason code from {DATA_MISSING, EVENT_RISK, ILLIQUID}." Unconstrained HOLD is an uncalibrated shrug being treated as a signal.
3. **Zero measurement until Jul 2.** No structured output existed, so nobody ever computed whether Grok-HOLD predicts anything. Swapping models without a scoreboard just changes whose vibes you ship.

**Verdict on "move off Grok": not yet — instrument, then bake off.** Grok stays for now because (a) its VC-gatekeeper leg is demonstrably functional, (b) real-time X sentiment access is a differentiator no other provider offers natively, and (c) we finally have AIJSON telemetry to judge it. But it earns its seat within 30 days or loses it — see bake-off below.

## Where the Quantlys Teams "Equity Research crew" fits (and where it doesn't)

The Teams crew is the right tool for the **slow path**, wrong for the hot path. A multi-agent crew run takes minutes and dollars; the scanner posts every 5 minutes and the pipeline already has cumulative-latency problems (G12). Institutional pattern to copy: the morning meeting → trading desk split.

- **Slow path (new, high value):** a pre-market Equity Research crew run (single scheduled execution ~08:30 ET) produces a *daily regime & watchlist thesis*: market regime call, sector tilts, per-watchlist-name bull/bear notes with confidence. Output lands in a Supabase table (`quantum.daily_research_thesis`) as structured JSON. Cost: one crew run/day, not per-signal.
- **Hot path (unchanged latency):** the per-signal analyst (Grok today) receives the day's thesis as ONE compact context field and must state whether it agrees or disagrees with the morning view for this name. The hot path consumes research; it doesn't perform it. This also gives BUY candidates their missing advocate — if the morning thesis is bullish a name, the packet finally contains a bull case.

This is the TradingAgents debate idea landed where the economics work: adversarial breadth in the slow path, one fast calibrated judge in the hot path.

## The four Conclave questions, resolved by best practice

**Q1 — HOLD-as-opposition: option (a)-in-shadow now, decide at n≥50.** An abstention is not directional evidence; counting it as opposition conflates "no conviction" with "conviction against." But don't flip live behavior on principle alone — the RCF drop-log (live 16:15 ET today) plus the Shadow Outcome Backfiller give paired counterfactuals within days. Shadow-reclassify HOLD→neutral for BOTH sides (side-symmetric; the asymmetric BUY-only variant is regime-overfit bait), log would-have-passed signals, compute forward returns. Decision gate: n≥50 RCF-dropped BUYs with 1h/EOD returns (~2–3 weeks at 15–25/week). Promote to live only if the would-have-passed cohort shows positive expectancy under the current bracket AND the fill-rate/risk footprint stays within Risk Gate limits.

**Q2 — the 5-AND soft-allow is a hard veto wearing a costume.** P(all five) at VIX>20 ≈ 0; conjunctive gates with independent ~50–70% legs multiply to nothing. Replace in shadow with a scored bar: 3-of-5 legs, with VC≥8 (not =10) and bias≥55. Same evidence stream, same promotion gate as Q1. If the council wants extra caution: 4-of-5 for SELLs, 3-of-5 for BUYs is defensible given measured side asymmetry — but ship the symmetric version first and let the data argue.

**Q3 — sequencing: parallel, shared infrastructure.** RCF policy and MTF v8 are different gates with independent failure modes; serializing them wastes the calendar. Run both shadows concurrently, sharing the promotion criteria the Conclave already ratified (≥100–150 resolved episodes, expectancy delta with t≥2, Brier calibration, control cohorts, loud fallbacks). One constraint: only ONE live promotion at a time, two clean weeks apart, so attribution stays possible.

**Q4 — act vs wait: both, with a deadline.** Shadow everything now (zero live risk), review at n≥50 BUY drops or 2026-07-20, whichever first. Hard rule: if the drop-log shows the would-have-passed BUY cohort exceeding +20bp/1h average by n=50, that's a standing quorum to promote Q1's reclassification without another full council cycle. Codify the threshold now to prevent both drift and impulse.

## Model bake-off (30-day, evidence-only)

Starting when the daily-thesis table exists: run the identical per-signal packet through Grok + one Anthropic model + one OpenAI/Gemini model in shadow (3 parallel calls on a 10–20% signal sample to cap G13 spend). Score weekly: directional accuracy at 1h/EOD, Brier score on confidence, HOLD rate on eventual winners, latency p95, cost/signal. Seat goes to the calibration winner; Grok keeps X-sentiment duty regardless (separate leg). Kill criterion for ANY model: HOLD rate >60% on signals that pass deterministic gates — an analyst that mostly abstains is not an analyst.

## Implementation order (IDSD iterations)

1. **Now:** 16:15 ET publish (already scheduled) starts the RCF drop-log. Conclave ratifies this memo (or amends).
2. **This week:** RCF shadow patch (HOLD→neutral + 3-of-5 soft-allow, shadow columns only); `daily_research_thesis` table + pre-market Teams crew run; thesis field added to analyst packet.
3. **Week of 07-13:** forced-choice + reason-coded abstention prompt for the hot-path analyst (shadow AIJSON v2 alongside v1); bake-off harness on sampled signals.
4. **07-20 review:** Q1/Q2 promotion decision on data; bake-off interim read.
5. **30 days:** analyst seat decision; revisit debate-stage question with RCF evidence + v8 score in hand.

## Risks

Regime dependence (VIX 24 window colors everything — the shadow window must include calmer days before promotion); Teams crew latency/reliability as a new morning dependency (mitigate: thesis is advisory-with-TTL — if stale/missing, hot path runs exactly as today, fail-open loud); multi-model spend (sampled 10–20%, G13 alert wired); the standing trap — shipping any of this to live gates before the evidence quorum. Rollbacks: every shadow patch is column-additive; live promotions are single-version republishes.
