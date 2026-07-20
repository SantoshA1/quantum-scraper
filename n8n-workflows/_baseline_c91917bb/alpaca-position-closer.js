// Alpaca Position Closer v3.1 — Fix #12 (TE-C5) pre-cancel open orders to prevent orphaned volatile trails
// Fix #15 helpers.httpRequest, Fix #18 static data keys
// ── TEST SIGNAL GUARD — never execute real trades on test payloads ──────────
// Checks all forms of the test flag: from SM (test_mode), raw body (test), or string 'true'
const _apcIsTest = ($input.first().json.test_mode === true ||
                    $input.first().json.test   === true   ||
                    $input.first().json.test   === 'true');
if (_apcIsTest) {
  console.log('[APC] TEST SIGNAL — skipping all Alpaca operations for: ' + ($input.first().json.ticker || 'UNKNOWN'));
  return [$input.first()];  // pass through unchanged, no Alpaca calls
}


const NL = String.fromCharCode(10);
const prev = $input.first().json;
const ticker = prev.ticker || '';
const execution = (prev.execution || prev._sm_route || '').toUpperCase();
const signal = (prev.signal || '').toUpperCase();

// v3.1 FIX: Market hours guard — do NOT place close orders after hours.
// After-hours orders go to 'accepted' status and fill at next open at potentially
// different prices. This caused the TSLA false close on 2026-04-20.
const _nowET = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
const _etDate = new Date(_nowET);
const _etMins = _etDate.getHours() * 60 + _etDate.getMinutes();
const _isMarketOpen = _etMins >= 570 && _etMins < 960; // 9:30 AM - 4:00 PM ET
const _isWeekday = _etDate.getDay() >= 1 && _etDate.getDay() <= 5;
if (!_isMarketOpen || !_isWeekday) {
  console.log('[APC v3.1] BLOCKED: Market closed (' + _etDate.toLocaleTimeString() + ' ET) — will not place close order for ' + ticker);
  return [{ json: { ...prev, alpaca_close_status: 'MARKET_CLOSED', alpaca_close_reason: 'After hours — close order deferred to next market open via GTC Re-Check' } }];
}

const isExit = execution === 'STAND ASIDE' || signal === 'NEUTRAL';

if (!isExit || !ticker) {
  return [{ json: { ...prev, alpaca_close_status: 'SKIPPED', alpaca_close_reason: 'Not an exit signal' } }];
}

if (ticker === 'SPY' || ticker === 'QQQ') {
  return [{ json: { ...prev, alpaca_close_status: 'SKIPPED', alpaca_close_reason: 'Index ticker — monitor only' } }];
}

const _creds = $getWorkflowStaticData('global');
const ALPACA_KEY = (($getWorkflowStaticData('global')._credentials||{}).alpaca_api_key || '');
const ALPACA_SECRET = (($getWorkflowStaticData('global')._credentials||{}).alpaca_secret_key || '');

// Fix #17 Batch 1 (2026-04-19): fail-closed Alpaca creds
if (!ALPACA_KEY || !ALPACA_SECRET) throw new Error('Alpaca creds missing from staticData._credentials (fail-closed)');
// SM-C2: env-driven Alpaca base URL (default paper, flip via staticData)
const _creds_AB = ($getWorkflowStaticData('global')._credentials) || {};
const ALPACA_BASE = _creds_AB.alpaca_base
  || (_creds_AB.alpaca_env === 'live'
    ? 'https://paper-api.alpaca.markets'
    : 'https://paper-api.alpaca.markets');
const ALPACA_HEADERS = {
  'APCA-API-KEY-ID': ALPACA_KEY,
  'APCA-API-SECRET-KEY': ALPACA_SECRET,
  'Content-Type': 'application/json'
};

// Fix #16: Retry helper
async function withRetry(fn, maxRetries = 2, baseDelay = 1000) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxRetries) throw err;
      const delay = baseDelay * Math.pow(2, attempt);
      console.log('[CLOSER] Retry ' + (attempt + 1) + '/' + maxRetries + ' after ' + delay + 'ms: ' + err.message);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

