# Canonical Source & n8n Publish Policy

**Decision:** this repo is the **canonical source** for n8n workflow *definitions*.
n8n Cloud is the runtime; the repo is the reviewed, tested, version-controlled truth.

**Reality check (2026-07-15): the repo is currently STALE.** Live n8n (`vaqfCaELhOEWnkdo`,
version `dc0ea61b…`) contains this week's expansion-cohort work — F1-B MTF shadow, F2
PF shadow, attribution nodes, expansion caps, kill-switch — none of which is reflected
in the committed exports (which sit at ~v5.19/v5.21). **Until the repo is reconciled to
live, publishing FROM the repo would roll back production.** Reconcile first. Always.

## The one rule that prevents disaster
**Never publish before reconciling.** Direction of truth is established by `export`,
enforced by the staleness guard in `.ci/n8n-sync.js` (publish refuses when live's
`versionId` differs from the repo's last export). This is the same doctrine as the
`quantum.ssm_workflow_updates` reconciliation tripwire, applied at the CI boundary.

## Flow

```
edit logic in repo ──> CI gate (tests+syntax+secrets) ──> PR review ──> merge to main
                                                                          │
                                          (manual, approved) publish-n8n.yml
                                                                          │
   node .ci/n8n-sync.js export --id <id>   ← reconcile FIRST (live -> repo)
   node .ci/n8n-sync.js diff   --id <id>   ← review what would change
   node .ci/n8n-sync.js publish --id <id>  ← dry-run unless N8N_ALLOW_PUBLISH=true
                                                                          │
                          record put_wrapped_update in ssm_workflow_updates
```

## Why publish is MANUAL, not push-triggered
Auto-publishing to a live (even paper) trading pipeline on every merge is unsafe: a bad
merge would hit production with no human in the loop. `publish-n8n.yml` is
`workflow_dispatch` only, gated behind the `production` GitHub Environment (required
reviewers), and runs the CI gate before it will publish. Publishing stays a deliberate,
reviewed, governance-logged act.

## One-time setup (PO)
1. n8n Cloud → Settings → **n8n API** → create an API key.
2. GitHub repo → Settings → Secrets and variables → Actions:
   - Secret `N8N_API_KEY` = the key (never commit it; the secret scanner will block it).
   - Variable `N8N_BASE_URL` = `https://tradenextgen.app.n8n.cloud`.
3. GitHub → Settings → Environments → create **`production`** with required reviewers.

## First reconciliation (do this before trusting the repo as canonical)
```bash
export N8N_BASE_URL=https://tradenextgen.app.n8n.cloud
export N8N_API_KEY=****   # your key; do not commit
# Pull the live main SM (and anything else that drifted) into the repo:
node .ci/n8n-sync.js export --id vaqfCaELhOEWnkdo
git add n8n-workflows/ .ci/n8n-manifest.json
git commit -m "chore: reconcile main SM from live n8n (dc0ea61b) — repo now canonical"
git push
# From here the staleness guard keeps repo and live honest.
```
`export --all` reconciles every workflow at once, but review the diff carefully — the
export shape drops inline credentials by design, so confirm nothing important is lost.

## Guardrails baked into the tooling
- `.ci/n8n-sync.js publish` is **dry-run by default**; a real PUT needs `N8N_ALLOW_PUBLISH=true`.
- **Staleness guard** refuses to publish when live moved since the last `export` (override only with `--force` + a documented reason).
- No mass-publish: `publish` targets exactly one `--id` at a time.
- The canonical JSON stores only `name/nodes/connections/settings` — never secrets. Rotate + scrub the exposures listed in `.ci/secret-baseline.json` before/independently of this.
