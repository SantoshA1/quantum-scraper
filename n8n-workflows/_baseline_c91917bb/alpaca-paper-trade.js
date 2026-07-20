// Alpaca Paper Trade v4.7 (TE-C4 existing-position guard — 2026-04-17) — TE-C3 fresh-price anchor — notional cap + safety clamps — GTC fix for bracket orders — Position Sizing + Native Bracket Orders + Slip-Proof Stops
// v4.3: Compute qty from eff_position_size × vix_size_mult × portfolio_value / price
//       Falls back to order_qty/qty/1 if sizing data unavailable
// Fix 1: Use Alpaca order_class='bracket' — stop and target are natively linked (real OCO).
//         Pre-bracket cancel sweep removed — no more orphaned legs.
// Fix 2: Stop buffer = max($0.10, 0.1% of price) for non-volatile; 0.2% for volatile.
//         Volatile names with trailing stop unaffected (no limit leg needed).

const prev    = $input.first().json;
// G16 Harness Broker Isolation (2026-07-17): a harness/test signal must NEVER POST a real Alpaca order.
// Fail-CLOSED: ANY harness indicator (even partial/malformed) suppresses the POST and returns a synthetic skipped
// order emitting a WOULD_PLACE_ORDER log. No POST => no order_events, no trade_log fill, no Telegram fill-notify,
// no TSM trigger, no L12 dedup corruption (all key off a real fill). GET account/positions stay live (safe reads).
const _aptHarness = !!(prev && (prev.harness === true || prev.is_test_injection === true || prev._is_harness === true || prev.is_dummy === true || String(prev.qtp_source || '').toUpperCase().indexOf('HARNESS') >= 0));
const _aptOrderPost = async (opts) => {
  if (_aptHarness) {
    let _b = {}; try { _b = JSON.parse(opts.body); } catch (_) {}
    console.log('[G16 HARNESS] WOULD_PLACE_ORDER (no broker POST): ' + JSON.stringify({ symbol: _b.symbol, qty: _b.qty, side: _b.side, type: _b.type }));
    return { id: 'HARNESS_' + Date.now().toString(36), client_order_id: _b.client_order_id || ('HARNESS_' + Date.now().toString(36)), status: 'skipped', _g16_harness: true, _would_place_order: true, filled_qty: '0', qty: _b.qty || '0', symbol: _b.symbol };
  }
  return await this.helpers.httpRequest(opts);
};
// F-DURABLE (2026-07-17): stamp Alpaca client_order_id encoding the signal id so order_events/trade_log.raw_payload links back to cohort evidence (durable attribution). Additive + fail-safe: null id => field omitted => identical to before. Unique via Date.now() suffix => never a duplicate rejection.
const _qetEntryCoid = (function(){ try { const raw = String((prev && (prev.signal_id || prev.idempotency_key)) || '').replace(/[^A-Za-z0-9-]/g,'').slice(0,60); return raw ? ('qet-' + raw + '-e' + Date.now().toString(36)) : null; } catch(_) { return null; } })();
const ticker  = (prev.ticker || '').toUpperCase();
const execution = (prev.execution || prev._sm_route || '').toUpperCase();
const signal  = (prev.signal || '').toUpperCase();

// QTP_ALPACA_SMOKE_TEST_HARD_SKIP_v5.5_20260516
// Defense-in-depth: even if a synthetic/smoke payload reaches this node, never place an order.
if (prev.test_mode === true || String(prev.test_mode || '').toLowerCase() === 'true' || String(prev.qtp_deployment_mode || '').toUpperCase().includes('SMOKE_TEST_NO_ORDER')) {
  return [{ json: { ...prev, alpaca_status: 'SKIPPED', alpaca_reason: 'Synthetic/smoke test payload — hard skip inside Alpaca Paper Trade', qtp_alpaca_smoke_skip_version: 'QTP_ALPACA_SMOKE_TEST_HARD_SKIP_v5.5_20260516' } }];
}

