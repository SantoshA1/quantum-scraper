# QTP vs Citadel / Renaissance — Honest Readout (2026-07-02)

Requested after Phase 0 completion. This is a capability-maturity comparison, not a returns comparison — QTP has exactly one completed round trip (NVR, −$54, paper). Anyone who compares a 6-week paper diagnostic to Medallion's audited 30-year track record is selling something. What follows is where QTP actually stands, what the benchmark actually is, and the shortest honest path toward it.

## The benchmark, current numbers

| Fund | Return | Context |
|---|---|---|
| Citadel Wellington | **+10.2% in 2025** (net) | Multistrategy, ~$67bn AUM after returning $5bn in profits; tactical trading +18.6%, equities +14.5% |
| Renaissance Medallion | ~66% gross / **~39% net avg** (historical, 30yr) | Employee-only, capped ~$10–15bn, returns capital annually |
| Renaissance RIEF (external) | **~7%/yr** last decade; −15% Oct 2025, +12.6% Nov rebound | AUM $16.5bn, less than half its level 5 years ago |

Two things the numbers teach: (1) even RenTech cannot export Medallion — their external funds do single digits; the 39% machine only works small, capacity-capped, at extreme turnover. That is *encouraging* for QTP: the game QTP plays (small capital, intraday, capacity-irrelevant) is the Medallion-shaped game, not the Wellington-shaped one. (2) Citadel's 10.2% is not an alpha number; it's an *engineering* number — thousands of small edges, ruthlessly risk-managed, compounding with almost no drawdown. That is the standard QTP must match in process before returns mean anything.

## Where QTP stands, dimension by dimension

**Alpha generation — seed found, engine inverted.** Phase 0 proved the scanner's rejected signals carry real gross edge: +15bp/1h (t=2.3), +25bp/EOD; the counter-trend cell earns +35.6bp/1h with a 40% TP rate; BUY-side fades +55.5bp/1h. That is a genuine, measured anomaly — most retail platforms never produce one. But the deployed MTF gate is *anti*-predictive (corr −0.15), the AI leg never ran, and the bracket geometry converts +15bp of edge into +1bp of P&L. Verdict: raw material exists; the refinery currently runs backwards. Citadel-standard gap: they kill inverted signals in days via forced calibration review; QTP took ~6 weeks and an external diagnostic.

**Execution — functional, not competitive.** Alpaca paper, market/bracket orders, one venue, no slippage model, stop hit 59% of the time by geometry. Citadel runs sub-millisecond, venue-optimized, internalized execution. QTP does not need that (its edge horizon is 60 minutes, not microseconds), but it does need: measured slippage per fill, borrow-cost awareness on shorts (~80% of the book), and exits matched to alpha horizon. All absent today.

**Risk management — architecturally ahead of its weight class.** Six enforced safety gates, non-overridable risk manager, kill switches, idempotency, paper/live separation, dead-man's switch, and (as of today) RLS on all 56 quantum tables. This is the one dimension where QTP's *design* genuinely resembles institutional practice. What's missing is statistical risk: no VaR, no factor exposure, no correlation-aware sizing — the book was ~80% short single-name equities and nothing measured that concentration.

**Research process — the actual gap.** Medallion's moat is not any signal; it's the machine that tests thousands of hypotheses with pre-registered rigor and kills losers unemotionally. QTP's equivalents are embryonic but real: council pre-registration, Conclave adversarial review, shadow-first deployment, Phase 0's fit-then-freeze discipline. The failure mode to date has been the opposite of RenTech's: shipping mechanisms (gates, scores, judges) before measuring them. Phase 0 is the first time QTP measured before building. That habit, repeated ~200 times, IS the firm.

**Reliability/observability — improving from a low base.** Silent fallbacks ran for weeks (fake AI judge, unconditional short-block); audit rows lied (blocked_stage NULLs, 17× duplicate writes); signals fire on market holidays. The fixes are known and several shipped. Citadel-standard: a strategy that misbehaves is auto-quarantined in minutes. QTP needs its loud-fallback + daily reconciliation layer finished before any capital scale-up.

## Can QTP "beat" them?

On percentage returns at small capital: **plausibly yes, eventually — because of size, not superiority.** The in-sample counter-trend cell (+10bp/trade under the current bracket, ~40% TP) at, say, 4 trades/day × 250 days compounds to very large annual percentages on small notional — numbers Medallion-scale money mathematically cannot achieve. But that sentence carries every caveat in the Phase 0 report: one regime, in-sample, gross of slippage/borrow, n=34 in the key cell. The honest claim today is: *QTP has located one measurable gross edge and has not yet demonstrated the ability to monetize any edge net.*

On what actually makes those firms great — calibrated risk, verified execution, hypothesis discipline, decade-long survival across regimes: **QTP is a promising seed roughly at "quant firm, week one" maturity**, with an unusually good safety architecture and an unusually honest diagnostic loop for its size.

## Shortest path (next 90 days, in order)

1. Monday 07-06: v7 green check (already scheduled) — verify before anything else moves.
2. MTF v8 shadow candidates (A/B/C per design draft) + bracket geometry re-fit — the two levers Phase 0 proved matter. Target: first *net-positive* shadow cohort of ≥150 episodes.
3. Execution accounting: log realized slippage + borrow cost per paper fill; without it, no shadow result is trustworthy.
4. Statistical risk floor: daily exposure summary (net/gross, side skew, top-name concentration) into the Daily Summary report.
5. Only then: scale paper size, and revisit the debate/LLM layer with bands defined by a score that actually ranks.

Measured against that plan, "better than Citadel" stops being a slogan and becomes a sequence of falsifiable milestones — which is exactly how the firms you're chasing were built.

## Sources

- [CNBC — Citadel flagship rises 10.2% in volatile 2025](https://www.cnbc.com/2026/01/02/ken-griffins-flagship-hedge-fund-at-citadel-rises-10point2percent-in-volatile-2025.html)
- [Bloomberg — Citadel Wellington climbed 10.2% last year](https://www.bloomberg.com/news/articles/2026-01-02/citadel-s-flagship-hedge-fund-wellington-climbed-10-2-last-year)
- [Tekedia — Citadel returns $5bn in 2025 profits, AUM $67bn](https://www.tekedia.com/citadel-to-return-5bn-in-2025-profits-to-investors-trimming-assets-to-67bn-amid-subdued-performance/)
- [Rupak Ghose — Renaissance under pressure (RIEF Oct 2025, AUM)](https://rupakghose.substack.com/p/renaissance-technologies-under-pressure)
- [QuantifiedStrategies — Medallion Fund returns](https://www.quantifiedstrategies.com/medallion-fund-returns/)
- [Institutional Investor — Renaissance October losses](https://www.institutionalinvestor.com/article/renaissance-suffers-huge-losses-october)
