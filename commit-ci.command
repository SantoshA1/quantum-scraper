#!/bin/bash
# Double-click this file (or run it in Terminal) to commit + push the QTP CI gate
# and the repo-canonical n8n publish tooling.
# The sandbox couldn't finalize git (it can't write .git internals); your Mac can.
set -e
cd "$(dirname "$0")"

# Clear the stale lock the sandbox left behind (harmless if absent).
rm -f .git/index.lock

git add .github/workflows/ci.yml .github/workflows/publish-n8n.yml \
        .ci/check-secrets.js .ci/check-syntax.js .ci/secret-baseline.json .ci/n8n-sync.js \
        tests/run-all.js package.json docs/CANONICAL-SOURCE.md

# Sanity: run the gate locally before committing (same as CI).
npm run ci

git commit -m "ci: commit gate + repo-canonical n8n publish tooling

Workstream A3 from the QTP build plan.

Commit gate (ci.yml, every PR/push):
- secret-leak gate (.ci/check-secrets.js) baseline ratchet — blocks NEW leaks;
  documents 3 pre-existing exposures in .ci/secret-baseline.json (incl. a LIVE
  webhook secret in a committed export — rotate+scrub, PO action)
- syntax check (.ci/check-syntax.js) tolerant of n8n node-body top-level await
- n8n workflow JSON parse validation
- gate/logic harnesses via npm test (tests/run-all.js) — 3 suites, 39 assertions

Repo-canonical publish (n8n-sync.js + publish-n8n.yml, docs/CANONICAL-SOURCE.md):
- repo is canonical source for n8n workflow definitions
- export/diff/publish tool with STALENESS GUARD (refuses to publish when live
  moved since last reconcile) — prevents a stale repo clobbering production
- publish is MANUAL (workflow_dispatch) + production environment approval, never
  auto-on-push; dry-run unless N8N_ALLOW_PUBLISH=true
- NOTE: repo is currently stale vs live (dc0ea61b); run 'n8n-sync.js export' to
  reconcile BEFORE any publish (see docs/CANONICAL-SOURCE.md)

deploy-railway.yml unchanged."

git push origin main

echo ""
echo "Committed and pushed. Next: add N8N_API_KEY secret + N8N_BASE_URL variable +"
echo "a 'production' environment on GitHub, then run: node .ci/n8n-sync.js export --id vaqfCaELhOEWnkdo"
echo "to reconcile the repo to live BEFORE any publish. See docs/CANONICAL-SOURCE.md."