const _creds       = $getWorkflowStaticData('global');
const _credsStore  = (_creds._credentials || {});
// ENTRY_CONTRACT_PATCH_20260501: prefer n8n variables; retain static fallback.
const ALPACA_KEY   = $vars.ALPACA_API_KEY || $vars.ALPACA_KEY_ID || _credsStore.alpaca_api_key || '';
const ALPACA_SEC   = $vars.ALPACA_SECRET_KEY || $vars.ALPACA_SECRET || _credsStore.alpaca_secret_key || '';

// Fix #17 Batch 1 (2026-04-19): fail-closed Alpaca creds
if (!ALPACA_KEY || !ALPACA_SEC) throw new Error('Alpaca creds missing from n8n variables/staticData._credentials (fail-closed)');
// SM-C2: env-driven Alpaca base URL (default paper, flip via staticData)
const _creds_AB = _credsStore;
const BASE = $vars.ALPACA_BASE_URL
  || _creds_AB.alpaca_base
  || (_creds_AB.alpaca_env === 'live'
    ? 'https://paper-api.alpaca.markets'
    : 'https://paper-api.alpaca.markets');
// QTP_ALPACA_NODE_PAPER_ONLY_ASSERT_v4.2.7 — final in-node fail-closed guard.
if (!String(BASE || '').toLowerCase().includes('paper-api.alpaca.markets')) {
  throw new Error('QTP PAPER-ONLY ASSERT BLOCKED: Alpaca Paper Trade BASE is not paper endpoint.');
}

const HDR          = {
  'APCA-API-KEY-ID':    ALPACA_KEY,
  'APCA-API-SECRET-KEY': ALPACA_SEC,
  'Content-Type':       'application/json'
};

const VOLATILE  = new Set(['SQQQ','TQQQ','SPXS','SPXL','SOXS','SOXL','UVXY','SVXY','SMCI','IONQ']);

// ── APT v4.4: Alpaca error detail extractor ──────────────────────────────
// Captures HTTP status + response body from httpRequest error objects.
// Alpaca 422s include actionable details in body.message (e.g. "stop_limit
// would immediately execute") that were previously swallowed.
function _alpacaErrDetail(e) {
  try {
    const status = e.statusCode || e.response?.statusCode || e.response?.status || null;
    let body = e.response?.body || e.response?.data || e.error || e.cause || null;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) {} }
    const bodyStr = body ? (typeof body === 'object' ? JSON.stringify(body).substring(0, 600) : String(body).substring(0, 600)) : '';
    return { status, body: bodyStr };
  } catch (_) {
    return { status: null, body: '' };
  }
}

const vol       = VOLATILE.has(ticker);
const SL_MULT   = vol ? 1.0 : 1.5;
const TRAIL_PCT = vol ? '3' : null;

const isEntry = ['BUY','SELL','BULLISH','BEARISH','LONG','SHORT'].includes(execution) ||
                ['BUY','SELL','BULLISH','BEARISH'].includes(signal);
if (!isEntry || !ticker) {
  return [{ json: { ...prev, alpaca_status: 'SKIPPED', alpaca_reason: 'Not an entry signal' } }];
}
if (ticker === 'SPY' || ticker === 'QQQ') {
  return [{ json: { ...prev, alpaca_status: 'SKIPPED', alpaca_reason: 'Index — monitor only' } }];
}

// ── v3.1 DEDUP GUARD — unchanged, still needed ───────────────────────────────
const _aptState = $getWorkflowStaticData('global');
if (!_aptState._aptDedup) _aptState._aptDedup = {};
const _dedupKey = ticker + '_' + (prev.timeframe || '5');
const _lastTradeMs = _aptState._aptDedup[_dedupKey] || 0;
if (Date.now() - _lastTradeMs < 90000) {
  console.log('[APT v4.3] DEDUP — already traded ' + ticker + ' within 90s, skipping duplicate');
  return [{ json: { ...prev, alpaca_status: 'SKIPPED', alpaca_reason: 'Dedup: already traded within 90s' } }];
}
_aptState._aptDedup[_dedupKey] = Date.now();
for (const k of Object.keys(_aptState._aptDedup)) {
  if (Date.now() - _aptState._aptDedup[k] > 300000) delete _aptState._aptDedup[k];
}
// ─────────────────────────────────────────────────────────────────────────────