try {
  // Check position exists
  let position;
  try {
    position = await withRetry(() => this.helpers.httpRequest({
      method: 'GET',
      url: ALPACA_BASE + '/v2/positions/' + ticker,
      headers: ALPACA_HEADERS,
      json: true,
      timeout: 5000
    }));
  } catch (e) {
    return [{ json: { ...prev, alpaca_close_status: 'NO_POSITION', alpaca_close_reason: 'No open position for ' + ticker } }];
  }

  const qty = parseFloat(position.qty) || 0;
  const side = qty >= 0 ? 'LONG' : 'SHORT';
  const unrealizedPL = parseFloat(position.unrealized_pl) || 0;
  const entryPrice = parseFloat(position.avg_entry_price) || 0;
  const currentPrice = parseFloat(position.current_price) || 0;
  const marketValue = parseFloat(position.market_value) || 0;

  // ──────────────────────────────────────────────────────────────────────────
  // Fix #12 (TE-C5): Pre-cancel all open orders for ticker to prevent orphaned
  // volatile trailing_stops (SQQQ/TQQQ/SPXS/SPXL/SOXS/SOXL/UVXY/SVXY/SMCI/IONQ).
  // Mirrors SSM TICKER-KILL pattern at L808-831. Fail-open on listing errors:
  // better to close the position than leave it open because we can't list orders.
  // ──────────────────────────────────────────────────────────────────────────
  let _fix12Cancelled = 0;
  let _fix12Failed = 0;
  try {
    const _openOrders = await withRetry(() => this.helpers.httpRequest({
      method: 'GET',
      url: ALPACA_BASE + '/v2/orders?status=open&symbols=' + ticker + '&limit=50&nested=true',
      headers: ALPACA_HEADERS,
      json: true,
      timeout: 5000
    }));
    const _ordersArr = Array.isArray(_openOrders) ? _openOrders : [];
    if (_ordersArr.length > 0) {
      console.log('[APC Fix #12] Cancelling ' + _ordersArr.length + ' open order(s) for ' + ticker + ' before close');
      for (const _o of _ordersArr) {
        try {
          await this.helpers.httpRequest({
            method: 'DELETE',
            url: ALPACA_BASE + '/v2/orders/' + _o.id,
            headers: ALPACA_HEADERS,
            json: true,
      timeout: 5000
    });
          _fix12Cancelled++;
        } catch (_cancelErr) {
          _fix12Failed++;
          console.log('[APC Fix #12] Cancel failed for order ' + _o.id + ': ' + (_cancelErr.message || _cancelErr));
        }
      }
    } else {
      console.log('[APC Fix #12] No open orders to cancel for ' + ticker);
    }
  } catch (_fetchErr) {
    // Fail-open on listing: proceed with close rather than leaving position open
    console.log('[APC Fix #12] Could not list open orders for ' + ticker + ' — proceeding with close: ' + (_fetchErr.message || _fetchErr));
  }

  // Close position
  const closeResp = await withRetry(() => this.helpers.httpRequest({
    method: 'DELETE',
    url: ALPACA_BASE + '/v2/positions/' + ticker + '?qty=' + Math.abs(qty) + '&time_in_force=gtc',
    headers: ALPACA_HEADERS,
    json: true,
      timeout: 10000
    }));

  // Fix #12: Clean up APT bracket/trail state so stale references don't misfire
  try {
    const _gd = $getWorkflowStaticData('global');
    if (_gd._bracketOrders && _gd._bracketOrders[ticker]) {
      delete _gd._bracketOrders[ticker];
      console.log('[APC Fix #12] Cleared _bracketOrders state for ' + ticker);
    }
    if (_gd._trailState && _gd._trailState[ticker]) {
      delete _gd._trailState[ticker];
      console.log('[APC Fix #12] Cleared _trailState for ' + ticker);
    }
  } catch (_stateErr) {
    console.log('[APC Fix #12] State cleanup error (non-fatal): ' + (_stateErr.message || _stateErr));
  }

  return [{ json: {
    ...prev,
    alpaca_close_status: 'CLOSED',
    alpaca_close_ticker: ticker,
    alpaca_close_side: side,
    alpaca_close_qty: Math.abs(qty),
    alpaca_close_entry_price: entryPrice,
    alpaca_close_exit_price: currentPrice,
    alpaca_close_unrealized_pl: unrealizedPL,
    alpaca_close_market_value: marketValue,
    alpaca_close_reason: 'STAND ASIDE signal — position closed',
    alpaca_close_orders_cancelled: _fix12Cancelled,
    alpaca_close_orders_cancel_failed: _fix12Failed,
  } }];

} catch (err) {
  return [{ json: {
    ...prev,
    alpaca_close_status: 'ERROR',
    alpaca_close_error: err.message || String(err),
  } }];
}
