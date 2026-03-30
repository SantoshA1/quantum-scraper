import { chromium } from 'playwright';
import express from 'express';
import cron from 'node-cron';

const app = express();
const PORT = process.env.PORT || 8080;

const TV_USERNAME = process.env.TRADINGVIEW_USERNAME;
const TV_PASSWORD = process.env.TRADINGVIEW_PASSWORD;
const N8N_WEBHOOK = "https://tradenextgen.app.n8n.cloud/webhook/script-scraper-complete";

// Health check + manual trigger
app.get('/health', (req, res) => res.json({ status: 'ok', message: 'Quantum Scraper v2 running' }));

app.post('/run', async (req, res) => {
  res.send('Scrape started – check logs');
  console.log("Manual scrape triggered");
  const scripts = await scrapeTradingView();
  await saveAndNotify(scripts);
});

app.listen(PORT, () => console.log(`Quantum Scraper listening on port ${PORT}`));

// ====================== SCRAPER FUNCTIONS ======================
async function scrapeTradingView() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  await page.goto("https://www.tradingview.com/accounts/signin/");
  await page.fill('input[name="username"]', TV_USERNAME);
  await page.fill('input[name="password"]', TV_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(8000);

  await page.goto("https://www.tradingview.com/scripts/");

  const scripts = [];
  const scriptLinks = await page.$$eval('a[href^="/script/"]', links => 
    links.slice(0, 30).map(link => ({
      title: link.textContent.trim(),
      url: "https://www.tradingview.com" + link.getAttribute('href')
    }))
  );

  for (const script of scriptLinks) {
    try {
      await page.goto(script.url, { waitUntil: 'networkidle' });
      await page.waitForTimeout(3000);

      let pineCode = "PROTECTED";
      try {
        await page.click('button:has-text("Copy Script")', { timeout: 5000 });
        await page.waitForTimeout(2000);
        pineCode = await page.evaluate(() => document.querySelector('textarea')?.value || "PROTECTED");
      } catch {}

      scripts.push({
        title: script.title,
        pine_code: pineCode,
        script_url: script.url,
        scraped_at: new Date().toISOString()
      });
    } catch (e) {}
  }

  await browser.close();
  return scripts;
}

async function saveAndNotify(scripts) {
  console.log(`Scraped ${scripts.length} scripts`);
  // Webhook to n8n
  await fetch(N8N_WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scripts })
  });
}

// Nightly cron
cron.schedule('0 2 * * *', async () => {
  const scripts = await scrapeTradingView();
  await saveAndNotify(scripts);
});

console.log("Quantum Scraper v2 started - waiting for cron...");