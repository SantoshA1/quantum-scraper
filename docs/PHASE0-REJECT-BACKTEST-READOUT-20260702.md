# Phase 0 Reject-Backtest — Read-Out (2026-07-02)

**Status: COMPLETE.** This is the diagnostic the 06-01 council pre-registration (A_FULL_CONVICTION) and the 07-02 Conclave verdict both mandated before any MTF tuning or debate-stage build. Executed by architect (Claude) — Supabase `quantum.exec_flow_audit` cohort + Massive Market Data 5-minute bars.

## Verdict in one line

**Blocked signals are NOT losers — but the alpha is NOT where the debate-stage proposal assumed, and the MTF confluence score is not positively predictive of outcomes. Do not build the Bull/Bear/Judge stage against the 50–65 band. Fix the score and the bracket geometry first.**

## Methodology

- Cohort: `exec_flow_audit` rows with `mtf_confluence_score > 0` and final decision PASS/BLOCK, 2026-05-20 → 2026-07-02 (audit data does not exist before ~May 7; **the council's "6-month replay" is impossible — 6 weeks is the maximum honest window**).
- Raw 10,125 rows collapse to **611 unique setups** (audit writes ~17 duplicate rows per evaluation), further collapsed to **193 independent episodes** (same symbol+side+score within 60 min = one episode) across the 78 symbols with ≥3 setups. 189 episodes had market data (4 fired on Memorial Day / Juneteenth — see data-quality findings).
- Coverage-bias check: unanalyzed tail (304 setups, 1–2 per symbol) matches analyzed cohort on score (51.1 vs 51.3), band mix (46% both), pass rate — no material bias.
- Per episode: entry = open of first 5-min bar after signal ts (RTH only); side-adjusted forward returns at +15m, +60m, EOD; bracket simulation TP +0.6% / SL −0.3% / 60-min timeout (the PFM PAPER_FILL_V1 geometry), first-touch ordering, same-bar-both = SL (conservative).
- Spot-verified by hand (USO 06-09 episode: entry 131.23, TP touch 130.385 vs threshold 130.44, r60 +194bp ✓).

## Results (gross, basis points, side-adjusted)

### Blocked vs Passed

| Cohort | n | r60 mean | r60 t | EOD mean | EOD t | Bracket mean | TP rate |
|---|---|---|---|---|---|---|---|
| BLOCKED (all) | 169 | **+15.4** | +2.31 | **+25.3** | +2.40 | +1.1 | 28% |
| PASSED | 19 | −13.1 | −0.49 | +31.2 | +0.61 | −8.9 | 16% |

### Blocked, by MTF score band (bracket = the exit model the platform actually trades)

| Band | n | r60 | Bracket mean | Bracket t | TP rate |
|---|---|---|---|---|---|
| <40 | 30 | +28.0 | +4.1 | +0.56 | 30% |
| **40–50** | 42 | +22.2 | **+14.1** | **+2.09** | **45%** |
| 50–60 | 63 | +12.0 | **−5.7** | −1.24 | 19% |
| 60–65 | 23 | +10.0 | +0.7 | +0.07 | 30% |
| 65+ | 11 | −14.1 | −17.1 | −2.12 | 9% |
| 50–65 (proposed debate band) | 86 | +11.5 | **−4.0** | −0.97 | 22% |

### By side (blocked only)

| Side | n | r60 mean | r60 t |
|---|---|---|---|
| SELL | 134 | +7.6 | +1.05 |
| **BUY** | 35 | **+45.3** | **+2.99** |

Correlation(MTF score, r60) among blocked: **−0.137** (weakly negative).

## Findings

**F1 — Buried alpha is real.** Blocked signals earned +15bp/1h and +25bp/EOD gross (both t>2.3). The veto stack has been discarding directionally correct signals. The 06-01 "system correctly cautious" framing does not survive contact with forward returns.

**F2 — The MTF confluence score is not a positive predictor. Point estimates are inverted.** Deep rejects (40–50) outperform every other band under the real bracket (+14.1bp, 45% TP, t=+2.09); the highest-scoring cohorts (65+ blocked, and PASSES) perform worst (−17.1bp and −8.9bp bracket). PASS n=19 is too small to declare inversion conclusively, but there is **zero evidence the score ranks setups correctly**, and weak evidence it ranks them backwards.

**F3 — The proposed debate band (50–65) is the wrong target.** Under the platform's actual TP0.6/SL0.3/60m exits it nets −4bp. Rescuing this band as proposed would have lost money. The Conclave's skepticism (Risk #1: "rescuing garbage faster") was directionally right — but for the inverse reason: the band is mediocre while the *deep* rejects are the alpha pocket.

**F4 — The bracket geometry destroys the edge.** Raw directional edge (+15bp/1h, growing to +25bp by EOD) collapses to +1bp under the bracket because the −0.3% stop is hit on 59% of episodes (100/169) before the +0.6% target or timeout. The alpha horizon (hours) is mismatched to the stop width (intraday noise). A 2:1 reward:risk bracket with a stop inside ~1σ of 60-min realized vol is a coin-flip harvester.

**F5 — BUY-side alpha is 6× SELL-side.** +45.3bp vs +7.6bp at 1h. The scanner emits ~75–81% SELLs; the book is concentrated in the weak side. (Consistent with the 06-30 finding that the short-block bug was masked for weeks precisely because the book was ~90% SELL.)

**F6 — Data-quality: signals fired on market holidays** (Memorial Day 05-25, Juneteenth 06-19 — 4 episodes with no market open). Scanner runs on closed days; add a trading-calendar guard.

## Decisions this forces (per Conclave mod #1)

1. **Debate stage: DO NOT BUILD as specified.** The premise (marginal band 50–65 = false-rejection pocket) is empirically wrong. Per the Conclave's own conditional: "If rejects are losers, do not build — retune instead." Rejects aren't losers, but the score that defines the bands is unreliable, so a judge keyed to those bands inherits a broken input. Revisit only after F2/F4 fixes, with bands redefined by whatever replaces the current score.
2. **P0 = MTF score diagnosis/recalibration.** The score is anti-predictive in this window. Before any threshold tuning (50 vs 60 vs 65 — all rearrange deck chairs), determine *why*: leg attribution (deterministic vs the never-ran AI leg), staleness, or inverted component weighting. The 06-01 council P0 (veto-leg attribution) stands, now with evidence the score itself — not the threshold — is the defect.
3. **P0b = bracket geometry review.** Widen SL or lengthen horizon: at current width the platform cannot monetize even a genuinely correct signal stream. Candidate: ATR-scaled stops, or EOD exit for signals passing a recalibrated gate. Backtest both against this episode set before shipping.
4. **P1 = BUY-side rebalance.** The scanner's SELL bias concentrates the book in the low-alpha side. Investigate whether the SELL skew is by design or a scanner defect.
5. **P1b = trading-calendar guard** (holiday signals).

## Caveats (read before quoting numbers)

Single 6-week window, one regime (May 20 – Jul 2 2026); episodes cluster on days (returns not fully independent); gross of spread/slippage/borrow — SELL shorts on thin names would net worse; entry modeled at next-bar open (real fills may differ); PASS cohort n=19; ~50% of setups analyzed (tail verified similar on observables); band definitions inherited from the deployed score, which F2 says is unreliable. This is a diagnostic, not a strategy backtest. t-stats assume independence they don't fully have — treat >2 as "worth acting on," not "proven."

## Artifacts

- Per-episode results: `phase0_episode_returns_20260702.csv` (189 rows: sym, side, score, decision, r15/r60/rEOD bp, bracket outcome)
- Cohort source: `quantum.exec_flow_audit` (dedupe SQL in report history, 2026-07-02 session)
- Prior stalled attempt: `quantum.phase0_buried_alpha_candidates` (3,643 rows, May 20–29 only, fwd returns never backfilled) — superseded by this read-out
