/* ─────────────────────────────────────────────────────────────
 *  quantum-scraper  v2.0  —  TradingView Pine Script Scraper
 *  Single-file Express + Playwright service for Railway
 * ───────────────────────────────────────────────────────────── */

const express = require('express');
const { chromium } = require('playwright');
const { google } = require('googleapis');
const https = require('https');
const http = require('http');

// ── ENV ───────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '8080', 10);
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

// ── EXPRESS  (starts IMMEDIATELY — fixes 502) ─────────────────
const app = express();
app.use(express.json());

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

app.get('/', (_req, res) => res.json({ service: 'quantum-scraper', version: '2.0.0' }));

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
    });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);

    // ── Step 1: Login ───────────────────────────────────────
    if (TV_USER && TV_PASS) {
      console.log('[SCRAPE] Logging in to TradingView …');
      await tvLogin(page);
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
  await sleep(3000);

  // Click "Email" tab in the sign-in modal
  const emailTab = page.locator('button, span, div').filter({ hasText: /^Email$/ }).first();
  try {
    await emailTab.click({ timeout: 8000 });
    await sleep(1000);
  } catch {
    console.log('[LOGIN] No Email tab found — trying direct form');
  }

  // Fill username
  const usernameField = page.locator('input[name="id"], input[name="username"], input[type="email"]').first();
  await usernameField.waitFor({ timeout: 10000 });
  await usernameField.fill(TV_USER);
  await sleep(500);

  // Fill password
  const passwordField = page.locator('input[name="password"], input[type="password"]').first();
  await passwordField.waitFor({ timeout: 5000 });
  await passwordField.fill(TV_PASS);
  await sleep(500);

  // Click sign in button
  const signInBtn = page.locator('button[type="submit"], button').filter({ hasText: /sign in/i }).first();
  await signInBtn.click();
  await sleep(5000);

  // Verify we're logged in by checking for user menu or avatar
  try {
    await page.waitForSelector('[data-name="user-menu-button"], .tv-header__user-menu-button', { timeout: 15000 });
    console.log('[LOGIN] Success');
  } catch {
    console.log('[LOGIN] Could not confirm login — continuing anyway');
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

  // Method 1: Check if there's a "Source code" tab and click it
  try {
    const sourceTab = page.locator('button, span, div, a').filter({ hasText: /source\s*code/i }).first();
    await sourceTab.click({ timeout: 5000 });
    await sleep(2000);
  } catch {
    // No source code tab — might be visible already or protected
  }

  // Method 2: Look for code in the code container (handles CSS hash classes)
  try {
    // TradingView uses dynamically-hashed class names like "code-xxxxx"
    // We look for the container that holds Pine script code
    pineCode = await page.evaluate(() => {
      // Strategy A: Find elements with class containing "code-" that have inner code-like content
      const codeContainers = document.querySelectorAll('[class*="code-"] > div, [class*="code-"]');
      for (const el of codeContainers) {
        const text = el.innerText || '';
        // Pine scripts typically start with these patterns
        if (
          text.length > 50 &&
          (text.includes('//@version') ||
            text.includes('indicator(') ||
            text.includes('strategy(') ||
            text.includes('library(') ||
            text.includes('study(') ||
            text.includes('input.'))
        ) {
          return text;
        }
      }

      // Strategy B: Look for <pre> or <code> tags
      const pres = document.querySelectorAll('pre, code');
      for (const el of pres) {
        const text = el.innerText || '';
        if (text.length > 50 && (text.includes('//@version') || text.includes('indicator('))) {
          return text;
        }
      }

      // Strategy C: Look for any element whose text looks like Pine Script
      const allDivs = document.querySelectorAll('div');
      for (const el of allDivs) {
        const text = el.innerText || '';
        if (
          text.length > 100 &&
          text.length < 50000 &&
          (text.includes('//@version') || text.includes('indicator(') || text.includes('strategy(')) &&
          text.includes('=') &&
          (text.includes('plot(') || text.includes('plotshape(') || text.includes('barcolor(') || text.includes('input.') || text.includes('ta.'))
        ) {
          return text;
        }
      }

      return '';
    });
  } catch (err) {
    console.error(`[EXTRACT] DOM extraction failed: ${err.message}`);
  }

  // Method 3: Try clipboard approach — click copy button
  if (!pineCode) {
    try {
      await page.evaluate(() => {
        // Override clipboard to capture copy
        window.__copiedText = '';
        const origWriteText = navigator.clipboard.writeText;
        navigator.clipboard.writeText = async (text) => {
          window.__copiedText = text;
          return origWriteText.call(navigator.clipboard, text);
        };
      });

      const copyBtn = page.locator('button, span').filter({ hasText: /copy\s*(source|script|code)?/i }).first();
      await copyBtn.click({ timeout: 4000 });
      await sleep(1500);

      const copied = await page.evaluate(() => window.__copiedText || '');
      if (copied && copied.length > 50) {
        pineCode = copied;
        console.log(`[EXTRACT] Got code via clipboard: ${copied.length} chars`);
      }
    } catch {
      // Copy approach didn't work
    }
  }

  // Check for protected indicators
  if (!pineCode) {
    const pageText = await page.evaluate(() => document.body.innerText);
    if (
      pageText.includes('invite-only') ||
      pageText.includes('protected source') ||
      pageText.includes('This script\'s source code is not available') ||
      pageText.includes('Access to this script is restricted')
    ) {
      isProtected = true;
      pineCode = 'PROTECTED';
    } else {
      isProtected = true;
      pineCode = 'REQUIRES_BROWSER_EXTRACTION';
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

  // Append new rows
  const rows = newResults.map(r => [
    r.title,
    r.author,
    r.script_url,
    r.category,
    r.pine_code,
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
 *  Webhook — POST results to n8n
 * ───────────────────────────────────────────────────────────── */
function sendWebhook(results) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(results);
    const parsed = new URL(WEBHOOK_URL);
    const transport = parsed.protocol === 'https:' ? https : http;

    const req = transport.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
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
 *  Utility
 * ───────────────────────────────────────────────────────────── */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
