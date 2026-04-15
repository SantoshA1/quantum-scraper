/* ─────────────────────────────────────────────────────────────
 *  quantum-scraper  v2.0  —  TradingView Pine Script Scraper
 *  Single-file Express + Playwright service for Railway
 * ───────────────────────────────────────────────────────────── */

const express = require('express');
const { chromium } = require('playwright-core');
const { google } = require('googleapis');
const https = require('https');
const http = require('http');
const rateLimit = require('express-rate-limit');
const { validateTicker } = require('./sp500');
const { signPayload } = require('./webhook-auth');

// ── ENV ───────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '8080', 10);
// SECURITY FIX (Audit C-1): API key MUST come from environment variable.
// No hardcoded fallback. Crash immediately if missing to prevent silent failure.
// Set XAI_API_KEY in Railway dashboard → Variables, or in your .env file.
const XAI_API_KEY = process.env.XAI_API_KEY;
if (!XAI_API_KEY) {
  console.error(
    '\n╔══════════════════════════════════════════════════════════════╗\n' +
    '║  FATAL: XAI_API_KEY environment variable is not set.       ║\n' +
    '║  The server cannot start without a valid xAI API key.      ║\n' +
    '║  Set it in Railway Variables or your local .env file.       ║\n' +
    '╚══════════════════════════════════════════════════════════════╝\n'
  );
  process.exit(1);
}
const TV_USER = process.env.TRADINGVIEW_USERNAME || '';
const TV_PASS = process.env.TRADINGVIEW_PASSWORD || '';
const SHEET_ID = process.env.GOOGLE_SHEET_ID || '16QmkJdHUptjAxLkVpJ5bghVSKRup3KtjKyaHQtz6BoQ';
const SHEET_NAME = process.env.GOOGLE_SHEET_NAME || 'Sheet1';
const SA_B64 = process.env.GOOGLE_SERVICE_ACCOUNT_B64 || '';
const WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || 'https://tradenextgen.app.n8n.cloud/webhook/script-scraper-complete';
const SCRIPTS_PER_CAT = parseInt(process.env.SCRIPTS_PER_CATEGORY || '30', 10);

// ── STATE ─────────────────────────────────────────────────────
let lastRun = null;
let lastStatus = 'idle';
let lastError = null;
let running = false;
let scriptsFound = 0;
let lastResults = [];

// ── EXPRESS  (starts IMMEDIATELY — fixes 502) ─────────────────
const app = express();
app.use(express.json());

// ── CORS (Audit C-3) ─────────────────────────────────────────
// Restrict to known origins. Server-to-server calls (n8n, Alpaca)
// don't send an Origin header, so CORS doesn't apply to them.
// Override via CORS_ALLOWED_ORIGINS env var (comma-separated).
const ALLOWED_ORIGINS = new Set(
  (process.env.CORS_ALLOWED_ORIGINS ||
    'https://agilityserv.com,https://www.agilityserv.com,http://localhost:3000,http://localhost:8080'
  ).split(',').map(o => o.trim()).filter(Boolean)
);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  // If no Origin header (server-to-server) or unknown origin: no CORS header set → browser blocks it
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    // Only send 204 for preflight if origin is allowed
    if (origin && ALLOWED_ORIGINS.has(origin)) return res.sendStatus(204);
    return res.sendStatus(403);
  }
  next();
});

// ── RATE LIMITING (Audit C-2) ────────────────────────────────
// 20 requests per minute per IP for signal/analysis endpoints.
const signalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Rate limit exceeded. Maximum 20 requests per minute.',
    retryAfterSeconds: 60,
  },
  keyGenerator: (req) => {
    return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
      || req.ip
      || 'unknown';
  },
});

// ── TICKER VALIDATION MIDDLEWARE (Audit C-2) ─────────────────
// Validates ticker from body (POST) or query (GET) against S&P 500 whitelist.
function tickerValidation(req, res, next) {
  const raw = req.body?.ticker || req.query?.ticker;
  const result = validateTicker(raw);
  if (!result.valid) {
    return res.status(400).json({
      error: 'Invalid ticker',
      detail: result.reason,
      hint: 'Only S&P 500 constituents and approved ETFs are accepted.',
    });
  }
  // Normalize ticker for downstream handlers
  if (req.body?.ticker) req.body.ticker = result.ticker;
  if (req.query?.ticker) req.query.ticker = result.ticker;
  next();
}

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    running,
    lastRun,
    lastStatus,
    lastError,
    scriptsFound,
    uptime: process.uptime(),
  });
});

app.post('/run', (_req, res) => {
  if (running) return res.status(409).json({ error: 'Scrape already in progress' });
  res.json({ message: 'Scrape started — check /health for status or watch logs' });
  runScrape().catch(err => console.error('[FATAL]', err));
});

app.get('/', (_req, res) => res.json({ service: 'quantum-scraper', version: '2.7.0' }));

