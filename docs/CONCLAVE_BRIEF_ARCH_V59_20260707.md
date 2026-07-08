# Conclave Review Request — Architecture v5.9 (Architect Revision, 2026-07-07)

Self-contained brief. Paste as-is. Review target: the architect's revision (v5.9) of the platform architecture (v5.8), which the platform owner will attach or summarize alongside this brief.

## Context

An automated paper-trading platform (n8n pipeline → Alpaca, Supabase data plane, LLM-assisted gates) just completed a diagnostic cycle: a reject-backtest (189 episodes) proved the deployed confluence score anti-predictive (corr −0.147, blocked signals +15bp/1h gross), the bracket exit model destroys the edge (stop hit 59% of episodes), and a week of incident forensics found seven silent failures (fake AI judge, dead vision call, 16×-too-wide stops, frozen book from an unprotected orphan position, dead monitors). All were root-caused and fixed with verified one-step rollbacks. Governance now requires shadow-first changes, calibration-gated promotions (Brier improvement + t≥2 + mixed-regime window), and one live promotion at a time.

The v5.8 architecture doc honestly registers 21 gaps. The architect's v5.9 revision makes five structural decisions on top of it. The council is asked to attack each.

## The five decisions under review

**D1 — Mothball the Discovery Engine.** v5.8 includes a strategy-discovery subsystem: Playwright scrapes TradingView scripts, Grok-4 vision scores chart screenshots 1–10 via a "senior quant trader, be decisive" prompt, results go to Google Sheets and Telegram. It has no backtest evidence, no bridge to production (v5.8's own G15), and its output has never been consumed by the live pipeline. v5.9 mothballs it until candidates are ranked by replay expectancy on the same frozen-episode harness the reject-backtest used. Rationale: the platform's deployed *quantitative* score was just proven anti-predictive; an unvalidated LLM opinion on a screenshot is strictly weaker evidence, and the subsystem costs maintenance + spend.

**D2 — Every defense layer faces the evidence harness or dies.** v5.8 advertises "14 defense layers." The diagnostic showed several layers *delete* alpha (higher-timeframe confluence legs anti-predictive; a regime-conflict veto systematically killed the 6×-alpha BUY side). v5.9 doctrine: within 60 days each layer must show, on the shared counterfactual harness, that its kills have negative expectancy — validated layers stay, inverted layers die, unmeasured layers get instrumented or retired. Target steady state ~6–8 layers.

**D3 — Four-plane decomposition.** Alpha plane (hot path: scanner → few validated gates → cost-accounted execution), Research plane (pre-market thesis crew, reject-backtest harness, 30-day model bake-off, mothballed discovery), Safety plane (sentiment kill, fail-closed risk gate, stop-protection ladder, kill switches), Proof plane (telemetry, per-fill cost truth, statistical risk floor, governance). Public-facing website and CI/CD removed to a separate doc.

**D4 — Gap re-prioritization.** Elevated: score fix + bracket geometry (joint #1), per-fill slippage/borrow accounting (#2, gates all shadow numbers), NEW gap "order-lifecycle events invisible to the audit trail — only fills are ingested, stop/bracket orders never appear" (#2, caused two multi-hour forensic hunts this week). Downgraded/merged: staging-mirror deferred until real money (draft/publish + paper-only is the de-facto staging today); manual-approval workflow merged into the existing council-verdict + owner-auth governance; broker-auth fail-closed re-scoped to credential wiring since the risk gate already fail-closes the book (proven live this week).

**D5 — The proof line.** Six-week sequence: (1) ATR-fit brackets on frozen episodes; (2) first calibration-gated live promotion from the drop-log cohort (deadline 07-20); (3) per-fill cost truth online; (4) replacement score must beat "trade everything the scanner emits, correctly sized" out-of-sample; (5) THE MILESTONE: a ≥150-episode shadow cohort net-positive after modeled costs — only then scale paper size, and only after that revisit discovery and any debate-stage machinery.

## Questions for the council

1. **D1 adversarial:** Mothballing discovery kills the platform's only exploration arm. Is the architect over-rotating on this week's evidence — sacrificing long-term optionality (new strategy sourcing) for short-term hygiene? Or is unvalidated exploration genuinely worse than none? If you would keep it alive, specify the minimum evidence standard that makes its output usable.
2. **D2, the hard one:** Evidence-gating *safety* layers has a survivorship trap — a layer that protects against rare tail events (e.g., the sentiment kill, halts, circuit breakers) will show near-zero measurable value in a 60-day window and could be wrongly executed. How should the doctrine distinguish alpha-filtering layers (measurable, must prove expectancy) from tail-protection layers (rarely fire, justified by scenario analysis instead)? Propose the classification rule.
3. **D3:** Is the four-plane decomposition right? What is mis-assigned or missing — specifically, does anything Citadel-grade (e.g., capacity analysis, regime detection, portfolio construction) deserve a plane *now* rather than after the milestone?
4. **D4:** Rank the re-prioritized gap list. Is deferring the staging mirror until real money defensible, or is it precisely backwards (staging is cheapest to build while stakes are low)?
5. **D5:** Is "≥150 episodes net-positive after modeled costs" the right scaling gate? Attack the number: sample size vs regime coverage vs episode independence (signals cluster on days). Should the milestone require a minimum number of distinct regime-days or a block-bootstrap significance test instead of a raw count?
6. **Meta:** v5.9's closing rule is "nothing ships unmeasured, nothing unmeasured survives." Name the one thing in v5.9 itself that is currently unmeasured and would violate its own rule first.

Deliver: verdict per decision (ratify / amend / reject, with the amendment text), ranked top-3 risks of adopting v5.9 as written, and answers to Q2 and Q5 in implementable form (rules, not sentiments).
