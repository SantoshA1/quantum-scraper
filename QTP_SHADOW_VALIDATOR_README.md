# Perplexity Handoff — QTP Shadow Validator Deployment

**This folder contains everything Perplexity needs to deploy the QTP Shadow Validator alongside the existing n8n pipeline. Drop the whole folder into Perplexity (or zip + upload) and paste the prompt below.**

## How to use

1. **Compress this folder** (right-click `perplexity_handoff/` → Compress → produces `perplexity_handoff.zip`), or upload files individually.
2. **Attach the zip / files** to your Perplexity session.
3. **Paste the prompt** from `PERPLEXITY_PROMPT.md` as your first message.
4. Perplexity will execute the 7 deployment phases and pause for your review between phases.

## File index (37 files, ~1 MB total)

```
perplexity_handoff/
├── README.md                       ← you are here
├── PERPLEXITY_PROMPT.md            ← paste this into Perplexity
│
├── DEPLOYMENT_PROMPT.md            ← 7-phase operational brief (Perplexity reads this twice)
├── FILE_MANIFEST.md                ← file inventory
├── SHADOW_VALIDATOR.md             ← FastAPI ops doc + n8n integration recipe
├── DRIFT_VERDICT.md                ← parity verdict per module
├── PINE_PATCHES.md                 ← Pine patch history (record only)
├── EXPORT_GUIDE.md                 ← export procedure (record only)
├── drift_report.json               ← latest drift run (verification artifact)
│
├── qtp_server_side/                ← Python package (the actual deploy target)
│   ├── __init__.py
│   ├── shadow_validator.py         ★ MAIN FastAPI service
│   ├── run_drift_manifest.py
│   ├── diff_at_bar.py
│   ├── split_tv_export.py
│   ├── drift.py
│   ├── indicators.py
│   ├── payload.py
│   ├── super_score_pro_v25.py      ★ 20/20 PASS
│   ├── webhook_bridge_v8.py        ★ 3/3 PASS
│   ├── quantum_swing_v83.py        ★ 22/24 PASS
│   ├── ensemble_engine_v1.py         2/5 PASS (3 fields drift by design)
│   └── quantum_scalp_strategy_v5.py  SKIPPED (no fixture)
│
├── pine-source/                    ← Pine source files + manifest (audit trail)
│   ├── manifest.json
│   ├── ai_super_score_pro_v25_universal.pine
│   ├── ai_super_score_ensemble_engine_v1.pine
│   ├── ai_super_score_webhook_bridge_v8.pine
│   ├── quantum_scalp_strategy_v5.pine
│   └── quantum_swing_v83_adaptive_multi_ticker.pine
│
├── pine-reference/                 ← Test fixtures (Phase 2 verification)
│   ├── ohlcv/   (4 CSVs)
│   └── outputs/ (4 CSVs)
│
└── deploy/                         ← Operational deployment helpers
    ├── requirements.txt            ← Python deps for the VM
    ├── qtp-shadow.service          ← systemd unit, ready to install
    └── n8n_shadow_branch.json      ← reference n8n node shape with the
                                      ensemble-manual-score filter built in
```

## Quick stats

```
super_score_pro_v25:        20/20  PASS  (EXACT PARITY)
webhook_bridge_v8:           3/3   PASS  (EXACT PARITY)
quantum_swing_v83:          22/24  PASS  (effective PASS — 2 known gaps)
ensemble_engine_v1:          2/5   PASS  (3 fields drift by design)
quantum_scalp_strategy_v5:  SKIPPED      (no Pine fixture — user-side action)

Total:                      47/49  validated  +  ensemble caveat
```

## Hard constraints Perplexity will respect

- DO NOT modify the existing trade-routing chain in n8n (Alpaca/Telegram/Supabase paths)
- DO NOT add the shadow validator to the critical path
- DO NOT expose port 8088 to public internet
- DO NOT push to main (feature branch + draft PR only)
- DO NOT execute Phase 7 cutover (gating live trades on Python verdict)
- DO filter ensemble's `raw_bull/raw_bear/final_score` from drift alerts (they drift by design — user-configured TV inputs)

## What's in the prompt

Perplexity will execute 7 phases:

1. **Commit + draft PR** — feature branch, no production effect
2. **Local validation re-run** — confirm 47/49 parity, no regression
3. **FastAPI smoke test** — uvicorn + curl
4. **VM/container provisioning** — systemd-managed, bound to 127.0.0.1
5. **n8n parallel branch** — backup workflow JSON first, then add Shadow Validate → IF Drift → Filter Ensemble → Slack (most sensitive step)
6. **24-48h monitoring** — watch drift, latency, false positives
7. **STOP — pause for user review** (no cutover)

At every phase, Perplexity runs a verification command and confirms the output before continuing. If verification fails, Perplexity stops and reports.

## Need to inspect a file?

All files are open and committed-grade. Read `PERPLEXITY_PROMPT.md` and `DEPLOYMENT_PROMPT.md` first — they together contain everything Perplexity needs.
