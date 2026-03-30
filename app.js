/* ─────────────────────────────────────────────────────────────
 *  quantum-scraper  v2.0  —  TradingView Pine Script Scraper
 *  Single-file Express + Playwright service for Railway
 * ───────────────────────────────────────────────────────────── */

const express = require('express');
const { chromium } = require('playwright-core');
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
let lastResults = [];

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

app.get('/', (_req, res) => res.json({ service: 'quantum-scraper', version: '2.6.0' }));

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
