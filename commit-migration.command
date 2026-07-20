#!/bin/bash
# Commit + push the Anthropic migration + dup-leg fix deltas.
set -e
cd "$(dirname "$0")"
rm -f .git/index.lock
git add n8n-workflows/_delta_anthropic_migration/ .ci/ commit-*.command
npm run ci
git commit -m "feat(llm): migrate all 4 LLM call sites Grok->Claude Opus 4.8 + fix dup enrichment leg

- ANTHROPIC_MIGRATION_v1 (live c26c87aa): analyst, signal analyzer v5.0, VC
  gatekeeper, chart vision v4.5.0 -> api.anthropic.com/v1/messages. Contracts
  preserved (choices shape, AIJSON tail, _grok_* telemetry names, all
  degradation paths). Key = \$vars.ANTHROPIC_API_KEY, VALUE verified via live
  1-token ping before publish (seed-then-verify doctrine).
- DUP_LEG_FIX_v1 (live 38696273): Merge DP Data Ready (append) before Dark
  Pool Engine; DPE + downstream leg now run ONCE per signal with FULL data
  (leg 1 previously fired pre-Price-History on degraded dp inputs).
Ports + notes in n8n-workflows/_delta_anthropic_migration/."
git push origin main
echo "Pushed."
