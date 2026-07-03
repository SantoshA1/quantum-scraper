# MTF Score v8 — Design Draft (2026-07-02)

**Status: DRAFT for Quantlys Conclave review. Nothing ships without Conclave verdict + PO auth. Shadow-first, no live gate changes.**

## Why v7 must be replaced, not re-thresholded

Phase 0 (189 episodes, May 20–Jul 2) + leg attribution (188 matched episodes, this session):

| Evidence | Value |
|---|---|
| corr(blended score, r60) | **−0.147** |
| corr(swing leg, bracket P&L) | **−0.177** (worst leg) |
| corr(long_term leg, bracket P&L) | −0.150 |
| corr(scalp leg, bracket P&L) | −0.087 (flat/non-monotonic) |
| Counter-trend scalps (scalp≥60, swing<40) | **+35.6bp/1h, +10.2bp bracket, 40% TP** (n=34) |
| Fully aligned (scalp≥60, swing≥55) | −3.5bp/1h, −7.3bp bracket, 21% TP (n=28) |
| BUY with scalp<55 | **+55.5bp/1h, +13.5bp bracket, 42% TP** (n=26) |
| AI leg (`mtf_confluence_score_ai`) | populated 5/10,125 rows, always = det. **Never ran.** |

The defect is structural: a SCALP profile (60-minute bracket hold) is scored ~50% by DAILY/WEEKLY and MONTHLY/QUARTERLY alignment. At a 1-hour horizon in this window, signals aligned with higher-timeframe trend are *extended* and mean-revert against the trade; signals fading that trend perform best. "Confluence" as an additive blend is directionally wrong for this horizon. Moving the threshold (50/60/65) just slides along an inverted axis — that is why every re-tune (v7 included) has failed to help.

## v8 design principles

1. **Horizon-match the gate.** The scalp gate consumes only horizon-relevant inputs. Swing/LT legs are REMOVED from the blend (weight 0) — retained as logged features only, for regime learning.
2. **Do not naively flip the sign.** The counter-trend edge is measured on one 6-week regime (n=34 in the key cell). Flipping "confluence" into "anti-confluence" on this sample is overfitting bait. Instead v8 ships as *candidates* in shadow, and this episode set is treated as in-sample only.
3. **Score must earn its place.** Any leg that fails calibration monotonicity in shadow (higher score → higher expectancy, Brier improvement vs base rate) gets weight 0. A gate that cannot beat "trade everything the scanner emits with correct sizing" is deleted, not tuned. (This is the deployed-state analog of the veto stack lesson.)

## Candidate scores (shadow, in parallel)

- **v8-A (null-confluence baseline):** gate = scalp leg only, threshold at scalp≥50. Purpose: isolate whether the scalp leg alone carries any signal. Expected from in-sample: roughly flat — this is the control.
- **v8-B (regime-conditional fade tilt):** score = scalp leg + counter-trend term `max(0, 55 − swing_score) × k` (k≈0.3), i.e. reward high scalp + low higher-TF alignment. In-sample this selects the +35bp/1h cell. MUST prove itself out-of-sample in shadow before any weight goes live.
- **v8-C (side-aware):** v8-B with separate BUY/SELL calibration (BUY alpha 6× SELL in-sample; scanner is ~80% SELL). Also the natural home for the scanner-skew investigation.

All three log to shadow columns (`shadow_mtf_score`, `shadow_mtf_decision` already exist in `exec_flow_audit`) with `shadow_engine_v` = `V8A/V8B/V8C`.

## Paired fix — bracket geometry (F4)

Score fixes are pointless while the exit model coin-flips: SL 0.3% was hit on 59% of episodes; raw +15bp/1h collapses to +1bp under the bracket. v8 shadow evaluation must run under BOTH exit models:
1. current TP0.6/SL0.3/60m (for comparability), and
2. candidate geometry: ATR(14, 5m)-scaled stop (≈1.2×ATR), TP 2×stop, 90–120m timeout — parameters to be fit on the Phase 0 episode CSV *then frozen* before shadow.

## Promotion criteria (per Conclave mods #5/#6)

≥100–150 resolved shadow episodes per candidate; expectancy delta > +0.15%/trade vs v7 baseline with t≥2; calibration monotonic across score deciles; no degradation on clean-pass controls; fallback-rate and latency (G12) + spend (G13) instrumented. Candidates that fail die loudly in the read-out — no silent re-tunes.

## Non-goals

No LLM/debate stage in this iteration (Phase 0 killed the 50–65 premise). No live threshold changes. No touching Monday's v7 green-check verification — v8 shadow work must not deploy before that verdict is in.

## Open questions for Conclave

1. Is the counter-trend term (v8-B) acceptable as a *candidate*, or does the one-regime sample demand a longer observation window first?
2. Should swing/LT legs survive as a **hard veto in the extreme** (e.g. swing>85 = blocked) even at weight 0, as tail protection?
3. Bracket re-fit: fit-then-freeze on Phase 0 episodes, or hold out half the episodes for validation?
4. Does v8-C's side-aware calibration mask the scanner SELL-skew defect rather than fix it upstream?

## Test automation (intent-driven, not spec-driven)

Outcome-verified tests only: (T1) replay the 189 Phase 0 episodes through each candidate scorer and assert expectancy ordering v8-B > v8-A > v7 in-sample (guards implementation, not thesis); (T2) property test — scorer output invariant to duplicate audit rows (the ~17× dup bug); (T3) holiday-calendar guard — scanner emissions on NYSE holidays must be dropped and logged (`blocked_reason='CALENDAR_CLOSED'`); (T4) fail-loud test — shadow scorer exception must write `DEBATE_FALLBACK_`-style loud audit row, never a silent det copy (the v7 AI-leg failure mode, regression-pinned).
