# gov 230 — Railway: verdict NO, we don't need it — decommission runbook (2026-08-19)

**PO authorization:** "Go ahead and decommission scraper if we are not using. Also confirm
if we need Railway?" · **Repo-side steps: done this commit. Dashboard/credential steps: PO.**

**Verdict up front:** **QTP does not need Railway — and it is effectively already living
without it.** A live probe today shows `quantum-scraper-production.up.railway.app` answering
**404 on `/` and `/health`** — the app is not serving at all — and nothing in QTP noticed or
broke. The decommission is therefore mostly *cleanup*, not surgery.

---

## 1 · What Railway actually hosted (read from `app.js` v2.7.0, 1,218 lines)

Not just the scraper. It is an Express service with five token-gated capabilities:

| endpoint | what it does | current caller |
|---|---|---|
| `POST /run` | launches the Playwright TradingView-scripts scrape — the **only** trigger; no self-scheduling exists | none found |
| `POST /signal` | Grok-3 signal engine (calls `api.x.ai`), UI-shaped JSON (`poweredBy: "Grok-3 · AgilityServ Quantum Pipeline"`, meta.color/glow) | none |
| `POST /ai-analysis` | xAI verdicts formatted for Telegram | none — replaced by in-node **Anthropic** (gov 227 provider note) |
| `GET /technical` | **Yahoo Finance** bars → RSI/MACD/ADX/SMA/EMA/VWAP calculator (no TradingView involved) | none — replaced by n8n-native Alpaca/Polygon compute |
| `GET /results` · `GET /health` (open) | scrape debug · liveness | `/health` pinged by one monitor workflow only |

## 2 · Four independent proofs nothing needs it

1. **Corpus fingerprints: zero, ever.** `/signal` output has unmistakable field shapes
   (`poweredBy` / `correlationScore` / `standAsideConditions` / "AgilityServ"). Searched the
   entire recorded corpus — `quantum.strategy_signals` **27,197 rows** +
   `quantum.grok_verdicts` **770 rows**, all time: **0 matches**. Railway's signal engines
   never landed one row in QTP's data.
2. **No caller holds the key.** `INTERNAL_API_TOKEN` (the n8n→Railway credential, distinct
   from the n8n→n8n `webhook_secret` per PR9) appears in **no workflow export**. The 4
   SM-C4 internal callers authenticate to the SSM webhook, not to Railway. The frontend
   (`index.html`) calls only n8n webhooks (`grok3-signal`, `website-signal`, `signal-feed`).
   The only Supabase edge function (`inject_test_signal`) doesn't reach Railway. The single
   Railway reference in any workflow: the **Dead Man's Switch** monitor pinging `/health`.
3. **Every job it had was replaced in-house.** Signal generation → Broad Scanner
   (n8n + Alpaca, ≈98% of ingress). AI analysis → Anthropic in-node. Technicals →
   n8n-native. Even TV-scripts scraping → **Script Scraper v6 scrapes natively in n8n**
   (fetches tradingview.com + pine-facade itself, writes Sheets — it never calls
   Railway `/run`).
4. **The live test already ran itself.** The service answers 404 today; the ledger, funnel
   audits, and the gov 225 fleet sweep show no failure attributable to it. It died (or was
   removed) silently and QTP didn't flinch — that is what zero dependency looks like.

**Honest caveats:** n8n MCP is disconnected this session, so the live workflow set couldn't
be re-read; the no-caller claim rests on repo exports + the zero-fingerprint corpus + this
window's byte audits (main pipeline, Broad Scanner, news feeder). The 5 MCP-blocked
workflows (Risk State Monitor, SSM Watchdog, WRO Monitor, Backtest Audit API, Shadow
Logger) remain unauditable — but proof 4 covers them: if one called Railway, it has already
been failing silently with no operational effect. About the Dead Man's Switch: whatever you
receive mornings tells us its state — daily "Railway Scraper: unreachable" alerts = active;
silence = already off. I'll confirm from execution history on reconnect.

## 3 · Done this commit (repo side)

- **Removed `.github/workflows/deploy-railway.yml`** — it auto-deployed Railway from `main`
  on every push (file moved to `_to_delete/deploy-railway.yml.gov230`, dropped from the
  tree). `ci.yml`'s comment updated; the CI quality gate itself is untouched.
- **Addendum on `TRADINGVIEW-USAGE-20260819.md`** correcting "running or idling" → the
  service is dark (404 at the edge).
- Remaining Railway URL references (PR9 checklist, the monitor export) are historical docs —
  left as history.

## 4 · Your steps (each ~2 min, any order — no urgency, the service is already dark)

1. **Railway dashboard** (railway.app): if the `quantum-scraper` project/service still
   exists, delete it. Its env vars die with it: `TRADINGVIEW_USERNAME/PASSWORD`,
   `XAI_API_KEY`, `INTERNAL_API_TOKEN`, `GOOGLE_SERVICE_ACCOUNT_B64`, `GOOGLE_SHEET_ID`.
   If it's already gone — the 404 suggests it may be — there's nothing to do, and any
   remaining Railway subscription can be cancelled.
2. **GitHub**: repo Settings → Secrets and variables → Actions → delete **`RAILWAY_TOKEN`**.
   (Until this branch merges to `main`, the old deploy workflow still exists there — Actions
   tab → "Deploy to Railway" → ⋯ → Disable workflow.)
3. **TradingView password: change it.** It lived in third-party env for months with
   automated logins. Only side effect: your desktop TradingView (the research bench) asks
   you to sign in again once.
4. **Google Cloud**: revoke the scraper's service-account key (the B64 one). Keep the
   Sheet — it's the historical scrape archive.
5. **Do NOT touch the xAI key yet.** The same key is hardcoded in 3 live n8n workflows
   (news feeder Grok Sentiment Scorer + 2 Website Signal). Rotating it now breaks them; it
   stays on the per-key rotation playbook (same discipline as Polygon, on your word).

## 5 · n8n side (your UI toggles now, or me with full discipline on MCP reconnect)

- **TradingView Script Scraper v6** — deactivate. Nightly TV scrape → Sheets, product
  unconsumed since ~04-20. Workflows list → toggle off.
- **Dead Man's Switch monitor** — has a Railway `/health` leg. If it's active I'll patch
  the leg out on reconnect (it also monitors the retired Signal Agent — worth re-scoping to
  the live fleet at the same time); or toggle it off yourself now.
- Both queue **behind the standing P0** (kill-switch tripwire root-cause) on reconnect.

## Ledger

- Railway verdict on record: **not needed**; already dark; zero dependency in the recorded
  corpus, ever.
- Scraper decommission: authorized; repo side done; dashboard/credentials = PO; n8n
  toggles = PO-or-reconnect.
- Secrets follow-up list updated: TV creds → *retire* (password change), Google SA key →
  *revoke*; xAI / Perplexity / Alpaca-fallback / webhook-secret / `QTP_SB_METER_KEY` items
  unchanged.
- gov 229 corrected by addendum (scraper wasn't "running or idling" — it isn't serving).
