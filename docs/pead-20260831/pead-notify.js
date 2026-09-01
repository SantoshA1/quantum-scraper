// QTP PEAD Backfill (A'2) — completion-only notifier (no daily spam; PO ruling on noise).
const items = $input.all().map((i) => i.json);
const sum = items.find((j) => j.summary);
const t = (typeof $vars !== 'undefined' && $vars.TELEGRAM_BOT_TOKEN) || '';
let sent = false;
if (sum && sum.remaining_after === 0 && sum.batch_n > 0 && t) {
  try {
    await this.helpers.httpRequest({ method: 'POST', url: 'https://api.telegram.org/bot' + t + '/sendMessage',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: 6648680513, parse_mode: 'HTML', disable_web_page_preview: true,
        text: '✅ <b>PEAD backfill complete</b> — earnings-surprise history loaded for the full universe. The A′ PEAD study can be pre-registered and run.' }),
      timeout: 8000 });
    sent = true;
  } catch (e) { console.log('[PEAD] telegram failed: ' + (e.message || e)); }
}
return [{ json: { sent, summary: sum || null } }];
