# QTP ACTION LOG — 2026-08-05
**Session:** claude-architect + PO + Conclave · **Governance rows:** 176–185 · **CI at close:** 28/28 suites
**Branch:** `fix/tsm-bars-window-20260804` (commits `06f24fc → de67350`, not pushed)

## Deployed today (chronological)

| # | Change | Version / Where | Proof | Gov | Commit |
|---|---|---|---|---|---|
| 1 | **K3 cooldown fires on LOSS exits only** — winner re-entries (AKAM-class) no longer blocked | Gate-K **v2.2** (`compute_kelly_gate`) | Fixture flip live: loss still blocks, +$500 'stop'-labeled win approves | 177 | `5282215` |
| 2 | **K1 regime filter armed for the first time ever** — gate mapped to real labels (RISK_ON blocks shorts, RISK_OFF blocks longs, CHOP neutral); 'UP'/'DOWN' had never existed in regime_state | Gate-K **v2.3** | Rollback-safe probes: first K1 block in its existence; CHOP neutrality proven | 178 | `733c987` |
| 3 | **Scanner freeze RCA + fix** — margin kill-switch (Alpaca `initial_margin`) froze the book 09:40→13:20 ET invisibly; guard moved to reg-T proxy; tripped cycles now write a visible pause row + marker router | Scanner **v3.5** (`975pZZEtxeUbzI22`) | Pre-patch trip reproduced (1.1s/[]); post-patch full scan emitted ADM; **AEP SELL filled 13:35 ET** — first order since 09:36 | 179 | `ffd0cbe` |
| 4 | **Capacity coherence** — margin cap 35%→50% (gross ≤ 1.0× equity); pre-entry sim factor 0.25→0.5 (breaches stop *before* entry) | Scanner **v3.6** | WYNN emission arithmetically impossible under v3.5 sim; emitted under v3.6 | 180 | `2c60dd7` |
| 5 | **Conclave brief: Kelly activation at n=40** — loss column proven unfit (empty −1R bucket, 92% uncertified writers, winner-'stop' rows, k\* sign-flips on honest correction) | `docs/CONCLAVE-BRIEF-KELLY-ACTIVATION-20260805.md` | Evidence pack, reproduction queries | — | `a0f7be1` |
| 6 | **PIN_PROBATION** (Conclave step 1) — `min_trades` floored at 200, caller-proof; `measurement_not_certified` ≠ `negative_measured_edge` encoded | Gate-K **v2.3.1** | Live: explicit `p_min_trades=40` still pins; trade #40 defused | 181 | `2b55438` |
| 7 | **Short-side 0.5× multiplier** (Conclave item 2i) — bearish risk halved (0.50%→0.25%); releases only on certified short PF > 1.0 over ≥20; fabricated rows invisible to trigger | Gate-K **v2.4** | Live flip: bearish $267.45 / bullish $534.90; release live-twin (21 certified shorts → 1.0×) | 182 | `2b55438` |
| 8 | **Maya matrix caught v2.4 crash** — unassigned plpgsql record killed every bullish call in a fresh session; fixed with scalars. *Standing rule: matrix opens bullish-first* | Gate-K **v2.4.1** | 16/16 live probes green; caught pre-open, zero production impact | 183 | `6bc1329` |
| 9 | **H5 certified heal** (Conclave step 3) — last uncertified exit writer closed; labels classified from `order_events` lifecycle; unreconstructables quarantined (`r_multiple=NULL`) | H5 **v3** (`RKK5aLIXKhNrVPpD`) | First touch healed WSM exit as **'trail'** (4 events, 2 stop prices) — v2 would have faked 'stop' | 184 | `de67350` |
| 10 | **R recompute from fills** (step 4) — ROOT CAUSE: denominator, not just labels (real stops risk ~$97 vs recorded $250–500); 38 rows recomputed (24 own-stop, 13 sibling, 1 quarantined); immutable trail `quantum.r_multiple_corrections` | ledger backfill | −1R bucket restored: 19/24 stop-losses in [−1.25,−0.8] (was 0) | 185 | `de67350` |
| 11 | **Acceptance gate 5/5 PASS → UNPINNED** (step 5) — honest verdict: `avg_loss_r` 1.033, win 18.4%, avg win 2.94R → **k\* = −0.099, sign-stable** | Gate-K **v2.5** | Bullish-first probes green; no pin marker; 23 certified shorts hold 0.5× | 185 | `de67350` |

*(Earlier this session, pre-dating this log's window: ingestor heartbeat v1.2 [gov 175], VC score-semantics decode, TSM bars-window + H4 v2 deploys [gov 173–174, 08-04].)*

## System state at close (2026-08-05 ~21:00 UTC)

- **Gate-K v2.5**: probation 0.50% long / 0.25% short; at trade #40 (~2 closes) → `negative_measured_edge` **halts new qtp-main-pipeline entries** — the honest verdict the Conclave pre-authorized ("up, down, or off"). Rolling 90d window; verdict self-updates as certified trades accrue.
- **Scanner v3.6**: emitting; margin proxy ~34% of 50% cap; kill-switch trips are loud (Telegram + pause row).
- **Book**: 6 open (WMT, AES, XPEV short · DGX, ALLE long · AEP short); WSM closed −$113 (trail).
- **Every exit writer is now certified**: H4 v2 (live) + H5 v3 (nightly). Convicted writers can no longer add rows.

## Watch tomorrow

1. First production gate calls on v2.5 (bullish-first crash class — matrix says clean).
2. Trade #40 → expect `negative_measured_edge` on qtp-main-pipeline; scanner keeps emitting, gate declines. That is correct behavior, not a failure.
3. H5 nightly 2 AM run — first scheduled certified heal.
4. Kill-switch behavior at the 50% line if the book grows.

## Open items (next Conclave / PO)

- **Stop-vs-budget mismatch (NEW)**: entries risk ~$97 actual vs ~$318 gate-approved — entry path's stop placement and gate sizing disagree ~3×. Decide which is intended.
- Regime Service 09:25 seed (C4 cold start) · VC C1–C3, C5 · RCF exemption · G17 slippage 26bp vs 13.2bp model.
- Branch push to origin (7+ commits local-only — PO call).

## Rollback pointers

Gate-K: re-apply `qtp_gate_k_v2_3_1_pin_probation_20260805` (re-pin) or earlier bodies per governance chain 177–185 · Scanner: republish `301d1f0e` (v3.5) / `4b5f0dd6` (v3.4) · H5: republish `da7c60ef` (v2) · R recompute: reversible row-by-row from `quantum.r_multiple_corrections.before_*`.
