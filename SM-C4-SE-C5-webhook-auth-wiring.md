# SM-C4 + SE-C5 — Webhook Auth Wiring (PR #9)

**Status**: ✅ Fixed. Caller workflows now include `_secret` in every
payload they POST to the Signal State Machine, and the Railway Express
service (`app.js`) now protects all mutating/data-returning endpoints
with an internal token middleware.

## TL;DR

Prior commit `0f20614` shipped an auth guard inside the Signal State
Machine code node (body `_secret` or `x-webhook-secret` header, fail-closed),
but its commit message falsely claimed "Updated 4 caller workflows" —
**none of the caller workflows were actually updated**. The SSM guard was
rejecting every internal caller, and the Railway HTTP API remained fully
unauthenticated.

This PR closes both gaps:

1. Adds `_secret: <webhook_secret>` to the outgoing payload of every
   internal caller workflow.
2. Adds an `INTERNAL_API_TOKEN` middleware to `app.js` that protects
   `/run`, `/signal`, `/ai-analysis`, `/technical`, and `/results`.
3. Adds a test harness that exercises the auth guard against crafted
   payloads (no secret, wrong secret, correct secret, unconfigured
   secret) and validates the Express middleware across three token
   presentation modes.

## Audit findings addressed

| Finding | Summary | Status after PR #9 |
|---|---|---|
| **SM-C4** | n8n webhook endpoints unauthenticated — any HTTP client with the URL could inject BUY/SELL signals | SSM receiver already had guard (commit `0f20614`); this PR wires all **4 internal callers** to send `_secret` |
| **SE-C5** | Railway `/run` (+ adjacent endpoints) unauthenticated — anyone could trigger scrapes, burn Grok credits, or read last results | `requireInternalToken` middleware added to 5 routes; `/health` intentionally left open for Railway probes |

## What changed

### 1. `n8n-workflows/broad-scanner.json`
Inside the `Scan All Tickers` code node:
- Loads `_WEBHOOK_SECRET` from `$getWorkflowStaticData('global')._credentials.webhook_secret`.
- Each emitted signal object now begins with `_secret: _WEBHOOK_SECRET`.

### 2. `n8n-workflows/rt-signal-agent.json`
Inside the `Fetch & Evaluate` code node:
- Loads `_WEBHOOK_SECRET` from the same staticData slot.
- The inline `this.helpers.httpRequest` body now carries `_secret` as its
  first field before `ticker`.

### 3. `n8n-workflows/daily-testing-agent-health-report.json`
Inside `Testing Agent — Node A`:
- Loads `_WEBHOOK_SECRET` from staticData.
- T7 webhook-latency probe body now includes `_secret`.
- `fire()` helper spreads `_secret` into every T1–T5 payload.
- Without this, the daily health report would show the pipeline as
  broken (all test signals rejected with `AUTH_FAILED`).

### 4. `n8n-workflows/polygon-news-grok-sentiment.json`
This workflow threads config through a Set node → Code node → HTTP node
chain, so `webhook_secret` is threaded through the same path:
- `Watchlist and Config` Set node: new assignment
  `webhook_secret = {{ staticData._credentials.webhook_secret }}` (read
  at runtime, never stored in the repo).
- `Split and Prepare Tickers` forwards `webhook_secret` onto every
  per-ticker item.
- `Parse and Validate Score` preserves `webhook_secret` on the final
  item shape.
- `POST Kill to Signal State Machine` body now includes
  `_secret: $json.webhook_secret`.

### 5. `app.js` — `requireInternalToken` middleware (SE-C5)
- Reads `process.env.INTERNAL_API_TOKEN` at startup; logs a prominent
  warning box if unset.
- Middleware accepts the token via (in order): `x-internal-token`
  header, `Authorization: Bearer <token>`, or `?token=…` query string
  (GET only).
- Uses constant-time comparison to prevent timing attacks.
- **Fail-closed**: if the env var is unset, protected routes return
  `503 Service not configured`. This prevents an accidental deploy with
  an empty token from silently leaving endpoints open.
- Logs rejected attempts with `[AUTH] REJECTED <method> <path> from <ip>`.
- Wired onto `POST /run`, `POST /signal`, `POST /ai-analysis`,
  `GET /technical`, `GET /results`. `GET /health` and `GET /` remain
  open for probes / service banner.

## Deployment checklist

Before merging, the following production config must be set (otherwise
the pipeline will fail closed everywhere):