const isLong    = ['BUY','BULLISH','LONG'].includes(execution) || ['BUY','BULLISH'].includes(signal);
const side      = isLong ? 'buy' : 'sell';
const closeSide = isLong ? 'sell' : 'buy';

// ── RISK-GATE v1.0 — 2026-04-29 audit-safe containment ─────────────────────
// Supabase is the system of record for current risk state. This pre-order
// gate is read-only and runs before any Alpaca order POST. It blocks only new
// entries/adds while risk state is dirty, and allows risk-reducing exits/covers.
// Supabase risk gate context is attached by Format Supabase Alpaca Risk Gate Context.

function __riskBlockedPayload(reason, details = {}) {
  return [{ json: {
    ...prev,
    alpaca_status: 'BLOCKED_RISK_GATE',
    alpaca_reason: reason,
    risk_gate_ok: false,
    risk_gate_blocked: true,
    risk_gate_reason: reason,
    event_type: 'RISK_GATE_BLOCK',
    target_table: 'risk_events',
    trade_status: 'BLOCKED_RISK_GATE',
    order_status: 'BLOCKED_RISK_GATE',
    idempotency_key: prev.idempotency_key || `risk_gate:${ticker}:${Date.now()}`,
    ...details,
  }}];
}

async function __aptReadPosition(symbol) {
  try {
    const pos = await this.helpers.httpRequest({
      method: 'GET',
      url: BASE + '/v2/positions/' + encodeURIComponent(symbol),
      headers: HDR,
      json: true,
      timeout: 4000,
    });
    return {
      exists: true,
      side: String(pos?.side || '').toLowerCase(),
      qty: Math.abs(Number(pos?.qty || 0)),
      raw_qty: Number(pos?.qty || 0),
    };
  } catch (e) {
    const msg = String(e?.message || e || '');
    if (msg.includes('404') || /not found|does not exist/i.test(msg)) {
      return { exists: false, side: '', qty: 0, raw_qty: 0 };
    }
    throw e;
  }
}

try {
  const riskGate = prev._supabase_risk_gate_status || {};
  const held = await __aptReadPosition.call(this, ticker);
  const desiredSide = isLong ? 'long' : 'short';
  const isFlat = !held.exists || held.qty === 0;
  const isAddSameDirection = held.qty > 0 && held.side === desiredSide;
  const isRiskReducing = held.qty > 0 && held.side !== desiredSide;
  const isNewOrAdd = isFlat || isAddSameDirection;
  const blockNewEntries = String(riskGate.new_entry_status || '').toUpperCase() === 'BLOCK_NEW_ENTRIES';
  // FIX 2026-06-30 (PO): short-entry block now CONDITIONAL on real risk state (was unconditional, ignored clean state).
  // Blocks fresh shorts only when the Supabase risk gate says BLOCK_NEW_ENTRIES or flags short-specific blockers; passes when clean.
  const blockShortEntry = desiredSide === 'short' && isNewOrAdd && (blockNewEntries || Number(riskGate.short_entry_blockers || 0) > 0);

  if (blockShortEntry) {
    console.log('[APT RISK-GATE] BLOCK short entry/add for ' + ticker + ' until risk state is clean');
    return __riskBlockedPayload('Temporary short-entry block until risk state is clean', {
      risk_gate_status: riskGate,
      risk_gate_desired_side: desiredSide,
      risk_gate_position_side: held.side || 'flat',
      risk_gate_position_qty: held.qty,
      risk_gate_is_risk_reducing: isRiskReducing,
    });
  }
  if (blockNewEntries && isNewOrAdd && !isRiskReducing) {
    console.log('[APT RISK-GATE] BLOCK new/add entry for ' + ticker + ' because Supabase risk gate is BLOCK_NEW_ENTRIES');
    return __riskBlockedPayload('Supabase risk gate BLOCK_NEW_ENTRIES', {
      risk_gate_status: riskGate,
      risk_gate_desired_side: desiredSide,
      risk_gate_position_side: held.side || 'flat',
      risk_gate_position_qty: held.qty,
      risk_gate_is_risk_reducing: isRiskReducing,
    });
  }
  console.log('[APT RISK-GATE] PASS ' + ticker + ' desired=' + desiredSide + ' held=' + (held.side || 'flat') + ' qty=' + held.qty + ' riskReducing=' + isRiskReducing);
} catch (riskErr) {
  const riskMsg = String(riskErr?.message || riskErr || '').slice(0, 1000);
  console.log('[APT RISK-GATE] FAIL-CLOSED for potential new entry on ' + ticker + ': ' + riskMsg);
  // If risk state is unavailable, fail closed for new entries/adds. Existing
  // exits/covers are still allowed when the broker position read succeeds.
  try {
    const held = await __aptReadPosition.call(this, ticker);
    const desiredSide = isLong ? 'long' : 'short';
    const isRiskReducing = held.qty > 0 && held.side !== desiredSide;
    if (isRiskReducing) {
      console.log('[APT RISK-GATE] Risk query failed but signal is risk-reducing; allowing ' + ticker);
    } else {
      return __riskBlockedPayload('Risk gate unavailable — fail-closed for new/add entry', {
        risk_gate_error: riskMsg,
        risk_gate_desired_side: desiredSide,
        risk_gate_position_side: held.side || 'flat',
        risk_gate_position_qty: held.qty,
      });
    }
  } catch (posErr) {
    return __riskBlockedPayload('Risk gate and position check unavailable — fail-closed', {
      risk_gate_error: riskMsg,
      risk_gate_position_error: String(posErr?.message || posErr || '').slice(0, 1000),
    });
  }
}
// ─────────────────────────────────────────────────────────────────────────────


