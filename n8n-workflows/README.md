# n8n Workflow Configs — AgilityServ Quantum Trading Pipeline

Disaster recovery backups for all critical n8n workflows running on `tradenextgen.app.n8n.cloud`.

All secrets have been redacted (`REDACTED_*` placeholders). After importing, replace each placeholder with the real credential value in the n8n editor.

---

## Activation Order

Import and activate in this exact sequence — later workflows depend on earlier ones.

| Order | Workflow | File | Why this order |
|---|---|---|---|
| **1** | Signal State Machine v5.16 | `signal-state-machine-v5.16.json` | Core pipeline — everything sends signals to its webhook |
| **2** | Polygon News → Grok Sentiment | `polygon-news-grok-sentiment.json` | Sentiment kill signals feed into the SM webhook |
| **3** | Broad Scanner | `broad-scanner.json` | Scans watchlist and pushes to SM webhook |
| **4** | RT Signal Agent | `rt-signal-agent.json` | Real-time scanner, also pushes to SM webhook |
| **5** | Trailing Stop Manager | `trailing-stop-manager-v1.json` | Manages stops on positions created by the SM |
| **6** | Telegram Grok Analyzer | `telegram-grok-analyzer.json` | Standalone — no dependency on other workflows |

**Why this order matters:** Workflows 2–4 push signals to the Signal State Machine's webhook (`/webhook/tradingview-signal`). If the SM isn't active first, those pushes return 404 and the scanners log errors. The Trailing Stop Manager manages positions already opened by the SM, so it needs the SM running first.

---

## Credential Placeholders

After importing each workflow, search for these placeholders in the Code nodes and replace with real values:

