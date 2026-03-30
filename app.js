import { chromium } from 'playwright';
import { GoogleSpreadsheet } from 'google-spreadsheet';
import cron from 'node-cron';
import fs from 'fs';

const TV_USERNAME = process.env.TRADINGVIEW_USERNAME;
const TV_PASSWORD = process.env.TRADINGVIEW_PASSWORD;
const SHEET_ID = "16QmkJdHUptjAxLkVpJ5bghVSKRup3KtjKyaHQtz6BoQ";
const N8N_WEBHOOK = "https://tradenextgen.app.n8n.cloud/webhook/script-scraper-complete";

async function scrapeTradingView() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  console.log("Logging into TradingView...");
  await page.goto("https://www.tradingview.com/accounts/signin/");
  await page.fill('input[name="username"]', TV_USERNAME);
  await page.fill('input[name="password"]', TV_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(8000);

  console.log("Navigating to scripts...");
  await page.goto("https://www.tradingview.com/scripts/");

  const scripts = [];

  // Scrape Editors' Picks + Most Popular
  const scriptLinks = await page.$$eval('a[href^="/script/"]', links => 
    links.map(link => ({
      title: link.textContent.trim(),
      url: "https://www.tradingview.com" + link.getAttribute('href')
    }))
  );

  for (const script of scriptLinks.slice(0, 30)) {
    try {
      await page.goto(script.url);
      await page.waitForTimeout(3000);

      // Try to extract code
      let pineCode = "PROTECTED";
      try {
        await page.click('button:has-text("Copy Script")', { timeout: 5000 });
        await page.waitForTimeout(2000);
        pineCode = await page.evaluate(() => {
          return document.querySelector('textarea')?.value || "PROTECTED";
        });
      } catch {}

      scripts.push({
        title: script.title,
        author: "Unknown",
        description: "Extracted via Playwright",
        pine_code: pineCode,
        screenshot_url: await page.screenshot({ path: `/tmp/${Date.now()}.png` }).then(() => "screenshot-saved"),
        script_url: script.url,
        category: "Most Popular",
        scraped_at: new Date().toISOString()
      });

      console.log(`✓ Scraped: ${script.title}`);
    } catch (e) {
      console.log(`✗ Failed: ${script.title}`);
    }
  }

  await browser.close();
  return scripts;
}

// Push to Google Sheet + n8n
async function saveAndNotify(scripts) {
  // Google Sheet logic would go here (add your service account code if needed)
  console.log(`Saved ${scripts.length} scripts`);

  // Call n8n webhook
  await fetch(N8N_WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scripts })
  });
}

// Run every night at 2:00 AM ET
cron.schedule('0 2 * * *', async () => {
  console.log("Starting nightly scrape...");
  const scripts = await scrapeTradingView();
  await saveAndNotify(scripts);
});

console.log("Quantum Scraper v2 started - waiting for cron...");