const signal_price = parseFloat(prev.price || 0);
const atrRaw = parseFloat(prev.atr   || prev.atr_est || 0);
const atr    = atrRaw > 0 ? atrRaw : signal_price * 0.015;

// ── TE-C3 v4.6: Fresh-price anchoring + staleness rejection ───────────────
// Bracket stop/TP were previously anchored to the signal price (prev.price),
// which can be seconds-to-minutes stale by the time the market order fills.
// Fetch the latest IEX trade print for this ticker and anchor stop/TP to it.
// Staleness thresholds:
//   |slip| > 2%  -> REJECT trade (fail-closed)
//   |slip| > 0.5% -> re-anchor + warning
//   |slip| <= 0.5% -> re-anchor silently
//   fetch failure -> fall back to signal_price (does not block trade)
let price = signal_price;
let fresh_price = null;
let slip_pct = 0;
let anchor_source = 'signal';
if (signal_price > 0) {
  try {
    const trR = await this.helpers.httpRequest({
      method: 'GET',
      url: 'https://data.alpaca.markets/v2/stocks/' + encodeURIComponent(ticker) + '/trades/latest',
      headers: {
        'APCA-API-KEY-ID':     ALPACA_KEY,
        'APCA-API-SECRET-KEY': ALPACA_SEC
      },
      json: true,
      timeout: 3000
    });
    const fp = parseFloat(trR && trR.trade && trR.trade.p);
    if (fp > 0) {
      fresh_price = fp;
      slip_pct = (fresh_price - signal_price) / signal_price;
      const absSlip = Math.abs(slip_pct);
      if (absSlip > 0.02) {
        console.log('[APT v4.6 TE-C3] REJECT — stale signal for ' + ticker +
          ': signal=$' + signal_price + ' fresh=$' + fresh_price +
          ' slip=' + (slip_pct*100).toFixed(2) + '% (threshold 2%)');
        return [{ json: {
          ...prev,
          alpaca_status:       'REJECTED',
          alpaca_reason:       'Stale signal price — |slip| > 2%',
          alpaca_signal_price: signal_price,
          alpaca_fresh_price:  fresh_price,
          alpaca_slip_pct:     slip_pct,
          alpaca_anchor_used:  'none'
        }}];
      }
      price = fresh_price;
      anchor_source = absSlip > 0.005 ? 'fresh_warn' : 'fresh';
      if (absSlip > 0.005) {
        console.log('[APT v4.6 TE-C3] WARN slip=' + (slip_pct*100).toFixed(2) +
          '% for ' + ticker + ' — re-anchoring stop/TP to fresh=$' + fresh_price);
      } else {
        console.log('[APT v4.6 TE-C3] OK slip=' + (slip_pct*100).toFixed(3) +
          '% for ' + ticker + ' — anchor=fresh=$' + fresh_price);
      }
    } else {
      console.log('[APT v4.6 TE-C3] Fresh-price fetch returned no price for ' + ticker + ' — falling back to signal_price');
    }
  } catch (fpErr) {
    console.log('[APT v4.6 TE-C3] Fresh-price fetch failed for ' + ticker + ': ' + (fpErr && fpErr.message) + ' — falling back to signal_price');
  }
}
// ─────────────────────────────────────────────────────────────────────────────

