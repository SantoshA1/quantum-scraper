# n8n Webhook HMAC Authentication — Setup Guide (Audit C-7)

This document provides copy-paste code snippets for securing all webhook
entry points in the Quantum Trading Pipeline's n8n workflows.

## Overview

**Protocol:** HMAC-SHA256 signature verification
**Header:** `X-Webhook-Signature: sha256=<hex digest>`
**Shared secret:** Stored in n8n workflow static data as `_webhook_secret`

## Step 0: Generate a Shared Secret

Run this once and save the output — you'll use this same value in Railway
env vars AND n8n workflow static data:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Store it in two places:
1. **Railway** → Variables → `WEBHOOK_SECRET=<the hex string>`
2. **n8n** → Each receiving workflow → Static Data → `_webhook_secret=<same hex string>`

---

## Step 1: Receiver — Verify Incoming Webhooks

Add a **Code node** immediately after every Webhook Trigger node that receives
trading signals. Connect the Webhook Trigger → this Code node → rest of workflow.

### Verification Code Node (copy-paste into n8n Code node)

```javascript
// ══════════════════════════════════════════════════════════════
// WEBHOOK HMAC VERIFICATION (Audit C-7)
// Place this Code node immediately after the Webhook Trigger.
// Rejects unsigned or incorrectly signed requests with an error.
// ══════════════════════════════════════════════════════════════
const crypto = require('crypto');

// Load shared secret from workflow static data
const staticData = $getWorkflowStaticData('global');
const WEBHOOK_SECRET = staticData._webhook_secret;

if (!WEBHOOK_SECRET) {
  // First-time setup: you must set _webhook_secret in workflow static data.
  // Go to: Workflow Settings → Static Data → set _webhook_secret
  throw new Error(
    'WEBHOOK_SECRET not configured. Set _webhook_secret in workflow static data.'
  );
}

// Get the signature header from the incoming request
const signatureHeader = $input.first().json.headers?.['x-webhook-signature']
  || $input.first().json.headers?.['X-Webhook-Signature']
  || '';

// Get the raw body — n8n Webhook nodes pass this in different ways
// depending on webhook configuration. Use the body object.
const body = $input.first().json.body || $input.first().json;
const bodyString = typeof body === 'string' ? body : JSON.stringify(body);

if (!signatureHeader) {
  console.log('[AUTH] REJECTED: No X-Webhook-Signature header');
  throw new Error('Unauthorized: Missing webhook signature.');
}

if (!signatureHeader.startsWith('sha256=')) {
  console.log('[AUTH] REJECTED: Invalid signature format');
  throw new Error('Unauthorized: Invalid signature format.');
}

const receivedSig = signatureHeader.slice(7);
const expectedSig = crypto
  .createHmac('sha256', WEBHOOK_SECRET)
  .update(bodyString)
  .digest('hex');

const receivedBuf = Buffer.from(receivedSig, 'hex');
const expectedBuf = Buffer.from(expectedSig, 'hex');

if (receivedBuf.length !== expectedBuf.length ||
    !crypto.timingSafeEqual(receivedBuf, expectedBuf)) {
  console.log('[AUTH] REJECTED: Signature mismatch');
  throw new Error('Unauthorized: Invalid webhook signature.');
}

console.log('[AUTH] ✅ Signature verified');

// Pass through the original data to the next node
return $input.all();
```

### Apply this to these webhook-receiving workflows:

| Workflow | Webhook Path | Priority |
|----------|-------------|----------|
| Signal State Machine v5.16 | `tradingview-signal` | **CRITICAL** — triggers real trades |
| Hybrid Discovery Engine | `script-scraper-complete` | HIGH — feeds discovery pipeline |
| Signal Feed Public Pipeline | `signal-feed` | MEDIUM — public-facing |
| Website Signal Engine | `qs-engine` / `website-signal` | MEDIUM — demo signals |

---

## Step 2: Sender — Sign Outgoing Webhook Calls from n8n

For n8n Code nodes that POST to other n8n webhooks (broad-scanner,
rt-signal-agent, polygon-sentiment, testing-agent), wrap the HTTP call
with HMAC signing.

