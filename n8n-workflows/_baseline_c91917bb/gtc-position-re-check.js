// GTC Position Re-Check v5.16 (TE-C2 fail-closed fix — 2026-04-17)
// Reads state._pendingGTCCloses, checks Alpaca for each pending ticker.
// If position is flat (404) → set re-entry cooldown and remove from pending.
// If still open → increment retryCount. On MAX_RETRIES: fail-closed —
//   set cooldown defensively, delete pending entry, alert operator.

const _tgToken = (typeof $vars !== 'undefined' && $vars.TELEGRAM_BOT_TOKEN) ? $vars.TELEGRAM_BOT_TOKEN : ''; // QTP_TG_TOKEN_VAR_v2_20260713 — literal fallback removed (rotation hygiene); in-code sends fail-soft if var empty
const state = $getWorkflowStaticData('global');

if (!state._pendingGTCCloses) state._pendingGTCCloses = {};
const pending = state._pendingGTCCloses;
const tickerList = Object.keys(pending);

if (tickerList.length === 0) {
  console.log('[GTC-CHECK v5.16] No pending GTC closes.');
  return [];
}

const ALPACA_KEY    = (($getWorkflowStaticData('global')._credentials||{}).alpaca_api_key || '');
const ALPACA_SECRET = (($getWorkflowStaticData('global')._credentials||{}).alpaca_secret_key || '');

// Fix #17 Batch 1 (2026-04-19): fail-closed Alpaca creds
if (!ALPACA_KEY || !ALPACA_SECRET) throw new Error('Alpaca creds missing from staticData._credentials (fail-closed)');
// SM-C2: env-driven Alpaca base URL (default paper, flip via staticData)
const _creds_AB = ($getWorkflowStaticData('global')._credentials) || {};
const ALPACA_BASE = _creds_AB.alpaca_base
  || (_creds_AB.alpaca_env === 'live'
    ? 'https://paper-api.alpaca.markets'
    : 'https://paper-api.alpaca.markets');
const MAX_RETRIES   = parseInt((state._config && state._config.gtcMaxRetries) || 2);
const COOLDOWN_HRS  = parseFloat((state._config && state._config.reEntryCooldownHours) || 24);

const nowMs      = Date.now();
const confirmed  = [];
const stillOpen  = [];
const maxedOut   = [];

console.log('[GTC-CHECK v5.16] Checking ' + tickerList.length + ' pending close(s): ' + tickerList.join(', '));

for (const ticker of tickerList) {
  const entry = pending[ticker];

  try {
    let isFlat = false;

    try {
      await this.helpers.httpRequest({
        method: 'GET',
        url: ALPACA_BASE + '/v2/positions/' + ticker,
        headers: {
          'APCA-API-KEY-ID': ALPACA_KEY,
          'APCA-API-SECRET-KEY': ALPACA_SECRET
        },
        json: true
      });
      // 200 = position still open
      isFlat = false;
      console.log('[GTC-CHECK v5.16] ' + ticker + ': still OPEN');
    } catch (posErr) {
      const msg = posErr.message || '';
      if (msg.includes('404') || msg.includes('not found') || msg.includes('does not exist')) {
        isFlat = true;
        console.log('[GTC-CHECK v5.16] ' + ticker + ': FLAT — position confirmed closed');
      } else {
        throw posErr;
      }
    }

    if (isFlat) {
      // Set re-entry cooldown — deferred from kill time to now
      if (!state._reEntryCooldown) state._reEntryCooldown = {};
      state._reEntryCooldown[ticker] = nowMs;
      delete state._pendingGTCCloses[ticker];
      confirmed.push(ticker);

      // Post-close confirmation alert
      const _etTime = new Date(nowMs).toLocaleTimeString('en-US', {
        timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true
      });
      try {
        await this.helpers.httpRequest({
          method: 'POST',
          url: 'https://api.telegram.org/bot' + _tgToken + '/sendMessage',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: 6648680513,
            text: 'GTC confirmed closed: ' + ticker + ' at ' + _etTime + '. Re-entry cooldown now active (' + COOLDOWN_HRS + 'h).'
          }),
          json: true
        });
      } catch (_tgErr) { /* silent */ }
      console.log('[GTC-CHECK v5.16] ' + ticker + ': cooldown set (' + COOLDOWN_HRS + 'h re-entry block)');
    } else {
      entry.retryCount = (entry.retryCount || 0) + 1;

      if (entry.retryCount >= MAX_RETRIES) {
        // TE-C2 v5.16: fail-closed — stop polling, set cooldown defensively,
        // delete pending entry so it cannot leak in state forever.
        if (!state._reEntryCooldown) state._reEntryCooldown = {};
        state._reEntryCooldown[ticker] = nowMs;
        delete state._pendingGTCCloses[ticker];
        maxedOut.push(ticker);
        console.log('[GTC-CHECK v5.16] ' + ticker + ' maxed out after ' + MAX_RETRIES + ' polls — cooldown set defensively (' + COOLDOWN_HRS + 'h), pending cleared; manual Alpaca check advised');
      } else {
        state._pendingGTCCloses[ticker] = entry;
        stillOpen.push(ticker);
      }
    }

  } catch (err) {
    console.log('[GTC-CHECK v5.16] Error on ' + ticker + ': ' + err.message);
    stillOpen.push(ticker);
  }
}

// Send Telegram summary only if there is something actionable
if (confirmed.length > 0 || maxedOut.length > 0) {
  const lines = ['✅ GTC Re-Check v5.16'];
  if (confirmed.length > 0)
    lines.push('Closed + cooldown set: ' + confirmed.join(', '));
  if (maxedOut.length > 0)
    lines.push('⚠️ FAIL-CLOSED after ' + MAX_RETRIES + ' polls: ' + maxedOut.join(', ') +
      '. Cooldown applied defensively (' + COOLDOWN_HRS + 'h). Verify on Alpaca — close order may have failed.');
  if (stillOpen.length > 0)
    lines.push('Still pending (retry): ' + stillOpen.join(', '));

  try {
    await this.helpers.httpRequest({
      method: 'POST',
      url: 'https://api.telegram.org/bot' + _tgToken + '/sendMessage',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: 6648680513, text: lines.join('\n') }),
      json: true
    });
  } catch (_tgErr) { /* silent */ }
}

return [{ json: { confirmed, stillOpen, maxedOut, totalPending: Object.keys(state._pendingGTCCloses).length } }];