'use strict';

function truncate(str, max = 3500) {
  if (!str) return '';
  const s = String(str);
  return s.length > max ? s.slice(0, max) + '\n...[truncated]' : s;
}

function buildAlertText(error, payloads, retryCount) {
  const first = (payloads && payloads[0]) || {};
  const errDescription = error && error.stack
    ? error.stack
    : (error && error.message ? error.message : String(error || 'unknown_error'));
  return truncate(
    `🚨 Databricks logging failed after ${retryCount} retries\n` +
    `Workflow: Quantum Trading Pipeline\n` +
    `Target event: ${first.event_type || 'unknown'}\n` +
    `Account: ${first.account_id || 'unknown'}\n` +
    `Strategy: ${first.strategy_id || 'unknown'}\n` +
    `Symbol: ${first.symbol || 'unknown'}\n` +
    `Trade ID: ${first.trade_id || 'none'}\n` +
    `Order ID: ${first.order_id || 'none'}\n` +
    `Error:\n${errDescription}\n` +
    `Payload:\n${JSON.stringify(payloads, null, 2)}`
  );
}

function buildSendMessagePayload({ chatId, text, botToken }) {
  if (!botToken) throw new Error('buildSendMessagePayload: botToken required');
  if (!chatId) throw new Error('buildSendMessagePayload: chatId required');
  const body = JSON.stringify({
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
  return {
    url: `https://api.telegram.org/bot${botToken}/sendMessage`,
    options: {
      hostname: 'api.telegram.org',
      path: `/bot${botToken}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 10000,
    },
    body,
  };
}

function sendTelegram(chatId, text, opts = {}) {
  const botToken = opts.botToken;
  if (!botToken || !chatId) return Promise.resolve({ skipped: true });
  const https = opts.https || require('https');
  const { options, body } = buildSendMessagePayload({ chatId, text, botToken });

  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => resolve({ chatId, statusCode: res.statusCode, body: data }));
    });
    req.on('error', (err) => resolve({ chatId, error: err.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ chatId, error: 'telegram_timeout' });
    });
    req.write(body);
    req.end();
  });
}

async function alertFinalFailure({ error, payloads, retryCount, cfg, https }) {
  const text = buildAlertText(error, payloads, retryCount);
  const results = [];
  results.push(await sendTelegram(cfg.telegramPersonalChatId, text, { botToken: cfg.telegramBotToken, https }));
  results.push(await sendTelegram(cfg.telegramSubscriberChatId, text, { botToken: cfg.telegramBotToken, https }));
  return { text, results };
}

module.exports = {
  truncate,
  buildAlertText,
  buildSendMessagePayload,
  sendTelegram,
  alertFinalFailure,
};
