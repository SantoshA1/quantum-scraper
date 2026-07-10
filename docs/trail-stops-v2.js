// ═══════════════════════════════════════════════════════════════════════════
// TRAILING STOP MANAGER v1.8 — Auto-Seed + Scale-Out Mode + Fill Detection
// Runs every 15 min during market hours. For each open position:
//   Tier 1: price >= entry + 1.5×ATR → sell 50%, raise stop to breakeven

//   Tier 2: price >= entry + 2.5×ATR → sell remaining 50% (full exit)
//   Tier 2 trail: price >= entry + 3.0×ATR → raise stop to entry + 1.5×ATR
//   Tier 3: price >= entry + 4.5×ATR → raise stop to entry + 3.0×ATR
//
// v1.6 CHANGES:
//   - AUTO-SEED: any position past Tier 1 without scaledOut entry gets
//     automatically seeded (synthetic Tier 1). Prevents the "tier skip" bug
//     where fast-movers jump from Tier 0 past Tier 1 in one interval.
//   - AUTO-SEED T2 AWARENESS: auto-seeded positions sell only 50% at T2
//     (their first real sell), then remaining 50% exits on next tier-up.
//     Non-auto-seeded positions (real T1 sell happened) still full-exit at T2.
//   - Legacy retro-seeds (v1.5 SMCI/IONQ) upgraded to autoSeeded for correct
//     50% T2 behavior.
//   - Removed hardcoded SMCI/IONQ retro-seed block (replaced by auto-seed).
//   - Added state consistency audit on every run (logs orphaned entries).
// ═══════════════════════════════════════════════════════════════════════════

// QTP_TSM_STOPWIDTH_EOD403_v4.3.0_20260706 — FIX1 stop-width sanity in v4.2.6 held-leg classifier;
// FIX2 EOD close guard nested-leg cancel + 403 retry + window start 945->930; FIX3 AUDIT_SAFE_MISSING_STOP_ONLY=false.
// QTP_TSM_ORPHAN_FLATTEN_v4.3.2_20260707 - carryover NOT_PROVEN_SCALP positions whose ONLY active protective
// stops are recovery-placed (qtp_sl_recovery_*/qtp_widestop_*) get leg-cancel + market flatten (paper only, windowed).
// QTP_TSM_ORPHAN_FLATTEN_v4.3.4_20260709 - REACHABILITY FIX: orphan-flatten was unreachable for
// recovery-stop-only carryovers >1 session old (nested under the prior-session entry gate). Orphan eval
// hoisted above that gate for ANY non-same-day carryover; organic-stop swings remain exempt; all gates kept.

// QTP_TSM_CREDENTIAL_MIGRATION_v2.0_20260710 — Alpaca transport goes through the token-gated
// QTP Alpaca Paper Broker Proxy (workflow nacafqPWhtsJjLvv), which holds the named n8n
// credential 'Alpaca-PAPER'. No embedded keys, no $vars, no staticData secrets here.
// Key rotation = update the Alpaca-PAPER credential only. All trading logic below is
// byte-identical to v4.3.4 except: alp() transport, bars fetch, removed key guard, TEST harness.
const BASE = 'https://paper-api.alpaca.markets'; // paper-endpoint safety guards below still check this string
const DATA = 'https://data.alpaca.markets';
const QTP_PROXY_URL = 'https://tradenextgen.app.n8n.cloud/webhook/qtp-alpaca-paper-proxy-x9v27';
const QTP_PROXY_TOKEN = String((typeof $vars !== 'undefined' && $vars.QTP_PROXY_TOKEN) || ''); // v2.2: rotated to n8n Variable after secret-scanner alert; proxies fail closed on mismatch
const QTP_TG_PROXY_URL = 'https://tradenextgen.app.n8n.cloud/webhook/qtp-telegram-proxy-k4p8w'; // v2.1: bot token removed — Telegram credential lives in QTP Telegram Proxy (oYZVDxX2yhX75Eu0)
const CHAT   = '6648680513';

const SCALE_OUT_MODE = true;

const state = $getWorkflowStaticData('global');
if (!state.scaledOut) state.scaledOut = {};
if (!state.trailState) state.trailState = {};


// QTP_STOP_LOSS_RECOVERY_v5.8_20260518
// Paper-gated stop-loss recovery for UNPROTECTED_BLOCKED_BY_LIMIT_EXIT.
// Safety constraints:
// - Paper endpoint only; hard-blocks any non-paper Alpaca base URL.
// - Market-hours only; no after-hours cancel/replace.
// - Cancels only non-stop same-side exit orders that reserve quantity.
// - Refetches position/orders after cancel before placing one GTC stop.
// - Idempotent recovery key prevents duplicate stop submissions and duplicate audit/order events.
// - Does not touch L12 fill dedup state._processedFills.
const QTP_STOP_RECOVERY_VERSION = 'QTP_STOP_LOSS_RECOVERY_v5.8_20260518';
const QTP_STOP_RECOVERY_ENABLED = true;
if (!state._stopRecoveryDedup) state._stopRecoveryDedup = {};
function qtpRecoveryHash(s) {
  s = String(s || '');
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
}
function qtpIsActiveOrderStatus(st) {
  return ['new','accepted','pending_new','held','partially_filled','pending_replace'].includes(String(st || '').toLowerCase());
}
function qtpIsStopType(t) {
  return ['stop','stop_limit','trailing_stop'].includes(String(t || '').toLowerCase());
}
function qtpOpenQty(o) {
  return Math.max(0, (parseFloat(o.qty || 0) || 0) - (parseFloat(o.filledQty || 0) || 0));
}

// v2.1 AUDIT-SAFE PATCH — 2026-04-29
// Missing-stop positions are classified and alerted only. This workflow must not
// auto-place protective stops when existing full-size exit orders may reserve qty,
// and it must never place new orders outside regular market hours.
const AUDIT_SAFE_MISSING_STOP_ONLY = false; // QTP_TSM_STOPWIDTH_EOD403_v4.3.0_20260706 FIX3: allow UNPROTECTED classifications to act (paper)
if (!state._missingStopAlerted) state._missingStopAlerted = {};


const r2 = n => Math.round(n * 100) / 100;

async function alp(method, path, body, host) {
  const resp = await this.helpers.httpRequest({
    method: 'POST', url: QTP_PROXY_URL,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: QTP_PROXY_TOKEN, host: host === 'data' ? 'data' : 'paper', method, path, body: body || null }),
    json: true, timeout: 45000
  });
  if (resp && resp.__qtp_proxy_error) {
    const pe = resp.__qtp_proxy_error;
    throw new Error('Request failed with status code ' + (pe.status || 'unknown') + (pe.body ? ' - ' + String(pe.body).slice(0, 300) : ''));
  }
  if (resp && resp.__qtp_proxy_ok) return resp.data;
  throw new Error('QTP_PROXY_BAD_RESPONSE: ' + JSON.stringify(resp || {}).slice(0, 200));
}

