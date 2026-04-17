# PR #9 Deployment Checklist — Webhook Auth End-to-End

**PR:** #9 — `fix(security): SM-C4 + SE-C5 wire webhook auth end-to-end`
**Status:** Code ready, tests 28/28 green. **DO NOT merge until steps 1–4 below are done.**
**Prepared:** 2026-04-17

---

## ⚠️ CRITICAL ORDERING RULE

**All credentials must be set on the live infra BEFORE merging PR #9.** Once merged, GitHub Actions auto-deploys Railway from `main` (commit `6c7c132`), and the Railway app will immediately start rejecting requests that don't carry `INTERNAL_API_TOKEN`. If you re-import the patched SSM JSON into n8n before `_credentials.webhook_secret` is set in all 5 workflows' staticData, **the entire pipeline goes dark** (all signals return `AUTH_FAILED` → route `SKIP`).

---

## 🔑 Secrets (single source of truth)

> ⚠️ **Store these in a password manager right now.** Do not commit this file with real secrets to git — this checklist keeps them for the duration of deployment only. After deployment, strip the values and commit or delete.

```
WEBHOOK_SECRET      = <WEBHOOK_SECRET_HEX>    # 64 hex chars, stored only in password manager + n8n staticData + TradingView alert body
INTERNAL_API_TOKEN  = <INTERNAL_API_TOKEN_HEX> # 64 hex chars, stored only in password manager + Railway env + n8n callers that hit Railway
```

> Real values were generated once during deployment prep on 2026-04-17 and recorded in the operator's password manager. This file is intentionally sanitized for git.

- Entropy: 256 bits each (32 random bytes → 64 hex chars)
- Generated with Python `secrets.token_hex(32)` — cryptographically secure
- **Distinct**: these two must never be interchanged. `WEBHOOK_SECRET` authenticates n8n → n8n. `INTERNAL_API_TOKEN` authenticates n8n → Railway.

### Regenerate if needed
```bash
python3 -c "import secrets; print(secrets.token_hex(32))"
```

---

## 📋 Deployment Steps (in order)

### Step 1 — Set `_credentials.webhook_secret` in **all 5 n8n workflows**

This is the receive-side auth secret used by the SSM's webhook guard.

**Workflows:** (all 5 must have the identical value)
1. `signal-state-machine-v5.21-sheets-v2` (SSM — the receiver)
2. `broad-scanner`
3. `daily-testing-agent-health-report`
4. `polygon-news-grok-sentiment`
5. `rt-signal-agent`

> **Why all 5:** The SSM reads `_credentials.webhook_secret` to validate inbound requests. The 4 callers read the same value and inject it as `_secret` in their outbound payload. Mismatched values = `AUTH_FAILED`.

**How to set it (per workflow):**

1. Open the workflow in n8n.
2. Add a one-shot "Set Credential" node (temporary) or edit via n8n CLI.
3. In any Code node, run once:
   ```js
   const state = $getWorkflowStaticData('global');
   state._credentials = state._credentials || {};
   state._credentials.webhook_secret = '<WEBHOOK_SECRET_HEX>';  // paste the 64-char hex from your password manager
   return [{ json: { set: true, len: state._credentials.webhook_secret.length }}];
   ```
4. Run the workflow once manually. Expected output: `{ set: true, len: 64 }`.
5. Delete the temporary node (staticData persists after deletion).
6. ✅ Verify by opening a Code node and running `return [{ json: $getWorkflowStaticData('global')._credentials }]` — should show `webhook_secret: '<first-5-chars>...'` (or redacted depending on n8n version).

---

### Step 2 — Set `INTERNAL_API_TOKEN` env var in Railway

1. Go to Railway dashboard → `quantum-scraper` project → Variables.
2. Add new variable:
   - **Key:** `INTERNAL_API_TOKEN`
   - **Value:** `<INTERNAL_API_TOKEN_HEX>` (the 64-char hex from your password manager — different secret from the webhook one)
