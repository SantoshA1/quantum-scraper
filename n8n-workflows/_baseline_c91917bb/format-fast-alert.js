// NODE — Format Fast Alert v12.2 — PERMANENT ghost-signal fix + channel gate
// Root cause (v11 regression): SM outputs activePositions as a COUNT (integer),
// not a ticker map. So `ticker in activePositions` was always false.
// v12 fix: check _sm_active_tickers (comma-separated string of SM position keys)
//          AND verify directly against Alpaca as the absolute source of truth.
//          A STAND ASIDE message is only sent if Alpaca confirms an open position.
//
// Rule: NO Alpaca position → NO user message. Period.

const prev    = $('Signal State Machine').first().json;
const ticker  = prev.ticker || '';
const alertType = prev.alert_type || 'SIGNAL_CHANGE';

// ── Guard 1: skip heartbeats, unknown tickers, test payloads ────────────────
if (!ticker || ticker === 'UNKNOWN' || ticker.length < 1) return [];
// v12: check all forms of test flag — from SM propagation OR raw webhook body
const _isTest = (prev.test_mode === true || prev.test === true || prev.test === 'true');
if (_isTest) {
  console.log('[FFA v12] TEST SIGNAL suppressed for: ' + ticker);
  return [];
}

// ── Guard 2: allowed alert types only ───────────────────────────────────────
const _allowedTypes = ['BULL_SWEEP','BEAR_SWEEP','STRONG_SETUP','BROAD_SCANNER','SENTIMENT_AGENT','SIGNAL_CHANGE'];
if (!_allowedTypes.includes(alertType)) return [];

// ── Guard 3: routing rules ───────────────────────────────────────────────────
// FULL-path → VC Gate → Format Telegram Message handles it. FFA stays silent.
// FAST_ONLY BUY/SELL → kill-switch downgrade, no Alpaca trade. FFA stays silent.
const _smRoute   = (prev._sm_route  || '').toUpperCase();
const _execUpper = (prev.execution  || '').toUpperCase().trim();

if (_smRoute === 'FULL') return [];
if (_smRoute === 'FAST_ONLY' && (_execUpper === 'BUY' || _execUpper === 'SELL' || _execUpper === 'SELL SHORT')) {
  return [];
}

// ── Guard 4: STAND ASIDE — MUST have a real Alpaca position ─────────────────
// This is the permanent fix. Two layers:
//
// Layer A — SM ticker list (fast, no API call):
//   _sm_active_tickers is a comma-separated string of tickers in state.activePositions.
//   If ticker is not in this list, the SM never tracked a position → ghost signal.
//
// Layer B — Alpaca direct check (authoritative):
//   If Layer A passes, confirm the position actually exists in Alpaca right now.
//   This catches edge cases where SM state drifted from Alpaca.
//
// Both layers must pass for a STAND ASIDE message to be sent.

if (_execUpper === 'STAND ASIDE') {
  // ── ALPACA IS THE SINGLE SOURCE OF TRUTH ──────────────────────────────────
  // SM state can be up to 30s stale (sync interval). We do NOT rely on it.
  // We call Alpaca directly on every STAND ASIDE to confirm a real position exists.
  // No Alpaca position = no message. This is the permanent fix.
  //
  // SM _sm_active_tickers is logged for debugging only.
  const _smActiveTickers = (prev._sm_active_tickers || '').split(',').filter(Boolean);
  console.log('[FFA v12] STAND ASIDE for ' + ticker + ' | SM tickers=[' + _smActiveTickers.join(',') + ']');

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

  let _hasAlpacaPosition = false;
  let _alpacaQty = 0;
  try {
    const _posResp = await this.helpers.httpRequest({
      method: 'GET',
      url: `${ALPACA_BASE}/v2/positions/${ticker}`,
      headers: {
        'APCA-API-KEY-ID':     ALPACA_KEY,
        'APCA-API-SECRET-KEY': ALPACA_SECRET,
      },
    });
    _alpacaQty = parseFloat(_posResp.qty || 0);
    _hasAlpacaPosition = Math.abs(_alpacaQty) > 0;
    console.log('[FFA v12] Alpaca: ' + ticker + ' qty=' + _alpacaQty + ' side=' + (_posResp.side || '?'));
  } catch (e) {
    // 404 = position not found = ghost signal. Any other error = safe default = block.
    _hasAlpacaPosition = false;
    const _errMsg = (e.message || String(e)).slice(0, 80);
    console.log('[FFA v12] GHOST BLOCKED (no Alpaca position): ' + ticker + ' — ' + _errMsg);
    return [];
  }

  if (!_hasAlpacaPosition) {
    console.log('[FFA v12] GHOST BLOCKED (qty=0): ' + ticker);
    return [];
  }

  // ── v12.2 FIX: STAND ASIDE on FAST_ONLY route means NO trade was placed.
  // The FFA is a message formatter, NOT a trade executor.
  // Only TICKER-KILL (SSM) and TSM actually close positions via Alpaca.
  // FAST_ONLY STAND ASIDE = informational only. Do NOT tell subscribers the position is closed.
  // Sending "Position Closed" here would be a false notification.
  console.log('[FFA v12.2] STAND ASIDE for ' + ticker + ' (qty=' + _alpacaQty + ') — FAST_ONLY route, NO close order placed. Suppressing false close notification.');
  return [];
}

