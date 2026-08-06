
// QTP Scalp Exit Watcher — PAPER ONLY v1.0
// Purpose: monitor open scalp positions for signal/status degradation and controlled paper exits.
// Hard constraints: paper Alpaca only; no live endpoint; no Databricks; no Google Sheets; idempotent; no duplicate closes.

const rows = $input.all().map(i => i.json || {});
const state = $getWorkflowStaticData('global');
if (!state.scalpExitWatcher) state.scalpExitWatcher = {};
const runId = `scalp_exit_watch_${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0,14)}`;

function num(v, fallback = 0) {
  if (v === undefined || v === null || String(v).trim() === '') return fallback;
  const n = Number(String(v).replace(/[$,%]/g, '').trim());
  return Number.isFinite(n) ? n : fallback;
}
function txt(v, fallback = '') {
  if (v === undefined || v === null) return fallback;
  const s = String(v).trim();
  return s ? s : fallback;
}
function upper(v) { return txt(v).toUpperCase(); }
function inMarketHoursNow() {
  const now = new Date();
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(now).reduce((a, x) => (a[x.type] = x.value, a), {});
  const h = Number(p.hour), m = Number(p.minute);
  return !['Sat','Sun'].includes(p.weekday) && ((h > 9 || (h === 9 && m >= 32)) && (h < 15 || (h === 15 && m <= 55)));
}

const ALPACA_KEY = $vars.ALPACA_API_KEY || $vars.ALPACA_KEY_ID || '';
const ALPACA_SECRET = $vars.ALPACA_SECRET_KEY || $vars.ALPACA_API_SECRET || $vars.ALPACA_SECRET || '';
const ALPACA_BASE = 'https://paper-api.alpaca.markets'; // hardcoded paper-only
const EXECUTE_PAPER_CLOSES = true; // paper-only execution is enabled by user approval; live remains impossible.
const MAX_CLOSES_PER_RUN = 4;
// QTP_SWING_MODE_v1_20260720 (PO-authorized swing conversion): when ON (default),
// the two SCALP TIME-STOPS (60m-losing, 90m-flat/red) are DISABLED so a protected,
// intact position is given time to reach its multi-day target and carries overnight
// under its GTC stop. ALL genuine protective exits remain (opposite-signal,
// explicit-exit, chart-adverse-with-loss, bias-lost-with-loss, -1.2% max-adverse,
// unprotected-emergency). Reversible: set $vars.QTP_SWING_MODE='false'.
const SWING_MODE = String($vars.QTP_SWING_MODE ?? 'true').toLowerCase() !== 'false';
const now = Date.now();
const marketOpen = inMarketHoursNow();

async function alpaca(method, path) {
  if (!ALPACA_KEY || !ALPACA_SECRET) throw new Error('Missing Alpaca paper vars');
  if (!ALPACA_BASE.includes('paper-api.alpaca.markets')) throw new Error('Hard stop: non-paper Alpaca base blocked');
  return await this.helpers.httpRequest({
    method,
    url: ALPACA_BASE + path,
    headers: { 'APCA-API-KEY-ID': ALPACA_KEY, 'APCA-API-SECRET-KEY': ALPACA_SECRET },
    json: true,
    timeout: 30000,
  });
}

const decisions = [];
let executed = 0;

