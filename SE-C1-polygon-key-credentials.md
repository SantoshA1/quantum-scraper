# SE-C1: Hardcoded Polygon API key moved to workflow credentials

**Audit ID:** SE-C1 (CRITICAL)
**Files touched:**
- `n8n-workflows/signal-state-machine-v5.16.json` (archived)
- `n8n-workflows/signal-state-machine-v5.21-sheets-v2.json` (currently active)

**Status after this PR:** code fixed + tested. **Key rotation is your responsibility — see below.**

---

## 🚨 REQUIRED BEFORE MERGE — rotate the Polygon key

The hardcoded key `LxG0VrVzcQYEtWDfg8d6G49iapiC4Ec_` is present in this repo's git
history (pre-this-PR). **Replacing the literal alone does not un-leak it.** Please:

1. Polygon.io dashboard → API keys → **revoke** `LxG0VrVzcQYEtWDfg8d6G49iapiC4Ec_`
2. Generate a new key.
3. In n8n, set the credential on each workflow (same pattern as the xAI / Alpaca fix
   from commit `cb41b9b`):
   ```
   staticData._credentials.polygon_api_key = "<new key>"
   ```
   Simplest: open the active workflow → add a one-shot Code node that runs
   `$getWorkflowStaticData('global')._credentials = { ...($getWorkflowStaticData('global')._credentials || {}), polygon_api_key: '<new key>' };`
   then execute it once and delete it. Same workflows: `signal-state-machine-v5.16` and `signal-state-machine-v5.21-sheets-v2`.
4. Merge this PR.

If the credential is **not** set when the workflow runs, the system fails
CLOSED (see Property C in the tests) — no fake indicators, no silent auto-pass.

---

## What the audit called out

> **[CRITICAL] SE-C1 — Hardcoded Polygon API Key in Plaintext**
> File: `Indicator_Enrichment.js`
> Polygon.io key hardcoded as string constant. Visible in n8n logs, git history, and
> workflow exports. Key enables data access and quota exhaustion.
> Fix: Move to `$env.POLYGON_API_KEY`. Rotate exposed key immediately.

## What was actually worse than the audit summary

The audit called out `Indicator_Enrichment.js` only. During scoping I found the
**same hardcoded key in 5 places per workflow version** (× 2 versions in repo = 10
total occurrences), split across two n8n surfaces:

| Node | Type | How the key was embedded |
|---|---|---|
| `Indicator Enrichment` | Code node | `const POLYGON_KEY = '<leaked>';` literal constant |
| `Fetch Options Chain` | HTTP Request | `?...&limit=250&apiKey=<leaked>` in the URL |
| `Fetch Price History` | HTTP Request | `?apiKey=<leaked>` in the URL |
| `Fetch Cross-Asset Today` | HTTP Request | `+ '?apiKey=<leaked>'` in a `{{ }}` concat |
| `Fetch Cross-Asset Previous` | HTTP Request | `+ '?apiKey=<leaked>'` in a `{{ }}` concat |

All 5 nodes also appeared in the `activeVersion.nodes` snapshot — n8n's published
version copy. Missing that snapshot would have left the leaked key live in the
deployed workflow even after the "top-level" fix. Both surfaces patched.

## Why `staticData._credentials` instead of `$env.POLYGON_API_KEY`

The audit recommended `$env.POLYGON_API_KEY`. Commit `0c75a89` in this repo
documents: *"Use staticData._credentials instead of `$env` (n8n cloud blocks `$env`
access)"*. The xAI + Alpaca emergency remediations (`cb41b9b`) all use
`$getWorkflowStaticData('global')._credentials.<name>`. This PR follows the same
pattern so there's one credential model, not two.

## Before / after (Indicator Enrichment Code node)

**Before** (line 13):
```js
const POLYGON_KEY = 'LxG0VrVzcQYEtWDfg8d6G49iapiC4Ec_';
```

**After**:
```js
// SE-C1 fix: Polygon key must come from workflow credentials, never be hardcoded.
// n8n Cloud blocks $env access, so we use staticData._credentials (same pattern
// as the post-cb41b9b xAI / Alpaca credential fixes).
const POLYGON_KEY = ($getWorkflowStaticData('global')._credentials || {}).polygon_api_key || '';
if (!POLYGON_KEY) {
  console.error('[IND ENRICH] Polygon API key not found in workflow credentials — enrichment BLOCKED');
  return [{
    json: {
      ...item,
      _dq_polygon_key_missing: true,
      _dq_quality_score: 0,
      _dq_missing_fields: 'POLYGON_API_KEY',
      _dq_staleness_note: 'Polygon API key not configured — indicators not fetched'
    }
  }];
}
```

All 6 downstream `${POLYGON_KEY}` URL templates keep working — we only changed the source.

## Before / after (HTTP Request URLs)

Two patterns were in use. Both are now parameterized.

**Plain tail (Fetch Options Chain, Fetch Price History):**
```diff
- ...&apiKey=LxG0VrVzcQYEtWDfg8d6G49iapiC4Ec_
+ ...&apiKey={{ ($getWorkflowStaticData('global')._credentials || {}).polygon_api_key || '' }}
```

**Expression concat (Fetch Cross-Asset Today/Previous):**
```diff
- ...format('yyyy-MM-dd') + '?apiKey=LxG0VrVzcQYEtWDfg8d6G49iapiC4Ec_' }}
+ ...format('yyyy-MM-dd') + '?apiKey=' + (($getWorkflowStaticData('global')._credentials || {}).polygon_api_key || '') }}
```

Each HTTP node already had `options.response.response.neverError: true`, so a
401-from-missing-key will not crash the pipeline — the downstream Cross-Asset
Engine will degrade to its existing `UNAVAILABLE` regime path.

## Test plan

`tests/test-indicator-enrichment-polygon-key.js` covers **5 properties**:

| # | Property | Pre-patch | Post-patch |
|---|---|---|---|
| A | Leaked key is absent from every node parameter (top-level + activeVersion) | ❌ | ✅ |
| B | Every Polygon HTTP node URL references `polygon_api_key` credential | ❌ | ✅ |
| C | Missing credential → fail-closed, NO HTTP calls, DQ flag set | ❌ (makes 6 calls w/ hardcoded key) | ✅ |
| D | Happy path — credential is embedded in URLs, 5 indicators fetched | ❌ (URL uses hardcoded key, not config) | ✅ |
| E | Regression — fully-populated item still short-circuits | ✅ | ✅ |

Baseline run against pre-patch code fails 4/5 — confirming the tests exercise real behavior.

```
Post-patch: 5 passed, 0 failed
Pre-patch:  1 passed, 4 failed
```

## Diff size

10 lines per workflow file (5 URL rewrites + 5 activeVersion URL rewrites, including
the Indicator Enrichment jsCode). Total: **20 insertions, 20 deletions across 2 files**,
plus the new test + this doc.

## Closes audit items

- **SE-C1** — hardcoded Polygon key removed from all 10 occurrences across both
  workflow versions (top-level + activeVersion).
- Partial credit toward **SE-H2** (plaintext credentials in staticData): this PR
  continues the staticData pattern; the broader encryption/secret-manager issue
  remains for a dedicated fix.