// v1.7: Retry helper with exponential backoff
async function retryAlp(ctx, method, path, body, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await alp.call(ctx, method, path, body);
    } catch (err) {
      if (attempt === maxRetries) throw err;
      const delay = 300 * Math.pow(2, attempt - 1); // 300ms, 600ms, 1200ms
      console.log(`[TRAIL v1.7] Retry ${attempt}/${maxRetries} for ${method} ${path} — waiting ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

async function tg(text) {
  try {
    await this.helpers.httpRequest({
      method: 'POST', url: QTP_TG_PROXY_URL,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: QTP_PROXY_TOKEN, chat_id: CHAT, text }),
      json: true
    });
  } catch (_) {}
}

// v1.9: Subscriber channel notification — clean, action-oriented messages only
// Rule: subscribers see every REAL Alpaca execution (entries, scale-outs, exits, stops)
// Rule: subscribers do NOT see internal system events (trail raises, auto-seeds, circuit breakers)
async function tgChannel(text) {
  try {
    await this.helpers.httpRequest({
      method: 'POST', url: QTP_TG_PROXY_URL,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: QTP_PROXY_TOKEN, chat_id: CHANNEL_ID, text }),
      json: true
    });
  } catch (_) {}
}

// ── QTP TSM TEST HARNESS v2.0 — active ONLY when the 'TSM Test Trigger' webhook fired ──
// In production (schedule trigger; test trigger disabled) the reference throws and __TEST
// stays null, so this block is inert. In test mode: Alpaca reads serve synthetic fixtures,
// writes are RECORDED (never sent), Telegram is captured. Zero broker side effects.
let __TEST = null;
try {
  const _tt = $('TSM Test Trigger').first().json;
  const _tb = (_tt && _tt.body) || _tt || {};
  if (_tb && _tb.scenario === 'qtp-tsm-synthetic-v1') __TEST = _tb;
} catch (_) { __TEST = null; }
const __testWrites = [];
const __testTg = [];
if (__TEST) {
  const FIX = __TEST.fixtures || {};
  const _fixOrders = (symFilter) => {
    const all = FIX.orders || [];
    if (!symFilter) return all;
    return all.filter(o => String(o.symbol || '').toUpperCase() === String(symFilter).toUpperCase());
  };
  alp = async function (method, path, body) {
    const m = String(method).toUpperCase();
    if (m === 'GET') {
      if (path === '/v2/positions') return FIX.positions || [];
      if (path.startsWith('/v2/positions/')) {
        const s = decodeURIComponent(path.split('/').pop());
        const p = (FIX.positions || []).find(x => x.symbol === s);
        if (!p) throw new Error('Request failed with status code 404 - position does not exist');
        return p;
      }
      if (path.startsWith('/v2/orders?')) {
        const ms = path.match(/symbols=([^&]+)/);
        return _fixOrders(ms ? decodeURIComponent(ms[1]) : null);
      }
      if (path.startsWith('/v2/orders/')) return { id: path.split('/').pop(), status: 'accepted', filled_qty: '0', filled_avg_price: null };
      if (path.startsWith('/v2/account/activities')) return FIX.activities || [];
      if (path.startsWith('/v2/stocks/bars')) return { bars: FIX.bars || {} };
      return {};
    }
    __testWrites.push({ method: m, path, body: body || null });
    if (m === 'POST' && path === '/v2/orders') return { id: 'test-ord-' + __testWrites.length, status: 'accepted', filled_qty: '0', filled_avg_price: null };
    return { ok: true };
  };
  const __tgSan = (t) => String(t).replace(/[^A-Za-z0-9 \-\.\$%@:|=+]/g, ' ').replace(/ +/g, ' ').slice(0, 140);
  tg = async function (text) { __testTg.push({ to: 'ops', text: __tgSan(text) }); };
  tgChannel = async function (text) { __testTg.push({ to: 'channel', text: __tgSan(text) }); };
}

let positions, orders;
try {
  positions = await alp.call(this, 'GET', '/v2/positions');
  orders    = await alp.call(this, 'GET', '/v2/orders?status=all&limit=500&direction=desc&nested=true'); // QTP_TSM_HELD_BRACKET_STOP_VISIBILITY_v4.2.6
} catch (e) {
  console.error('[TRAIL v1.7] Alpaca fetch failed:', e.message);
  return [{ json: { error: e.message } }];
}

// v2.0 FIX: Market hours guard — skip order placement during after-hours.
// TSM schedule runs every 15 min 24/7. Fill detection still runs (read-only),
// but stop adjustments and scale-outs are blocked outside regular hours.
const _tsmNowET = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
const _tsmETDate = new Date(_tsmNowET);
const _tsmETMins = _tsmETDate.getHours() * 60 + _tsmETDate.getMinutes();
const _tsmMarketOpen = _tsmETMins >= 570 && _tsmETMins < 960 && _tsmETDate.getDay() >= 1 && _tsmETDate.getDay() <= 5;

if (!state.knownPositions) state.knownPositions = {};
// v1.7.1: Fill dedup — prevents duplicate alerts if runs overlap
if (!state._processedFills) state._processedFills = {};
const CHANNEL_ID = '-1003889511940';  // subscriber channel — paid service notifications

const currentSymbols = new Set((positions || []).map(p => p.symbol));
const previousSymbols = Object.keys(state.knownPositions);
const closedSymbols = previousSymbols.filter(s => !currentSymbols.has(s));
const fillAlerts = [];

if (closedSymbols.length > 0) {
  console.log(`[TRAIL v1.7] Detected ${closedSymbols.length} closed position(s): ${closedSymbols.join(', ')}`);
  let recentFills = [];
  try { recentFills = await alp.call(this, 'GET', '/v2/account/activities/FILL?direction=desc&page_size=50'); } catch (_) {}
  for (const sym of closedSymbols) {
    const prev = state.knownPositions[sym];
    const entry = prev.entry || 0; const qty = prev.qty || 0; const side = prev.side || 'long';
    const exitFill = recentFills.find(f => f.symbol === sym && (f.side === 'sell' || f.side === 'buy') && f.side !== (side === 'long' ? 'buy' : 'sell'));
    const exitPrice = exitFill ? parseFloat(exitFill.price) : 0;
    const exitTime = exitFill ? exitFill.transaction_time : '';

    // v1.7.1: Fill dedup — build a unique key from symbol + fill ID + timestamp
    // If we've already processed this exact fill, skip it entirely.
    const _fillId = exitFill ? exitFill.id : '';
    const _dedupKey = sym + '_' + (_fillId || exitTime || Date.now());
    if (state._processedFills[_dedupKey]) {
      console.log(`[TRAIL v1.7.1] DEDUP: skipping already-processed fill for ${sym} (key=${_dedupKey.substring(0, 30)})`);
      delete state.trailState[sym]; delete state.scaledOut[sym];
      continue;
    }
    state._processedFills[_dedupKey] = Date.now();

    // Prune fill dedup entries older than 24h to prevent unbounded growth
    const _fillPruneAge = 24 * 60 * 60 * 1000;
    for (const k of Object.keys(state._processedFills)) {
      if (Date.now() - state._processedFills[k] > _fillPruneAge) delete state._processedFills[k];
    }

    const exitTimeET = exitTime ? new Date(exitTime).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true }) : '?';
    const isLong = side === 'long';
    const pnl = isLong ? (exitPrice - entry) * Math.abs(qty) : (entry - exitPrice) * Math.abs(qty);
    const pnlPct = entry > 0 ? ((exitPrice - entry) / entry * 100 * (isLong ? 1 : -1)) : 0;
    const pnlSign = pnl >= 0 ? '+' : ''; const icon = pnl >= 0 ? '✅' : '🔴';
    const tierInfo = state.trailState[sym] ? `Tier ${state.trailState[sym].tier}` : 'Initial stop';
    const msg = `${icon} <b>POSITION CLOSED — ${sym}</b>
${side.toUpperCase()} ${Math.abs(qty)} shares
Entry: $${entry.toFixed(2)} → Exit: $${exitPrice.toFixed(2)} at ${exitTimeET}
<b>P&L: ${pnlSign}$${pnl.toFixed(2)} (${pnlSign}${pnlPct.toFixed(1)}%)</b>
Stop tier at exit: ${tierInfo}`;
    await tg.call(this, msg);
    // v1.9: Subscriber notification for position close (stop-loss fill)
    const _subCloseMsg = `${icon} <b>${sym} — POSITION CLOSED</b>\n` +
      `${side.toUpperCase()} ${Math.abs(qty)} shares\n` +
      `Entry: $${entry.toFixed(2)} → Exit: $${exitPrice.toFixed(2)}\n` +
      `<b>P&L: ${pnlSign}$${pnl.toFixed(2)} (${pnlSign}${pnlPct.toFixed(1)}%)</b>\n\n` +
      `Quantum Trading System`;
    await tgChannel.call(this, _subCloseMsg);
    fillAlerts.push({ type: 'FILL_DETECTED', sym, side, qty: Math.abs(qty), entry, exit: exitPrice, pnl: r2(pnl), pnlPct: r2(pnlPct), exitTime: exitTimeET });
    delete state.trailState[sym]; delete state.scaledOut[sym];
    console.log(`[TRAIL v1.7.1] ${sym}: closed — P&L ${pnlSign}$${pnl.toFixed(2)}, state cleaned, fill deduped`);
  }
}

state.knownPositions = {};
for (const p of (positions || [])) {
  state.knownPositions[p.symbol] = { entry: parseFloat(p.avg_entry_price), qty: parseFloat(p.qty), side: parseFloat(p.qty) >= 0 ? 'long' : 'short', price: parseFloat(p.current_price) };
}

if (!positions || positions.length === 0) {
  console.log('[TRAIL v1.7] No open positions.');
  if (fillAlerts.length > 0) return fillAlerts.map(a => ({ json: a }));
  return [{ json: { message: 'No open positions', fills: fillAlerts.length } }];
}

// QTP_TSM_HELD_BRACKET_STOP_VISIBILITY_v4.2.6
// Fetching status=all is required because Alpaca exposes held bracket/OCO stop legs
// only under nested parent order history for some symbols. Never count stale canceled,
// expired, rejected, or filled stop orders as protection.
const QTP_ACTIVE_STOP_STATUSES_v426 = ['new', 'accepted', 'pending_new', 'held', 'partially_filled'];
const stopMap = {};
for (const o of orders) {
  const _type = String(o.type || o.order_type || '').toLowerCase();
  const _status = String(o.status || '').toLowerCase();
  if (['stop', 'stop_limit', 'trailing_stop'].includes(_type) && QTP_ACTIVE_STOP_STATUSES_v426.includes(_status)) {
    stopMap[o.symbol] = { orderId: o.id, stopPrice: parseFloat(o.stop_price || 0), type: _type, side: o.side, status: _status };
  }
}

const openOrderMap = {};
for (const o of orders) {
  if (!openOrderMap[o.symbol]) openOrderMap[o.symbol] = [];
  openOrderMap[o.symbol].push({
    orderId: o.id,
    clientOrderId: o.client_order_id,
    type: o.type,
    side: o.side,
    status: o.status,
    qty: parseFloat(o.qty || 0),
    filledQty: parseFloat(o.filled_qty || 0),
    limitPrice: o.limit_price ? parseFloat(o.limit_price) : null,
    stopPrice: o.stop_price ? parseFloat(o.stop_price) : null,
    createdAt: o.created_at,
    orderClass: o.order_class || o.orderClass || null,
    legs: Array.isArray(o.legs) ? o.legs : []
  });

  // QTP_NESTED_BRACKET_LEG_CANCEL_v4.2.16
  // Alpaca bracket parents can be status=filled while active take-profit/stop-loss
  // legs reserve shares as nested orders. If we close a failed scalp carryover,
  // those nested leg IDs must be cancelable candidates; otherwise the market close
  // gets 403 insufficient qty available.
  for (const leg of (Array.isArray(o.legs) ? o.legs : [])) {
    const legSym = leg.symbol || o.symbol;
    if (!legSym) continue;
    if (!openOrderMap[legSym]) openOrderMap[legSym] = [];
    openOrderMap[legSym].push({
      orderId: leg.id,
      clientOrderId: leg.client_order_id,
      type: leg.type,
      side: leg.side,
      status: leg.status,
      qty: parseFloat(leg.qty || 0),
      filledQty: parseFloat(leg.filled_qty || 0),
      limitPrice: leg.limit_price ? parseFloat(leg.limit_price) : null,
      stopPrice: leg.stop_price ? parseFloat(leg.stop_price) : null,
      createdAt: leg.created_at || o.created_at,
      orderClass: leg.order_class || o.order_class || o.orderClass || null,
      parentOrderId: o.id,
      isNestedLeg: true,
      qtpVersion: 'QTP_NESTED_BRACKET_LEG_CANCEL_v4.2.16_20260514'
    });
  }
}



// QTP_SCALP_EOD_CLOSE_GUARD v4.2.11 — additive end-of-day scalp guard + explicit scalp-to-swing conversion gate.
// Default: same-day scalp positions close near EOD. Overnight carry is allowed only if SCALP_TO_SWING_CONVERSION proves every criterion.
// Safety: fail-closed to EOD close on missing Supabase data, weak evidence, unresolved order-event mismatch, or unprotected risk state.
if (!state.qtpScalpEodClosed) state.qtpScalpEodClosed = {};
if (!state.qtpScalpSwingApproved) state.qtpScalpSwingApproved = {};
const QTP_SCALP_EOD_ENABLED = String($vars.QTP_SCALP_EOD_CLOSE_ENABLED ?? 'true').toLowerCase() !== 'false';
const QTP_SCALP_EOD_START_MIN = Number($vars.QTP_SCALP_EOD_START_MIN || 930); // QTP_TSM_STOPWIDTH_EOD403_v4.3.0_20260706 FIX 2c: 15:30 ET so the guard gets 2 runs (was 945)
const QTP_SCALP_EOD_END_MIN = Number($vars.QTP_SCALP_EOD_END_MIN || 959);     // 15:59 ET
const _qtpTodayET = _tsmETDate.toISOString().slice(0, 10);
const _qtpScalpEodWindow = QTP_SCALP_EOD_ENABLED && _tsmMarketOpen && _tsmETMins >= QTP_SCALP_EOD_START_MIN && _tsmETMins <= QTP_SCALP_EOD_END_MIN;

function _qtpOrderDateET(o) {
  try { return new Date(o.filled_at || o.submitted_at || o.created_at || '').toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); } catch (_) { return ''; }
}
function _qtpSameDayFilledBracketEntry(sym) {
  return (orders || []).find(o =>
    String(o.symbol || '').toUpperCase() === sym &&
    String(o.status || '').toLowerCase() === 'filled' &&
    String(o.order_class || '').toLowerCase() === 'bracket' &&
    String(o.type || '').toLowerCase() === 'market' &&
    _qtpOrderDateET(o) === _qtpTodayET
  );
}
function _qtpSqlEsc(v) { return String(v ?? '').replace(/'/g, "''"); }
function _qtpNum(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function _qtpUpper(v) { return String(v ?? '').trim().toUpperCase(); }



// QTP_SUPABASE_TRAILING_STOP_MANAGER_v4.2.1
// Preloaded by Query Supabase TSM Context. This replaces the old Supabase inline lookup for scalp-to-swing conversion.
const _qtpTsmContextRows = $input.all().map(i => i.json || {});
const _qtpTsmContextBySymbolDate = {};
const _qtpTsmContextBySymbol = {};
for (const row of _qtpTsmContextRows) {
  const sym = String(row.symbol || '').toUpperCase();
  const day = String(row.event_date || '').slice(0, 10);
  if (sym && day) _qtpTsmContextBySymbolDate[`${sym}:${day}`] = row;
  if (sym) _qtpTsmContextBySymbol[sym] = row;
}
function _qtpSupabaseFirst(sym, eventDay) {
  const s = String(sym || '').toUpperCase();
  const d = String(eventDay || '').slice(0, 10);
  return _qtpTsmContextBySymbolDate[`${s}:${d}`] || _qtpTsmContextBySymbol[s] || {};
}


async function _qtpScalpToSwingConversion(sym, pos, entryOrder) {
  const qty = parseFloat(pos.qty || 0);
  const isLong = qty > 0;
  const entry = parseFloat(pos.avg_entry_price || entryOrder.filled_avg_price || 0);
  const current = parseFloat(pos.current_price || 0);
  const eventDay = String(entryOrder.filled_at || new Date().toISOString()).slice(0, 10);
  const r = _qtpSupabaseFirst(sym, eventDay);
  if (!r || Object.keys(r).length === 0) {
    return { allow: false, reasons: ['supabase_check_missing:' + sym], data: {} };
  }

  const bias = _qtpNum(r.bias_score);
  const aiConf = _qtpNum(r.ai_confidence);
  const sample = _qtpNum(r.backtest_sample);
  const pf = _qtpNum(r.backtest_pf);
  const protectedQty = _qtpNum(r.protected_qty);
  const vwap = _qtpNum(r.vwap);
  const sma50 = _qtpNum(r.sma50);
  const ema200 = _qtpNum(r.ema200);
  const cross = _qtpUpper(r.cross_asset);
  const aiPass = String(r.ai_guard_pass ?? '').toLowerCase() === 'true';
  const riskProtected = _qtpUpper(r.protection_status) === 'FULLY_PROTECTED' && String(r.blocks_new_entries).toLowerCase() !== 'true' && protectedQty !== null && protectedQty >= Math.abs(qty);
  const filledLogged = Number(r.filled_logged || 0) > 0;
  const noMismatch = filledLogged; // If Supabase has not logged the filled state, overnight conversion is not allowed.
  const biasPass = bias !== null && bias >= 75;
  const aiPassStrict = aiConf !== null && aiConf >= 80 && aiPass;
  const crossPass = cross.includes('ALIGNED') || cross.includes('STRONG') || cross.includes('CONFIRMED');
  const green = isLong ? current >= entry : current <= entry;
  const trendPass = green || (isLong && ((vwap !== null && current >= vwap) || (sma50 !== null && current >= sma50) || (ema200 !== null && current >= ema200))) || (!isLong && ((vwap !== null && current <= vwap) || (sma50 !== null && current <= sma50) || (ema200 !== null && current <= ema200)));
  const backtestPass = sample !== null && sample >= 100 && pf !== null && pf >= 1.2;

  const checks = { biasPass, aiPassStrict, crossPass, trendPass, backtestPass, riskProtected, noMismatch };
  const reasons = [];
  if (!biasPass) reasons.push(`bias ${bias ?? 'N/A'} < 75`);
  if (!aiPassStrict) reasons.push(`ai_conf ${aiConf ?? 'N/A'} < 80 or ai_guard_pass=${aiPass}`);
  if (!crossPass) reasons.push(`cross_asset ${cross || 'N/A'} not ALIGNED/STRONG/CONFIRMED`);
  if (!trendPass) reasons.push(`not green and not above trend refs current=${current} entry=${entry} vwap=${vwap ?? 'N/A'} sma50=${sma50 ?? 'N/A'} ema200=${ema200 ?? 'N/A'}`);
  if (!backtestPass) reasons.push(`backtest sample=${sample ?? 'N/A'} pf=${pf ?? 'N/A'} fails sample>=100 pf>=1.2`);
  if (!riskProtected) reasons.push(`risk not fully protected status=${r.protection_status || 'N/A'} protected_qty=${r.protected_qty || 'N/A'} blocks=${r.blocks_new_entries || 'N/A'}`);
  if (!noMismatch) reasons.push('Supabase FILLED order_event missing');

  return { allow: Object.values(checks).every(Boolean), reasons, data: { ...r, current, entry, checks } };
}

const qtpScalpEodActions = [];
if (_qtpScalpEodWindow) {
  for (const pos of positions) {
    const sym = String(pos.symbol || '').toUpperCase();
    const qty = Math.abs(parseFloat(pos.qty || 0));
    if (!sym || !qty) continue;
    const dedup = `${_qtpTodayET}_${sym}`;
    if (state.qtpScalpEodClosed[dedup]) continue;
    const entryOrder = _qtpSameDayFilledBracketEntry(sym);
    if (!entryOrder) continue;

    const conversion = await _qtpScalpToSwingConversion.call(this, sym, pos, entryOrder);
    if (conversion.allow) {
      state.qtpScalpSwingApproved[dedup] = { ts: new Date().toISOString(), version: 'QTP_SCALP_TO_SWING_CONVERSION_v4.2.11_20260513', data: conversion.data };
      const msg = `✅ <b>SCALP→SWING APPROVED — ${sym}</b>
${qty} shares may carry overnight.
Rules passed: bias>=75, AI>=80, cross-asset confirmed, trend/green, backtest>=100/PF>=1.2, fully protected, FILLED audit present.
Quantum Trading System`;
      await tg.call(this, msg);
      qtpScalpEodActions.push({ type: 'SCALP_TO_SWING_CONVERSION_APPROVED', sym, qty, version: 'QTP_SCALP_TO_SWING_CONVERSION_v4.2.11_20260513', data: conversion.data });
      continue;
    }

    const side = parseFloat(pos.qty || 0) > 0 ? 'sell' : 'buy';
    const existing = openOrderMap[sym] || [];
    let cancelled = 0;
    let cancelFailed = 0;
    try {
      for (const o of existing) {
        const st = String(o.status || '').toLowerCase();
        if (['new','accepted','pending_new','held','partially_filled','pending_replace'].includes(st)) {
          try { await alp.call(this, 'DELETE', '/v2/orders/' + o.orderId); cancelled++; }
          catch (e) { cancelFailed++; console.warn(`[QTP EOD SCALP v4.2.9] ${sym}: cancel failed ${o.orderId}: ${e.message}`); }
        }
      }
      // QTP_TSM_STOPWIDTH_EOD403_v4.3.0_20260706 — FIX 2a: port of v4.2.16 nested-leg cancel onto
      // the same-day EOD close path. Held bracket child legs reserve shares and caused Alpaca 403
      // on F and HWM. Re-fetch fresh nested orders for the symbol, cancel every cancelable
      // parent/child, wait ~2s, then submit the market close.
      const _eodCancelLegs = async () => {
        let n = 0;
        try {
          const _fresh = await alp.call(this, 'GET', '/v2/orders?status=all&limit=200&direction=desc&nested=true&symbols=' + encodeURIComponent(sym));
          for (const fo of (_fresh || [])) {
            for (const cand of [fo, ...(Array.isArray(fo.legs) ? fo.legs : [])]) {
              const cst = String(cand.status || '').toLowerCase();
              if (cand.id && ['new','accepted','pending_new','held','partially_filled','pending_replace'].includes(cst)) {
                try { await alp.call(this, 'DELETE', '/v2/orders/' + cand.id); n++; }
                catch (e) { console.warn(`[QTP EOD v4.3.0] ${sym}: leg cancel failed ${cand.id}: ${e.message}`); }
              }
            }
          }
        } catch (e) { console.warn(`[QTP EOD v4.3.0] ${sym}: fresh leg-cancel fetch failed: ${e.message}`); }
        return n;
      };
      cancelled += await _eodCancelLegs();
      await new Promise(r => setTimeout(r, 2000));
      // FIX 2b: on 403 (legs still reserving shares), re-run the leg cancel and retry the close ONCE.
      let closeResp;
      try {
        closeResp = await retryAlp(this, 'POST', '/v2/orders', { symbol: sym, qty: String(qty), side, type: 'market', time_in_force: 'day' });
      } catch (e) {
        const _is403 = String(e.message || '').includes('403') || /insufficient/i.test(String(e.message || ''));
        if (!_is403) throw e;
        console.warn(`[QTP EOD v4.3.0] ${sym}: close got 403 — re-running leg cancel and retrying once`);
        cancelled += await _eodCancelLegs();
        await new Promise(r => setTimeout(r, 2000));
        closeResp = await retryAlp(this, 'POST', '/v2/orders', { symbol: sym, qty: String(qty), side, type: 'market', time_in_force: 'day' });
      }
      state.qtpScalpEodClosed[dedup] = { ts: new Date().toISOString(), qty, side, entryOrderId: entryOrder.id, closeOrderId: closeResp && closeResp.id, conversionDenied: conversion.reasons };
      const msg = `⏰ <b>SCALP EOD CLOSE SUBMITTED — ${sym}</b>
${side.toUpperCase()} ${qty} shares | same-day scalp bracket entry
Cancelled open exit orders: ${cancelled} | cancel failures: ${cancelFailed}
Reason: SCALP_TO_SWING_CONVERSION failed: ${conversion.reasons.join('; ').slice(0, 700)}
Quantum Trading System`;
      await tg.call(this, msg);
      await tgChannel.call(this, msg);
      qtpScalpEodActions.push({ type: 'SCALP_EOD_CLOSE_SUBMITTED', sym, qty, side, cancelled, cancelFailed, closeOrderId: closeResp && closeResp.id, conversionDenied: conversion.reasons, version: 'QTP_SCALP_EOD_CLOSE_GUARD_v4.2.11_20260513' });
    } catch (e) {
      qtpScalpEodActions.push({ type: 'SCALP_EOD_CLOSE_ERROR', sym, qty, side, error: e.message, conversionDenied: conversion.reasons, version: 'QTP_SCALP_EOD_CLOSE_GUARD_v4.2.11_20260513' });
      console.error(`[QTP EOD SCALP v4.2.9] ${sym}: close failed`, e.message);
    }
  }
}



// QTP_SCALP_CARRYOVER_CLOSE_GUARD v4.2.15 — close missed prior-session scalp carryovers safely.
// Scope: prior regular-session bracket entries only, proven by Supabase as Broad Scanner 5/15m scalp.
// Safety:
// - Does not touch same-day scalps handled by QTP_SCALP_EOD_CLOSE_GUARD.
// - Does not touch older swing/legacy positions.
// - Runs regular hours only after 10:00 ET to avoid opening volatility.
// - Reuses SCALP_TO_SWING_CONVERSION. If conversion passes, hold. If conversion fails, cancel exits then submit market close.
// - Fail-safe: if Supabase cannot prove the position is a prior-session scalp, skip.
if (!state.qtpScalpCarryoverClosed) state.qtpScalpCarryoverClosed = {};
if (!state.qtpScalpCarryoverSkipped) state.qtpScalpCarryoverSkipped = {};
const QTP_SCALP_CARRYOVER_ENABLED = String($vars.QTP_SCALP_CARRYOVER_CLOSE_ENABLED ?? 'true').toLowerCase() !== 'false';
const QTP_SCALP_CARRYOVER_START_MIN = Number($vars.QTP_SCALP_CARRYOVER_START_MIN || 600); // 10:00 ET
const QTP_SCALP_CARRYOVER_END_MIN = Number($vars.QTP_SCALP_CARRYOVER_END_MIN || 930);     // QTP_TSM_STOPWIDTH_EOD403_v4.3.0_20260706: stop before widened same-day EOD guard (was 945)
const QTP_ORPHAN_FLATTEN_ENABLED = true; // QTP_TSM_ORPHAN_FLATTEN_v4.3.2_20260707 kill switch - set false to disable orphan carryover flatten
const _qtpCarryoverWindow = QTP_SCALP_CARRYOVER_ENABLED && _tsmMarketOpen && _tsmETMins >= QTP_SCALP_CARRYOVER_START_MIN && _tsmETMins < QTP_SCALP_CARRYOVER_END_MIN;

function _qtpPriorSessionDateET() {
  const d = new Date(_tsmETDate);
  const day = d.getDay();
  d.setDate(d.getDate() - (day === 1 ? 3 : 1));
  return d.toISOString().slice(0, 10);
}
const _qtpPriorSessionET = _qtpPriorSessionDateET();

function _qtpPriorSessionFilledBracketEntry(sym) {
  return (orders || []).find(o =>
    String(o.symbol || '').toUpperCase() === sym &&
    String(o.status || '').toLowerCase() === 'filled' &&
    String(o.order_class || '').toLowerCase() === 'bracket' &&
    String(o.type || '').toLowerCase() === 'market' &&
    _qtpOrderDateET(o) === _qtpPriorSessionET
  );
}

async function _qtpCarryoverScalpProof(sym, eventDay) {
  const r = _qtpSupabaseFirst(sym, eventDay);
  const rows = Number(r.scalp_rows || 0);
  const tf = String(r.timeframe || '');
  const alert = _qtpUpper(r.alert_type);
  return {
    ok: rows > 0 && (alert.includes('BROAD_SCANNER') || ['5','15'].includes(tf)),
    rows,
    data: r
  };
}


// QTP_TSM_ORPHAN_FLATTEN_v4.3.4_20260709 — REACHABILITY FIX helpers.
// v4.3.2 nested the orphan test inside the (!proof.ok) branch, itself reached only after
// `if (!entryOrder) continue` where entryOrder = _qtpPriorSessionFilledBracketEntry (an
// EXACTLY-one-session-old filled bracket market entry). Multi-day carryovers (e.g. F: short,
// open since 2026-07-06, protected solely by a qtp_sl_recovery_ stop) never yield a
// prior-session entryOrder, so the loop `continue`d out BEFORE the orphan test — making
// orphan-flatten unreachable for precisely the recovery-stop-only carryovers it targets.
// Fix: hoist orphan evaluation into a helper invoked ABOVE the entry gate, for ANY carryover
// (NOT a same-day entry). Organic-stop swings (AFL/CDNS/LDOS: non-recovery client_order_id)
// return isOrphan=false and stay exempt. All protection semantics preserved.
const _QTP_ORPHAN_ACTIVE_ST = ['new','accepted','pending_new','held','partially_filled','pending_replace'];
function _qtpOrphanStops(sym) {
  const isStop = (o) => ['stop','stop_limit','trailing_stop'].includes(String(o.type || '').toLowerCase());
  const isRecoveryCid = (cid) => String(cid || '').startsWith('qtp_sl_recovery_') || String(cid || '').startsWith('qtp_widestop_');
  const active = (openOrderMap[sym] || []).filter(o => isStop(o) && _QTP_ORPHAN_ACTIVE_ST.includes(String(o.status || '').toLowerCase()));
  const recovery = active.filter(o => isRecoveryCid(o.clientOrderId));
  return { active, recovery, isOrphan: active.length > 0 && recovery.length === active.length };
}
function _qtpHasTodayOpeningFill(sym, isLong) {
  const openSide = isLong ? 'buy' : 'sell';
  return (orders || []).some(o =>
    String(o.symbol || '').toUpperCase() === String(sym || '').toUpperCase() &&
    String(o.status || '').toLowerCase() === 'filled' &&
    String(o.side || '').toLowerCase() === openSide &&
    _qtpOrderDateET(o) === _qtpTodayET
  );
}
async function _qtpTryOrphanFlatten(pos, dedup) {
  const sym = String(pos.symbol || '').toUpperCase();
  const qty = Math.abs(parseFloat(pos.qty || 0));
  if (!sym || !qty) return false;
  const _of = _qtpOrphanStops(sym);
  const _ofPaper = String(BASE || '').includes('paper-api.alpaca.markets');
  // Safety gates (unchanged from v4.3.2): kill switch, orphan criterion (ALL active protective
  // stops recovery-placed), market-open, paper endpoint. Enclosing carryover window still applies.
  if (!(QTP_ORPHAN_FLATTEN_ENABLED && _of.isOrphan && _tsmMarketOpen && _ofPaper)) return false;
  const side = parseFloat(pos.qty || 0) > 0 ? 'sell' : 'buy';
  const entry = parseFloat(pos.avg_entry_price || 0);
  // QTP_TSM_ORPHAN_FLATTEN_v4.3.4_20260709 PROFIT GUARD: an in-profit recovery-stop-only
  // carryover is SPARED (kept on its existing protective stop, allowed to run); only
  // non-profit orphans (genuinely un-managed losers) are flattened below.
  const _uPlpc = Number(pos.unrealized_plpc); const _uPl = Number(pos.unrealized_pl);
  if ((Number.isFinite(_uPlpc) && _uPlpc > 0) || (Number.isFinite(_uPl) && _uPl > 0)) {
    qtpScalpEodActions.push({ type: 'ORPHAN_SPARED_IN_PROFIT', sym, side, unrealized_pl: _uPl, unrealized_plpc: _uPlpc, note: 'recovery-stop-only carryover in profit — kept on protective stop, not flattened', version: 'QTP_TSM_ORPHAN_FLATTEN_v4.3.4_20260709' });
    return false; // in profit — spare, do NOT flatten
  }
  const cancelledStops = _of.recovery.map(o => ({ orderId: o.orderId, clientOrderId: o.clientOrderId }));
  try {
    const _ofCancelLegs = async () => {
      let n = 0;
      try {
        const _fresh = await alp.call(this, 'GET', '/v2/orders?status=all&limit=200&direction=desc&nested=true&symbols=' + encodeURIComponent(sym));
        for (const fo of (_fresh || [])) {
          for (const cand of [fo, ...(Array.isArray(fo.legs) ? fo.legs : [])]) {
            const cst = String(cand.status || '').toLowerCase();
            if (cand.id && _QTP_ORPHAN_ACTIVE_ST.includes(cst)) {
              try { await alp.call(this, 'DELETE', '/v2/orders/' + cand.id); n++; }
              catch (e) { console.warn(`[QTP ORPHAN v4.3.3] ${sym}: leg cancel failed ${cand.id}: ${e.message}`); }
            }
          }
        }
      } catch (e) { console.warn(`[QTP ORPHAN v4.3.3] ${sym}: fresh leg-cancel fetch failed: ${e.message}`); }
      return n;
    };
    let cancelled = await _ofCancelLegs();
    await new Promise(r => setTimeout(r, 2000));
    let closeResp;
    try {
      closeResp = await retryAlp(this, 'POST', '/v2/orders', { symbol: sym, qty: String(qty), side, type: 'market', time_in_force: 'day' });
    } catch (e) {
      const _is403 = String(e.message || '').includes('403') || /insufficient/i.test(String(e.message || ''));
      if (!_is403) throw e;
      console.warn(`[QTP ORPHAN v4.3.3] ${sym}: close got 403 - re-running leg cancel and retrying once`);
      cancelled += await _ofCancelLegs();
      await new Promise(r => setTimeout(r, 2000));
      closeResp = await retryAlp(this, 'POST', '/v2/orders', { symbol: sym, qty: String(qty), side, type: 'market', time_in_force: 'day' });
    }
    state.qtpScalpCarryoverClosed[dedup] = { ts: new Date().toISOString(), qty, side, closeOrderId: closeResp && closeResp.id, orphanFlatten: true, cancelledStops, version: 'QTP_TSM_ORPHAN_FLATTEN_v4.3.4_20260709' };
    qtpScalpEodActions.push({ type: 'ORPHAN_CARRYOVER_FLATTENED', sym, side, qty, entry, reason: 'recovery-stop-only carryover; no organic exit path', cancelledStops, cancelled, closeOrderId: closeResp && closeResp.id, version: 'QTP_TSM_ORPHAN_FLATTEN_v4.3.4_20260709' });
    const msg = `\u{1F9F9} <b>ORPHAN CARRYOVER FLATTENED - ${sym}</b>
${side.toUpperCase()} ${qty} shares @ market | entry ${entry}
Reason: recovery-stop-only carryover; no organic exit path
Recovery stops cancelled: ${cancelledStops.map(s => s.clientOrderId).join(', ').slice(0, 300)}
Close order: ${closeResp && closeResp.id}
Mode: PAPER ONLY | QTP_TSM_ORPHAN_FLATTEN_v4.3.4_20260709`;
    await tg.call(this, msg);
    await tgChannel.call(this, msg);
    return true;
  } catch (e) {
    qtpScalpEodActions.push({ type: 'ORPHAN_FLATTEN_FAILED_REVIEW_REQUIRED', sym, side, qty, entry, error: e.message, cancelledStops, version: 'QTP_TSM_ORPHAN_FLATTEN_v4.3.4_20260709' });
    console.error(`[QTP ORPHAN v4.3.3] ${sym}: flatten failed - REVIEW REQUIRED`, e.message);
    return true;
  }
}

if (_qtpCarryoverWindow) {
  for (const pos of positions) {
    const sym = String(pos.symbol || '').toUpperCase();
    const qty = Math.abs(parseFloat(pos.qty || 0));
    if (!sym || !qty) continue;

    const dedup = `${_qtpTodayET}_${sym}_carryover`;
    if (state.qtpScalpCarryoverClosed[dedup] || state.qtpScalpSwingApproved[dedup]) continue;

    // QTP_TSM_ORPHAN_FLATTEN_v4.3.4_20260709 — hoisted orphan check (reachability fix).
    // Runs for ANY carryover (a position with NO opening fill today -> not a same-day entry),
    // BEFORE the prior-session entry gate that previously hid multi-day orphans like F.
    // _qtpTryOrphanFlatten re-checks all safety gates and only acts on recovery-stop-only
    // positions; organic-stop swings return false and continue to normal handling below.
    if (!_qtpHasTodayOpeningFill(sym, parseFloat(pos.qty || 0) > 0)) {
      if (await _qtpTryOrphanFlatten.call(this, pos, dedup)) continue;
    }

    const entryOrder = _qtpPriorSessionFilledBracketEntry(sym);
    if (!entryOrder) continue;

    const eventDay = String(entryOrder.filled_at || entryOrder.submitted_at || '').slice(0, 10);
    const proof = await _qtpCarryoverScalpProof.call(this, sym, eventDay);
    if (!proof.ok) {
      // QTP_TSM_ORPHAN_FLATTEN_v4.3.4_20260709 — orphan flatten is now evaluated EARLIER
      // (hoisted above the prior-session entry gate). Retained here as a secondary net for
      // prior-session carryovers, delegating to the single _qtpTryOrphanFlatten implementation.
      // Organic-stop positions return false and fall through to the NOT_PROVEN_SCALP skip below.
      if (await _qtpTryOrphanFlatten.call(this, pos, dedup)) continue;
      state.qtpScalpCarryoverSkipped[dedup] = { ts: new Date().toISOString(), reason: 'not_proven_prior_session_scalp', proof: proof.data, version: 'QTP_SCALP_CARRYOVER_CLOSE_GUARD_v4.2.15_20260514' };
      qtpScalpEodActions.push({ type: 'SCALP_CARRYOVER_SKIPPED_NOT_PROVEN_SCALP', sym, qty, proof: proof.data, version: 'QTP_SCALP_CARRYOVER_CLOSE_GUARD_v4.2.15_20260514' });
      continue;
    }

    const conversion = await _qtpScalpToSwingConversion.call(this, sym, pos, entryOrder);
    if (conversion.allow) {
      state.qtpScalpSwingApproved[dedup] = { ts: new Date().toISOString(), version: 'QTP_SCALP_TO_SWING_CONVERSION_v4.2.15_20260514', data: conversion.data, proof: proof.data };
      const msg = `✅ <b>SCALP CARRYOVER HOLD APPROVED — ${sym}</b>
${qty} shares remain protected and may continue overnight.
Rules passed: bias>=75, AI>=80, cross-asset confirmed, trend/green, backtest>=100/PF>=1.2, fully protected, FILLED audit present.
Quantum Trading System`;
      await tg.call(this, msg);
      qtpScalpEodActions.push({ type: 'SCALP_CARRYOVER_HOLD_APPROVED', sym, qty, proof: proof.data, version: 'QTP_SCALP_CARRYOVER_CLOSE_GUARD_v4.2.15_20260514', data: conversion.data });
      continue;
    }

    const side = parseFloat(pos.qty || 0) > 0 ? 'sell' : 'buy';
    const existing = openOrderMap[sym] || [];
    let cancelled = 0;
    let cancelFailed = 0;
    try {
      for (const o of existing) {
        const st = String(o.status || '').toLowerCase();
        if (['new','accepted','pending_new','held','partially_filled','pending_replace'].includes(st)) {
          try { await alp.call(this, 'DELETE', '/v2/orders/' + o.orderId); cancelled++; }
          catch (e) { cancelFailed++; console.warn(`[QTP CARRYOVER SCALP v4.2.15] ${sym}: cancel failed ${o.orderId}: ${e.message}`); }
        }
      }
      const closeResp = await retryAlp(this, 'POST', '/v2/orders', { symbol: sym, qty: String(qty), side, type: 'market', time_in_force: 'day' });
      state.qtpScalpCarryoverClosed[dedup] = { ts: new Date().toISOString(), qty, side, entryOrderId: entryOrder.id, closeOrderId: closeResp && closeResp.id, conversionDenied: conversion.reasons, proof: proof.data };
      const msg = `⏰ <b>SCALP CARRYOVER CLOSE SUBMITTED — ${sym}</b>
${side.toUpperCase()} ${qty} shares | prior-session Broad Scanner scalp
Cancelled open exit orders: ${cancelled} | cancel failures: ${cancelFailed}
Reason: SCALP_TO_SWING_CONVERSION failed: ${conversion.reasons.join('; ').slice(0, 700)}
Quantum Trading System`;
      await tg.call(this, msg);
      await tgChannel.call(this, msg);
      qtpScalpEodActions.push({ type: 'SCALP_CARRYOVER_CLOSE_SUBMITTED', sym, qty, side, cancelled, cancelFailed, closeOrderId: closeResp && closeResp.id, conversionDenied: conversion.reasons, proof: proof.data, version: 'QTP_SCALP_CARRYOVER_CLOSE_GUARD_v4.2.15_20260514' });
    } catch (e) {
      qtpScalpEodActions.push({ type: 'SCALP_CARRYOVER_CLOSE_ERROR', sym, qty, side, error: e.message, conversionDenied: conversion.reasons, proof: proof.data, version: 'QTP_SCALP_CARRYOVER_CLOSE_GUARD_v4.2.15_20260514' });
      console.error(`[QTP CARRYOVER SCALP v4.2.15] ${sym}: close failed`, e.message);
    }
  }
}


// QTP_TSM_ORPHAN_FLATTEN_v4.3.4_20260709 — read-only reachability diagnostic.
// Outside the carryover action window (or when the market is closed) NO orders are placed, but
// orphan-eligible carryovers are still surfaced so operators and post-close verification can
// confirm the orphan branch now SEES them (e.g. F). Pure read; no Alpaca writes.
if (!_qtpCarryoverWindow) {
  for (const pos of (positions || [])) {
    const sym = String(pos.symbol || '').toUpperCase();
    if (!sym) continue;
    if (_qtpHasTodayOpeningFill(sym, parseFloat(pos.qty || 0) > 0)) continue;
    const _od = _qtpOrphanStops(sym);
    if (_od.isOrphan) {
      qtpScalpEodActions.push({
        type: 'ORPHAN_ELIGIBLE_WINDOW_CLOSED',
        sym,
        side: parseFloat(pos.qty || 0) > 0 ? 'long' : 'short',
        qty: Math.abs(parseFloat(pos.qty || 0)),
        entry: parseFloat(pos.avg_entry_price || 0),
        activeStops: _od.active.length,
        recoveryStops: _od.recovery.length,
        recoveryClientOrderIds: _od.recovery.map(o => o.clientOrderId),
        marketOpen: _tsmMarketOpen,
        carryoverWindow: _qtpCarryoverWindow,
        note: 'orphan-reachable; flatten deferred until carryover window + market open',
        version: 'QTP_TSM_ORPHAN_FLATTEN_v4.3.4_20260709'
      });
      console.log(`[QTP ORPHAN v4.3.3] ${sym}: ORPHAN_ELIGIBLE_WINDOW_CLOSED (reachability diagnostic)`);
    }
  }
}

const symbols = positions.map(p => p.symbol).join(',');
let barsData = {};
try {
  const resp = await alp.call(this, 'GET', `/v2/stocks/bars?symbols=${symbols}&timeframe=1Day&limit=20&feed=sip`, null, 'data');
  barsData = resp.bars || {};
} catch (e) { console.warn('[TRAIL v1.7] Bars fetch failed, using 2% proxy ATR:', e.message); }

function calcATR(bars) {
  if (!bars || bars.length < 2) return null;
  let sum = 0;
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].h, l = bars[i].l, pc = bars[i - 1].c;
    sum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  return sum / (bars.length - 1);
}

// ═══════════════════════════════════════════════════════════════════════════
// v1.6 AUTO-SEED + LEGACY UPGRADE
// ═══════════════════════════════════════════════════════════════════════════
const autoSeeded = [];

if (SCALE_OUT_MODE) {
  for (const pos of positions) {
    const sym = pos.symbol;
    const entry = parseFloat(pos.avg_entry_price);
    const current = parseFloat(pos.current_price);
    const qty = parseFloat(pos.qty);
    const isLong = qty > 0;
    const absQty = Math.abs(qty);

    if (state.scaledOut[sym]) {
      if (state.scaledOut[sym].retroactive && !state.scaledOut[sym].autoSeeded) {
        state.scaledOut[sym].autoSeeded = true;
        console.log(`[TRAIL v1.7] UPGRADE: ${sym} legacy retro-seed -> marked autoSeeded for 50% T2 sell`);
      }
      continue;
    }

    const bars = barsData[sym];
    let atr = calcATR(bars);
    if (!atr || atr <= 0) atr = entry * 0.02;

    const t1 = isLong ? entry + 1.5 * atr : entry - 1.5 * atr;
    const pastT1 = isLong ? current >= t1 : current <= t1;

    if (pastT1) {
      const halfQty = Math.floor(absQty / 2);
      state.scaledOut[sym] = { qty: halfQty, price: current, time: new Date().toISOString(), autoSeeded: true };
      if (!state.trailState[sym] || state.trailState[sym].tier < 1) {
        state.trailState[sym] = { tier: 1, lastStopSet: isLong ? r2(entry - 0.05) : r2(entry + 0.05) };
      }
      autoSeeded.push(sym);
      console.log(`[TRAIL v1.7] AUTO-SEED: ${sym} past T1 ($${r2(t1)}) without scaledOut -> seeded (${halfQty}sh synthetic)`);
    }
  }
  if (autoSeeded.length > 0) {
    await tg.call(this, `🔧 <b>AUTO-SEED — ${autoSeeded.length} position(s)</b>
${autoSeeded.join(', ')} were past Tier 1 without scale-out state.
Seeded as "Tier 1 done" — Tier 2 exit (sell ~50%) now armed.
<i>Trail Manager v1.6 auto-seed</i>`);
  }
}

const orphanedScaleOut = Object.keys(state.scaledOut).filter(s => !currentSymbols.has(s) && !state.scaledOut[s].tier2Done);
for (const orphan of orphanedScaleOut) { console.log(`[TRAIL v1.7] AUDIT: removing orphaned scaledOut for ${orphan}`); delete state.scaledOut[orphan]; }
const orphanedTrail = Object.keys(state.trailState).filter(s => !currentSymbols.has(s));
for (const orphan of orphanedTrail) { console.log(`[TRAIL v1.7] AUDIT: removing orphaned trailState for ${orphan}`); delete state.trailState[orphan]; }

const actions = [];
const skipped = [];

for (const pos of positions) {
  const sym = pos.symbol;
  const entry = parseFloat(pos.avg_entry_price);
  const current = parseFloat(pos.current_price);
  const qty = parseFloat(pos.qty);
  const isLong = qty > 0;
  const absQty = Math.abs(qty);

  const existingStop = stopMap[sym];
  if (!existingStop) {
    const bars = barsData[sym];
    let atr_miss = calcATR(bars);
    if (!atr_miss || atr_miss <= 0) atr_miss = entry * 0.02;
    let missStop = isLong ? r2(entry - 1.5 * atr_miss) : r2(entry + 1.5 * atr_miss);
    const missSide = isLong ? 'sell' : 'buy';
    let stopAdjusted = false;
    if (isLong && missStop >= current) { missStop = r2(current * 0.97); stopAdjusted = true; }
    else if (!isLong && missStop <= current) { missStop = r2(current * 1.03); stopAdjusted = true; }

    const openOrdersForSymbol = openOrderMap[sym] || [];
    const activeExitStatuses = ['new', 'accepted', 'pending_new', 'held', 'partially_filled'];
    const activeExitOrders = openOrdersForSymbol.filter(o => o.side === missSide && activeExitStatuses.includes(String(o.status || '').toLowerCase()));
    const pendingCancelExitOrders = openOrdersForSymbol.filter(o => o.side === missSide && String(o.status || '').toLowerCase() === 'pending_cancel');
    const sameSideExitOrders = activeExitOrders.concat(pendingCancelExitOrders);
    const activeReservedQty = activeExitOrders.reduce((sum, o) => sum + Math.max(0, (o.qty || 0) - (o.filledQty || 0)), 0);
    const pendingCancelReservedQty = pendingCancelExitOrders.reduce((sum, o) => sum + Math.max(0, (o.qty || 0) - (o.filledQty || 0)), 0);
    const blockedByExit = activeReservedQty >= Math.max(0, absQty - 0.0001);
    const blockedByPendingCancel = pendingCancelReservedQty >= Math.max(0, absQty - 0.0001);

    // QTP_TSM_OCO_AUDIT_FIX_v4.2.5
    // Alpaca OCO/bracket parents can appear as a sell/buy limit with a nested held stop leg.
    // If nested stop-leg coverage >= position qty, the position is protected and this
    // audit workflow must not emit MISSING STOP or request manual review. No orders touched.
    const nestedStopLegs = [];
    // v4.2.6: scan all symbol order records because a filled bracket parent may carry
    // a held stop child while the /open endpoint only exposes the take-profit limit.
    for (const o of openOrdersForSymbol) {
      for (const leg of (Array.isArray(o.legs) ? o.legs : [])) {
        const legType = String(leg.type || leg.order_type || '').toLowerCase();
        const legSide = String(leg.side || '').toLowerCase();
        const legStatus = String(leg.status || '').toLowerCase();
        if (legSide === missSide && ['stop','stop_limit','trailing_stop'].includes(legType) && activeExitStatuses.includes(legStatus)) {
          nestedStopLegs.push(leg);
        }
      }
    }
    const nestedProtectedQty = nestedStopLegs.reduce((sum, leg) => sum + Math.max(0, parseFloat(leg.qty || 0) - parseFloat(leg.filled_qty || 0)), 0);
    if (nestedProtectedQty >= Math.max(0, absQty - 0.0001)) {
      // QTP_TSM_STOPWIDTH_EOD403_v4.3.0_20260706 — FIX 1: stop-width sanity check.
      // A held/live protective stop leg only counts as protection if its distance from entry
      // is sane. Absurd bracket stop legs (+4.9% on scalp shorts) previously classified every
      // position OCO_PROTECTED_AUDIT_SAFE all day (WDAY ran -4.4% unstopped).
      const MAX_PROTECTIVE_STOP_PCT = 0.012; // 1.2%
      const _widthStopDistPct = nestedStopLegs.reduce((mx, leg) => {
        const sp = parseFloat(leg.stop_price || 0);
        return (Number.isFinite(sp) && sp > 0 && entry > 0) ? Math.max(mx, Math.abs(sp - entry) / entry) : mx;
      }, 0);
      if (_widthStopDistPct <= MAX_PROTECTIVE_STOP_PCT) {
        actions.push({
          type: 'OCO_PROTECTED_AUDIT_SAFE',
          sym,
          side: isLong ? 'long' : 'short',
          qty: absQty,
          protectedQty: nestedProtectedQty,
          nestedStopCount: nestedStopLegs.length,
          stopDistancePct: Math.round(_widthStopDistPct * 10000) / 10000,
          action: 'NO_ORDER_PLACED_ALREADY_PROTECTED',
          version: 'QTP_TSM_HELD_BRACKET_STOP_VISIBILITY_v4.2.6'
        });
        skipped.push(sym + ' (nested OCO stop protected)');
        console.log(`[TSM v4.2.5] ${sym}: nested OCO stop coverage ${nestedProtectedQty}/${absQty}; suppressing false MISSING STOP alert.`);
        continue;
      }
      // Stop leg too wide -> UNPROTECTED_STOP_TOO_WIDE. Cancel the too-wide held leg(s)
      // (v4.2.16 nested-leg records) then place a tight GTC stop at entry -/+ min(0.9%, 1.5xATR%),
      // reusing the v5.8 recovery request/dedup primitives. Note: the v5.8 missing-stop recovery
      // excludes stop-type blockers by design, so this branch performs its own cancel+replace.
      const _tightPct = Math.min(0.009, (atr_miss && entry > 0) ? (1.5 * atr_miss / entry) : 0.009);
      const _tightStop = isLong ? r2(entry * (1 - _tightPct)) : r2(entry * (1 + _tightPct));
      const _wideLegIds = nestedStopLegs.map(l => l.id).filter(Boolean).sort();
      const _widthHash = qtpRecoveryHash(`${sym}|${missSide}|${absQty}|${_tightStop}|${_wideLegIds.join('|')}`);
      const _widthKey = `stop_too_wide_recovery:${sym}:${_widthHash}`;
      const _widthPaper = String(BASE || '').includes('paper-api.alpaca.markets');
      const _widthRecent = Date.now() - (state._stopRecoveryDedup[_widthKey] || 0) < 15 * 60 * 1000;
      let _widthResult = null;
      if (AUDIT_SAFE_MISSING_STOP_ONLY) {
        _widthResult = { type: 'STOP_TOO_WIDE_AUDIT_ONLY', sym };
      } else if (!QTP_STOP_RECOVERY_ENABLED) {
        _widthResult = { type: 'STOP_TOO_WIDE_SKIPPED_RECOVERY_DISABLED', sym };
      } else if (!_widthPaper) {
        _widthResult = { type: 'STOP_TOO_WIDE_SKIPPED_NON_PAPER_ENDPOINT', sym, base: BASE };
      } else if (!_tsmMarketOpen) {
        _widthResult = { type: 'STOP_TOO_WIDE_SKIPPED_MARKET_CLOSED', sym };
      } else if (_widthRecent) {
        _widthResult = { type: 'STOP_TOO_WIDE_SKIPPED_DEDUP', sym, recoveryKey: _widthKey };
      } else {
        state._stopRecoveryDedup[_widthKey] = Date.now();
        const _widthCancelled = [];
        const _widthErrors = [];
        try {
          for (const legId of _wideLegIds) {
            try { await alp.call(this, 'DELETE', '/v2/orders/' + legId); _widthCancelled.push(legId); }
            catch (e) { _widthErrors.push({ orderId: legId, error: e.message }); }
          }
          await new Promise(r => setTimeout(r, 2000));
          const stopResp = await retryAlp(this, 'POST', '/v2/orders', {
            symbol: sym, qty: String(absQty), side: missSide,
            type: 'stop', stop_price: String(_tightStop), time_in_force: 'gtc',
            client_order_id: `qtp_widestop_${sym.toLowerCase()}_${_widthHash}`.slice(0, 48)
          });
          state.trailState[sym] = { tier: 0, lastStopSet: _tightStop, recovered: true, recoveryKey: _widthKey, recoveredAt: new Date().toISOString() };
          _widthResult = { type: 'STOP_TOO_WIDE_REPLACED_WITH_TIGHT_STOP', sym, cancelled: _widthCancelled, cancelErrors: _widthErrors, stopPrice: _tightStop, stopOrderId: stopResp && stopResp.id, recoveryKey: _widthKey, idempotency_key: _widthKey };
          await tg.call(this, `🛡️ <b>STOP TOO WIDE — REPLACED — ${sym}</b>
${isLong ? 'LONG' : 'SHORT'} ${absQty} shares
Held stop leg was ${(Math.round(_widthStopDistPct * 10000) / 100).toFixed(2)}% from entry (max ${(MAX_PROTECTIVE_STOP_PCT * 100).toFixed(1)}%)
Cancelled leg(s): ${_widthCancelled.length} | New GTC stop: <b>${missSide.toUpperCase()} ${absQty} @ $${_tightStop}</b>
Mode: PAPER ONLY | QTP_TSM_STOPWIDTH_EOD403_v4.3.0_20260706`);
        } catch (e) {
          _widthResult = { type: 'STOP_TOO_WIDE_RECOVERY_FAILED_REVIEW_REQUIRED', sym, error: e.message, cancelled: _widthCancelled, cancelErrors: _widthErrors, recoveryKey: _widthKey };
          state._stopRecoveryDedup[_widthKey] = Date.now() - (13 * 60 * 1000);
          await tg.call(this, `⚠️ <b>STOP TOO WIDE — RECOVERY FAILED — ${sym}</b>
${e.message}
Cancelled: ${_widthCancelled.length} | POSITION MAY BE UNPROTECTED — review now.
QTP_TSM_STOPWIDTH_EOD403_v4.3.0_20260706`);
        }
      }
      actions.push({
        type: 'UNPROTECTED_STOP_TOO_WIDE',
        sym,
        side: isLong ? 'long' : 'short',
        qty: absQty,
        entry,
        current,
        stopDistancePct: Math.round(_widthStopDistPct * 10000) / 10000,
        maxAllowedPct: MAX_PROTECTIVE_STOP_PCT,
        proposedStop: _tightStop,
        nestedStopCount: nestedStopLegs.length,
        recovery: _widthResult,
        requiresManualReview: !(_widthResult && _widthResult.type === 'STOP_TOO_WIDE_REPLACED_WITH_TIGHT_STOP'),
        version: 'QTP_TSM_STOPWIDTH_EOD403_v4.3.0_20260706'
      });
      skipped.push(sym + ' (stop too wide: ' + (_widthResult ? _widthResult.type : 'n/a') + ')');
      console.warn(`[QTP v4.3.0] ${sym}: held stop leg ${_widthStopDistPct} from entry exceeds ${MAX_PROTECTIVE_STOP_PCT}; result=${_widthResult ? _widthResult.type : 'n/a'}`);
      continue;
    }

    const classification = blockedByExit
      ? 'UNPROTECTED_BLOCKED_BY_LIMIT_EXIT'
      : (blockedByPendingCancel
        ? 'UNPROTECTED_BLOCKED_BY_PENDING_CANCEL'
        : (!_tsmMarketOpen ? 'UNPROTECTED_MARKET_CLOSED_AUDIT_ONLY' : 'UNPROTECTED_AUDIT_ONLY'));

    const auditEvent = {
      type: 'MISSING_STOP_AUDIT',
      sym,
      classification,
      side: isLong ? 'long' : 'short',
      qty: absQty,
      entry,
      current,
      proposedStop: missStop,
      stopSide: missSide,
      atr: r2(atr_miss),
      adjusted: stopAdjusted,
      marketOpen: _tsmMarketOpen,
      blockingOrders: sameSideExitOrders.map(o => ({
        orderId: o.orderId,
        type: o.type,
        side: o.side,
        status: o.status,
        qty: o.qty,
        filledQty: o.filledQty,
        limitPrice: o.limitPrice,
        createdAt: o.createdAt
      })),
      action: 'NO_ORDER_PLACED_AUDIT_SAFE',
      requiresManualReview: true
    };

    // QTP_STOP_LOSS_RECOVERY_v5.8_20260518
    // Convert the previous alert-only branch into a safe paper-only cancel/replace recovery.
    // This branch is intentionally narrow: only blocked-by-limit exits, regular market hours,
    // paper Alpaca endpoint, and no duplicate recovery key in recent state.
    let recoveryResult = null;
    // QTP_TSM_NAKED_RECOVERY_v4.3.1_20260707: fully-naked positions (UNPROTECTED_AUDIT_ONLY —
    // no stop leg, no blocking exit) previously had NO handler and sat CRITICAL, tripping
    // blocks_new_entries and freezing the whole book via the Risk Gate (F/HWM 2026-07-07).
    // Same recovery machinery: zero blockers to cancel, straight to GTC stop placement.
    if (QTP_STOP_RECOVERY_ENABLED && (classification === 'UNPROTECTED_BLOCKED_BY_LIMIT_EXIT' || classification === 'UNPROTECTED_AUDIT_ONLY')) {
      const paperOnly = String(BASE || '').includes('paper-api.alpaca.markets');
      const recoveryBlockers = activeExitOrders.filter(o => qtpIsActiveOrderStatus(o.status) && !qtpIsStopType(o.type) && qtpOpenQty(o) > 0);
      const blockerSig = recoveryBlockers.map(o => `${o.orderId}:${o.status}:${qtpOpenQty(o)}`).sort().join('|');
      const recoveryHash = qtpRecoveryHash(`${sym}|${missSide}|${absQty}|${missStop}|${blockerSig}`);
      const recoveryKey = `blocked_stop_recovery:${sym}:${recoveryHash}`;
      const lastRecovery = state._stopRecoveryDedup[recoveryKey] || 0;
      const recentRecovery = Date.now() - lastRecovery < 15 * 60 * 1000;

      if (!paperOnly) {
        recoveryResult = { type: 'STOP_RECOVERY_SKIPPED_NON_PAPER_ENDPOINT', sym, base: BASE, version: QTP_STOP_RECOVERY_VERSION };
      } else if (!_tsmMarketOpen) {
        recoveryResult = { type: 'STOP_RECOVERY_SKIPPED_MARKET_CLOSED', sym, version: QTP_STOP_RECOVERY_VERSION };
      } else if (recentRecovery) {
        recoveryResult = { type: 'STOP_RECOVERY_SKIPPED_DEDUP', sym, recoveryKey, version: QTP_STOP_RECOVERY_VERSION };
      } else if (recoveryBlockers.length === 0 && classification === 'UNPROTECTED_BLOCKED_BY_LIMIT_EXIT') { // v4.3.1: naked positions proceed with zero cancels
        recoveryResult = { type: 'STOP_RECOVERY_SKIPPED_NO_CANCELABLE_BLOCKER', sym, version: QTP_STOP_RECOVERY_VERSION };
      } else {
        state._stopRecoveryDedup[recoveryKey] = Date.now();
        const clientOrderId = `qtp_sl_recovery_${sym.toLowerCase()}_${recoveryHash}`.slice(0, 48);
        const cancelled = [];
        const cancelErrors = [];
        try {
          for (const o of recoveryBlockers) {
            try {
              await alp.call(this, 'DELETE', '/v2/orders/' + o.orderId);
              cancelled.push(o.orderId);
              await new Promise(r => setTimeout(r, 300));
            } catch (e) {
              cancelErrors.push({ orderId: o.orderId, error: e.message });
            }
          }

          if (cancelErrors.length > 0) throw new Error('cancel_blocker_failed: ' + JSON.stringify(cancelErrors).slice(0, 500));

          await new Promise(r => setTimeout(r, 900));
          let posNow = null;
          try { posNow = await alp.call(this, 'GET', '/v2/positions/' + encodeURIComponent(sym)); } catch (_) { posNow = null; }
          const qtyNow = posNow ? Math.abs(parseFloat(posNow.qty || 0)) : 0;
          if (!Number.isFinite(qtyNow) || qtyNow <= 0) {
            recoveryResult = { type: 'STOP_RECOVERY_POSITION_CLOSED_AFTER_CANCEL', sym, cancelled, recoveryKey, version: QTP_STOP_RECOVERY_VERSION };
          } else {
            const refreshedOrders = await alp.call(this, 'GET', '/v2/orders?status=all&limit=500&direction=desc&nested=true');
            const refreshedForSym = (refreshedOrders || []).filter(o => o.symbol === sym);
            const refreshedActiveStop = refreshedForSym.find(o =>
              String(o.side || '').toLowerCase() === missSide &&
              qtpIsStopType(o.type) &&
              qtpIsActiveOrderStatus(o.status) &&
              Math.max(0, (parseFloat(o.qty || 0) || 0) - (parseFloat(o.filled_qty || 0) || 0)) >= Math.max(0, qtyNow - 0.0001)
            );
            if (refreshedActiveStop) {
              recoveryResult = { type: 'STOP_RECOVERY_ALREADY_PROTECTED_AFTER_REFRESH', sym, stopOrderId: refreshedActiveStop.id, cancelled, recoveryKey, version: QTP_STOP_RECOVERY_VERSION };
            } else {
              const safeStop = isLong ? Math.min(missStop, r2(current * 0.995)) : Math.max(missStop, r2(current * 1.005));
              const stopResp = await retryAlp(this, 'POST', '/v2/orders', {
                symbol: sym,
                qty: String(qtyNow),
                side: missSide,
                type: 'stop',
                stop_price: String(safeStop),
                time_in_force: 'gtc',
                client_order_id: clientOrderId
              });
              state.trailState[sym] = { tier: 0, lastStopSet: safeStop, recovered: true, recoveryKey, recoveredAt: new Date().toISOString() };
              recoveryResult = {
                type: 'STOP_RECOVERY_REPLACED_BLOCKING_LIMIT_WITH_STOP',
                sym,
                side: isLong ? 'long' : 'short',
                qty: qtyNow,
                stopSide: missSide,
                stopPrice: safeStop,
                cancelled,
                stopOrderId: stopResp && stopResp.id,
                clientOrderId,
                recoveryKey,
                idempotency_key: recoveryKey,
                l12_fill_dedup_untouched: true,
                version: QTP_STOP_RECOVERY_VERSION
              };
            }
          }
        } catch (e) {
          recoveryResult = { type: 'STOP_RECOVERY_FAILED_REVIEW_REQUIRED', sym, error: e.message, cancelled, cancelErrors, recoveryKey, idempotency_key: recoveryKey, version: QTP_STOP_RECOVERY_VERSION };
          // Allow retry after 2 minutes if this attempt failed before a confirmed stop.
          state._stopRecoveryDedup[recoveryKey] = Date.now() - (13 * 60 * 1000);
        }
      }
    }

    if (recoveryResult && recoveryResult.type === 'STOP_RECOVERY_REPLACED_BLOCKING_LIMIT_WITH_STOP') {
      auditEvent.action = 'AUTO_RECOVERY_CANCEL_REPLACE_STOP_PLACED';
      auditEvent.requiresManualReview = false;
      auditEvent.recovery = recoveryResult;
      actions.push(auditEvent);
      actions.push(recoveryResult);
      skipped.push(sym + ' (blocked stop auto-recovered)');
      await tg.call(this, `🛡️ <b>STOP LOSS RECOVERY — ${sym}</b>
${isLong ? 'LONG' : 'SHORT'} ${recoveryResult.qty} shares
Cancelled blocking exit order(s): ${recoveryResult.cancelled.length}
New paper stop: <b>${recoveryResult.stopSide.toUpperCase()} ${recoveryResult.qty} @ $${recoveryResult.stopPrice}</b>
Order: ${recoveryResult.stopOrderId || recoveryResult.clientOrderId}
Mode: PAPER ONLY | ${QTP_STOP_RECOVERY_VERSION}`);
      console.warn(`[${QTP_STOP_RECOVERY_VERSION}] ${sym}: recovered blocked stop; stop=${recoveryResult.stopPrice}; order=${recoveryResult.stopOrderId}`);
      continue;
    }

    actions.push(auditEvent);
    if (recoveryResult) actions.push(recoveryResult);
    skipped.push(sym + ' (' + classification + ')');
    console.warn(`[TSM v2.1 AUDIT-SAFE] ${sym}: ${classification}; recovery=${recoveryResult ? recoveryResult.type : 'not_attempted'}; proposed stop $${missStop}; blockingOrders=${sameSideExitOrders.length}; pendingCancel=${pendingCancelExitOrders.length}`);

    const alertKey = `${sym}:${classification}:${Math.round(absQty * 10000) / 10000}:${missStop}:${recoveryResult ? recoveryResult.type : 'NO_RECOVERY'}`;
    if (state._missingStopAlerted[sym] !== alertKey) {
      state._missingStopAlerted[sym] = alertKey;
      const blockers = sameSideExitOrders.length
        ? sameSideExitOrders.map(o => `${o.side} ${o.type} ${o.qty} @ ${o.limitPrice || 'n/a'} (${o.status})`).join('; ')
        : 'none detected';
      await tg.call(this, `⚠️ <b>MISSING STOP — RECOVERY REVIEW</b>
${sym}: ${isLong ? 'LONG' : 'SHORT'} ${absQty} shares
Entry: $${entry.toFixed(2)} | Current: $${current.toFixed(2)}
Proposed stop: $${missStop.toFixed(2)} (${stopAdjusted ? 'adjusted' : '1.5×ATR'})
Classification: <b>${classification}</b>
Blocking exit orders: ${blockers}
Recovery result: <b>${recoveryResult ? recoveryResult.type : 'NOT_ATTEMPTED'}</b>
Action taken: <b>${recoveryResult && recoveryResult.type.includes('SKIPPED') ? 'NO ORDER PLACED' : 'REVIEW REQUIRED'}</b>
Mode: PAPER ONLY | ${QTP_STOP_RECOVERY_VERSION}`);
    }
    continue;
  }

  if (existingStop.type === 'trailing_stop') { skipped.push(sym + ' (native trail)'); continue; }

  const bars = barsData[sym];
  let atr = calcATR(bars);
  if (!atr || atr <= 0) atr = entry * 0.02;

  if (!state.trailState[sym]) { state.trailState[sym] = { tier: 0, lastStopSet: existingStop.stopPrice }; }
  const ts = state.trailState[sym];

  const BUF = 0.05;
  const t1_trigger = isLong ? entry + 1.5 * atr : entry - 1.5 * atr;
  const t1_stop = isLong ? r2(entry - BUF) : r2(entry + BUF);
  const t2_scaleout_trigger = isLong ? entry + 2.5 * atr : entry - 2.5 * atr;
  const t2_trigger = isLong ? entry + 3.0 * atr : entry - 3.0 * atr;
  const t2_stop = isLong ? r2(entry + 1.5 * atr) : r2(entry - 1.5 * atr);
  const t3_trigger = isLong ? entry + 4.5 * atr : entry - 4.5 * atr;
  const t3_stop = isLong ? r2(entry + 3.0 * atr) : r2(entry - 3.0 * atr);

  let newTier = ts.tier;
  let newStop = null;
  if (isLong) {
    if (current >= t3_trigger && ts.tier < 3) { newTier = 3; newStop = t3_stop; }
    else if (current >= t2_trigger && ts.tier < 2) { newTier = 2; newStop = t2_stop; }
    else if (current >= t1_trigger && ts.tier < 1) { newTier = 1; newStop = t1_stop; }
  } else {
    if (current <= t3_trigger && ts.tier < 3) { newTier = 3; newStop = t3_stop; }
    else if (current <= t2_trigger && ts.tier < 2) { newTier = 2; newStop = t2_stop; }
    else if (current <= t1_trigger && ts.tier < 1) { newTier = 1; newStop = t1_stop; }
  }

  // v1.8: SCALE-OUT CHECK — runs independently of tier transitions.
  // Fixes bug where auto-seeded positions at max tier never get their
  // scale-out sell because the tier transition block is never entered.
  if (SCALE_OUT_MODE && state.scaledOut[sym] && !state.scaledOut[sym].tier2Done) {
    const _t2s_trigger = isLong ? entry + 2.5 * atr : entry - 2.5 * atr;
    const _t2s_hit = isLong ? current >= _t2s_trigger : current <= _t2s_trigger;
    if (_t2s_hit) {
      const _soSide = isLong ? 'sell' : 'buy';
      const _wasAuto = state.scaledOut[sym].autoSeeded;
      let _soQty;
      if (_wasAuto) {
        _soQty = Math.floor(absQty / 2);
        if (_soQty < 1) _soQty = absQty;
      } else {
        _soQty = absQty;
      }
      try {
        // TSM_CONFIRMED_FILL_NOTIFY_PATCH_20260504
        // Safety: catch-up scale-outs must not queue market orders before regular open,
        // must not duplicate while a closing order is already open, and subscriber
        // "sold/profit locked" messages require confirmed Alpaca filled_qty > 0.
        if (!_tsmMarketOpen) {
          console.log('[TSM v2.2] ' + sym + ': Market closed — skipping catch-up scale-out');
          actions.push({ type: 'CATCH_UP_SCALE_OUT_SKIPPED_MARKET_CLOSED', sym, qty: _soQty, entry, current });
          continue;
        }
        const _existingCatchupExit = (openOrderMap[sym] || []).find(o =>
          o.side === _soSide && ['new','accepted','pending_new','partially_filled'].includes(String(o.status || '').toLowerCase())
        );
        if (_existingCatchupExit) {
          console.log('[TSM v2.2] ' + sym + ': existing closing order open — skipping duplicate catch-up scale-out');
          actions.push({ type: 'CATCH_UP_SCALE_OUT_SKIPPED_EXISTING_CLOSE_ORDER', sym, orderId: _existingCatchupExit.orderId, status: _existingCatchupExit.status });
          continue;
        }
        // Cancel existing stop first to free shares
        if (existingStop) {
          try { await alp.call(this, 'DELETE', '/v2/orders/' + existingStop.orderId); } catch(_) {}
          await new Promise(r => setTimeout(r, 300));
        }
        const _soOrder = await retryAlp(this, 'POST', '/v2/orders', {
          symbol: sym, qty: String(_soQty), side: _soSide,
          type: 'market', time_in_force: 'day'
        });
        await new Promise(r => setTimeout(r, 1200));
        let _soOrderNow = _soOrder || {};
        try {
          if (_soOrder && _soOrder.id) _soOrderNow = await alp.call(this, 'GET', '/v2/orders/' + _soOrder.id);
        } catch (_) {}
        const _soFilledQty = parseFloat(_soOrderNow.filled_qty || 0);
        const _soFillAvg = parseFloat(_soOrderNow.filled_avg_price || current || 0);
        const _soConfirmedFill = Number.isFinite(_soFilledQty) && _soFilledQty > 0;
        const _soBanked = isLong ? (_soFillAvg - entry) * (_soConfirmedFill ? _soFilledQty : _soQty) : (entry - _soFillAvg) * (_soConfirmedFill ? _soFilledQty : _soQty);
        if (_wasAuto && _soQty < absQty) {
          // First real sell — keep rest trailing
          const _soRemain = absQty - _soQty;
          if (_soConfirmedFill) {
            state.scaledOut[sym].autoSeeded = false;
            state.scaledOut[sym].qty = _soFilledQty;
            state.scaledOut[sym].price = _soFillAvg;
            state.scaledOut[sym].realT1Time = new Date().toISOString();
            console.log('[TRAIL v2.2] ' + sym + ': SCALE OUT confirmed — filled ' + _soFilledQty + '/' + _soQty + ' @ ~$' + _soFillAvg);
            await tg.call(this, '💰 <b>SCALE OUT — ' + sym + '</b>\nFilled ' + _soFilledQty + ' of ' + absQty + ' shares at ~$' + _soFillAvg.toFixed(2) + '\n<b>Banked: ~$' + _soBanked.toFixed(2) + '</b>\nRemaining target: ' + _soRemain + ' shares — trailing\n\n<i>Scale-Out v2.2 — confirmed fill</i>');
          } else {
            console.log('[TRAIL v2.2] ' + sym + ': catch-up scale-out submitted but not filled yet — suppressing sold/profit Telegram');
          }
          // Place new stop for target remaining qty. Existing pending market order reserves the scale-out qty.
          try {
            const _soStop = isLong ? r2(entry - 0.05) : r2(entry + 0.05);
            await retryAlp(this, 'POST', '/v2/orders', {
              symbol: sym, qty: String(_soRemain), side: _soSide === 'sell' ? 'sell' : 'buy',
              type: 'stop', stop_price: String(_soStop), time_in_force: 'gtc'
            });
          } catch(_) {}
          actions.push({ type: _soConfirmedFill ? 'CATCH_UP_SCALE_OUT_CONFIRMED' : 'CATCH_UP_SCALE_OUT_SUBMITTED_AWAITING_FILL', sym, requestedQty: _soQty, filledQty: _soFilledQty, remainQty: _soRemain, banked: _soConfirmedFill ? r2(_soBanked) : 0, entry, current, fillAvg: _soConfirmedFill ? _soFillAvg : null });
          // v2.2: Subscriber notification only for confirmed fill quantity
          if (_soConfirmedFill) await tgChannel.call(this, '💰 <b>' + sym + ' — PARTIAL SELL</b>\nFilled ' + _soFilledQty + ' shares at ~$' + _soFillAvg.toFixed(2) + '\nProfit locked: ~$' + _soBanked.toFixed(2) + '\nRemaining target: ' + _soRemain + ' shares — trailing stop active\n\nQuantum Trading System');
        } else {
          // Full exit
          if (_soConfirmedFill) {
            state.scaledOut[sym].tier2Done = true;
            state.scaledOut[sym].tier2Price = _soFillAvg;
            state.scaledOut[sym].tier2Time = new Date().toISOString();
            console.log('[TRAIL v2.2] ' + sym + ': FULL EXIT confirmed — filled ' + _soFilledQty + '/' + _soQty + ' @ ~$' + _soFillAvg);
            await tg.call(this, '🏁 <b>FULL EXIT — ' + sym + '</b>\nFilled ' + _soFilledQty + ' shares at ~$' + _soFillAvg.toFixed(2) + '\n<b>P&L: ~$' + _soBanked.toFixed(2) + '</b>\n\n<i>Scale-Out v2.2 — confirmed fill</i>');
            actions.push({ type: 'CATCH_UP_FULL_EXIT_CONFIRMED', sym, requestedQty: _soQty, filledQty: _soFilledQty, banked: r2(_soBanked), entry, current, fillAvg: _soFillAvg });
            await tgChannel.call(this, '🏁 <b>' + sym + ' — POSITION EXIT FILL</b>\nFilled ' + _soFilledQty + ' shares at ~$' + _soFillAvg.toFixed(2) + '\n<b>Total P&L: ~$' + _soBanked.toFixed(2) + '</b>\n\nQuantum Trading System');
          } else {
            console.log('[TRAIL v2.2] ' + sym + ': full-exit market order submitted but not filled yet — suppressing sold/profit Telegram');
            actions.push({ type: 'CATCH_UP_FULL_EXIT_SUBMITTED_AWAITING_FILL', sym, requestedQty: _soQty, filledQty: 0, entry, current });
          }
        }
        if (state._stopFailures) delete state._stopFailures[sym];
        continue; // Done with this position
      } catch (soErr) {
        console.error('[TRAIL v1.8] ' + sym + ': catch-up scale-out FAILED: ' + soErr.message);
      }
    }
  }

  if (!newStop || newTier === ts.tier) continue;

  try {
    // v2.0: Block stop adjustments outside market hours
    if (!_tsmMarketOpen) {
      console.log('[TSM v2.0] ' + sym + ': Market closed — skipping stop adjustment');
      continue;
    }
    // v1.7: Cancel-Retry-Rollback — no unprotected window
    // Step 1: Cancel old stop
    try {
      await alp.call(this, 'DELETE', '/v2/orders/' + existingStop.orderId);
      console.log(`[TRAIL v1.7] ${sym}: cancelled old stop ${existingStop.orderId}`);
    } catch (cancelErr) {
      // If cancel fails, position still has old stop — safe, just skip this cycle
      console.warn(`[TRAIL v1.7] ${sym}: cancel failed (${cancelErr.message}) — old stop intact, skipping`);
      continue;
    }
    await new Promise(r => setTimeout(r, 300));

    let remainQty = absQty;
    let scaledThisRun = false;

    // TIER 1 SCALE-OUT
    if (SCALE_OUT_MODE && newTier === 1 && !state.scaledOut[sym]) {
      const sellQty = Math.floor(absQty / 2);
      if (absQty <= 3) {
        state.scaledOut[sym] = { qty: 0, price: current, time: new Date().toISOString(), singleShare: true };
        console.log(`[TRAIL v1.7] ${sym}: small position (${absQty}sh) — skip Tier 1 sell, breakeven + Tier 2`);
        await tg.call(this, `🛡️ <b>TIER 1 — ${sym} (${absQty}sh)</b>
Small position — skip scale-out, stop raised to breakeven $${newStop.toFixed(2)}
Full exit at Tier 2 (entry + 2.5×ATR = $${r2(isLong ? entry + 2.5*atr : entry - 2.5*atr).toFixed(2)})
<i>Scale-Out v1.6</i>`);
        actions.push({ type: 'TIER1_SMALL_POS', sym, entry, current, newStop, tier2Target: r2(isLong ? entry + 2.5*atr : entry - 2.5*atr) });
      }
      if (sellQty >= 1 && absQty > 3) {
        const scaleOutSide = isLong ? 'sell' : 'buy';
        try {
          await alp.call(this, 'POST', '/v2/orders', { symbol: sym, qty: String(sellQty), side: scaleOutSide, type: 'market', time_in_force: 'day' });
          remainQty = absQty - sellQty;
          state.scaledOut[sym] = { qty: sellQty, price: current, time: new Date().toISOString() };
          scaledThisRun = true;
          const banked = isLong ? r2((current - entry) * sellQty) : r2((entry - current) * sellQty);
          console.log(`[TRAIL v1.7] ${sym}: SCALE OUT — sold ${sellQty}/${absQty} @ ~$${current} — banked ~$${banked}`);
          await tg.call(this, `💰 <b>SCALE OUT — ${sym}</b>
Sold ${sellQty} of ${absQty} shares (50%) at ~$${current.toFixed(2)}
<b>Banked: ~$${banked.toFixed(2)}</b> (${r2(banked / (entry * sellQty) * 100)}%)
Remaining: ${remainQty} shares — trailing with stop at $${newStop}

<i>Scale-Out Mode v1.6 — locking profits at Tier 1</i>`);
          // v1.9: Subscriber notification — scale out
          const _subScaleMsg = `💰 <b>${sym} — PARTIAL SELL (50%)</b>\nSold ${sellQty} of ${absQty} shares at ~$${current.toFixed(2)}\nProfit locked: ~$${banked.toFixed(2)} (${r2(banked / (entry * sellQty) * 100)}%)\nRemaining: ${remainQty} shares — trailing stop active\n\nQuantum Trading System`;
          try { await tgChannel.call(this, _subScaleMsg); } catch (_) {}
          actions.push({ type: 'SCALE_OUT', sym, side: isLong ? 'long' : 'short', soldQty: sellQty, remainQty, price: current, banked, entry, tier: newTier });
        } catch (scaleErr) {
          console.error(`[TRAIL v1.7] ${sym}: scale-out FAILED: ${scaleErr.message}`);
          remainQty = absQty;
        }
      }
    }

    // TIER 2 SCALE-OUT (with auto-seed awareness)
    if (SCALE_OUT_MODE && newTier >= 2 && state.scaledOut[sym] && !state.scaledOut[sym].tier2Done) {
      const t2ScaleHit = isLong ? current >= t2_scaleout_trigger : current <= t2_scaleout_trigger;
      if (t2ScaleHit) {
        const scaleOutSide = isLong ? 'sell' : 'buy';
        const wasAutoSeeded = state.scaledOut[sym].autoSeeded;
        let t2SellQty;
        if (wasAutoSeeded) {
          t2SellQty = Math.floor(remainQty / 2);
          if (t2SellQty < 1) t2SellQty = remainQty;
        } else {
          t2SellQty = remainQty;
        }
        try {
          await alp.call(this, 'POST', '/v2/orders', { symbol: sym, qty: String(t2SellQty), side: scaleOutSide, type: 'market', time_in_force: 'day' });
          const t2Banked = isLong ? r2((current - entry) * t2SellQty) : r2((entry - current) * t2SellQty);
          scaledThisRun = true;
          if (wasAutoSeeded && t2SellQty < remainQty) {
            remainQty = remainQty - t2SellQty;
            state.scaledOut[sym].autoSeeded = false;
            state.scaledOut[sym].qty = t2SellQty;
            state.scaledOut[sym].price = current;
            state.scaledOut[sym].realT1Time = new Date().toISOString();
            console.log(`[TRAIL v1.7] ${sym}: AUTO-SEED SCALE OUT — sold ${t2SellQty}/${absQty} @ ~$${current} (first real sell)`);
            await tg.call(this, `💰 <b>SCALE OUT — ${sym} (auto-seeded)</b>
Sold ${t2SellQty} of ${absQty} shares (50%) at ~$${current.toFixed(2)}
<b>Banked: ~$${t2Banked.toFixed(2)}</b>
Remaining: ${remainQty} shares — trailing with stop at $${newStop}

<i>Scale-Out v1.6 — catch-up sell (T1 was missed)</i>`);
            // v1.9: Subscriber notification — scale out (catch-up)
            const _subCatchMsg = `💰 <b>${sym} — PARTIAL SELL (50%)</b>\nSold ${t2SellQty} of ${absQty} shares at ~$${current.toFixed(2)}\nProfit locked: ~$${t2Banked.toFixed(2)}\nRemaining: ${remainQty} shares — trailing stop active\n\nQuantum Trading System`;
            try { await tgChannel.call(this, _subCatchMsg); } catch (_) {}
            actions.push({ type: 'AUTO_SEED_SCALE_OUT', sym, side: isLong ? 'long' : 'short', soldQty: t2SellQty, remainQty, price: current, banked: t2Banked, entry, tier: newTier });
          } else {
            const t1Banked = state.scaledOut[sym].qty * (isLong ? (state.scaledOut[sym].price - entry) : (entry - state.scaledOut[sym].price));
            const totalBanked = r2(t1Banked + t2Banked);
            state.scaledOut[sym].tier2Done = true;
            state.scaledOut[sym].tier2Price = current;
            state.scaledOut[sym].tier2Time = new Date().toISOString();
            remainQty = 0;
            console.log(`[TRAIL v1.7] ${sym}: FULL EXIT — sold remaining ${t2SellQty}sh @ ~$${current}`);
            await tg.call(this, `🏁 <b>FULL EXIT — ${sym}</b>
Sold remaining ${t2SellQty} shares at ~$${current.toFixed(2)}

📊 <b>Trade Summary</b>
  Tier 1: sold ${state.scaledOut[sym].qty}sh @ $${state.scaledOut[sym].price.toFixed(2)}
  Tier 2: sold ${t2SellQty}sh @ ~$${current.toFixed(2)}
  Entry:  $${entry.toFixed(2)}
  <b>Total P&L: ~$${totalBanked.toFixed(2)}</b>

<i>Scale-Out Mode v1.6 — position fully closed</i>`);
            // v1.9: Subscriber notification — full exit
            const _subExitMsg = `🏁 <b>${sym} — POSITION FULLY CLOSED</b>\nAll ${t2SellQty} shares sold at ~$${current.toFixed(2)}\n<b>Total P&L: ~$${totalBanked.toFixed(2)}</b>\n\nQuantum Trading System`;
            try { await tgChannel.call(this, _subExitMsg); } catch (_) {}
            actions.push({ type: 'FULL_EXIT', sym, side: isLong ? 'long' : 'short', exitPrice: current, totalBanked, entry, tier1: state.scaledOut[sym], tier: 2 });
          }
        } catch (exitErr) { console.error(`[TRAIL v1.7] ${sym}: Tier 2 exit FAILED: ${exitErr.message}`); }
      }
    }

    if (remainQty <= 0) { state.trailState[sym] = { tier: newTier, lastStopSet: newStop }; continue; }

    // v1.7: Place new stop with retry + rollback on failure
    const stopSide = isLong ? 'sell' : 'buy';
    let newOrder;
    try {
      newOrder = await retryAlp(this, 'POST', '/v2/orders', {
        symbol: sym, qty: String(remainQty), side: stopSide,
        type: 'stop', stop_price: String(newStop), time_in_force: 'gtc'
      });
      console.log(`[TRAIL v1.7] ${sym}: NEW stop at $${newStop} (Tier ${newTier}) qty=${remainQty} order=${newOrder.id}`);
      state.trailState[sym] = { tier: newTier, lastStopSet: newStop };
      // Reset failure counter on success
      if (state._stopFailures) delete state._stopFailures[sym];
    } catch (placeErr) {
      // ROLLBACK: new stop failed — reinstate old stop at previous price
      console.error(`[TRAIL v1.7] ${sym}: NEW stop FAILED after retries: ${placeErr.message}`);
      console.log(`[TRAIL v1.7] ${sym}: ROLLBACK — reinstating old stop at $${existingStop.stopPrice}`);
      try {
        await retryAlp(this, 'POST', '/v2/orders', {
          symbol: sym, qty: String(remainQty), side: stopSide,
          type: 'stop', stop_price: String(existingStop.stopPrice), time_in_force: 'gtc'
        });
        console.log(`[TRAIL v1.7] ${sym}: ROLLBACK SUCCESS — old stop reinstated at $${existingStop.stopPrice}`);
      } catch (rollbackErr) {
        // Both new and rollback failed — position is UNPROTECTED
        console.error(`[TRAIL v1.7] ${sym}: *** ROLLBACK ALSO FAILED *** — position UNPROTECTED`);
        // Track failures for circuit breaker
        if (!state._stopFailures) state._stopFailures = {};
        state._stopFailures[sym] = (state._stopFailures[sym] || 0) + 1;

        // Circuit breaker: 2+ failures → alert and pause
        const totalFailures = Object.values(state._stopFailures).reduce((a, b) => a + b, 0);
        if (totalFailures >= 2) {
          await tg.call(this,
            `⛔ <b>STOP REPLACEMENT CIRCUIT BREAKER</b>\n` +
            `${sym}: both new stop and rollback FAILED\n` +
            `Total stop failures this cycle: ${totalFailures}\n` +
            `<b>POSITION MAY BE UNPROTECTED</b>\n` +
            `Check Alpaca immediately and place stops manually.\n` +
            `<i>Trail Manager v1.7 — stop circuit breaker</i>`
          );
        }
      }
      actions.push({ sym, tier: newTier, error: 'Stop replacement failed: ' + placeErr.message, rollback: true });
      continue; // Skip to next position — don't send "trail raised" alert for a failed replacement
    }

    const tierLabels = ['Initial', 'Breakeven + Scale Out', 'Lock +1.5×ATR', 'Lock +3×ATR'];
    const gain = isLong ? r2(current - entry) : r2(entry - current);
    const gainPct = r2(gain / entry * 100);

    if (!scaledThisRun) {
      actions.push({ sym, tier: newTier, tierLabel: tierLabels[newTier], oldStop: existingStop.stopPrice, newStop, entry, current, atr: r2(atr), gain, gainPct });
    }
    if (!scaledThisRun) await tg.call(this, `🔄 <b>TRAIL STOP RAISED — ${sym}</b>
Tier ${newTier}: ${tierLabels[newTier]}
Entry: $${entry.toFixed(2)} → Current: $${current.toFixed(2)} (+${gainPct}%)
Old stop: $${existingStop.stopPrice.toFixed(2)} → <b>New: $${newStop.toFixed(2)}</b>
ATR: $${r2(atr)} | Gain locked: $${gain.toFixed(2)}/share`);

  } catch (e) {
    console.error(`[TRAIL v1.7] ${sym}: FAILED to update stop:`, e.message);
    actions.push({ sym, tier: newTier, error: e.message });
  }
}

if (actions.length === 0 && autoSeeded.length === 0) {
  console.log(`[TRAIL v1.7] No trail adjustments needed. Skipped: ${skipped.join(', ')}`);
}

const allResults = [...fillAlerts, ...qtpScalpEodActions, ...actions];
if (autoSeeded.length > 0) allResults.push({ json: { type: 'AUTO_SEED', symbols: autoSeeded, count: autoSeeded.length } });
if (__TEST) allResults.push({ json: { type: 'TSM_TEST_REPORT', scenario: 'qtp-tsm-synthetic-v1', writes: __testWrites, telegrams: __testTg, version: 'QTP_TSM_CREDENTIAL_MIGRATION_v2.0_20260710' } });
return allResults.length > 0 ? allResults.map(a => a.json ? a : { json: a }) : [{ json: { message: 'No adjustments or fills', checked: positions.length, skipped, fills: 0, autoSeeded: 0 } }];