| Placeholder | What it is | Used in |
|---|---|---|
| `REDACTED_ALPACA_KEY_ID` | Alpaca API Key ID | SM, RT Signal Agent, Trailing Stop Manager |
| `REDACTED_ALPACA_SECRET` | Alpaca API Secret Key | SM, RT Signal Agent, Trailing Stop Manager |
| `REDACTED_XAI_API_KEY` | xAI Grok-3 API key | SM (Grok AI Analysis), Polygon Sentiment |
| `REDACTED_TELEGRAM_BOT_TOKEN` | Telegram Bot token | SM, Polygon Sentiment, Broad Scanner, RT Signal Agent |
| `REDACTED_CHAT_ID` | Telegram chat ID (personal) | SM, Polygon Sentiment, Broad Scanner, RT Signal Agent |
| `REDACTED_POLYGON_KEY` | Polygon.io API key | SM (Dark Pool), Polygon Sentiment |
| `REDACTED_JWT_TOKEN` | n8n API key (for Dead-Man's Switch) | Referenced in Dead-Man's Switch workflows (not in this repo) |

### n8n Credential Manager (OAuth-based)

These workflows also reference n8n-managed OAuth credentials that must be configured in **Settings → Credentials** before import:

| Credential Type | Name in n8n | Used by |
|---|---|---|
| `googleSheetsOAuth2Api` | Google Sheets account | SM, Broad Scanner, RT Signal Agent |
| `telegramApi` | Telegram account | SM (Send to Channel, Send VC Pass/Rejection) |
| `telegramApi` | Telegram account 2 | Telegram Grok Analyzer |
| `xAiApi` | xAi account | Telegram Grok Analyzer |

---

## Workflow Details

### 1. Signal State Machine v5.16
- **File:** `signal-state-machine-v5.16.json`
- **n8n ID:** `vaqfCaELhOEWnkdo`
- **Nodes:** 39
- **Trigger:** Webhook POST at `/webhook/tradingview-signal`
- **Schedules:** GTC Re-Check at 9:35 AM ET + 10:00 AM ET (cron `35 13 * * 1-5` and `0 14 * * 1-5` UTC)
- **Dependencies:** Alpaca Paper API, xAI Grok-3, Google Sheets, Telegram, Polygon

**Node chain:**
```
Webhook Trigger
  → Gap News Detector → Indicator Enrichment → Signal State Machine
  → Route Signal (FULL / FAST_ONLY / SKIP)

FULL path:
  → Backtest Engine → Options Flow → Dark Pool → Cross-Asset
  → Grok AI Analysis → VC Agent → VC Score Parser → VC Gate
  → [score ≥ 7] → Grok Signal Analyzer → Alpaca Paper Trade + Telegram
  → [score 6]   → Log + Telegram (no trade)
  → [score < 6] → VC Rejection Logger

FAST_ONLY path:
  → Format Fast Alert → Telegram
  → Alpaca Position Closer

Kill switches: SENTIMENT_KILL (-0.75), TICKER_KILL, COOLDOWN_BLOCK (24h),
KILL_GATE (2+ hard contradictions), DD_HALT, SYSTEM-WIDE DD HALT
```

**Google Sheets used:**
- Signal log: `19Mb7yGbj124ltMmwCx9nrWUYXcd_ViQKPAOW9-JbSMA`
- Shadow log: written via Append Shadow to Sheet node

---

### 2. Polygon News → Grok Sentiment
- **File:** `polygon-news-grok-sentiment.json`
- **n8n ID:** `ARfeHFGyGQGgeXXB`
- **Nodes:** 10
- **Trigger:** Schedule — every 10 minutes
- **Dependencies:** Polygon News API, xAI Grok-3, Telegram

**Node chain:**
```
Every 10 Minutes → Watchlist and Config (105 tickers)
  → Split and Prepare Tickers → Polygon News per Ticker
  → Filter and Deduplicate Articles → Grok Sentiment Scorer
  → Parse and Validate Score → Kill Signal Threshold (-0.75)
  → POST Kill to Signal State Machine webhook
  → Telegram Personal Log
```

**Config (in "Watchlist and Config" Set node):**
- Tickers: 105 S&P 500 + watchlist tickers
- Sentiment kill threshold: -0.75
- Lookback: 240 minutes (4 hours)
- SM webhook: `https://tradenextgen.app.n8n.cloud/webhook/tradingview-signal`

---

### 3. Broad Scanner
- **File:** `broad-scanner.json`
- **n8n ID:** `975pZZEtxeUbzI22`
- **Nodes:** 5
- **Trigger:** Schedule — every 5 minutes
- **Dependencies:** Google Sheets (ticker watchlist), SM webhook

**Node chain:**
```
Every 5 Minutes → Load Tickers (Google Sheet)
  → Scan All Tickers (Code — fetches data, computes indicators, scores)
  → Push to Pipeline (HTTP POST to SM webhook)
```

**Google Sheets used:**
- Ticker watchlist: `1gMSYFW6ZsJpIkyXQQZOxczfr1ryLC3pb1TI3C_-2v-E` (Sheet1)

---

### 4. RT Signal Agent
- **File:** `rt-signal-agent.json`
- **n8n ID:** `qq1mZLLsuUtot0ID`
- **Nodes:** 4
- **Trigger:** Schedule — every 5 minutes
- **Dependencies:** Google Sheets (ticker watchlist), Alpaca Market Data, SM webhook

**Node chain:**
```
Schedule Trigger → Load Tickers (Google Sheet)
  → Fetch & Evaluate (Code — Alpaca bars + indicator computation)
  → Push to Pipeline (HTTP POST to SM webhook)
```

**Google Sheets used:**
- Ticker watchlist: `1gMSYFW6ZsJpIkyXQQZOxczfr1ryLC3pb1TI3C_-2v-E` (Sheet1)

**Known issue:** Add retry on the Google Sheets node (Retry on Fail = true, Max Tries = 2, Wait = 30s) to handle transient Sheets API errors.

---

### 5. Trailing Stop Manager v1.0
- **File:** `trailing-stop-manager-v1.json`
- **n8n ID:** `vFnPjyx8srnzcYgV`
- **Nodes:** 2
- **Trigger:** Schedule — every 15 minutes
- **Dependencies:** Alpaca Paper API, Alpaca Market Data API (SIP feed), Telegram

**Node chain:**
```
Every 15 min → Trail Stops (Code)
  → Fetch positions + stop orders from Alpaca
  → Calculate 14-day ATR from daily bars
  → Apply tiered trailing logic
  → Cancel old stop → place new higher stop
  → Telegram alert for each adjustment
```

**Trailing tiers:**
| Tier | Trigger | New Stop Level |
|---|---|---|
| 0 | Entry (placed by SM) | Entry - 1.5×ATR |
| 1 | Price ≥ Entry + 1.5×ATR | Breakeven (entry - $0.05 buffer) |
| 2 | Price ≥ Entry + 3.0×ATR | Entry + 1.5×ATR |
| 3 | Price ≥ Entry + 4.5×ATR | Entry + 3.0×ATR |

**Note:** Credentials (Alpaca key/secret, Telegram token) are embedded in the Code node, not in the `REDACTED_*` format. They were not caught by GitHub push protection on initial push. If rotating credentials, update the `HDR` and `TG_URL` constants in the Trail Stops code.

---

### 6. Telegram Grok Analyzer
- **File:** `telegram-grok-analyzer.json`
- **n8n ID:** `ZpiY9O8xpW3KV0nH`
- **Nodes:** 7
- **Trigger:** Telegram message (via Telegram Trigger node)
- **Dependencies:** Telegram Bot API, xAI Grok-3

**Node chain:**
```
Telegram Trigger → Filter Trading Signals
  → Format Signal Prompt → Grok Signal Analyzer (AI Agent)
  → xAI Grok Chat Model → Log Analysis
```

**Credentials:** Uses n8n credential manager (`telegramApi`, `xAiApi`) — not embedded in code. Re-configure these in n8n Settings → Credentials after import.

---

## Google Sheets Reference

| Sheet | ID | Used by |
|---|---|---|
| Ticker Watchlist | `1gMSYFW6ZsJpIkyXQQZOxczfr1ryLC3pb1TI3C_-2v-E` | Broad Scanner, RT Signal Agent |
| Signal Log | `19Mb7yGbj124ltMmwCx9nrWUYXcd_ViQKPAOW9-JbSMA` | SM (Append to Google Sheet) |
| Public Signal Feed | `1ACjgFqi9k6pkKafjD9AiDMWCHIwvEE-MFPR6dW4e1KM` | Signal Feed workflow (not in this repo) |

---

## Disaster Recovery Procedure

1. Log into `https://tradenextgen.app.n8n.cloud`
2. Verify Google Sheets OAuth credential exists in Settings → Credentials (re-authenticate if needed)
3. Verify Telegram API credential exists
4. Import workflows **in the order listed above** (dashboard → Import from JSON)
5. For each imported workflow:
   - Open the editor
   - Search for `REDACTED_` in all Code nodes
   - Replace each placeholder with the real credential value
   - Save (Ctrl+S)
   - Activate (toggle ON)
6. Verify the SM webhook responds: `curl -X POST https://tradenextgen.app.n8n.cloud/webhook/tradingview-signal -H "Content-Type: application/json" -d '{"ticker":"TEST"}'`
7. Monitor first 5 minutes of execution for errors in each workflow's execution log

---

*Last updated: April 13, 2026*