// ── v4.3: Position sizing from SM eff_position_size × vix_size_mult ─────────
// SM passes eff_position_size (% of portfolio, e.g. 5) and vix_size_mult (e.g. 0.7)
// If either is missing or price is 0, fall back to order_qty → qty → 1
let qty;
const effPct    = Math.min(parseFloat(prev.eff_position_size || 0), 10); // v4.3: clamped to max 10%
const vixMult   = parseFloat(prev.vix_size_mult || 1);
const explicitQ = parseInt(prev.order_qty || prev.qty || 0);

if (explicitQ > 0) {
  // Upstream already computed a qty — use it
  qty = explicitQ;
  console.log(`[APT v4.3] Using explicit qty=${qty}`);
} else if (effPct > 0 && price > 0) {
  // Compute from portfolio value
  let portfolioValue = 0;
  try {
    const acct = await this.helpers.httpRequest({
      method: 'GET', url: BASE + '/v2/account', headers: HDR, json: true,
      timeout: 5000
    });
    portfolioValue = parseFloat(acct.portfolio_value || acct.equity || 0);
  } catch (e) {
    const _d = _alpacaErrDetail(e);
    console.error('[APT v4.4] Account fetch FAILED — blocking trade:', e.message, 'status:', _d.status, 'body:', _d.body);
    return [{ json: { ...prev, alpaca_status: 'ERROR', alpaca_error: 'Account fetch failed: ' + e.message, alpaca_http_status: _d.status, alpaca_error_body: _d.body } }];
  }
  if (portfolioValue <= 0) {
    return [{ json: { ...prev, alpaca_status: 'ERROR', alpaca_error: 'Portfolio value is zero or negative' } }];
  }
  const MAX_NOTIONAL = 100000; // v4.5 (2026-04-17): Raised from $10k to $100k per user request
  const rawNotional = portfolioValue * (effPct / 100) * vixMult;
  const notional = Math.min(rawNotional, MAX_NOTIONAL);
  qty = Math.max(1, Math.floor(notional / price));
  if (rawNotional > MAX_NOTIONAL) {
    console.log(`[APT v4.5] CAPPED: raw=$${rawNotional.toFixed(0)} → $${MAX_NOTIONAL} (max notional cap)`);
  }
  console.log(`[APT v4.5] Sized: portfolio=$${portfolioValue} × ${effPct}% × ${vixMult} = $${notional.toFixed(0)} / $${price} = ${qty} shares`);
} else {
  qty = 1;
  console.log(`[APT v4.3] Fallback qty=1 (effPct=${effPct}, price=${price})`);
}
// ─────────────────────────────────────────────────────────────────────────────

// QTP_EXT_HOURS_ALPACA_LIMIT_ONLY_v2_20260527
// Extended-hours orders must be paper-only, limit orders, and include
// extended_hours=true. Blocks if no usable price is available.
const __aptIsExt = prev.is_extended_hours === true || String(prev.is_extended_hours || '').toLowerCase() === 'true';
const __aptSession = String(prev.market_session || 'REGULAR').toUpperCase();
const __aptMaxNotional = Number(prev.extended_hours_max_notional || 0);
if (__aptIsExt) {
  if (prev.qtp_live_trading_allowed === true) {
    return [{ json: { ...prev, alpaca_status: 'SKIPPED', alpaca_reason: 'EXT_HOURS_LIVE_FORBIDDEN', qtp_ext_hours_alpaca_v: 'QTP_EXT_HOURS_ALPACA_LIMIT_ONLY_v2_20260527' } }];
  }
  if (prev.extended_hours_risk_block === true || String(prev.extended_hours_risk_block || '').toLowerCase() === 'true') {
    return [{ json: { ...prev, alpaca_status: 'SKIPPED', alpaca_reason: prev.extended_hours_risk_reason || 'EXT_HOURS_RISK_BLOCK', qtp_ext_hours_alpaca_v: 'QTP_EXT_HOURS_ALPACA_LIMIT_ONLY_v2_20260527' } }];
  }
}

