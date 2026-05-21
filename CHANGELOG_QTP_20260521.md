# QTP Changelog — 2026-05-21

## MTF confluence audit visibility and SCALP profile fix

Workflow: `TradingView AI Super Score → Perplexity → Telegram`

Workflow ID: `vaqfCaELhOEWnkdo`

### P7 — MTF audit visibility

- Patched `Merge MTF AI Verdict`.
- Added `QTP_MTF_AUDIT_VISIBILITY_20260521`.
- MTF-blocked candidates are now tagged as `blocked_stage = 'MTF_CONFLUENCE_BLOCK'`
  when no upstream gate already set a block.
- Added `_mtf_*` triage fields to preserve tier scores and block reason.
- Confirmed non-interference:
  - `VC_HARD_KILL` remains `VC_HARD_KILL`.
  - `BROAD_SCANNER_BIAS_PATH` remains `BROAD_SCANNER_BIAS_PATH`.

### P8 — SCALP MTF reweight

- Patched `QTP Multi-Timeframe Confluence Engine`.
- Added `QTP_MTF_SCALP_REWEIGHT_v6.2_20260521`.
- Updated engine marker to `QTP_MTF_CONFLUENCE_v6.2_20260521`.
- SCALP weighting changed to `65% scalp / 35% swing / 0% long_term`.
- SWING and LONG_TERM weighting/floor logic preserved.

### Validation

- JCI-style replay: `FINAL_MTF_CONFLUENCE_PASS`, score `67.7`.
- Weak SCALP replay: `FINAL_MTF_CONFLUENCE_BLOCK`, score `14.95`.
- R3.2 KILL regression: `blocked_stage = VC_HARD_KILL`.
- SWING formula unchanged.
- BROAD_SCANNER parser path unaffected.

### GitHub sync notes

Artifacts are stored under:

`n8n-node-patches/2026-05-21-mtf-confluence/`

The full workflow JSON was not committed because it contains unrelated credential
fallback material. Only changed node code, deploy scripts, smoke tests, and
deployment result manifests were synced.
