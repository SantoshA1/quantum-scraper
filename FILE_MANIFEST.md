# File Manifest for Perplexity Deployment

Every file the deploying agent needs, organized by priority and purpose. Paths are relative to the repo root (`/Users/santoshadari/Documents/Claude/Projects/Quantlys Engine/`).

## How to use this manifest

1. Read `DEPLOYMENT_PROMPT.md` first — that's the operational brief
2. Then verify every file below is present in the working tree with the indicated purpose
3. Commit them on a feature branch per Phase 1 of the prompt
4. Execute deployment phases 1-7 in order

---

## Tier 1 — Must read before doing anything (3 files)

| File | Purpose |
|---|---|
| `DEPLOYMENT_PROMPT.md` | The operational brief — seven phases, rollback procedures, hard constraints |
| `SHADOW_VALIDATOR.md` | FastAPI service operational doc — n8n integration recipe, run commands |
| `DRIFT_VERDICT.md` | Per-module parity verdict; useful for confirming Phase 2 didn't regress |

## Tier 2 — Production code (the actual deployable artifact)

These are the Python files that get deployed onto the VM. They must all be present together; do not deploy a partial subset.

| File | Purpose |
|---|---|
| `qtp_server_side/__init__.py` | Package init |
| `qtp_server_side/shadow_validator.py` | **The FastAPI service** — the actual deploy target |
| `qtp_server_side/run_drift_manifest.py` | Offline drift runner; used in Phase 2 verification |
| `qtp_server_side/diff_at_bar.py` | Per-bar diagnostic — useful for investigating drift alerts post-deploy |
| `qtp_server_side/split_tv_export.py` | TV CSV → fixture; needed when user does ensemble re-export later |
| `qtp_server_side/drift.py` | Drift tolerances + comparison helpers |
| `qtp_server_side/indicators.py` | Shared indicator library (EMA, RSI, MACD, ADX, BB, ATR, Stoch, CCI, PSAR, VWAP, etc) |
| `qtp_server_side/payload.py` | Canonical payload field definitions |
| `qtp_server_side/super_score_pro_v25.py` | Python port — **20/20 PASS** parity confirmed |
| `qtp_server_side/webhook_bridge_v8.py` | Python port — **3/3 PASS** parity confirmed |
| `qtp_server_side/quantum_swing_v83.py` | Python port — **22/24 PASS** (2 documented gaps) |
| `qtp_server_side/ensemble_engine_v1.py` | Python port — plumbing wired, awaiting user Pine paste for full parity |
| `qtp_server_side/quantum_scalp_strategy_v5.py` | Python port — module shipped; no Pine source in user's TV account yet |

## Tier 3 — Pine source + manifest (reference only)

These document the canonical Pine versions the Python was ported from. Not deployed to the VM but should be committed in the repo for traceability.

| File | Purpose |
|---|---|
| `pine-source/manifest.json` | Catalog of 5 Pine files with sha256 hashes + feature flags |
| `pine-source/ai_super_score_pro_v25_universal.pine` | Pine source, hash `01a2eedf…` matches manifest |
| `pine-source/ai_super_score_ensemble_engine_v1.pine` | Pine source — uploaded version hash mismatches manifest (`7194db96` vs `0d3e3485`); user has newer rev |
| `pine-source/ai_super_score_webhook_bridge_v8.pine` | Pine source, hash matches manifest |
| `pine-source/quantum_scalp_strategy_v5.pine` | Pine source — uploaded version hash mismatches manifest |
| `pine-source/quantum_swing_v83_adaptive_multi_ticker.pine` | Pine source (added this session) |

## Tier 4 — Fixtures + reports (verification only)

Test fixtures used by `run_drift_manifest.py` in Phase 2. Required for the verification test, not for the runtime validator.

| File | Purpose |
|---|---|
| `pine-reference/ohlcv/*.csv` | OHLCV bars per module, parsed from user's TV exports |
| `pine-reference/outputs/*.csv` | Pine reference outputs per module |
| `qtp_server_side/drift_report.json` | Latest drift run output (296 KB) — represents current parity state |

## Tier 5 — Reference docs

| File | Purpose |
|---|---|
| `PINE_PATCHES.md` | All 7 Pine plot patches written this session, including the pending Ensemble v1 one |
| `EXPORT_GUIDE.md` | Manual TradingView CSV export procedure (for the user when they need to re-export) |
| `FILE_MANIFEST.md` | This file |

## Files explicitly NOT to deploy

- `qtp_server_side/__pycache__/` — Python bytecode, regenerate locally
- Any `.csv` not under `pine-reference/` (those are diagnostic uploads from session work)
- `qtp_server_side/drift_report.json` — generated artifact, not source

---

## Current parity scores (snapshot for Phase 2 verification)

When the deploying agent runs the drift manifest in Phase 2, the output should match:

```
super_score_pro_v25:       20/20 PASS  (EXACT PARITY)
webhook_bridge_v8:          3/3  PASS  (EXACT PARITY)
quantum_swing_v83:         22/24 PASS  (psar + weekly_dd_pct drift — known gaps)
ensemble_engine_v1:         2/5  PASS  (adx + rel_vol exact; 3 scoring fields drift on user-input-dependent manual_bull_score — design boundary, not bug)
quantum_scalp_strategy_v5: SKIPPED      (no Pine fixture available)
```

If any score regresses from the above (other than ensemble_engine_v1 progressing forward), stop and investigate before continuing deployment.

## Quick file count

```
3 Tier-1 docs
13 Tier-2 Python files
6 Tier-3 Pine + manifest files
~10 Tier-4 fixture/report files
3 Tier-5 reference docs
─────────────────────────────
~35 files total
```

A `git ls-tree -r HEAD --name-only` on the feature branch after Phase 1's commit should show approximately this count.