if (__aptIsExt && __aptMaxNotional > 0 && price > 0 && qty * price > __aptMaxNotional) {
  const cappedQty = Math.max(1, Math.floor(__aptMaxNotional / price));
  console.log(`[APT EXT v2] Capping extended-hours qty ${qty} → ${cappedQty} using max_notional=${__aptMaxNotional}`);
  qty = cappedQty;
}

// ── TE-C4 v4.7: Existing-position guard (fail-closed on duplicate/reversal) ─
// Query Alpaca for an existing position in this ticker right before submitting
// the bracket. Same-side → SKIPPED (duplicate). Opposite-side → SKIPPED
// (manual-close required). 404 → flat, proceed. Any other error → fail-open
// (log and proceed), so an Alpaca API hiccup does not block trading.
try {
  const _posR = await this.helpers.httpRequest({
    method: 'GET',
    url: BASE + '/v2/positions/' + encodeURIComponent(ticker),
    headers: HDR,
    json: true,
    timeout: 4000
  });
  const heldSide = String((_posR && _posR.side) || '').toLowerCase(); // 'long' | 'short'
  const heldQty  = parseFloat((_posR && _posR.qty) || 0);
  const signalSide = isLong ? 'long' : 'short';
  if (heldQty !== 0 && heldSide === signalSide) {
    console.log('[APT v4.7 TE-C4] SKIP — already holding ' + ticker + ' ' + heldSide + ' qty=' + heldQty + ' (same-direction duplicate)');
    return [{ json: {
      ...prev,
      alpaca_status:       'SKIPPED',
      alpaca_reason:       'Already held — same-direction existing position',
      alpaca_held_side:    heldSide,
      alpaca_held_qty:     heldQty,
      alpaca_signal_side:  signalSide,
      alpaca_signal_price: signal_price,
      alpaca_fresh_price:  fresh_price,
      alpaca_slip_pct:     slip_pct,
      alpaca_anchor_used:  anchor_source
    }}];
  }
  if (heldQty !== 0 && heldSide && heldSide !== signalSide) {
    console.log('[APT v4.7 TE-C4] SKIP — existing opposite-side position on ' + ticker + ' held=' + heldSide + ' signal=' + signalSide + ' (manual close required)');
    return [{ json: {
      ...prev,
      alpaca_status:       'SKIPPED',
      alpaca_reason:       'Existing opposite-side position — manual close required first',
      alpaca_held_side:    heldSide,
      alpaca_held_qty:     heldQty,
      alpaca_signal_side:  signalSide,
      alpaca_signal_price: signal_price,
      alpaca_fresh_price:  fresh_price,
      alpaca_slip_pct:     slip_pct,
      alpaca_anchor_used:  anchor_source
    }}];
  }
  // heldQty === 0 — position row exists but flat; treat as no position and proceed.
} catch (_posErr) {
  const _msg = (_posErr && _posErr.message) || '';
  if (_msg.includes('404') || _msg.includes('not found') || _msg.includes('does not exist')) {
    // Expected path — no existing position, proceed to bracket submit.
  } else {
    // Unexpected error: fail-open, but log loud.
    console.log('[APT v4.7 TE-C4] Position-check fetch error for ' + ticker + ': ' + _msg + ' — proceeding (fail-open)');
  }
}
// ─────────────────────────────────────────────────────────────────────────────

const r2 = n => Math.round(n * 100) / 100;

const stopPrice = isLong ? r2(price - atr * SL_MULT) : r2(price + atr * SL_MULT);