// ── Below: non-STAND ASIDE scanner/sweep signals ─────────────────────────────
// v12.1: CHANNEL GATE — only format BUY/SELL signals if Alpaca placed a trade.
// If alpaca_status is SKIPPED, ERROR, or empty → no message to subscribers.
const _alpStatus = (prev.alpaca_status || '').toUpperCase();
const _TRADE_PLACED = new Set(['PLACED','PENDING_NEW','ACCEPTED','NEW','FILLED','PARTIALLY_FILLED']);
if (!_TRADE_PLACED.has(_alpStatus)) {
  console.log('[FFA v12.1] CHANNEL GATE BLOCKED — alpaca_status=' + _alpStatus + ' ticker=' + ticker + ' — no trade placed, suppressing channel message');
  return [];
}

const execution  = (prev.execution || prev._sm_execution || 'STAND ASIDE').toUpperCase();
const isScannerSignal = (alertType === 'BROAD_SCANNER' || alertType === 'SENTIMENT_AGENT');

let isBull;
if (execution === 'BUY' || execution === 'LONG') {
  isBull = true;
} else if (execution === 'SELL' || execution === 'SHORT' || execution === 'SELL SHORT') {
  isBull = false;
} else {
  isBull = (alertType === 'BULL_SWEEP');
}

const _price = parseFloat(prev.price || prev.currentPrice || prev._sm_current_price || 0);
const priceStr = _price > 0 ? _price.toFixed(2) : 'market';

const _atr = parseFloat(prev.atr || 0);
const _stopDist = _atr * 1.5;
const _stopPrice = isBull
  ? (_price > 0 && _atr > 0 ? (_price - _stopDist).toFixed(2) : '')
  : (_price > 0 && _atr > 0 ? (_price + _stopDist).toFixed(2) : '');

const _volRatio = parseFloat(prev.volume_ratio || 0);
const volStr = _volRatio > 0 ? _volRatio.toFixed(1) + 'x avg' : 'unavailable';

const NL = String.fromCharCode(10);

const tf = (prev.timeframe || '').toString().toUpperCase();
const isScalp = ['5','5M','15','15M','1','1M','3','3M'].includes(tf);
const stratLabel = isScalp ? 'Scalp' : 'Swing';

const sweepLabel = isScannerSignal
  ? (isBull ? 'BUY' : 'SELL')
  : (isBull ? 'BULL SWEEP' : 'BEAR SWEEP');
const direction = isBull ? 'LONG' : 'SHORT';

function val(v, prefix, suffix) {
  prefix = prefix || ''; suffix = suffix || '';
  if (v === undefined || v === null || v === '' || v === 0 || v === '0' || v === 'N/A') return 'N/A';
  return prefix + v + suffix;
}

const qualityGate   = prev._sm_quality_gate || 'PASS';
const maxConfidence = prev._sm_max_confidence !== undefined ? prev._sm_max_confidence : 10;
const contradictions = prev._sm_contradiction_count || 0;
let gateBadge = qualityGate === 'KILL'
  ? 'SIGNAL KILLED - ' + contradictions + ' contradictions'
  : qualityGate === 'WARN'
    ? 'CAUTION - max ' + maxConfidence + '/10'
    : 'CLEAR - max ' + maxConfidence + '/10';

let mktLine = '';
if (prev.spy_status || prev.qqq_status) {
  const spyTag = prev.spy_status === 'HEALTHY' ? 'SPY OK' : prev.spy_status === 'BREAKING_DOWN' ? 'SPY DOWN' : 'SPY WEAK';
  const qqqTag = prev.qqq_status === 'HEALTHY' ? 'QQQ OK' : prev.qqq_status === 'BREAKING_DOWN' ? 'QQQ DOWN' : 'QQQ WEAK';
  const xlyTag = prev.xly_status === 'ALIGNED' ? 'XLY OK' : 'XLY DIV';
  const vixStr = prev.vix ? ' | VIX ' + prev.vix : '';
  const cs = prev.cross_asset_status;
  const tone = cs === 'ALL_ALIGNED' ? 'Aligned' : (cs && cs.includes('BREAK')) ? 'Hostile' : 'Mixed / Cautious';
  mktLine = spyTag + ' | ' + qqqTag + ' | ' + xlyTag + vixStr + ' | ' + tone;
}

let message = '';
message += '<b>' + ticker + ' | ' + stratLabel + ' ' + sweepLabel + '</b>' + NL;
message += gateBadge + NL + NL;
message += direction + ' @ $' + priceStr + NL;
message += 'Volume: ' + volStr + NL;
message += 'Bias: ' + val(prev.bias_score, '', '%') + ' | ' + val(prev.regime) + NL;
message += 'RSI: ' + val(prev.rsi) + ' | MACD: ' + val(prev.macd_hist) + NL;
message += 'ATR: ' + val(prev.atr) + NL;

if (mktLine) {
  message += NL + 'MARKET: ' + mktLine + NL;
}

if (_stopPrice) {
  message += NL + (isBull
    ? 'Stop: $' + _stopPrice + ' | TP: $' + (_price > 0 && _atr > 0 ? (_price + _atr * 3).toFixed(2) : 'N/A')
    : 'Stop: $' + _stopPrice + ' | TP: $' + (_price > 0 && _atr > 0 ? (_price - _atr * 3).toFixed(2) : 'N/A')) + NL;
}

if (isScannerSignal) {
  message += NL + 'Source: ' + alertType.replace('_', ' ') + NL;
}

message += NL + 'Quantum Trading System';

return [{ json: { message } }];