/* ─────────────────────────────────────────────────────────────
 *  /signal  — Grok-3 Quantum Pipeline Signal Engine
 *  POST { ticker, price, change, rsi, macd, ema20, ema50,
 *         bb_upper, bb_lower, volume, atr, obv, indicators[] }
 *  Returns { signal, confidence, correlationScore, vcGateScore,
 *            reasons[], tradePlan{}, standAsideConditions[],
 *            marketContext, meta{}, poweredBy }
 * ───────────────────────────────────────────────────────────── */
app.post('/signal', signalLimiter, tickerValidation, async (req, res) => {
  const {
    ticker = 'UNKNOWN', price = 0,
    change = 0, changePct = 0,
    rsi = 50, macd = 0, macdSignal = 0, macdHist = 0,
    ema20 = 0, ema50 = 0,
    bbUpper = 0, bbMiddle = 0, bbLower = 0, bbPosition = 0.5,
    atr = 0, obvTrend = 'NEUTRAL', volRatio = 1,
    high52 = 0, low52 = 0, lastDate = 'N/A', roc10 = 0,
    // also accept snake_case
    bb_upper, bb_lower, volume = 0, obv = 0, indicators = []
  } = req.body || {};

  const bbUp = bbUpper || bb_upper || 0;
  const bbLo = bbLower || bb_lower || 0;
  const pct = changePct || change;

  const systemPrompt = `You are the AgilityServ Quantum Trading Pipeline AI, powered by Grok-3.
You are a world-class quant analyst. Analyze the given ticker's technical indicators and output a structured JSON trading signal.

Rules:
- Signal must be exactly one of: "BUY", "SELL", or "STAND ASIDE"
- Confidence is 0-100 (integer)
- correlationScore is 0-100 (cross-asset momentum alignment score)
- vcGateScore is 0-100 (volatility-corrected momentum gate score)
- reasons: 3-5 specific data-backed bullet strings citing actual indicator values
- tradePlan: direction ("LONG" or "SHORT"), entry, stopLoss, target1, target2 as "$X.XX" strings, riskReward as "1:X" ratio
- standAsideConditions: 2-3 specific conditions that would invalidate the signal
- marketContext: 1 concise sentence about current macro/sector context for this ticker
- meta.color: "#00E599" for BUY, "#FF4444" for SELL, "#FFB800" for STAND ASIDE
- meta.glow: rgba string matching the color (e.g. "rgba(0,229,153,0.35)" for BUY)
- poweredBy: always exactly "Grok-3 · AgilityServ Quantum Pipeline"

Output ONLY valid JSON with these exact keys. No markdown fences. No explanation outside the JSON.
- CRITICAL: Use square brackets [ ] for ALL JSON arrays. NEVER use Python-style parentheses ( ) for arrays.`;

  const userMsg = `Ticker: ${ticker} | Last Close: $${price} (${pct >= 0 ? '+' : ''}${Number(pct).toFixed(2)}%) | Date: ${lastDate}

Technical Indicators:
- RSI(14): ${rsi} ${rsi > 70 ? '[OVERBOUGHT]' : rsi < 30 ? '[OVERSOLD]' : '[NEUTRAL]'}
- MACD: ${macd} | Signal: ${macdSignal} | Histogram: ${Number(macdHist).toFixed(4)}
- EMA20: $${Number(ema20).toFixed(2)} | EMA50: $${Number(ema50).toFixed(2)} ${ema20 > ema50 ? '[BULLISH CROSS]' : '[BEARISH CROSS]'}
- Bollinger Upper: $${Number(bbUp).toFixed(2)} | Mid: $${Number(bbMiddle).toFixed(2)} | Lower: $${Number(bbLo).toFixed(2)}
- BB Position: ${Number(bbPosition * 100).toFixed(0)}% (0=lower band, 100=upper band)
- ATR(14): ${atr} | OBV Trend: ${obvTrend} | Volume Ratio vs Avg: ${Number(volRatio).toFixed(2)}x
- 52W High: $${high52} | 52W Low: $${low52} | ROC(10): ${roc10}%

Provide the Quantum Pipeline signal JSON for ${ticker}.`;


  try {
    const payload = JSON.stringify({
      model: 'grok-3',
      temperature: 0.2,
      max_tokens: 900,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMsg }
      ]
    });

    const xaiRes = await new Promise((resolve, reject) => {
      const req2 = https.request({
        hostname: 'api.x.ai',
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + XAI_API_KEY,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        },
        timeout: 30000
      }, (r) => {
        let body = '';
        r.on('data', d => body += d);
        r.on('end', () => resolve({ status: r.statusCode, body }));
      });
      req2.on('error', reject);
      req2.on('timeout', () => { req2.destroy(); reject(new Error('xAI timeout')); });
      req2.write(payload);
      req2.end();
    });

    if (xaiRes.status !== 200) {
      console.error('[SIGNAL] xAI error:', xaiRes.status, xaiRes.body.substring(0, 200));
      return res.status(502).json({ error: 'xAI API error', status: xaiRes.status });
    }

    const xaiJson = JSON.parse(xaiRes.body);
    const content = xaiJson.choices?.[0]?.message?.content || '';

    // Sanitize LLM response: strip fences + fix Python tuple arrays → JSON arrays
    const clean = sanitizeLLMJson(content);
    const signal = JSON.parse(clean);

    console.log(`[SIGNAL] ${ticker} → ${signal.signal} (${signal.confidence}%)`);
    res.json(signal);
  } catch (err) {
    console.error('[SIGNAL] Failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ─────────────────────────────────────────────────────────────
 *  /ai-analysis  — Structured AI verdict for Telegram messages
 *  POST { ticker, signal_type, price, rsi, macd, adx, bias,
 *         vix, cross_asset, options, dark_pool, strategy_stats }
 *  Returns the parsed JSON analysis (no raw API object)
 * ───────────────────────────────────────────────────────────── */
app.post('/ai-analysis', signalLimiter, tickerValidation, async (req, res) => {
  const {
    ticker = 'UNKNOWN',
    signal_type = 'UNKNOWN',
    price = 0,
    rsi = null,
    macd = null,
    adx = null,
    bias = null,
    vix = null,
    cross_asset = '',
    options = '',
    dark_pool = '',
    strategy_stats = ''
  } = req.body || {};

  const prompt = `You are a quantitative trading AI analyst. Analyze the trading signal context below.

Output ONLY a valid JSON object — no markdown, no explanation, no extra text.
CRITICAL: Use square brackets [ ] for JSON arrays. NEVER use Python parentheses ( ) for arrays.

Context:
Ticker: ${ticker}
Signal: ${signal_type}
Price: $${price}
RSI: ${rsi != null ? rsi : 'N/A'}
MACD: ${macd != null ? macd : 'N/A'}
ADX: ${adx != null ? adx : 'N/A'}
Bias: ${bias != null ? bias + '%' : 'N/A'}
VIX: ${vix != null ? vix : 'N/A'}
Cross-Asset: ${cross_asset || 'N/A'}
Options Flow: ${options || 'N/A'}
Dark Pool: ${dark_pool || 'N/A'}
Strategy Stats: ${strategy_stats || 'N/A'}

Return exactly this JSON structure:
{
  "spy_correlation": <float 0.0-1.0>,
  "sentiment": "<bearish|bullish|neutral>",
  "sweep_verdict": "<positive|negative|neutral>",
  "strategy_performance": <float 0.0-1.0>,
  "options_flow": "<bearish|bullish|neutral>",
  "cross_asset": "<correlated|uncorrelated|divergent|neutral>",
  "signal_verdict": "<valid|invalid|confirmed|unconfirmed>",
  "confidence": <float 0.0-1.0>,
  "trade_action": "<BUY|SELL|HOLD>",
  "regime_tags": ["<tag1>", "<tag2>"]
}`;

  try {
    const payload = JSON.stringify({
      model: 'grok-3',
      temperature: 0.1,
      max_tokens: 320,
      messages: [{ role: 'user', content: prompt }]
    });

    const xaiRes = await new Promise((resolve, reject) => {
      const r2 = https.request({
        hostname: 'api.x.ai',
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + XAI_API_KEY,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        },
        timeout: 30000
      }, (r) => {
        let body = '';
        r.on('data', d => body += d);
        r.on('end', () => resolve({ status: r.statusCode, body }));
      });
      r2.on('error', reject);
      r2.on('timeout', () => { r2.destroy(); reject(new Error('xAI timeout')); });
      r2.write(payload);
      r2.end();
    });

    if (xaiRes.status !== 200) {
      console.error('[AI-ANALYSIS] xAI error:', xaiRes.status, xaiRes.body.substring(0, 200));
      return res.status(502).json({ error: 'xAI API error', status: xaiRes.status });
    }

    const xaiJson = JSON.parse(xaiRes.body);
    const rawContent = xaiJson.choices?.[0]?.message?.content || '';
    const clean = sanitizeLLMJson(rawContent);
    const analysis = JSON.parse(clean);

    console.log(`[AI-ANALYSIS] ${ticker} → ${analysis.trade_action} (conf: ${analysis.confidence})`);
    res.json(analysis);
  } catch (err) {
    console.error('[AI-ANALYSIS] Failed:', err.message);
    res.status(500).json({ error: err.message, hint: 'JSON parse failed — raw LLM response had invalid syntax' });
  }
});

/* ─────────────────────────────────────────────────────────────
 *  /technical  — Fetch & compute technical indicators
 *  GET /technical?ticker=TXG
 *  Returns { rsi, macd, macd_signal, macd_hist, adx,
 *            sma50, ema200, vwap, range, range_high, range_low }
 * ───────────────────────────────────────────────────────────── */
app.get('/technical', signalLimiter, tickerValidation, async (req, res) => {
  const ticker = req.query.ticker; // Already validated & normalized by tickerValidation middleware

  try {
    // Fetch 250 days daily + today's 5-min intraday in parallel
    const [daily, intraday] = await Promise.all([
      fetchYahooChart(ticker, '250d', '1d'),
      fetchYahooChart(ticker, '1d', '5m')
    ]);

    if (!daily || daily.closes.length < 30) {
      return res.status(404).json({ error: `No data found for ${ticker}` });
    }

    const { closes, highs, lows, volumes } = daily;

    const rsiVal       = calcRSI(closes, 14);
    const macdObj      = calcMACD(closes);
    const adxVal       = calcADX(highs, lows, closes, 14);
    const sma50Val     = calcSMA(closes, 50);
    const ema200Val    = calcEMA(closes, 200);
    const todayHigh    = highs[highs.length - 1];
    const todayLow     = lows[lows.length - 1];
    const range        = parseFloat((todayHigh - todayLow).toFixed(4));

    let vwapVal = null;
    if (intraday && intraday.closes.length > 0) {
      vwapVal = calcVWAP(intraday.highs, intraday.lows, intraday.closes, intraday.volumes);
    }

    res.json({
      ticker,
      rsi:         rsiVal,
      macd:        macdObj ? macdObj.macd        : null,
      macd_signal: macdObj ? macdObj.signal      : null,
      macd_hist:   macdObj ? macdObj.histogram   : null,
      adx:         adxVal,
      sma50:       sma50Val,
      ema200:      ema200Val,
      vwap:        vwapVal,
      range,
      range_high:  parseFloat(todayHigh.toFixed(4)),
      range_low:   parseFloat(todayLow.toFixed(4)),
      timestamp:   new Date().toISOString()
    });
  } catch (err) {
    console.error('[TECHNICAL]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Return last scrape results (for debugging)
app.get('/results', (_req, res) => {
  const summary = lastResults.map(r => ({
    title: r.title,
    author: r.author,
    script_url: r.script_url,
    pine_code_length: r.pine_code ? r.pine_code.length : 0,
    pine_code_preview: r.pine_code ? r.pine_code.substring(0, 100) : '',
    is_protected: r.is_protected,
  }));
  res.json({ count: summary.length, scripts: summary });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[SERVER] Listening on 0.0.0.0:${PORT}`);
});

/* ═══════════════════════════════════════════════════════════════
 *  SCRAPER CORE
 * ═══════════════════════════════════════════════════════════════ */

async function runScrape() {
  running = true;
  lastStatus = 'running';
  lastError = null;
  scriptsFound = 0;
  const startTime = Date.now();
  let browser;

  try {
    console.log('[SCRAPE] Launching browser …');
    const launchOpts = {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process',
      ],
    };
    // Use system Chromium if available (Docker), otherwise Playwright's bundled one
    if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
      launchOpts.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    }
    browser = await chromium.launch(launchOpts);
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);

    // ── Step 1: Login (optional — open-source scripts work without it)
    if (TV_USER && TV_PASS) {
      console.log('[SCRAPE] Attempting TradingView login …');
      try {
        await tvLogin(page);
      } catch (loginErr) {
        console.log(`[SCRAPE] Login failed: ${loginErr.message} — continuing without login`);
      }
    } else {
      console.log('[SCRAPE] No credentials — running without login');
    }

    // ── Step 2: Collect script URLs ─────────────────────────
    console.log('[SCRAPE] Collecting script URLs …');
    const scriptUrls = await collectScriptUrls(page);
    console.log(`[SCRAPE] Found ${scriptUrls.length} script URLs`);

    // ── Step 3: Extract Pine code from each script ──────────
    const results = [];
    for (let i = 0; i < scriptUrls.length; i++) {
      const url = scriptUrls[i];
      console.log(`[SCRAPE] (${i + 1}/${scriptUrls.length}) ${url}`);
      try {
        const data = await extractScript(page, url);
        results.push(data);
      } catch (err) {
        console.error(`[SCRAPE] Failed ${url}: ${err.message}`);
        results.push({
          title: 'UNKNOWN',
          author: 'UNKNOWN',
          script_url: url,
          category: 'unknown',
          pine_code: 'ERROR: ' + err.message,
          is_protected: true,
          description: '',
          screenshot_url: '',
          scraped_at: new Date().toISOString(),
        });
      }
    }

    scriptsFound = results.length;
    lastResults = results;
    const withCode = results.filter(r => !r.is_protected && !r.pine_code.startsWith('ERROR')).length;
    console.log(`[SCRAPE] Done: ${results.length} scripts, ${withCode} with Pine code`);

    // ── Step 4: Push to Google Sheets ───────────────────────
    if (SA_B64) {
      console.log('[SHEETS] Pushing to Google Sheets …');
      await pushToSheets(results);
      console.log('[SHEETS] Done');
    } else {
      console.log('[SHEETS] Skipped — no GOOGLE_SERVICE_ACCOUNT_B64');
    }

    // ── Step 5: Send webhook to n8n ─────────────────────────
    if (WEBHOOK_URL) {
      console.log('[WEBHOOK] Notifying n8n …');
      await sendWebhook(results);
      console.log('[WEBHOOK] Done');
    }

    lastRun = new Date().toISOString();
    lastStatus = 'success';
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[SCRAPE] Complete in ${elapsed}s — ${withCode} scripts with code`);
  } catch (err) {
    lastStatus = 'error';
    lastError = err.message;
    console.error('[SCRAPE] FAILED:', err);
  } finally {
    if (browser) await browser.close().catch(() => {});
    running = false;
  }
}

/* ─────────────────────────────────────────────────────────────
 *  TradingView Login
 * ───────────────────────────────────────────────────────────── */
async function tvLogin(page) {
  await page.goto('https://www.tradingview.com/#signin', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sleep(4000);

  // Step 1: Click "Email" button in the sign-in panel
  try {
    // The Email button in the initial sign-in panel
    const emailBtn = page.locator('button[name="Email"], button:has-text("Email")').first();
    await emailBtn.click({ timeout: 10000 });
    await sleep(2000);
    console.log('[LOGIN] Clicked Email button');
  } catch {
    console.log('[LOGIN] No Email button found — form may already be visible');
  }

  // Step 2: Fill username (stable selectors: name="username" or id="id_username")
  const usernameField = page.locator('#id_username, input[name="username"]').first();
  await usernameField.waitFor({ state: 'visible', timeout: 10000 });
  await usernameField.fill(TV_USER);
  await sleep(500);
  console.log('[LOGIN] Filled username');

  // Step 3: Fill password (stable selectors: name="password" or id="id_password")
  const passwordField = page.locator('#id_password, input[name="password"]').first();
  await passwordField.waitFor({ state: 'visible', timeout: 5000 });
  await passwordField.fill(TV_PASS);
  await sleep(500);
  console.log('[LOGIN] Filled password');

  // Step 4: Click Sign In submit button
  try {
    // Try multiple selector strategies
    const signInBtn = page.locator('button[type="submit"], button:has-text("Sign in"), button[class*="submitButton"]').first();
    await signInBtn.click({ timeout: 8000 });
    console.log('[LOGIN] Clicked Sign In');
  } catch {
    // Fallback: press Enter in the password field
    console.log('[LOGIN] Submit button not found — pressing Enter');
    await passwordField.press('Enter');
  }
  await sleep(5000);

  // Step 5: Verify login — check for user menu avatar
  try {
    await page.waitForSelector('[data-name="user-menu-button"], [class*="userAvatar"]', { timeout: 15000 });
    console.log('[LOGIN] Success — logged in');
  } catch {
    // Check if there's a CAPTCHA or 2FA
    const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 2000));
    if (bodyText.includes('captcha') || bodyText.includes('CAPTCHA') || bodyText.includes('robot')) {
      console.log('[LOGIN] CAPTCHA detected — continuing without login');
    } else if (bodyText.includes('Two factor') || bodyText.includes('verification')) {
      console.log('[LOGIN] 2FA required — continuing without login');
    } else {
      console.log('[LOGIN] Could not confirm login — continuing anyway');
    }
  }
}

/* ─────────────────────────────────────────────────────────────
 *  Collect Script URLs from /scripts/ page
 * ───────────────────────────────────────────────────────────── */
async function collectScriptUrls(page) {
  const urls = new Set();

  // Helper: scrape one tab's script links
  async function scrapeListPage(categoryUrl, category, max) {
    try {
      await page.goto(categoryUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await sleep(3000);

      // Scroll to load more scripts
      for (let s = 0; s < 5; s++) {
        await page.evaluate(() => window.scrollBy(0, 1500));
        await sleep(1500);
      }

      // Collect all script links
      const links = await page.$$eval('a[href*="/script/"]', (anchors) =>
        anchors
          .map(a => a.href)
          .filter(h => h.includes('/script/') && !h.includes('/chart/'))
      );

      let count = 0;
      for (const link of links) {
        const clean = link.split('?')[0].split('#')[0];
        if (!urls.has(clean) && count < max) {
          urls.add(clean);
          count++;
        }
      }
      console.log(`[COLLECT] ${category}: found ${count} new URLs`);
    } catch (err) {
      console.error(`[COLLECT] ${category} failed: ${err.message}`);
    }
  }

  // Editors' Picks
  await scrapeListPage(
    'https://www.tradingview.com/scripts/editors-picks/',
    'editors_picks',
    SCRIPTS_PER_CAT
  );

  // Most Popular (default /scripts/ page, sorted by popularity)
  await scrapeListPage(
    'https://www.tradingview.com/scripts/?sort=popularity',
    'popular',
    SCRIPTS_PER_CAT
  );

  return [...urls];
}

/* ─────────────────────────────────────────────────────────────
 *  Extract Pine code from a single script page
 * ───────────────────────────────────────────────────────────── */
async function extractScript(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sleep(2500);

  // Get title
  const title = await page
    .$eval('h1', el => el.textContent.trim())
    .catch(() => page.title());

  // Get author
  const author = await page
    .$eval('a[href*="/u/"] span, .tv-chart-view__title-author a', el => el.textContent.trim())
    .catch(() => 'unknown');

  // Get description from meta tag
  const description = await page
    .$eval('meta[property="og:description"]', el => el.content)
    .catch(() => '');

  // Get screenshot URL from og:image
  const screenshotUrl = await page
    .$eval('meta[property="og:image"]', el => el.content)
    .catch(() => '');

  // Determine category from URL structure or page content
  const category = url.includes('editors') ? 'editors_picks' : 'popular';

  // ── Try to extract Pine code ────────────────────────────
  let pineCode = '';
  let isProtected = false;

  // Step A: Click "Source code" tab (TV shows Chart tab by default)
  try {
    const sourceTab = page.locator('[role="tab"]').filter({ hasText: /source\s*code/i }).first();
    await sourceTab.click({ timeout: 8000 });
    await sleep(2500);
    console.log(`[EXTRACT] Clicked Source code tab`);
  } catch {
    console.log(`[EXTRACT] No Source code tab — might be protected`);
  }

  // Step B: Try clipboard intercept + Copy button
  // TV renders code as hundreds of <span> tokens — Copy button is most reliable
  try {
    // Intercept both clipboard.writeText AND execCommand('copy')
    await page.evaluate(() => {
      window.__copiedText = '';
      // Intercept modern clipboard API
      if (navigator.clipboard && navigator.clipboard.writeText) {
        const orig = navigator.clipboard.writeText.bind(navigator.clipboard);
        navigator.clipboard.writeText = async (text) => {
          window.__copiedText = text;
          return orig(text);
        };
      }
      // Intercept legacy execCommand('copy') — capture selection
      const origExec = document.execCommand.bind(document);
      document.execCommand = function(cmd, ...args) {
        if (cmd === 'copy') {
          const sel = window.getSelection();
          if (sel) window.__copiedText = sel.toString();
        }
        return origExec(cmd, ...args);
      };
    });

    const copyBtn = page.locator('button[aria-label*="opy"], button[title*="opy"], button:has-text("Copy")').first();
    await copyBtn.click({ timeout: 5000 });
    await sleep(2000);

    // Try intercepted text first
    let copied = await page.evaluate(() => window.__copiedText || '');
    // If intercept didn't work, try reading clipboard directly
    if (!copied || copied.length < 30) {
      try {
        copied = await page.evaluate(() => navigator.clipboard.readText());
      } catch { /* clipboard read may fail */ }
    }
    if (copied && copied.length > 30) {
      pineCode = copied;
      console.log(`[EXTRACT] Got code via Copy button: ${copied.length} chars`);
    }
  } catch (err) {
    console.log(`[EXTRACT] Copy button failed: ${err.message}`);
  }

  // Step C: Fallback — extract from <main> element's innerText
  // TV renders Pine code as individual token <span>s inside <main>
  if (!pineCode) {
    try {
      pineCode = await page.evaluate(() => {
        const main = document.querySelector('main');
        if (!main) return '';
        const text = main.innerText || '';
        if (
          text.length > 50 &&
          (text.includes('//@version') || text.includes('indicator(') ||
           text.includes('strategy(') || text.includes('library('))
        ) {
          // Clean: remove line numbers and UI text
          const lines = text.split('\n');
          const clean = [];
          let started = false;
          for (const line of lines) {
            if (/^\d+$/.test(line.trim())) continue;
            if (/^(Pine Script|Source code|Chart|Copy)/.test(line.trim())) continue;
            if (!started && (line.includes('//') || line.includes('//@version') ||
                line.includes('indicator') || line.includes('strategy'))) {
              started = true;
            }
            if (started) clean.push(line);
          }
          return clean.join('\n').trim();
        }
        return '';
      });
      if (pineCode && pineCode.length > 50) {
        console.log(`[EXTRACT] Got code from <main>: ${pineCode.length} chars`);
      } else {
        pineCode = '';
      }
    } catch (err) {
      console.log(`[EXTRACT] <main> extraction failed: ${err.message}`);
    }
  }

  // Step D: Broad scan — any element with Pine patterns
  if (!pineCode) {
    try {
      pineCode = await page.evaluate(() => {
        const els = document.querySelectorAll('div, section, article, main');
        for (const el of els) {
          const t = el.innerText || '';
          if (t.length > 100 && t.length < 100000 &&
              (t.includes('//@version') || t.includes('indicator(') || t.includes('strategy(')) &&
              (t.includes('plot(') || t.includes('input.') || t.includes('ta.'))) {
            return t;
          }
        }
        return '';
      });
      if (pineCode) console.log(`[EXTRACT] Got code via broad scan: ${pineCode.length} chars`);
    } catch (err) {
      console.log(`[EXTRACT] Broad scan failed: ${err.message}`);
    }
  }

  // Check for protected/invite-only indicators
  if (!pineCode) {
    const pageText = await page.evaluate(() => document.body.innerText.substring(0, 3000));
    if (
      pageText.includes('invite-only') ||
      pageText.includes('protected source') ||
      pageText.includes('source code is not available') ||
      pageText.includes('Access to this script is restricted') ||
      pageText.includes('This is an invite-only')
    ) {
      isProtected = true;
      pineCode = 'PROTECTED';
      console.log(`[EXTRACT] Script is PROTECTED`);
    } else {
      isProtected = true;
      pineCode = 'REQUIRES_BROWSER_EXTRACTION';
      console.log(`[EXTRACT] Could not extract — REQUIRES_BROWSER_EXTRACTION`);
    }
  }

  return {
    title,
    author,
    script_url: url,
    category,
    pine_code: pineCode,
    is_protected: isProtected,
    description: description.substring(0, 500),
    screenshot_url: screenshotUrl,
    scraped_at: new Date().toISOString(),
  };
}

/* ─────────────────────────────────────────────────────────────
 *  Google Sheets — Push with dedup (upsert by script_url)
 * ───────────────────────────────────────────────────────────── */
async function pushToSheets(results) {
  if (!SA_B64) return;

  const creds = JSON.parse(Buffer.from(SA_B64, 'base64').toString('utf-8'));
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  // Read existing rows to dedup
  let existingUrls = new Set();
  try {
    const existing = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!C:C`, // column C = script_url
    });
    if (existing.data.values) {
      existingUrls = new Set(existing.data.values.flat());
    }
  } catch {
    // Sheet might be empty or column doesn't exist yet
  }

  // Ensure headers exist
  const headers = [
    'title', 'author', 'script_url', 'category', 'pine_code',
    'is_protected', 'description', 'screenshot_url', 'scraped_at',
  ];
  try {
    const headerCheck = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A1:I1`,
    });
    if (!headerCheck.data.values || headerCheck.data.values[0]?.[0] !== 'title') {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${SHEET_NAME}!A1:I1`,
        valueInputOption: 'RAW',
        requestBody: { values: [headers] },
      });
    }
  } catch {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A1:I1`,
      valueInputOption: 'RAW',
      requestBody: { values: [headers] },
    });
  }

  // Filter new results (dedup)
  const newResults = results.filter(r => !existingUrls.has(r.script_url));
  if (newResults.length === 0) {
    console.log('[SHEETS] No new scripts to add');
    return;
  }

  // Append new rows (truncate pine_code to 49000 chars — Sheets limit is 50000)
  const MAX_CELL = 49000;
  const rows = newResults.map(r => [
    r.title,
    r.author,
    r.script_url,
    r.category,
    r.pine_code && r.pine_code.length > MAX_CELL
      ? r.pine_code.substring(0, MAX_CELL) + '\n// ... TRUNCATED (full code: ' + r.pine_code.length + ' chars)'
      : r.pine_code,
    String(r.is_protected),
    r.description,
    r.screenshot_url,
    r.scraped_at,
  ]);

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:I`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows },
  });

  console.log(`[SHEETS] Appended ${newResults.length} new rows (${results.length - newResults.length} duplicates skipped)`);
}

/* ─────────────────────────────────────────────────────────────
 *  Webhook — POST results to n8n (Audit C-7: HMAC signed)
 * ───────────────────────────────────────────────────────────── */
function sendWebhook(results) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(results);
    const parsed = new URL(WEBHOOK_URL);
    const transport = parsed.protocol === 'https:' ? https : http;

    // Audit C-7: Sign payload with HMAC-SHA256
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    };
    try {
      headers['X-Webhook-Signature'] = signPayload(payload);
    } catch (err) {
      console.warn('[WEBHOOK] Signing skipped:', err.message);
    }

    const req = transport.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers,
        timeout: 30000,
      },
      (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => {
          console.log(`[WEBHOOK] Response ${res.statusCode}: ${body.substring(0, 200)}`);
          resolve();
        });
      }
    );
    req.on('error', (err) => {
      console.error(`[WEBHOOK] Error: ${err.message}`);
      resolve(); // Don't fail the whole scrape over a webhook error
    });
    req.on('timeout', () => {
      req.destroy();
      console.error('[WEBHOOK] Timeout');
      resolve();
    });
    req.write(payload);
    req.end();
  });
}

/* ─────────────────────────────────────────────────────────────
 *  Utilities
 * ───────────────────────────────────────────────────────────── */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * sanitizeLLMJson
 * Fixes two common Grok output bugs before JSON.parse:
 *  1. Markdown fences  (```json ... ```)
 *  2. Python-style tuple arrays  ("key": ("a", "b"))  →  ["a", "b"]
 */
function sanitizeLLMJson(text) {
  // 1. Strip markdown fences
  let s = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  // 2. Replace Python tuples used as JSON arrays
  //    Pattern: colon then (  ...items...  ) where items are strings or numbers
  s = s.replace(/(:\s*)\(([^()]*)\)/g, (match, colon, inner) => {
    // Only convert if inner looks like a list (has a comma or starts with quote/digit)
    if (/[,"'\d]/.test(inner.trim())) {
      return colon + '[' + inner + ']';
    }
    return match; // leave non-list parens alone
  });
  return s;
}

/* ── Yahoo Finance ──────────────────────────────────────────────── */

/** Fetch OHLCV arrays from Yahoo Finance chart API */
function fetchYahooChart(ticker, range, interval) {
  return new Promise((resolve, reject) => {
    const path = `/v8/finance/chart/${encodeURIComponent(ticker)}` +
      `?range=${range}&interval=${interval}&includePrePost=false`;
    const opts = {
      hostname: 'query1.finance.yahoo.com',
      path,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; QuantumScraper/2.7)',
        'Accept': 'application/json'
      },
      timeout: 15000
    };
    const req = https.request(opts, (r) => {
      let body = '';
      r.on('data', d => body += d);
      r.on('end', () => {
        try {
          const json = JSON.parse(body);
          const result = json.chart?.result?.[0];
          if (!result) return resolve(null);
          const quote = result.indicators?.quote?.[0];
          if (!quote) return resolve(null);
          // Filter null candles
          const out = { closes: [], highs: [], lows: [], opens: [], volumes: [] };
          const ts = result.timestamp || [];
          for (let i = 0; i < ts.length; i++) {
            if (quote.close[i] != null && quote.high[i] != null && quote.low[i] != null) {
              out.closes.push(quote.close[i]);
              out.highs.push(quote.high[i]);
              out.lows.push(quote.low[i]);
              out.opens.push(quote.open[i] ?? quote.close[i]);
              out.volumes.push(quote.volume[i] ?? 0);
            }
          }
          resolve(out);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Yahoo Finance timeout')); });
    req.end();
  });
}

/* ── Technical Indicator Calculators ────────────────────────────── */

/** RSI(14) — Wilder's smoothing */
function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  const delta = closes.slice(1).map((v, i) => v - closes[i]);
  let avgG = 0, avgL = 0;
  for (let i = 0; i < period; i++) {
    if (delta[i] > 0) avgG += delta[i]; else avgL -= delta[i];
  }
  avgG /= period; avgL /= period;
  for (let i = period; i < delta.length; i++) {
    avgG = (avgG * (period - 1) + Math.max(delta[i], 0)) / period;
    avgL = (avgL * (period - 1) + Math.max(-delta[i], 0)) / period;
  }
  if (avgL === 0) return 100;
  return parseFloat((100 - 100 / (1 + avgG / avgL)).toFixed(2));
}

/** EMA helper — returns final EMA value */
function calcEMA(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) ema = values[i] * k + ema * (1 - k);
  return parseFloat(ema.toFixed(4));
}

/** EMA helper — returns full array (for MACD) */
function emaArray(values, period) {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const arr = [];
  let cur = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  arr.push(cur);
  for (let i = period; i < values.length; i++) {
    cur = values[i] * k + cur * (1 - k);
    arr.push(cur);
  }
  return arr;
}

/** SMA */
function calcSMA(values, period) {
  if (values.length < period) return null;
  const s = values.slice(-period).reduce((a, b) => a + b, 0);
  return parseFloat((s / period).toFixed(4));
}

/** MACD(12,26,9) */
function calcMACD(closes, fast = 12, slow = 26, signal = 9) {
  const fastArr = emaArray(closes, fast);
  const slowArr = emaArray(closes, slow);
  if (!fastArr.length || !slowArr.length) return null;
  const offset = fastArr.length - slowArr.length;
  const macdLine = slowArr.map((v, i) => fastArr[i + offset] - v);
  const sigArr = emaArray(macdLine, signal);
  if (!sigArr.length) return null;
  const lastM = macdLine[macdLine.length - 1];
  const lastS = sigArr[sigArr.length - 1];
  return {
    macd:      parseFloat(lastM.toFixed(6)),
    signal:    parseFloat(lastS.toFixed(6)),
    histogram: parseFloat((lastM - lastS).toFixed(6))
  };
}

/** ADX(14) — Wilder's Directional Movement */
function calcADX(highs, lows, closes, period = 14) {
  const n = closes.length;
  if (n < period * 2 + 1) return null;
  const tr = [], pDM = [], mDM = [];
  for (let i = 1; i < n; i++) {
    tr.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    ));
    const up = highs[i] - highs[i - 1];
    const dn = lows[i - 1] - lows[i];
    pDM.push(up > dn && up > 0 ? up : 0);
    mDM.push(dn > up && dn > 0 ? dn : 0);
  }
  // Wilder smooth
  let sTR  = tr.slice(0, period).reduce((a, b) => a + b, 0);
  let sP   = pDM.slice(0, period).reduce((a, b) => a + b, 0);
  let sM   = mDM.slice(0, period).reduce((a, b) => a + b, 0);
  const dx = [];
  for (let i = period; i < tr.length; i++) {
    sTR = sTR - sTR / period + tr[i];
    sP  = sP  - sP  / period + pDM[i];
    sM  = sM  - sM  / period + mDM[i];
    const pDI = sTR > 0 ? 100 * sP / sTR : 0;
    const mDI = sTR > 0 ? 100 * sM / sTR : 0;
    const sum = pDI + mDI;
    dx.push(sum > 0 ? 100 * Math.abs(pDI - mDI) / sum : 0);
  }
  if (dx.length < period) return null;
  let adxVal = dx.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dx.length; i++) adxVal = (adxVal * (period - 1) + dx[i]) / period;
  return parseFloat(adxVal.toFixed(2));
}

/** Intraday VWAP */
function calcVWAP(highs, lows, closes, volumes) {
  let tpv = 0, vol = 0;
  for (let i = 0; i < closes.length; i++) {
    const tp = (highs[i] + lows[i] + closes[i]) / 3;
    tpv += tp * (volumes[i] || 0);
    vol += (volumes[i] || 0);
  }
  return vol > 0 ? parseFloat((tpv / vol).toFixed(4)) : null;
}