1. **n8n side**: for each of the following workflows, open
   Settings → Static Data and ensure this key exists:
   ```json
   "_credentials": { "webhook_secret": "<same 32+-char value used in SSM>" }
   ```
   Workflows to configure:
   - Broad Scanner
   - Real-Time Signal Agent (`rt-signal-agent`)
   - Daily Testing Agent (Health Report)
   - Polygon News Grok Sentiment

   The SSM workflow (v5.21) must have the same secret value — it's
   already there since commit `0f20614`. Any mismatch → `AUTH_FAILED`.

2. **Railway side**: in the quantum-scraper service, set:
   ```
   INTERNAL_API_TOKEN=<32+ char random hex>
   ```
   Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

3. **TradingView alerts**: any alerts that POST directly to
   `/webhook/tradingview-signal` need `_secret: "<same secret>"` added
   to the alert JSON body. The SSM auth guard accepts `x-webhook-secret`
   as a header fallback if TradingView is configured that way instead.

4. **Verify**: after deploy, run the Daily Testing Agent once manually
   and confirm all 5 T-signals pass the SSM auth guard (no `AUTH_FAILED`
   entries in execution logs).

## What this PR does NOT change

- **`webhook-auth.js` (HMAC-SHA256 module)**: left in place. It's still
  used by `app.js sendWebhook()` to sign outbound POSTs to the
  `script-scraper-complete` webhook (commit `6ef19d0`). The
  corresponding verify-side snippet in
  `n8n-webhook-auth-snippets.md` was never actually deployed to any
  receiver workflow and remains as reference documentation. Migrating
  everything to a single scheme is a follow-up consideration.
- **Older inactive workflow variants** (`*--inactive.json`, `my-workflow-*`):
  not patched. These are not active in production. If any of them are
  reactivated, they must be patched the same way.
- **Polygon key rotation**: separate task. `LxG0VrVzcQYEtWDfg8d6G49iapiC4Ec_`
  is still in git history from before PR #8 and must be rotated in the
  Polygon.io dashboard.

## Tests

`tests/test-webhook-auth-wiring.js` — 28 assertions across 6 properties:

| Property | Assertions | What it proves |
|---|---|---|
| **A** — Callers reference secret | 11 | Every caller workflow's signal-emitting node now loads the secret from staticData AND embeds it in the outgoing payload (not just a commented reference) |
| **B** — SSM rejects no-secret | 1 | Extracted auth guard returns `AUTH_FAILED` when `_secret` is absent |
| **C** — SSM rejects wrong-secret | 1 | Auth guard returns `AUTH_FAILED` when `_secret` value doesn't match |
| **D** — SSM accepts correct secret | 2 | Guard falls through (no early return) on correct secret; fails closed if the credential itself is unconfigured |
| **E** — Middleware blocks | 3 | Missing env → 503; missing/wrong token → 401 |
| **F** — Middleware accepts | 4 | Header, Bearer, and query-string (GET only) all work; query-string on POST is rejected |
| **Source check** | 6 | Regex confirms the 5 protected routes all include `requireInternalToken`, and `/health` does not |

### Post-patch
```
Results: 28 passed, 0 failed
```

### Pre-patch baseline proof

Restored `broad-scanner.json`, `rt-signal-agent.json`,
`daily-testing-agent-health-report.json`,
`polygon-news-grok-sentiment.json`, and `app.js` from `HEAD` (pre-PR)
and re-ran the same suite:

```
[A] Caller workflows reference webhook_secret
  ❌ broad-scanner: Scan All Tickers loads _WEBHOOK_SECRET
  ❌ broad-scanner: signal object includes _secret field
  ❌ rt-signal-agent: Fetch & Evaluate loads _WEBHOOK_SECRET
  ❌ rt-signal-agent: outgoing httpRequest body includes _secret
  ❌ daily-testing: Node A loads _WEBHOOK_SECRET
  ❌ daily-testing: T7 probe body includes _secret
  ❌ daily-testing: fire() payload spreads _secret
  ❌ polygon-sentiment: Watchlist and Config assigns webhook_secret
  ❌ polygon-sentiment: Split forwards webhook_secret per-item
  ❌ polygon-sentiment: Parse forwards webhook_secret to final item
  ❌ polygon-sentiment: POST Kill body includes _secret

[B/C/D] SSM auth guard
  ✅ B/C/D/D-bis all pass (guard was already shipped in commit 0f20614)

[E/F] app.js requireInternalToken middleware
  FATAL: middleware source not found in app.js
```

That outcome is the audit verdict in test form: the SSM receiver already
had the guard, but the callers were never wired and `app.js` had no
middleware at all. This PR flips the 11 caller tests + adds the 13
middleware tests to green.

## Run

```bash
cd quantum-scraper
node tests/test-webhook-auth-wiring.js
```
