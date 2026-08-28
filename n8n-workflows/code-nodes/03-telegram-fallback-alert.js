// n8n Code node: Telegram Fallback Alert
// Place after an IF node evaluating: {{$json.databricks_logging_ok === false}}
// Mode: Run Once for All Items
// Language: JavaScript
// Requires NODE_FUNCTION_ALLOW_BUILTIN to include https.

const https = require('https');

const botToken = $env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const chatIds = [
  $env.TELEGRAM_PERSONAL_CHAT_ID || process.env.TELEGRAM_PERSONAL_CHAT_ID,
  $env.TELEGRAM_SUBSCRIBER_CHAT_ID || process.env.TELEGRAM_SUBSCRIBER_CHAT_ID,
].filter(Boolean);

function sendTelegram(chatId, text) {
  const body = JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true });
  const options = {
    hostname: 'api.telegram.org',
    path: `/bot${botToken}/sendMessage`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    timeout: 10000,
  };
  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => resolve({ chatId, statusCode: res.statusCode, body: data }));
    });
    req.on('error', (err) => resolve({ chatId, error: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ chatId, error: 'telegram_timeout' }); });
    req.write(body);
    req.end();
  });
}

const payload = items.map((i) => i.json);
const text = `🚨 Databricks logging final failure\n${JSON.stringify(payload, null, 2).slice(0, 3500)}`;

const results = [];
for (const chatId of chatIds) {
  results.push(await sendTelegram(chatId, text));
}

return [{ json: { telegram_alert_sent: true, results } }];
