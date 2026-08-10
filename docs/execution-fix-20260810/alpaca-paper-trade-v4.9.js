// Alpaca Paper Trade v4.9 (EX-C1/C2/C3 execution fix — 2026-08-10) — TE-C4 existing-position guard — notional cap + safety clamps — Position Sizing + Native Bracket Orders + Slip-Proof Stops
//
// ═══ v4.9, 2026-08-10 — the execution fix (Conclave ruling of 2026-08-10) ═══
// Finding: entry slippage was $1,288.68 of a $1,693.75 realized loss (76.1%), concentrated
// 27x in the first ten minutes, and the guard that existed to prevent it (TE-C3) was
// measuring the wrong price — its `fresh` verdicts were ANTI-correlated with actual harm.
// The pre-flight of 2026-08-10 falsified the proposed fix (swap to /quotes/latest): this
// account's data tier is IEX-only, `sip_available:false`, and 7 of 10 probed symbols —
// including every mid-cap QTP actually trades — showed 5-12% spreads with last prints up
// to 36 minutes stale. There is no usable reference price to be had on this feed, at any
// endpoint. So the fix cannot be "measure better"; it has to be "bound what you pay".
//
//   EX-C1  Marketable-LIMIT entry with a hard slippage cap (default 0.30%, derived from
//          the measured 48-entry distribution — the point where the filled population pays
//          ~zero net slippage while the skipped population is clearly loss-making).
//          Replaces the unbounded market order. The broker, not a guard, now enforces it.
//   EX-C2  Fill poll + no-fill cancel. Brackets forbid IOC/FOK (day|gtc only), so the
//          IOC semantic is emulated: poll ~12s, then ZERO fill -> cancel (safe: no
//          position exists), PARTIAL fill -> do NOT cancel a bracket (Alpaca cancels the
//          whole group, which would strip protection from the shares already filled).
//   EX-C3  Fill-anchored protective stop via PATCH (atomic replace, no naked window) +
//          execution-regime tagging so the long-book rebuild can be measured pre/post fix.
//
// Every Alpaca behaviour relied on here was measured, not assumed — probe execution
// 545502, 2026-08-10, docs/execution-fix-20260810/PROBE-ORDER-STATE-RESULT.md.
// Revert: set n8n variable QTP_ENTRY_LIMIT_CAP_ACTIVE=0 (no republish). NOTE THE FOOTGUN —
// this block FAILS CLOSED, so DELETING the variable does not revert it; it must be set to 0.
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

// ── APT v4.9 EX-C1/C2/C3 config ──────────────────────────────────────────
// FAIL-CLOSED: absent/blank variable => cap ACTIVE. Only the literal '0' turns it off.
const _exCapActive = String(($vars && $vars.QTP_ENTRY_LIMIT_CAP_ACTIVE) !== undefined && $vars.QTP_ENTRY_LIMIT_CAP_ACTIVE !== '' ? $vars.QTP_ENTRY_LIMIT_CAP_ACTIVE : '1') !== '0';
// Cap in PERCENT. 0.30 derived from the measured 48-entry / 30-day distribution:
//   cap    fills   fill rate   slippage paid on filled   P&L of the trades it skips
//   0.25%  33/48   68.8%       -$78.56                   -$1,018.88
//   0.30%  35/48   72.9%       -$20.00                   -$915.65   <- chosen
//   0.40%  39/48   81.3%       +$117.45                  -$312.04
//   0.50%  41/48   85.4%       +$212.23                  +$4.50
// 0.30% is where the filled book pays ~zero net slippage while what it turns away is
// still clearly loss-making. Bounded to (0, 2%] so a fat-fingered variable cannot
// silently restore unbounded slippage.
const _exCapPct = (function () {
  const raw = Number(($vars && $vars.QTP_ENTRY_LIMIT_CAP_PCT) || 0.30);
  return (Number.isFinite(raw) && raw > 0 && raw <= 2.0) ? raw / 100 : 0.0030;
})();
const r2v49 = n => Math.round(n * 100) / 100;
const _exPollMs     = 1500;
const _exPollTries  = 8;        // ~12s, then decide
// E2 target 1.15%, NOT 1.20%. The Trailing Stop Manager classifies a held bracket stop leg
// as UNPROTECTED_STOP_TOO_WIDE at |stop-entry|/entry > 1.20% and responds by cancelling it
// and forcing a 0.9% stop — which is what noise-killed WST on 08-10. Cent-rounding puts a
// 1.20% target on both sides of that line (ALGN 08-07 landed at 1.2003% against its signal
// and escaped only because its fill happened to be favourable). 1.15% sits provably inside.
const _exStopTargetPct = 0.0115;
const _exStopTsmBar    = 0.0119;
const _exRegime = 'EXEC_V49_LIMIT_CAP';