// ── Fix 2: Slip-proof stop buffer — max($0.10, 0.1% of price) ────────────
// Old: flat $0.05 — worthless in any fast move (RDDT gapped $4.91 past it)
// New: dynamic buffer, always meaningful relative to stock price
const slipBuffer = r2(Math.max(0.10, price * (vol ? 0.002 : 0.001)));
const stopLimit  = isLong ? r2(stopPrice - slipBuffer) : r2(stopPrice + slipBuffer);
// ─────────────────────────────────────────────────────────────────────────────

const tpPrice = isLong
  ? r2(price + atr * (vol ? 2.0 : 3.0))
  : r2(price - atr * (vol ? 2.0 : 3.0));

async function retry(fn, n = 2, ms = 800) {
  for (let i = 0; i <= n; i++) {
    try { return await fn(); }
    catch (e) {
      if (i === n) throw e;
      await new Promise(r => setTimeout(r, ms * Math.pow(2, i)));
    }
  }
}

// ── Fix 1: Native Alpaca bracket order ───────────────────────────────────
// order_class='bracket' links stop + target natively. Alpaca enforces the OCO.
// No pre-cancel sweep needed — no independent legs, no orphan risk.
// Volatile tickers that use trailing_stop cannot use bracket order_class,
// so they fall back to the v3.1 two-order approach (trailing_stop is safe —
// it doesn't have a limit leg that can slip, it always fills).

let entryResp;

