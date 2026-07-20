// PF_MARGIN Telegram Notifier v1.0 - Option 2 PF_MARGIN paper bypass
// Tightening 1: any signal marked is_test_injection=true MUST send a [TEST] prefixed alert.
// Always fires (skip / dry_run / test_cancel / panic), so audit trail is complete.

const _tgToken = (typeof $vars !== 'undefined' && $vars.TELEGRAM_BOT_TOKEN) ? $vars.TELEGRAM_BOT_TOKEN : ''; // QTP_TG_TOKEN_VAR_v2_20260713 — literal fallback removed (rotation hygiene); in-code sends fail-soft if var empty
const j = $input.first()?.json || {};
const insertRow = (function(){
  try { return $input.first()?.json || {}; } catch(_) { return {}; }
})();

// Read upstream gate decision (Bypass Gate output context)
let gateCtx = j;
try { gateCtx = $('PF_MARGIN Bypass Gate').first()?.json || j; } catch(_) {}
let execCtx = j;
try { execCtx = $('PF_MARGIN Executor').first()?.json || j; } catch(_) {}

const isTest = (gateCtx._pfm_is_test_injection === true) || (execCtx._pfm_is_test_injection === true);
const symbol = gateCtx._pfm_symbol || '';
const side = gateCtx._pfm_side || '';
const routeMode = gateCtx._pfm_route_mode || 'skip';
const flagValue = gateCtx._pfm_flag_value || '';
const skipCond = gateCtx._pfm_skip_at_condition;
const gateReason = gateCtx._pfm_reason || '';
const execStatus = execCtx._pfm_executor_status || 'noop';
const execReason = execCtx._pfm_executor_reason || '';
const res = execCtx._pfm_executor_result || {};
const tradeId = insertRow.trade_id || j.trade_id || null;
const newDailyCount = insertRow.new_daily_trade_count || j.new_daily_trade_count || null;
const insertStatus = insertRow.insert_status || j.insert_status || 'unknown';

// Notification policy: only fire Telegram when meaningful. Otherwise return passthrough (silent).
// Fire on: (a) test injections (is_test_injection=true) — visibility for QA, (b) any routed=true outcome, (c) panic_refuse.
// Do NOT fire on production-mode skip outcomes — they would spam every signal that fails any of the 13 conditions.
const shouldNotify =
  isTest === true ||
  execStatus === 'panic_refuse' ||
  (gateCtx._pfm_routed === true && routeMode !== 'skip');

if (!shouldNotify) {
  return [{ json: { ...j, _pfm_telegram_status: 'suppressed', _pfm_telegram_reason: 'production_skip_silent' } }];
}

// Build subject tag chain
let tag = '[EXP-PFM]';
if (routeMode === 'dry_run') tag += '[DRY_RUN]';
else if (routeMode === 'test_cancel') tag += '[TEST_CANCEL]';
else if (routeMode === 'panic_live_not_wired') tag += '[PANIC]';
else if (routeMode === 'skip') tag += '[SKIP]';

if (isTest) tag += '[TEST]';  // Tightening 1: explicit test marker

let title = '';
let body = '';

if (routeMode === 'skip') {
  title = `${tag} Signal skipped`;
  body = `<b>${symbol || '(no symbol)'} ${side || ''}</b>\n` +
         `Reason: <code>${gateReason}</code> (condition C${skipCond ?? '?'})\n` +
         `flag_value=<code>${flagValue}</code>`;
} else if (execStatus === 'panic_refuse') {
  title = `${tag} PANIC — LIVE branch unwired, refused`;
  body = `<b>${symbol || '?'} ${side || '?'}</b>\nflag_value=<code>${flagValue}</code>\n` +
         `Executor refused. Investigate immediately.`;
} else if (routeMode === 'dry_run') {
  title = `${tag} Dry-run audit row`;
  body = `<b>${symbol} ${side}</b> @ notional=$50.00\n` +
         `trade_id=<code>${tradeId || 'N/A'}</code>\n` +
         `daily_count=${newDailyCount ?? '?'}, insert=<code>${insertStatus}</code>\n` +
         `exit_reason=<code>${res.exit_reason || 'DRY_RUN_NO_ALPACA'}</code>`;
} else if (routeMode === 'test_cancel') {
  const bpDelta = (res.buying_power_delta != null) ? `$${Number(res.buying_power_delta).toFixed(4)}` : 'N/A';
  title = `${tag} Submit-then-cancel test`;
  body = `<b>${symbol} ${side}</b>\n` +
         `order_id=<code>${res.alpaca_order_id || 'N/A'}</code>\n` +
         `alpaca_status=<code>${res.alpaca_status || '?'}</code>\n` +
         `cancel_status=<code>${res.cancel_status || '?'}</code>\n` +
         `buying_power_delta=<code>${bpDelta}</code> (threshold $0.50)\n` +
         `trade_id=<code>${tradeId || 'N/A'}</code>, insert=<code>${insertStatus}</code>` +
         (execStatus === 'warn' ? `\n⚠️ <b>WARN:</b> ${execReason}` : '');
} else {
  title = `${tag} Unknown route_mode=${routeMode}`;
  body = `exec_status=${execStatus}, reason=${execReason}`;
}

const text = `${title}\n${body}`;

// Telegram credentials (mirror cron task pattern; reuse bot + chat_id)
const TG_BOT = _tgToken;
const TG_CHAT = '6648680513';

try {
  const resp = await $helpers.httpRequest({
    method: 'POST',
    url: `https://api.telegram.org/bot${TG_BOT}/sendMessage`,
    body: { chat_id: TG_CHAT, parse_mode: 'HTML', disable_web_page_preview: true, text: text },
    json: true,
    timeout: 6000
  });
  return [{ json: { ...j, _pfm_telegram_status: 'ok', _pfm_telegram_message_id: resp?.result?.message_id || null, _pfm_telegram_text: text } }];
} catch (e) {
  return [{ json: { ...j, _pfm_telegram_status: 'fail', _pfm_telegram_error: (e.message||String(e)).slice(0,400), _pfm_telegram_text: text } }];
}
