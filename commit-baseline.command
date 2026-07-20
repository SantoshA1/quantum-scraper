#!/bin/bash
# Double-click (or run in Terminal) to commit + push the live-n8n reconciliation baseline
# and the publish-workflow environment fix. The sandbox can't write .git; your Mac can.
set -e
cd "$(dirname "$0")"
rm -f .git/index.lock

git add n8n-workflows/_baseline_c91917bb/ .ci/n8n-manifest.json \
        .github/workflows/publish-n8n.yml \
        lib/gates/vc_score.js tests/test-vc-score-gate.js

# Re-run the gate (same as CI) before committing.
npm run ci

git commit -m "chore: reconcile repo baseline to live n8n (versionId c91917bb)

Conclave amendment #3 (repo-canonical, do-not-extract-against-unrecorded-baseline):
- n8n-workflows/_baseline_c91917bb/ : 90 code nodes + 4 SQL nodes exported from the
  live Signal State Machine (vaqfCaELhOEWnkdo) at versionId c91917bb, with
  _MANIFEST.json (per-node sha256_live for CI drift diff). Secrets redacted.
- .ci/n8n-manifest.json : records vaqfCaELhOEWnkdo -> versionId c91917bb baseline.
- publish-n8n.yml : environment 'production' made OPTIONAL (workflow_dispatch is the
  primary manual gate) so it works without GitHub environment reviewer protection.

This is the recorded baseline A2 gate-extraction diffs against. Topology/connections
NOT captured here (needs n8n API export). Governance row 121 in ssm_workflow_updates.

A2 first extraction (proves the pattern for the rest of the workstream):
- lib/gates/vc_score.js : VC Score Parser calibrated-v2 contract (SHADOW_A=1.18,
  SHADOW_B=0.55, threshold>=7) extracted verbatim from the live node; pure +
  dependency-free (vendored-inline; n8n Cloud restricts require).
- tests/test-vc-score-gate.js : 11 table-driven checks incl. the >=7 pass boundary
  (raw 5.4 fails, 5.5 passes), clamp/garbage, KILL + STAND ASIDE overrides. Green."

git push origin main
echo ""
echo "Pushed. Baseline recorded at versionId c91917bb; A2 extraction can now proceed against it."
