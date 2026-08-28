#!/usr/bin/env node
/* Tests: databricks/telegram-alert.js — payload shape, truncation, no real network calls */
'use strict';

const assert = require('assert');
const path = require('path');
const { EventEmitter } = require('events');

const {
  truncate,
  buildAlertText,
  buildSendMessagePayload,
  sendTelegram,
  alertFinalFailure,
} = require(path.resolve(__dirname, '..', '..', 'databricks', 'telegram-alert.js'));

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (err) { failed++; console.log(`  ❌ ${name} — ${err.message}`); }
}

// ---------------------------------------------------------------------------
// Fake https client — captures requests and returns canned responses without
// ever touching the network.
// ---------------------------------------------------------------------------
function makeFakeHttps(response = { statusCode: 200, body: '{"ok":true}' }) {
  const calls = [];
  const https = {
    request(options, cb) {
      const req = new EventEmitter();
      req.write = (body) => { calls.push({ options, body }); };
      req.end = () => {
        const res = new EventEmitter();
        res.statusCode = response.statusCode;
        cb(res);
        process.nextTick(() => {
          res.emit('data', response.body);
          res.emit('end');
        });
      };
      req.destroy = () => {};
      return req;
    },
    calls,
  };
  return https;
}

(async () => {
  console.log('\n[databricks/telegram-alert]');

  await t('truncate passes short strings through', () => {
    assert.strictEqual(truncate('short', 100), 'short');
  });

  await t('truncate adds marker past max', () => {
    const out = truncate('x'.repeat(400), 100);
    assert.ok(out.startsWith('x'.repeat(100)));
    assert.ok(out.endsWith('...[truncated]'));
  });

  await t('buildAlertText names retry count, event, account, trade id', () => {
    const text = buildAlertText(new Error('boom'), [{
      event_type: 'trade_log', account_id: 'acct_1', strategy_id: 'meanrev',
      symbol: 'AAPL', trade_id: 'trd_1', order_id: 'ord_1',
    }], 8);
    assert.match(text, /after 8 retries/);
    assert.match(text, /Target event: trade_log/);
    assert.match(text, /Account: acct_1/);
    assert.match(text, /Trade ID: trd_1/);
    assert.match(text, /Error:\n/);
    assert.match(text, /boom/);
  });

  await t('buildAlertText tolerates missing fields with unknown/none placeholders', () => {
    const text = buildAlertText('string-error', [], 8);
    assert.match(text, /Target event: unknown/);
    assert.match(text, /Account: unknown/);
    assert.match(text, /Trade ID: none/);
  });

  await t('buildSendMessagePayload constructs correct Telegram POST', () => {
    const { url, options, body } = buildSendMessagePayload({
      chatId: 'chat123', text: 'hello', botToken: 'BOT:XYZ',
    });
    assert.strictEqual(url, 'https://api.telegram.org/botBOT:XYZ/sendMessage');
    assert.strictEqual(options.method, 'POST');
    assert.strictEqual(options.hostname, 'api.telegram.org');
    assert.strictEqual(options.path, '/botBOT:XYZ/sendMessage');
    assert.strictEqual(options.headers['Content-Type'], 'application/json');
    const parsed = JSON.parse(body);
    assert.strictEqual(parsed.chat_id, 'chat123');
    assert.strictEqual(parsed.text, 'hello');
    assert.strictEqual(parsed.parse_mode, 'HTML');
    assert.strictEqual(parsed.disable_web_page_preview, true);
  });

  await t('buildSendMessagePayload requires botToken and chatId', () => {
    assert.throws(() => buildSendMessagePayload({ chatId: 'c', text: 't', botToken: '' }), /botToken/);
    assert.throws(() => buildSendMessagePayload({ chatId: '', text: 't', botToken: 'b' }), /chatId/);
  });

  await t('sendTelegram skips cleanly when botToken or chatId missing', async () => {
    const a = await sendTelegram('', 'hi', { botToken: 'b' });
    const b = await sendTelegram('chat', 'hi', { botToken: '' });
    assert.deepStrictEqual(a, { skipped: true });
    assert.deepStrictEqual(b, { skipped: true });
  });

  await t('sendTelegram uses injected https and does not hit network', async () => {
    const https = makeFakeHttps({ statusCode: 200, body: '{"ok":true}' });
    const res = await sendTelegram('chat-id', 'hello', { botToken: 'BOT:XYZ', https });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(https.calls.length, 1);
    const payload = JSON.parse(https.calls[0].body);
    assert.strictEqual(payload.chat_id, 'chat-id');
    assert.strictEqual(payload.text, 'hello');
  });

  await t('alertFinalFailure sends to both personal and subscriber chats', async () => {
    const https = makeFakeHttps({ statusCode: 200, body: '{"ok":true}' });
    const cfg = {
      telegramBotToken: 'BOT:ABC',
      telegramPersonalChatId: 'personal_1',
      telegramSubscriberChatId: 'subs_1',
    };
    const out = await alertFinalFailure({
      error: new Error('boom'),
      payloads: [{ trade_id: 'trd_1', account_id: 'acct_1' }],
      retryCount: 8,
      cfg, https,
    });
    assert.strictEqual(out.results.length, 2);
    assert.strictEqual(https.calls.length, 2);
    const chatIds = https.calls.map((c) => JSON.parse(c.body).chat_id).sort();
    assert.deepStrictEqual(chatIds, ['personal_1', 'subs_1']);
    assert.match(out.text, /after 8 retries/);
  });

  await t('alertFinalFailure skips channels when chat id is missing', async () => {
    const https = makeFakeHttps();
    const cfg = { telegramBotToken: 'BOT:ABC', telegramPersonalChatId: 'personal_only', telegramSubscriberChatId: '' };
    const out = await alertFinalFailure({
      error: 'err', payloads: [{}], retryCount: 1, cfg, https,
    });
    assert.strictEqual(out.results[0].statusCode, 200);
    assert.deepStrictEqual(out.results[1], { skipped: true });
  });

  console.log(`\n  ${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
})();