if (TRAIL_PCT) {
  // ── Volatile path: market entry + trailing stop (unchanged from v3.1) ──────
  // trailing_stop always fills (no limit), so slip risk is zero.
  // Cannot use bracket class with trailing_stop.
  try {
    entryResp = await retry(() => _aptOrderPost({
      method: 'POST', url: BASE + '/v2/orders', headers: HDR, json: true,
      body: JSON.stringify(__aptIsExt ? { ...(_qetEntryCoid?{client_order_id:_qetEntryCoid}:{}), symbol: ticker, qty: String(qty), side, type: 'limit', time_in_force: 'day', limit_price: String(Number(price).toFixed(2)), extended_hours: true } : { ...(_qetEntryCoid?{client_order_id:_qetEntryCoid}:{}), symbol: ticker, qty: String(qty), side, type: 'market', time_in_force: 'gtc' }),
      timeout: 8000
    }));
  } catch (err) {
    const _d = _alpacaErrDetail(err);
    console.error('[APT v4.4] Entry FAILED:', err.message, 'status:', _d.status, 'body:', _d.body);
    return [{ json: { ...prev, alpaca_status: 'ERROR', alpaca_error: err.message, alpaca_http_status: _d.status, alpaca_error_body: _d.body, alpaca_failed_stage: 'volatile_entry' } }];
  }
  const entryId = entryResp?.id;
  console.log(`[APT v4.4] VOL Entry: ${ticker} ${side} qty=${qty} id=${entryId}`);

  // Small wait for fill
  await new Promise(r => setTimeout(r, 1200));

  let slId = null, tpId = null;
  try {
    const sl = await retry(() => _aptOrderPost({
      method: 'POST', url: BASE + '/v2/orders', headers: HDR, json: true,
      body: JSON.stringify({
        symbol: ticker, qty: String(qty), side: closeSide,
        type: 'trailing_stop', trail_percent: TRAIL_PCT, time_in_force: 'gtc'
      }),
      timeout: 8000
    }));
    slId = sl?.id;
    console.log(`[APT v4.3] VOL Trail stop: ${ticker} trail=${TRAIL_PCT}% id=${slId}`);
  } catch (e) { console.error('[APT v4.3.1] Trail stop FAILED — NAKED POSITION, needs recovery:', e.message); prev._needs_stop_recovery = true; prev._stop_error = e.message || String(e); }

  const state = $getWorkflowStaticData('global');
  if (!state._bracketOrders) state._bracketOrders = {};
  state._bracketOrders[ticker] = {
    entryId, slId, tpId: null, isVolatile: true, side, qty,
    entryPrice: price, stopPrice: 'trail:' + TRAIL_PCT + '%', tpPrice: null,
    attachedAt: new Date().toISOString(), bracketType: 'trailing'
  };

  return [{ json: {
    ...prev,
    alpaca_status:      entryResp?.status || 'submitted',
      alpaca_qty:         qty,
      alpaca_side:        side,
      alpaca_notional:    Number((qty * fresh_price).toFixed(2)),
    alpaca_entry_id:    entryId,
    alpaca_sl_id:       slId,
    alpaca_tp_id:       null,
    alpaca_stop_price:  'trail:' + TRAIL_PCT + '%',
    alpaca_tp_price:    null,
    alpaca_is_volatile: true,
    alpaca_atr_used:    atr,
    alpaca_signal_price: signal_price,
    alpaca_fresh_price:  fresh_price,
    alpaca_slip_pct:     slip_pct,
    alpaca_anchor_used:  anchor_source,
    alpaca_bracket_v:   '4.7'
  }}];

} else {
  // ── Standard path: single bracket order (entry + stop + target, all linked) ─
  // Alpaca creates all three legs atomically. If one fills, the other cancels.
  // No pre-cancel sweep. No orphan risk. No separate order IDs to track.
  const bracketBody = {
    ...(_qetEntryCoid?{client_order_id:_qetEntryCoid}:{}), 
    symbol:          ticker,
    qty:             String(qty),
    side,
    type:            __aptIsExt ? 'limit' : 'market',
    time_in_force:   __aptIsExt ? 'day' : 'gtc',
    ...( __aptIsExt ? { limit_price: String(Number(price).toFixed(2)), extended_hours: true } : {} ),
    order_class:     'bracket',
    stop_loss: {
      stop_price:  String(stopPrice),
      limit_price: String(stopLimit)   // slip-proof buffer applied here
    },
    take_profit: {
      limit_price: String(tpPrice)
    }
  };

  try {
    entryResp = await retry(() => _aptOrderPost({
      method: 'POST', url: BASE + '/v2/orders', headers: HDR, json: true,
      body: JSON.stringify(bracketBody),
      timeout: 8000
    }));
  } catch (err) {
    const _d = _alpacaErrDetail(err);
    console.error('[APT v4.4] Bracket entry FAILED:', err.message, 'status:', _d.status, 'body:', _d.body);
    return [{ json: { ...prev, alpaca_status: 'ERROR', alpaca_error: err.message, alpaca_http_status: _d.status, alpaca_error_body: _d.body, alpaca_failed_stage: 'bracket_entry' } }];
  }

  const entryId = entryResp?.id;
  const legs    = entryResp?.legs || [];
  const slLeg   = legs.find(l => l.type === 'stop_limit' || l.type === 'stop');
  const tpLeg   = legs.find(l => l.type === 'limit');
  const slId    = slLeg?.id || null;
  const tpId    = tpLeg?.id || null;

  console.log(`[APT v4.3] Bracket: ${ticker} ${side} qty=${qty} stop=$${stopPrice}(buf=$${slipBuffer}) tp=$${tpPrice} | entryId=${entryId} slId=${slId} tpId=${tpId}`);

  const state = $getWorkflowStaticData('global');
  if (!state._bracketOrders) state._bracketOrders = {};
  state._bracketOrders[ticker] = {
    entryId, slId, tpId, isVolatile: false, side, qty,
    entryPrice: price, stopPrice, stopLimit, tpPrice, slipBuffer,
    attachedAt: new Date().toISOString(), bracketType: 'native_oco'
  };

  return [{ json: {
    ...prev,
    alpaca_status:      entryResp?.status || 'submitted',
      alpaca_qty:         qty,
      alpaca_side:        side,
      alpaca_notional:    Number((qty * fresh_price).toFixed(2)),
    alpaca_entry_id:    entryId,
    alpaca_sl_id:       slId,
    alpaca_tp_id:       tpId,
    alpaca_stop_price:  stopPrice,
    alpaca_stop_limit:  stopLimit,
    alpaca_slip_buffer: slipBuffer,
    alpaca_tp_price:    tpPrice,
    alpaca_is_volatile: false,
    alpaca_atr_used:    atr,
    alpaca_signal_price: signal_price,
    alpaca_fresh_price:  fresh_price,
    alpaca_slip_pct:     slip_pct,
    alpaca_anchor_used:  anchor_source,
    alpaca_bracket_v:   '4.7'
  }}];
}