### Signing Helper (add at the top of any n8n Code node that sends webhooks)

```javascript
// ══════════════════════════════════════════════════════════════
// WEBHOOK HMAC SIGNING HELPER (Audit C-7)
// Add this function at the top of Code nodes that call webhooks
// ══════════════════════════════════════════════════════════════
const crypto = require('crypto');
const _staticData = $getWorkflowStaticData('global');
const WEBHOOK_SECRET = _staticData._webhook_secret;

function signAndPost(url, bodyObj) {
  const bodyStr = JSON.stringify(bodyObj);
  const headers = { 'Content-Type': 'application/json' };

  if (WEBHOOK_SECRET) {
    const sig = crypto.createHmac('sha256', WEBHOOK_SECRET).update(bodyStr).digest('hex');
    headers['X-Webhook-Signature'] = 'sha256=' + sig;
  } else {
    console.warn('[AUTH] WEBHOOK_SECRET not set — sending unsigned request');
  }

  return this.helpers.httpRequest({
    method: 'POST',
    url: url,
    headers: headers,
    body: bodyStr,
    json: false,
  });
}
```

Then replace direct `this.helpers.httpRequest` calls with `signAndPost.call(this, url, body)`.

### Example: rt-signal-agent signal dispatch (before → after)

**Before (unsigned):**
```javascript
await this.helpers.httpRequest({
  method: 'POST',
  url: 'https://tradenextgen.app.n8n.cloud/webhook/tradingview-signal',
  headers: { 'Content-Type': 'application/json' },
  body: { ticker: ticker, price: signal.price, ... }
});
```

**After (signed):**
```javascript
await signAndPost.call(this,
  'https://tradenextgen.app.n8n.cloud/webhook/tradingview-signal',
  { ticker: ticker, price: signal.price, ... }
);
```

### Apply signing to these sender workflows:

| Workflow | What it calls |
|----------|--------------|
| Broad Scanner | `tradingview-signal` |
| RT Signal Agent v2.6 | `tradingview-signal` |
| Polygon News Grok Sentiment | `tradingview-signal` |
| Daily Testing Agent | `tradingview-signal` (test signals) |
| app.js sendWebhook() | `script-scraper-complete` (already done in code) |

---

## Step 3: Set the Shared Secret in n8n Workflows

For each workflow that sends or receives signed webhooks:

1. Open the workflow in n8n editor
2. Click **Settings** (gear icon) → **Static Data**
3. Add to the JSON: `"_webhook_secret": "<your 64-char hex secret>"`
4. Save the workflow

Example static data JSON:
```json
{
  "_webhook_secret": "a1b2c3d4e5f6...your64charhexsecret...",
  "scaledOut": {},
  "trailState": {}
}
```

**Important:** Use the same secret value across all workflows and in the
Railway `WEBHOOK_SECRET` env var.

---

## Rollout Strategy (Zero Downtime)

To avoid breaking the pipeline during rollout:

1. **Phase 1 — Add signing to all senders first** (they'll send the header;
   receivers ignore it since there's no verification node yet)
2. **Phase 2 — Add verification Code nodes to receivers** (now they check
   the header that senders are already providing)
3. **Phase 3 — Test with the Daily Testing Agent** to confirm end-to-end

This way, at no point does a sender lack the header that a receiver requires.

---

## Verification Checklist

- [ ] Generated a 32-byte hex secret
- [ ] Set `WEBHOOK_SECRET` in Railway env vars
- [ ] Set `_webhook_secret` in static data for: Signal State Machine, Hybrid Discovery, Signal Feed, Website Signal Engine
- [ ] Set `_webhook_secret` in static data for: Broad Scanner, RT Signal Agent, Polygon Sentiment, Testing Agent
- [ ] Added signing helper to: Broad Scanner, RT Signal Agent, Polygon Sentiment, Testing Agent
- [ ] Added verification Code node after Webhook Trigger in: Signal State Machine, Hybrid Discovery
- [ ] Ran Daily Testing Agent — all test signals pass authentication
- [ ] Confirmed: unsigned POST to `tradingview-signal` from curl is rejected