// GET an order (safe read). Harness never touches the broker.
const _exGetOrder = async (orderId) => {
  const r = await this.helpers.httpRequest({
    method: 'GET', url: BASE + '/v2/orders/' + encodeURIComponent(orderId) + '?nested=true',
    headers: HDR, json: true, timeout: 5000
  });
  return r;
};
// EX-C2 poll. Emulates IOC, which order_class:'bracket' does not permit.
// Returns one of: FILLED | PARTIAL | NO_FILL | TERMINAL_NO_FILL | UNREADABLE | HARNESS_SKIP.
// UNREADABLE is deliberately NOT folded into NO_FILL. "The order did not fill" and "we never
// got a readable answer about the order" demand opposite actions: the first is safe to
// cancel, the second must never be cancelled and must never be reported as a skip, because
// the order may in fact be filled and reporting a skip would put a real position outside the
// ledger — the exact divergence class the H4/H5 reconciler exists to catch.
const _exPollFill = async (orderId, wantQty) => {
  if (_aptHarness) return { outcome: 'HARNESS_SKIP', filledQty: wantQty, fillPrice: null, order: null, polls: 0, reads: 0 };
  let last = null, reads = 0, lastErr = null;
  for (let i = 0; i < _exPollTries; i++) {
    await new Promise(r => setTimeout(r, _exPollMs));
    try { last = await _exGetOrder(orderId); reads++; }
    catch (e) { lastErr = String((e && e.message) || e).slice(0, 160); continue; }
    const st = String((last && last.status) || '').toLowerCase();
    const fq = Number((last && last.filled_qty) || 0);
    if (st === 'filled' || fq >= wantQty) {
      return { outcome: 'FILLED', filledQty: fq, fillPrice: Number(last.filled_avg_price || 0) || null, order: last, polls: i + 1, reads };
    }
    if (['canceled', 'expired', 'rejected', 'done_for_day', 'suspended'].includes(st)) {
      return { outcome: fq > 0 ? 'PARTIAL' : 'TERMINAL_NO_FILL', filledQty: fq, fillPrice: Number((last && last.filled_avg_price) || 0) || null, order: last, polls: i + 1, reads };
    }
  }
  if (reads === 0) return { outcome: 'UNREADABLE', filledQty: 0, fillPrice: null, order: null, polls: _exPollTries, reads: 0, err: lastErr };
  const fq = Number((last && last.filled_qty) || 0);
  return { outcome: fq > 0 ? 'PARTIAL' : 'NO_FILL', filledQty: fq,
           fillPrice: Number((last && last.filled_avg_price) || 0) || null, order: last, polls: _exPollTries, reads };
};
const _exCancelOrder = async (orderId) => {
  if (_aptHarness) return { ok: true, harness: true };
  try {
    await this.helpers.httpRequest({ method: 'DELETE', url: BASE + '/v2/orders/' + encodeURIComponent(orderId), headers: HDR, json: true, timeout: 5000 });
    return { ok: true };
  } catch (e) { return { ok: false, err: String((e && e.message) || e).slice(0, 200) }; }
};
// EX-C3 stop geometry, anchored to the price actually paid.
const _exFillStop = (fill, long) => {
  let s = long ? r2v49(fill * (1 - _exStopTargetPct)) : r2v49(fill * (1 + _exStopTargetPct));
  for (let i = 0; i < 60; i++) {
    if (!(Math.abs(s - fill) / fill > _exStopTsmBar)) break;
    const n = r2v49(long ? s + 0.01 : s - 0.01);
    if ((long && n >= fill) || (!long && n <= fill)) break;   // never cross the fill
    s = n;
  }
  return s;
};
// PATCH = atomic replace. The probe (execution 545502) proved the broker returns a NEW
// order id and marks the old leg 'replaced' -> any stored slId goes STALE and must be
// re-recorded. The TSM is unaffected: it enumerates live legs from
// /v2/orders?status=all&nested=true and 'replaced' is not in its active-status list.
const _exPatchStop = async (legId, newStop) => {
  if (_aptHarness) return { ok: true, harness: true, id: legId, stop_price: String(newStop) };
  try {
    const r = await this.helpers.httpRequest({
      method: 'PATCH', url: BASE + '/v2/orders/' + encodeURIComponent(legId), headers: HDR, json: true,
      body: JSON.stringify({ stop_price: String(newStop) }), timeout: 6000
    });
    return { ok: true, id: (r && r.id) || legId, stop_price: (r && r.stop_price) || null, status: (r && r.status) || null };
  } catch (e) {
    const _d = _alpacaErrDetail(e);
    return { ok: false, err: String((e && e.message) || e).slice(0, 200), http: _d.status, body: _d.body };
  }
};

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

