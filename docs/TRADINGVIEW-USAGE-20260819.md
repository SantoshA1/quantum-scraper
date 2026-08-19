# gov 229 — How TradingView is actually used in QTP (2026-08-19)

**Analysis only — no state changed. Read-only session (n8n MCP disconnected).**

**Verdict up front:** TradingView is QTP's **ancestor, not its dependency**. Not one live
trading decision touches TradingView today. It survives in four places: as the *name* on the
front door, as the *schema* every signal still speaks, as a *retired scraper* that still
holds live TradingView login credentials, and as a *research bench* on the Mac. Zero of the four
are in the signal-to-fill path.

---

## 1 · Signal ingress: zero TradingView signals in 90 days

Every payload that entered the `tradingview-signal` webhook in the last 90 days, by source:

| source tag | rows | when | what it really is |
|---|---|---|---|
| `BROAD_SCANNER` / `server_side` / UA `n8n` | **13,043 (≈98%)** | continuous, live through today | QTP's own internal Broad Scanner (gov 224 cursor) |
| `TRADINGVIEW_AI_SUPER_SCORE` | **129** | **all on 2026-05-27**, `qtp_source="phase"` | the Phase 2b **Synthetic Injection One-Shot** — my test harness wearing the TV label, not TradingView |
| other | remainder | scattered | internal manual/test traffic, none TradingView-tagged |

**Not a single genuine TradingView-originated signal exists in the 90-day record.** And one
*couldn't* arrive today even if a Pine alert fired: since the SM-C4/SE-C5 hardening, the
webhook requires a `_secret` known to exactly **4 internal callers** (plus Railway's
`INTERNAL_API_TOKEN` middleware on the server side). TradingView's alert POSTs carry no
secret. The front door still has the old name on it, but the lock was changed and only
internal callers hold keys.

## 2 · Why everything is still *named* TradingView: the contract outlived the sender

The main pipeline is still called "TradingView AI Super Score → Perplexity → Telegram"; the
webhook path is still literally `"path": "tradingview-signal"`. That is not dead code — it
is a preserved **contract**. The TV Pine alert template defined the signal payload schema
(ticker / price / bias_score / adx / rsi / mtf fields …), and when the v5.5 server-side
cutover replaced TradingView as the sender, the Broad Scanner adopted that schema verbatim
so nothing downstream had to change. Same pattern as "Grok AI Analysis" being Claude Opus
under the hood (gov 227 provider note): **legacy names, preserved contracts, replaced
engines.** Renaming would touch 4 internal callers and 150+ nodes for zero operational gain
— recommend leaving the names alone and letting docs carry the truth.

## 3 · The scraper: the repo's namesake is a retired organ — with live credentials

The repo is literally named `quantum-scraper` after this. What exists:

- **`app.js` — "quantum-scraper v2.0 — TradingView Pine Script Scraper"** on Railway.
  Puppeteer logs into tradingview.com with **`TRADINGVIEW_USERNAME` / `TRADINGVIEW_PASSWORD`**
  env credentials (app.js:31-32) and scrapes `/scripts/editors-picks/` and
  `/scripts/?sort=popularity` (app.js:691, 698).
- **n8n "TradingView Script Scraper v6"** — nightly 2AM ET schedule trigger in the export,
  writes to Google Sheets. Live enabled-state unverifiable this session (MCP down).

**The decisive fact is downstream: nothing consumes its output anymore.**
`quantum_watchlist_raw` = 624 rows — `script_url` **NULL on all 624**, authors **0**.
Provenance: 531 rows from Broad Scanner / Real-Time Signal Agent / Strat Cache Builder
(newest **2026-04-20**), 85 `manual` (2026-07-22), 8 mixed (2026-04-24). The trading
universe has been internally sourced + manual adds since ~April; not one current watchlist
row traces to a scraped TradingView script.

**Security angle (new item for the hardcoded-secrets follow-up list):** a real TradingView
username/password pair sits live in Railway env, powering automated logins for a function
with no consumer. That is idle credential surface (and automated scraping sits poorly with
TV's ToS). Decommission vs deliberate revival is your call — my recommendation is
**decommission**: kill the Railway scrape job and the Script Scraper v6 workflow, retire the
TV credentials, keep the code in git history.

## 4 · The one live use: your desktop TradingView MCP — research, not trading

The Mac's desktop bridge exposes ~100 `tradingview__*` tools (charts, Pine editor, replay,
alerts, screenshots). This is how the Pine out-of-sample work got done on 08-13/08-14
(`PINE-OOS-*` docs): I drive TradingView interactively for research — compiling Pine,
pulling OHLCV, reading strategy results. **The cloud n8n runtime cannot reach these tools
and never does** — they exist only while your desktop app is open, and nothing in the
signal-to-fill path references them. This is the healthy configuration: TradingView as lab
bench, Alpaca+Polygon+internal scanner as production.

## 5 · Summary map

| TradingView touchpoint | status | in the trading path? |
|---|---|---|
| Live signal source (Pine alerts → webhook) | **dead since v5.5 cutover**; auth now excludes it | no |
| Webhook path + pipeline names + payload schema | alive as **legacy contract** | cosmetically only |
| Pine-script scraper (Railway + Script Scraper v6 + Sheets) | running or idling, **output unconsumed since ~04-20** | no |
| Universe sourcing from scraped scripts | retired (~April); universe now internal + manual | no |
| Desktop TradingView MCP (~100 tools) | **active, interactive research only** | no |
| `TRADINGVIEW_USERNAME/PASSWORD` in Railway env | **live credentials, idle purpose** | no — but real secret surface |

## Ledger

- **Added to the hardcoded-secrets follow-up list:** `TRADINGVIEW_USERNAME` /
  `TRADINGVIEW_PASSWORD` (Railway env) — retire with the scraper, or rotate if kept.
- **PO decision open:** scraper decommission (my recommendation) vs revival as a deliberate
  research feed.
- No gov action taken; nothing in this audit changes trading behavior.
- Standing P0 unchanged: kill-switch tripwire root-cause when n8n MCP reconnects.

---

## ADDENDUM (gov 230, same day) — decommission ordered; Railway found already dark

PO authorized the scraper decommission and asked whether Railway is needed at all. Full
evidence and runbook: `RAILWAY-DECOMMISSION-20260819.md`. Verdict: **not needed.** Two
corrections to §3 above: (1) the Railway app only ever scrapes on `POST /run` — it has no
self-scheduling — and n8n's Script Scraper v6 scrapes TradingView **natively**, never
calling Railway; (2) a live probe today shows the Railway service answering **404 on `/`
and `/health`** — "running or idling" overstated it: **the service is not serving at all**,
and QTP never noticed. The Railway auto-deploy workflow was removed from the repo in the
gov 230 commit. Railway also hosted retired Grok-3 `/signal`, xAI `/ai-analysis`, and
Yahoo-based `/technical` engines — zero fingerprints from any of them in the full recorded
corpus (27,197 signals + 770 verdicts, all time).
