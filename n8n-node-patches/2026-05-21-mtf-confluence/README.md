# QTP MTF Confluence Deployment — 2026-05-21

This bundle records the production n8n node changes deployed to workflow
`vaqfCaELhOEWnkdo` (`TradingView AI Super Score → Perplexity → Telegram`) on
2026-05-20 EDT / 2026-05-21 UTC.

## P7 — MTF audit visibility

Target node: `Merge MTF AI Verdict` (`qtp-merge-mtf-ai-verdict-v59`)

Change:
- Tags MTF-blocked candidates with `blocked_stage = 'MTF_CONFLUENCE_BLOCK'`
  when no upstream gate already set `blocked_stage`.
- Adds triage fields:
  - `_mtf_block_reason`
  - `_mtf_scalp_score`
  - `_mtf_swing_score`
  - `_mtf_long_term_score`
  - `_mtf_deterministic_score`
  - `_mtf_ai_score`
  - `_mtf_profile`
  - `_mtf_block_version = 'QTP_MTF_AUDIT_VISIBILITY_20260521'`
- Does not change MTF scoring, thresholds, VC parser logic, or order routing.

Validation:
- MTF block is now visible as `MTF_CONFLUENCE_BLOCK`.
- R3.2 / VC hard-kill `blocked_stage` is not overwritten.
- BROAD_SCANNER parser `blocked_stage` is not overwritten.

## P8 — SCALP profile reweight

Target node: `QTP Multi-Timeframe Confluence Engine`
(`qtp-mtf-confluence-engine-v59`)

Change:
- SCALP deterministic MTF weighting changed from:
  - `55% scalp / 30% swing / 15% long_term`
- To:
  - `65% scalp / 35% swing / 0% long_term`
- SCALP long-term floor remains excluded. SWING and LONG_TERM formulas and
  floor branches are preserved.
- Engine version marker updated to `QTP_MTF_CONFLUENCE_v6.2_20260521`.

Validation:
- JCI replay passes MTF with `mtf_confluence_score = 67.7`.
- Weak SCALP still blocks.
- R3.2 KILL remains blocked with `blocked_stage = VC_HARD_KILL`.
- SWING formula remains `0.20 / 0.55 / 0.25`.
- BROAD_SCANNER parser path remains unaffected.

## Files

- `merge_mtf_ai_verdict_v5_9_audit_visibility.js` — deployed Merge node code.
- `mtf_confluence_engine_v6_2_scalp_reweight.js` — deployed MTF engine code.
- `patch_mtf_audit_visibility_p7_20260521.py` — deployment script.
- `patch_mtf_scalp_reweight_p8_20260521.py` — deployment script.
- `smoke_mtf_audit_visibility_p7.js` — local smoke checks for P7.
- `smoke_mtf_scalp_reweight_p8.js` — local smoke checks for P8.
- `patch_mtf_audit_visibility_result_20260521T021854Z.json` — deployment result.
- `patch_mtf_scalp_reweight_v62_result_20260521T023005Z.json` — deployment result.

## Security note

The full active n8n workflow export is intentionally not committed here because
the workflow contains credential fallback material in unrelated nodes. This
bundle stores only the changed node code and deployment metadata needed for
audit, rollback, and parity tracking.