// ── TE-C3 v4.6, DEMOTED TO TELEMETRY BY v4.9 EX-C1 ────────────────────────
// What this block used to do: fetch /trades/latest, re-anchor `price` to it, and REJECT
// above 2% apparent slip. What it actually did: compare one stale number to another.
// `intended_entry` is byte-equal to the TradingView payload (a prior bar); the IEX last
// print on QTP's mid-caps is minutes-to-tens-of-minutes old (WST 19.6 min, ALGN 36 min,
// measured 2026-08-10). Two stale numbers agreed and the guard called the agreement
// freshness — 45 trades cleared `fresh`, 7 of them breaching its own 0.5% line, while the
// 3 it flagged `fresh_warn` had BETTER fills. Its verdicts were anti-correlated with harm.
//
// Under EX-C1 the cap is enforced by the limit price at the broker, on the ACTUAL fill,
// which strictly dominates the old 2% reject: >0.30% is now impossible rather than merely
// detected-after-the-fact against an unusable reference. So the fetch is kept for its
// telemetry value (the slippage analysis reads alpaca_fresh_price / alpaca_slip_pct) but
// it no longer moves `price` and no longer rejects.
// When _exCapActive is false the ORIGINAL v4.6 behaviour is restored exactly, so the
// revert flag is a true revert and not a third, untested code path.
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
      if (absSlip > 0.02 && !_exCapActive) {
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
      if (!_exCapActive) price = fresh_price;   // v4.9: telemetry only while the cap is active
      anchor_source = _exCapActive
        ? (absSlip > 0.005 ? 'signal_capped_warn' : 'signal_capped')
        : (absSlip > 0.005 ? 'fresh_warn' : 'fresh');
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

// QTP_ENTRY_STOP_CLAMP_v1_20260806 (gov 189): entry stops were placed at raw ATR*mult
// (3-6% on volatile names) while the TSM enforces max 1.2% — every wide entry armed the
// TSM cancel/replace recovery (naked-window class: WRB 13:45Z / APA 14:15Z 2026-08-06).
// Clamp the bracket stop distance to the same 1.2% the TSM enforces so entry and manager
// agree; qty sizing is %-of-portfolio and unaffected. Mirror: lib/entry/stop_clamp.js
const MAX_ENTRY_STOP_PCT = 0.012;
const _rawStopDist = atr * SL_MULT;
const _stopDist = Math.min(_rawStopDist, price * MAX_ENTRY_STOP_PCT);
if (_stopDist < _rawStopDist) console.log('[APT STOP-CLAMP v1] ' + ticker + ': ATR stop ' + r2(_rawStopDist) + ' (' + (Math.round(_rawStopDist / price * 10000) / 100) + '%) clamped to 1.2% = ' + r2(_stopDist));
const stopPrice = isLong ? r2(price - _stopDist) : r2(price + _stopDist);

// ── Fix 2: Slip-proof stop buffer — max($0.10, 0.1% of price) ────────────
// Old: flat $0.05 — worthless in any fast move (RDDT gapped $4.91 past it)
// New: dynamic buffer, always meaningful relative to stock price
const slipBuffer = r2(Math.max(0.10, price * (vol ? 0.002 : 0.001)));
const stopLimit  = isLong ? r2(stopPrice - slipBuffer) : r2(stopPrice + slipBuffer);
// ─────────────────────────────────────────────────────────────────────────────

const tpPrice = isLong
  ? r2(price + atr * (vol ? 2.0 : 3.0))
  : r2(price - atr * (vol ? 2.0 : 3.0));

// ── APT v4.9 EX-C1: the capped marketable limit ──────────────────────────
// Anchored to the SIGNAL price, deliberately. The 0.30% cap was derived from the measured
// (fill - signal)/signal distribution, and `intended_entry` in trade_ledger is the signal
// price — so this is the one anchor under which the cap means what the analysis said it
// means. Anchoring to the IEX print would put the falsified reference back on the money path.
const _exLimitPx = isLong ? r2(signal_price * (1 + _exCapPct)) : r2(signal_price * (1 - _exCapPct));
// FAIL-CLOSED. If the cap is active but a usable limit cannot be computed we refuse the
// trade; we never silently fall back to an unbounded market order, because that failure
// mode is invisible — it looks exactly like a normal fill until the month's P&L is counted.
if (_exCapActive && !(_exLimitPx > 0)) {
  console.error('[APT v4.9 EX-C1] BLOCK ' + ticker + ' — cap active but no usable limit price (signal_price=' + signal_price + ')');
  return [{ json: { ...prev,
    alpaca_status: 'BLOCKED_EXEC_CAP', alpaca_reason: 'EX-C1: cap active but limit price uncomputable — refusing to fall back to a market order',
    alpaca_signal_price: signal_price, alpaca_exec_regime: _exRegime, alpaca_exec_cap_pct: _exCapPct * 100,
    alpaca_bracket_v: '4.9' } }];
}
if (_exCapActive) console.log('[APT v4.9 EX-C1] ' + ticker + ' ' + side + ' limit=' + _exLimitPx + ' = signal ' + signal_price + ' ' + (isLong ? '+' : '-') + (_exCapPct * 100).toFixed(2) + '% cap');

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
      // v4.9 EX-C1: capped marketable limit on every path. TIF 'day' — a capped limit that
      // has not filled inside the poll window is cancelled below, so gtc would only leave a
      // stale order to fill hours later at a price nobody decided on.
      body: JSON.stringify(_exCapActive
        ? { ...(_qetEntryCoid?{client_order_id:_qetEntryCoid}:{}), symbol: ticker, qty: String(qty), side, type: 'limit', time_in_force: 'day', limit_price: String(_exLimitPx.toFixed(2)), ...(__aptIsExt ? { extended_hours: true } : {}) }
        : (__aptIsExt ? { ...(_qetEntryCoid?{client_order_id:_qetEntryCoid}:{}), symbol: ticker, qty: String(qty), side, type: 'limit', time_in_force: 'day', limit_price: String(Number(price).toFixed(2)), extended_hours: true } : { ...(_qetEntryCoid?{client_order_id:_qetEntryCoid}:{}), symbol: ticker, qty: String(qty), side, type: 'market', time_in_force: 'gtc' })),
      timeout: 8000
    }));
  } catch (err) {
    const _d = _alpacaErrDetail(err);
    console.error('[APT v4.4] Entry FAILED:', err.message, 'status:', _d.status, 'body:', _d.body);
    return [{ json: { ...prev, alpaca_status: 'ERROR', alpaca_error: err.message, alpaca_http_status: _d.status, alpaca_error_body: _d.body, alpaca_failed_stage: 'volatile_entry' } }];
  }
  const entryId = entryResp?.id;
  console.log(`[APT v4.4] VOL Entry: ${ticker} ${side} qty=${qty} id=${entryId}`);

  // ── v4.9 EX-C2 (volatile path) ────────────────────────────────────────────
  // The old code waited a flat 1200ms and then placed a trailing stop for the FULL qty
  // regardless of whether anything had filled. Under a market order that was merely
  // sloppy; under a capped limit it would be a live defect — an unfilled entry would leave
  // a naked trailing stop for shares that do not exist. Poll, then size protection to what
  // was actually filled.
  const _exVol = await _exPollFill(entryId, qty);
  const _exVolFilled = _exVol.outcome === 'HARNESS_SKIP' ? qty : _exVol.filledQty;
  if (_exCapActive && _exVol.outcome === 'UNREADABLE') {
    // Unknown fill state and NO bracket on this path, so there is also no protective leg to
    // fall back on. Do not cancel (it may have filled) and do not place a trailing stop for
    // a quantity we cannot verify. Hand it to recovery, which is what that machinery is for.
    console.error('[APT v4.9 EX-C2] ' + ticker + ' VOL fill state UNKNOWN — all status reads failed. Flagging for stop recovery.');
    return [{ json: { ...prev,
      alpaca_status: 'ERROR_FILL_STATE_UNKNOWN',
      alpaca_reason: 'EX-C2 (volatile): entry submitted but every order-status read failed — fill state unknown; no trailing stop placed, flagged for recovery',
      alpaca_entry_id: entryId, alpaca_limit_price: _exLimitPx, alpaca_poll_outcome: 'UNREADABLE',
      alpaca_poll_error: _exVol.err || null, alpaca_needs_reconciliation: true,
      _needs_stop_recovery: true, _stop_error: 'fill state unknown after ' + _exVol.polls + ' failed reads',
      alpaca_qty: qty, alpaca_side: side, alpaca_is_volatile: true,
      alpaca_signal_price: signal_price, alpaca_fresh_price: fresh_price, alpaca_slip_pct: slip_pct,
      alpaca_anchor_used: anchor_source, alpaca_exec_regime: _exRegime, alpaca_exec_cap_pct: _exCapPct * 100,
      alpaca_bracket_v: '4.9' } }];
  }
  if (_exCapActive && _exVolFilled <= 0) {
    const _c = await _exCancelOrder(entryId);
    console.log('[APT v4.9 EX-C2] ' + ticker + ' VOL no fill within cap ' + (_exCapPct*100).toFixed(2) + '% — entry cancelled (' + (_c.ok ? 'ok' : _c.err) + ')');
    return [{ json: { ...prev,
      alpaca_status: 'SKIPPED_NO_FILL_WITHIN_CAP',
      alpaca_reason: 'EX-C1/C2: limit ' + _exLimitPx + ' (' + (_exCapPct*100).toFixed(2) + '% cap) did not fill within ' + ((_exPollMs*_exPollTries)/1000) + 's — entry cancelled, no position taken',
      alpaca_entry_id: entryId, alpaca_limit_price: _exLimitPx, alpaca_cancelled: _c.ok,
      alpaca_poll_outcome: _exVol.outcome, alpaca_filled_qty: 0,
      alpaca_signal_price: signal_price, alpaca_fresh_price: fresh_price, alpaca_slip_pct: slip_pct,
      alpaca_anchor_used: anchor_source, alpaca_exec_regime: _exRegime, alpaca_exec_cap_pct: _exCapPct * 100,
      alpaca_is_volatile: true, alpaca_bracket_v: '4.9' } }];
  }
  // Partial on the volatile path: there is NO bracket group here, just a standalone limit,
  // so cancelling the remainder damages nothing — and it must be cancelled, because a later
  // fill would sit unprotected until the next 15-minute TSM sweep. (The bracket path below
  // does the OPPOSITE, and deliberately so: there, cancel kills the whole OCO group.)
  if (_exCapActive && _exVol.outcome === 'PARTIAL') {
    const _c = await _exCancelOrder(entryId);
    console.log('[APT v4.9 EX-C2] ' + ticker + ' VOL PARTIAL ' + _exVolFilled + '/' + qty + ' — remainder cancelled (' + (_c.ok ? 'ok' : _c.err) + '), protecting filled shares only');
  }
  const _exVolQty = Math.max(1, Math.floor(_exVolFilled) || qty);

  let slId = null, tpId = null;
  try {
    const sl = await retry(() => _aptOrderPost({
      method: 'POST', url: BASE + '/v2/orders', headers: HDR, json: true,
      body: JSON.stringify({
        symbol: ticker, qty: String(_exVolQty), side: closeSide,
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
    entryId, slId, tpId: null, isVolatile: true, side, qty: _exVolQty,
    entryPrice: _exVol.fillPrice || price, stopPrice: 'trail:' + TRAIL_PCT + '%', tpPrice: null,
    attachedAt: new Date().toISOString(), bracketType: 'trailing'
  };

  return [{ json: {
    ...prev,
    alpaca_status:      entryResp?.status || 'submitted',
      alpaca_qty:         _exVolQty,
      alpaca_side:        side,
      // v4.9: was (qty * fresh_price) — fresh_price is null whenever the data fetch fails,
      // which silently wrote notional 0. Use the price actually paid, else the anchor.
      alpaca_notional:    Number((_exVolQty * (_exVol.fillPrice || price)).toFixed(2)),
    alpaca_entry_id:    entryId,
    alpaca_sl_id:       slId,
    alpaca_tp_id:       null,
    alpaca_fill_price:   _exVol.fillPrice || null,
    alpaca_filled_qty:   _exVolFilled,
    alpaca_poll_outcome: _exVol.outcome,
    alpaca_limit_price:  _exCapActive ? _exLimitPx : null,
    alpaca_exec_regime:  _exRegime,
    alpaca_exec_cap_pct: _exCapPct * 100,
    alpaca_stop_price:  'trail:' + TRAIL_PCT + '%',
    alpaca_tp_price:    null,
    alpaca_is_volatile: true,
    alpaca_atr_used:    atr,
    alpaca_signal_price: signal_price,
    alpaca_fresh_price:  fresh_price,
    alpaca_slip_pct:     slip_pct,
    alpaca_anchor_used:  anchor_source,
    alpaca_bracket_v:   '4.9'
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
    // v4.9 EX-C1: a capped marketable LIMIT replaces the unbounded market order.
    // time_in_force is 'day' and cannot be IOC/FOK — order_class:'bracket' permits only
    // day|gtc (verified against the Alpaca order docs before this was written). The IOC
    // semantic is emulated by EX-C2's poll-then-cancel below.
    type:            _exCapActive ? 'limit' : (__aptIsExt ? 'limit' : 'market'),
    time_in_force:   _exCapActive ? 'day'   : (__aptIsExt ? 'day'   : 'gtc'),
    ...( _exCapActive
           ? { limit_price: String(_exLimitPx.toFixed(2)), ...(__aptIsExt ? { extended_hours: true } : {}) }
           : ( __aptIsExt ? { limit_price: String(Number(price).toFixed(2)), extended_hours: true } : {} ) ),
    order_class:     'bracket',
    stop_loss: {
      stop_price:  String(stopPrice)   // QTP_PLAIN_STOP_20260730: plain STOP (market-on-trigger) — guaranteed fill; limit_price removed so a fast move cannot leave the protective stop unfilled/naked (BA 07-30 root cause)
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
  let   slId    = slLeg?.id || null;
  const tpId    = tpLeg?.id || null;

  console.log(`[APT v4.3] Bracket: ${ticker} ${side} qty=${qty} stop=$${stopPrice}(buf=$${slipBuffer}) tp=$${tpPrice} | entryId=${entryId} slId=${slId} tpId=${tpId}`);

  // ══ v4.9 EX-C2 — poll for the fill, then decide ══════════════════════════
  const _exBr        = await _exPollFill(entryId, qty);
  const _exBrFilled  = _exBr.outcome === 'HARNESS_SKIP' ? qty : _exBr.filledQty;
  const _exFillPx    = _exBr.fillPrice;

  // ZERO fill -> cancel. Safe by construction and PROVEN so: probe execution 545502
  // cancelled an unfilled bracket entry and both child legs went to 'canceled', with zero
  // open orders and no position left behind. There is nothing to strip protection from.
  // UNREADABLE: every status read failed. We do not know whether this order filled, so we
  // do the only safe thing — touch nothing (the bracket is protective if it did fill), and
  // say so plainly instead of guessing in either direction.
  if (_exCapActive && _exBr.outcome === 'UNREADABLE') {
    console.error('[APT v4.9 EX-C2] ' + ticker + ' fill state UNKNOWN — all ' + _exBr.polls + ' status reads failed (' + (_exBr.err || 'n/a') + '). NOT cancelling and NOT reporting a skip; the bracket stands and reconciliation will resolve it.');
    return [{ json: { ...prev,
      alpaca_status:  'ERROR_FILL_STATE_UNKNOWN',
      alpaca_reason:  'EX-C2: entry submitted but every order-status read failed — fill state unknown; order left working with its bracket intact for reconciliation',
      alpaca_entry_id: entryId, alpaca_limit_price: _exLimitPx, alpaca_cancelled: false,
      alpaca_poll_outcome: 'UNREADABLE', alpaca_poll_error: _exBr.err || null,
      alpaca_needs_reconciliation: true,
      alpaca_sl_id: slId, alpaca_tp_id: tpId, alpaca_stop_price: stopPrice, alpaca_tp_price: tpPrice,
      alpaca_qty: qty, alpaca_side: side,
      alpaca_signal_price: signal_price, alpaca_fresh_price: fresh_price, alpaca_slip_pct: slip_pct,
      alpaca_anchor_used: anchor_source, alpaca_exec_regime: _exRegime, alpaca_exec_cap_pct: _exCapPct * 100,
      alpaca_is_volatile: false, alpaca_bracket_v: '4.9' } }];
  }

  if (_exCapActive && _exBrFilled <= 0) {
    // TERMINAL_NO_FILL means the broker already ended it (canceled/expired/rejected); there
    // is nothing left to cancel and issuing one would only produce a spurious error.
    const _alreadyDead = _exBr.outcome === 'TERMINAL_NO_FILL';
    const _c = _alreadyDead ? { ok: true, skipped: 'already terminal' } : await _exCancelOrder(entryId);
    // A failed cancel is not cosmetic: the entry may still be working and could fill later,
    // which would put a position on the book that this node has just declared skipped.
    // Re-read once and report the truth rather than the intent.
    let _stillOpen = false;
    if (!_c.ok) {
      try {
        const _re = await _exGetOrder(entryId);
        const _st = String((_re && _re.status) || '').toLowerCase();
        _stillOpen = !['canceled', 'expired', 'rejected', 'filled', 'done_for_day'].includes(_st);
      } catch (_) { _stillOpen = true; }
    }
    console.log('[APT v4.9 EX-C2] ' + ticker + ' no fill at or inside ' + _exLimitPx + ' within ' + ((_exPollMs*_exPollTries)/1000) + 's — bracket ' + (_alreadyDead ? 'already terminal' : 'cancelled (' + (_c.ok ? 'ok' : _c.err) + ')') + '. Signal skipped, not lost: it simply was not available at a price we agreed to pay.');
    return [{ json: { ...prev,
      alpaca_status:  _stillOpen ? 'SKIPPED_NO_FILL_CANCEL_FAILED' : 'SKIPPED_NO_FILL_WITHIN_CAP',
      alpaca_reason:  _stillOpen
        ? 'EX-C2: limit ' + _exLimitPx + ' did not fill in time AND the cancel failed — the entry may still be working; needs reconciliation'
        : 'EX-C1/C2: limit ' + _exLimitPx + ' (' + (_exCapPct*100).toFixed(2) + '% cap from signal ' + signal_price + ') did not fill within ' + ((_exPollMs*_exPollTries)/1000) + 's — entry cancelled, no position taken',
      alpaca_entry_id: entryId, alpaca_limit_price: _exLimitPx, alpaca_cancelled: _c.ok && !_stillOpen,
      alpaca_cancel_error: _c.ok ? null : _c.err,
      alpaca_needs_reconciliation: _stillOpen,
      alpaca_poll_outcome: _exBr.outcome, alpaca_filled_qty: 0, alpaca_qty: 0,
      alpaca_signal_price: signal_price, alpaca_fresh_price: fresh_price, alpaca_slip_pct: slip_pct,
      alpaca_anchor_used: anchor_source, alpaca_exec_regime: _exRegime, alpaca_exec_cap_pct: _exCapPct * 100,
      alpaca_is_volatile: false, alpaca_bracket_v: '4.9' } }];
  }

  // PARTIAL fill -> do NOT cancel. Alpaca's own documentation: "if any one of the orders is
  // canceled, any remaining open order in the group is canceled" — so cancelling the
  // remainder of a partially filled bracket entry would take the stop and target down with
  // it and leave the ALREADY-FILLED shares naked. Leaving it working is also the better
  // outcome on the merits: TIF is 'day', so any further fill is still bounded by the same
  // capped limit, and Alpaca scales the protective legs to the filled quantity.
  // Note this is the exact opposite of the volatile path above, where the entry is a
  // standalone order with no group to damage. The asymmetry is the point.
  const _exPartial = _exCapActive && _exBr.outcome === 'PARTIAL';
  if (_exPartial) {
    console.warn('[APT v4.9 EX-C2] ' + ticker + ' PARTIAL ' + _exBrFilled + '/' + qty + ' at cap — NOT cancelling: cancelling a bracket cancels the whole group and would strip protection from the filled shares. Remainder left working (TIF day, same capped limit).');
  }

  // ══ v4.9 EX-C3 — re-anchor the protective stop to the price actually paid ══
  // WST 08-10: stop 1.199% below the SIGNAL, 2.950% below the FILL. The TSM classifies
  // anything past 1.20%-from-entry as UNPROTECTED_STOP_TOO_WIDE, cancels it and forces a
  // 0.9% stop — which sat 0.25% under the market and was hit by ordinary noise 40 minutes
  // later. The bad fill did not merely cost the entry price; it triggered a chain that
  // force-exited a position whose exit price was ABOVE its own signal price.
  // PATCH is an atomic replace: the old leg goes to 'replaced' and the new one is live in
  // the same operation, so unlike cancel-then-place there is no naked window. Proven on
  // this account, probe execution 545502.
  let _exStopFinal = stopPrice, _exReanchor = null;
  if (_exCapActive && _exFillPx > 0 && slId && !_aptHarness) {
    const _realisedPct = Math.abs(stopPrice - _exFillPx) / _exFillPx;
    if (_realisedPct > _exStopTsmBar) {
      // Only ever TIGHTEN. A favourable fill leaves the stop closer than the cap, and
      // widening it back out would be an unauthorised increase in risk on a winning entry.
      const _newStop = _exFillStop(_exFillPx, isLong);
      const _p = await _exPatchStop(slId, _newStop);
      _exReanchor = { from: stopPrice, to: _newStop, fill: _exFillPx,
                      realised_pct_before: Math.round(_realisedPct * 1e6) / 1e4,
                      realised_pct_after: Math.round(Math.abs(_newStop - _exFillPx) / _exFillPx * 1e6) / 1e4,
                      ok: _p.ok, new_leg_id: _p.ok ? _p.id : null, err: _p.ok ? null : _p.err };
      if (_p.ok) {
        _exStopFinal = _newStop;
        // The replace returns a NEW order id (measured, probe 545502). Anything still
        // holding the old id is now pointing at a 'replaced' order.
        if (_p.id && _p.id !== slId) slId = _p.id;
        console.log('[APT v4.9 EX-C3] ' + ticker + ' stop re-anchored to fill ' + _exFillPx + ': ' + stopPrice + ' -> ' + _newStop + ' (' + _exReanchor.realised_pct_before + '% -> ' + _exReanchor.realised_pct_after + '% of fill), new leg ' + slId);
      } else {
        // Fail-SAFE, not fail-closed: the original protective stop is untouched and still
        // live. The position is protected, just more widely than intended, and the TSM will
        // see it. Flag loudly rather than pretend.
        console.error('[APT v4.9 EX-C3] ' + ticker + ' stop re-anchor FAILED (' + _p.err + ') — original stop ' + stopPrice + ' still live at ' + _exReanchor.realised_pct_before + '% of fill; TSM will treat it as too wide');
        prev._exec_reanchor_failed = true;
      }
    }
  }

  const state = $getWorkflowStaticData('global');
  if (!state._bracketOrders) state._bracketOrders = {};
  state._bracketOrders[ticker] = {
    entryId, slId, tpId, isVolatile: false, side, qty: _exBrFilled || qty,
    entryPrice: _exFillPx || price, stopPrice: _exStopFinal, stopLimit, tpPrice, slipBuffer,
    attachedAt: new Date().toISOString(), bracketType: 'native_oco',
    execRegime: _exRegime, limitPrice: _exCapActive ? _exLimitPx : null, reanchor: _exReanchor
  };

  return [{ json: {
    ...prev,
    alpaca_status:      entryResp?.status || 'submitted',
      alpaca_qty:         _exBrFilled || qty,
      alpaca_side:        side,
      // v4.9: was (qty * fresh_price). fresh_price is null on any data-fetch failure, which
      // silently recorded notional 0. Use the price actually paid, else the anchor.
      alpaca_notional:    Number(((_exBrFilled || qty) * (_exFillPx || price)).toFixed(2)),
    alpaca_entry_id:    entryId,
    alpaca_sl_id:       slId,
    alpaca_tp_id:       tpId,
    alpaca_stop_price:  _exStopFinal,
    alpaca_stop_price_initial: stopPrice,
    alpaca_fill_price:   _exFillPx,
    alpaca_filled_qty:   _exBrFilled,
    alpaca_poll_outcome: _exBr.outcome,
    alpaca_partial_fill: _exPartial,
    alpaca_limit_price:  _exCapActive ? _exLimitPx : null,
    alpaca_stop_reanchor: _exReanchor,
    alpaca_exec_regime:  _exRegime,
    alpaca_exec_cap_pct: _exCapPct * 100,
    alpaca_stop_limit:  stopLimit,
    alpaca_slip_buffer: slipBuffer,
    alpaca_tp_price:    tpPrice,
    alpaca_is_volatile: false,
    alpaca_atr_used:    atr,
    alpaca_signal_price: signal_price,
    alpaca_fresh_price:  fresh_price,
    alpaca_slip_pct:     slip_pct,
    alpaca_anchor_used:  anchor_source,
    alpaca_bracket_v:   '4.9'
  }}];
}