3. Do NOT click "Deploy" yet. Railway will redeploy automatically when we merge PR #9.
4. ✅ After merge + deploy: `curl https://<railway-url>/run` should return `401 Unauthorized` (not `503 Service not configured` — that would mean the env var didn't stick).

---

### Step 3 — Update any TradingView alerts that POST directly to the SSM webhook

TradingView alerts don't have access to n8n staticData, so they need the secret baked into their alert message body.

**Alert message body — add `_secret` field:**

```json
{
  "_secret": "<WEBHOOK_SECRET_HEX>",
  "ticker": "{{ticker}}",
  "execution": "{{strategy.order.action}}",
  "price": "{{close}}",
  "timeframe": "{{interval}}"
}
```

**Where to set it:**
- TradingView → Alerts → (each alert that posts to the n8n webhook) → Edit → Message box.
- Count: likely 1–2 alerts per strategy (buy + sell) × number of tickers being tracked.

> ⚠️ **TradingView stores this in plain text.** Anyone with view-access to the alert can read it. If that's a concern, rotate the secret after deployment and keep it scoped to TradingView only.

---

### Step 4 — Pre-merge smoke test on a non-live workflow

Before merging PR #9, do one end-to-end test with the infra in the new state:

1. Pick any one of the 4 caller workflows (e.g. `daily-testing-agent-health-report`).
2. Run it manually from n8n.
3. ✅ Expected: SSM receives the call, recognizes `_secret`, and processes normally (no `AUTH_FAILED`).
4. ❌ If SSM returns `AUTH_FAILED` → Step 1 was incomplete for that workflow or the SSM. Re-check staticData on both sides.

If step 4 passes, you're cleared to merge.

---

### Step 5 — Merge PR #9

```bash
gh pr merge 9 --squash --delete-branch --subject "fix(security): SM-C4 + SE-C5 wire webhook auth end-to-end (#9)"
```

GitHub Actions will auto-deploy Railway from `main`.

---

### Step 6 — Post-merge verification

After the Railway deploy finishes (~2–3 min):

```bash
# Should return 200 (health is not gated)
curl -sS -w "\nHTTP:%{http_code}\n" https://quantum-scraper-production.up.railway.app/health

# Should return 401 (gated, no token)
curl -sS -w "\nHTTP:%{http_code}\n" -X POST https://quantum-scraper-production.up.railway.app/run

# Should return 200 with token (use Authorization: Bearer)
curl -sS -w "\nHTTP:%{http_code}\n" -X POST \
  -H "Authorization: Bearer <INTERNAL_API_TOKEN_HEX>" \
  https://quantum-scraper-production.up.railway.app/run
```

Then import the updated SSM JSON into live n8n and watch the Daily Testing Agent cycle through without `AUTH_FAILED`.

---

## 🚨 Rollback Plan (if anything breaks)

**Symptom: all signals returning `AUTH_FAILED` → route `SKIP`**
- Likely cause: one of the 5 workflows missing `_credentials.webhook_secret`, or values don't match.
- Fix: re-run Step 1 for that workflow. No code rollback needed.

**Symptom: Railway returning `503 Service not configured` on all protected routes**
- Cause: `INTERNAL_API_TOKEN` not set in Railway env.
- Fix: re-run Step 2. Railway will redeploy with the new env.

**Symptom: TradingView alerts silently failing (pipeline doesn't fire on real-time alerts)**
- Cause: TradingView alert body missing `_secret` field.
- Fix: re-run Step 3 for that alert.

**Full code rollback (last resort):**
```bash
git revert 0da75ae  # (or whatever PR #9's merge commit is)
git push origin main
```
Railway auto-deploys the revert. SSM auth guard stays (it's already on main pre-PR #9), but callers go back to not sending `_secret` — which means SSM will `AUTH_FAILED` everything until staticData `webhook_secret` is also cleared.

---

## 📊 What's changing — quick reference

| Layer | Before PR #9 | After PR #9 |
|---|---|---|
| SSM webhook guard | ✅ Already live (commit `0f20614`) | ✅ Unchanged |
| 4 caller workflows send `_secret` | ❌ No | ✅ Yes |
| Railway `/run` `/signal` `/ai-analysis` `/technical` `/results` | ❌ Unauthenticated | ✅ `requireInternalToken` |
| Railway `/health` | ✅ Open | ✅ Open (intentional) |
| n8n staticData stores `webhook_secret` | ❌ No | ✅ Yes (set manually in Step 1) |
| Railway env has `INTERNAL_API_TOKEN` | ❌ No | ✅ Yes (set in Step 2) |

---

## ✅ Pre-merge sign-off

Tick each item before executing Step 5:

- [ ] Step 1 complete — `_credentials.webhook_secret` set in all 5 workflows (SSM + 4 callers)
- [ ] Step 2 complete — `INTERNAL_API_TOKEN` set in Railway dashboard
- [ ] Step 3 complete — All relevant TradingView alerts have `_secret` in body
- [ ] Step 4 complete — One caller workflow successfully round-trips through SSM with no `AUTH_FAILED`
- [ ] Both secrets saved in password manager
- [ ] This file's secret values replaced with placeholders before committing (or file deleted)
