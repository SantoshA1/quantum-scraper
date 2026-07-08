# Cost-Model Self-Validation v0 — Slippage Residuals (2026-07-07)

Conclave Q6 mandate: the cost model must measure itself before it gates anything. This is the first measurement. Method: all 19 market-order fills Jul 6–7 (dedup'd) vs prior-1-min-bar close reference (Massive 1-min aggregates). Negative = fill worse than reference (a cost).

## Residual distribution (bp per fill side, signed as cost)

| Fill | slip bp | | Fill | slip bp |
|---|---|---|---|---|
| TEL short 13:35 | −61.6 | | OTIS cover 15:45 | +2.7 |
| HWM buy 13:38 | +18.6 | | ULTA cover 15:45 | −11.3 |
| F short 13:40 | −93.7 | | WDAY cover 15:45 | −8.3 |
| NEE buy 13:42 | −21.6 | | TEL cover 15:45 | −4.5 |
| CBRE buy 13:42 | −32.0 | | HWM sell (7/7) | +33.2 |
| ULTA short 14:11 | −19.1 | | HWM buy (7/7) | −6.7 |
| OTIS short 14:31 | −2.8 | | HWM sell (7/7) | −18.7 |
| NEE sell 14:46 | +5.7 | | CBRE buy (7/7) | −2.1 |
| WDAY short 15:01 | −9.1 | | CBRE sell (7/7) | −10.6 |
| CBRE sell 15:14 | −9.2 | | | |

**Mean −13.2bp / median −9.2bp per fill side → ≈ −20 to −26bp per round trip** under the current all-market-order execution. Opening-burst fills (13:30–13:45 ET) are the worst (F −94, TEL −62; reference staleness inflates these somewhat — treat as upper bound) — ex-open mean ≈ −9bp/side.

## Why this matters (the Conclave's Q6, confirmed empirically)

Phase 0's headline edge was **+15.4bp/1h gross**. A ~−20bp round-trip slippage cost, previously assumed zero, **consumes the entire measured edge**. Every prior shadow number that said "net-positive" under zero-cost assumptions is unproven. This is not a reason to stop — it is the exact number the bracket re-fit and v8 evaluation must now clear, and it argues for: (1) limit/marketable-limit entries instead of pure market orders, (2) avoiding the opening 15 minutes for market-order entries, (3) an effect-size floor ≥ ~25bp in the D5 milestone gate (which the ratified day-block bootstrap already requires: 5th percentile > modeled round-trip cost — that cost is now measured, not assumed).

## Caveats

n=19 fills, two sessions, one regime; prior-minute-close reference is imperfect (stale at the open — direction of bias inflates cost estimates); paper-fill simulation may differ from live microstructure in either direction. v1: the Order Lifecycle Ingestor (live as of today) captures submit-vs-fill timing so future residuals use submit-time reference; recompute weekly; publish rolling distribution to the Proof plane.