for (const r of rows) {
  const symbol = upper(r.symbol);
  const side = upper(r.position_side);
  const qty = Math.abs(num(r.quantity));
  const pnlPct = num(r.unrealized_pnl_pct, 0);
  const pnl = num(r.unrealized_pnl, 0);
  const holdMin = num(r.hold_minutes, 0);
  const protection = upper(r.protection_status);
  const protectedQty = num(r.protected_qty, 0);
  const unprotectedQty = num(r.unprotected_qty, 0);
  const stopCount = num(r.protective_stop_count, 0);
  const limitCount = num(r.exit_limit_count, 0);
  const recentExitEvents = num(r.recent_exit_event_count, 0);
  const signalDir = upper(r.signal_direction);
  const auditSide = upper(r.audit_side);
  const gate = upper(r.gate_decision);
  const entryTs = txt(r.entry_ts);
  const idemKey = `scalp_exit:${symbol}:${entryTs || 'no_entry'}:${side}`;
  const last = state.scalpExitWatcher[idemKey] || {};
  const dedupBlocked = last.ts && (now - last.ts) < 30 * 60 * 1000;

  const isLong = side === 'LONG';
  const isShort = side === 'SHORT';
  const oppositeSignal =
    (isLong && ['SHORT','SELL','BEARISH'].includes(signalDir)) ||
    (isShort && ['LONG','BUY','BULLISH'].includes(signalDir)) ||
    (isLong && ['SELL','SHORT'].includes(auditSide)) ||
    (isShort && ['BUY','LONG'].includes(auditSide));
  const explicitExit = gate.includes('STAND ASIDE') || gate.includes('STAND_ASIDE') || gate.includes('EXIT') || gate.includes('SELL_TO_CLOSE') || gate.includes('BUY_TO_COVER') || gate.includes('CLOSE');
  const chartBearishForLong = isLong && gate.includes('CHART_VISION_TREND=BEARISH') && pnlPct <= -0.0025;
  const chartBullishForShort = isShort && gate.includes('CHART_VISION_TREND=BULLISH') && pnlPct <= -0.0025;
  const biasLost = gate.includes('BIAS=BIAS_BLOCK') && pnlPct <= -0.0025;
  const timeStopLosing = !SWING_MODE && holdMin >= 60 && pnlPct <= -0.0075;
  const timeStopFlatOrRed = !SWING_MODE && holdMin >= 90 && pnlPct <= 0;
  const maxAdverseMove = pnlPct <= -0.012;
  const unprotectedEmergency = protection !== 'FULLY_PROTECTED' || unprotectedQty > 0 || stopCount < 1;

  const reasons = [];
  if (oppositeSignal) reasons.push('OPPOSITE_SIGNAL_AFTER_ENTRY');
  if (explicitExit) reasons.push('EXPLICIT_EXIT_OR_STAND_ASIDE_AFTER_ENTRY');
  if (chartBearishForLong || chartBullishForShort) reasons.push('CHART_VISION_ADVERSE_WITH_LOSS');
  if (biasLost) reasons.push('BIAS_LOST_WITH_LOSS');
  if (timeStopLosing) reasons.push('SCALP_TIME_STOP_LOSING_60M');
  if (timeStopFlatOrRed) reasons.push('SCALP_TIME_STOP_FLAT_OR_RED_90M');
  if (maxAdverseMove) reasons.push('SCALP_MAX_ADVERSE_MOVE');
  if (unprotectedEmergency) reasons.push('UNPROTECTED_OR_STOP_MISSING');

  let action = 'MONITOR';
  if (!marketOpen) action = 'HOLD_MARKET_CLOSED';
  else if (!symbol || qty <= 0 || !['LONG','SHORT'].includes(side)) action = 'SKIP_INVALID_POSITION';
  else if (recentExitEvents > 0) action = 'SKIP_RECENT_EXIT_EVENT';
  else if (dedupBlocked) action = 'SKIP_IDEMPOTENCY_WINDOW';
  else if (reasons.length > 0) action = 'PAPER_CLOSE_RECOMMENDED';

  const decision = {
    run_id: runId,
    checked_at: new Date().toISOString(),
    symbol,
    position_side: side,
    quantity: qty,
    entry_ts: entryTs,
    hold_minutes: holdMin,
    current_price: num(r.current_price, null),
    avg_entry_price: num(r.avg_entry_price, null),
    unrealized_pnl: pnl,
    unrealized_pnl_pct: pnlPct,
    protection_status: protection,
    protected_qty: protectedQty,
    unprotected_qty: unprotectedQty,
    protective_stop_count: stopCount,
    exit_limit_count: limitCount,
    recent_exit_event_count: recentExitEvents,
    latest_signal_direction: signalDir,
    latest_audit_side: auditSide,
    action,
    reasons,
    idempotency_key: idemKey,
    swing_mode: SWING_MODE,
    paper_only: true,
    live_alpaca_trading_allowed: false,
    alpaca_endpoint: 'paper-api.alpaca.markets',
  };

  if (action === 'PAPER_CLOSE_RECOMMENDED' && EXECUTE_PAPER_CLOSES && executed < MAX_CLOSES_PER_RUN) {
    try {
      const openOrders = await alpaca.call(this, 'GET', `/v2/orders?status=open&symbols=${encodeURIComponent(symbol)}&nested=true`);
      const orders = Array.isArray(openOrders) ? openOrders : [];
      for (const o of orders) {
        if (o && o.id) {
          try { await alpaca.call(this, 'DELETE', `/v2/orders/${encodeURIComponent(o.id)}`); } catch (e) {}
        }
      }
      const closeResp = await alpaca.call(this, 'DELETE', `/v2/positions/${encodeURIComponent(symbol)}?percentage=100`);
      decision.action = 'PAPER_CLOSE_SUBMITTED';
      decision.alpaca_close_status = txt(closeResp.status, 'SUBMITTED');
      decision.alpaca_close_order_id = txt(closeResp.id);
      decision.cancelled_open_order_count = orders.length;
      state.scalpExitWatcher[idemKey] = { ts: now, action: decision.action, symbol };
      executed += 1;
    } catch (e) {
      decision.action = 'PAPER_CLOSE_FAILED_NEEDS_REVIEW';
      decision.error = String(e?.message || e).slice(0, 1000);
      state.scalpExitWatcher[idemKey] = { ts: now, action: decision.action, symbol };
    }
  } else if (action === 'PAPER_CLOSE_RECOMMENDED') {
    decision.action = EXECUTE_PAPER_CLOSES ? 'PAPER_CLOSE_DEFERRED_MAX_PER_RUN' : 'DRY_RUN_RECOMMEND_CLOSE';
  }

  decisions.push(decision);
}

return decisions.map(d => ({ json: d }));
