
// ═══════════════════════════════════════════════════════════════════════════
// TRAILING STOP MANAGER v1.7 — Atomic Replace + Circuit Breaker (C-5 fix)
// Runs every 15 min during market hours. For each open position:
//   Tier 1: price >= entry + 1.5×ATR → sell 50%, raise stop to breakeven
//   Tier 2: price >= entry + 2.5×ATR → sell remaining 50% (full exit)
//   Tier 2 trail: price >= entry + 3.0×ATR → raise stop to entry + 1.5×ATR
//   Tier 3: price >= entry + 4.5×ATR → raise stop to entry + 3.0×ATR
//
// v1.7 CHANGES (C-5 audit fix — trailing stop race condition):
//   - ATOMIC REPLACE: Uses Alpaca PATCH /v2/orders/{id} to update stop_price
//     in a single API call. Zero unprotected window. The old cancel-wait-place
//     pattern (500ms+ gap) is eliminated for same-qty stop adjustments.
//   - OVERLAP-SAFE FALLBACK: When PATCH fails (e.g. qty change needed after
//     scale-out), uses "place new → verify → cancel old" pattern instead of
//     the dangerous "cancel old → wait → place new" pattern.
//   - CIRCUIT BREAKER: If stop replacement fails twice consecutively for a
//     symbol, that symbol's trailing is paused and an alert fires. This
//     prevents repeated failures from leaving positions permanently unprotected.
//   - All v1.6 features preserved: auto-seed, scale-out, fill detection.
// ═══════════════════════════════════════════════════════════════════════════

const BASE = 'https://paper-api.alpaca.markets';
const DATA = 'https://data.alpaca.markets';
const HDR  = { 'APCA-API-KEY-ID': 'REDACTED_ALPACA_KEY_ID', 'APCA-API-SECRET-KEY': 'REDACTED_ALPACA_SECRET' };
const TG_URL = 'https://api.telegram.org/botREDACTED_TELEGRAM_BOT_TOKEN/sendMessage';
const CHAT   = 'REDACTED_CHAT_ID';

const SCALE_OUT_MODE = true;  // Tier 1 sell 50%, Tier 2 sell remaining 50% → full exit
const CIRCUIT_BREAKER_THRESHOLD = 2;  // consecutive failures before pausing a symbol

const state = $getWorkflowStaticData('global');
if (!state.scaledOut) state.scaledOut = {};
if (!state.trailState) state.trailState = {};
if (!state.circuitBreaker) state.circuitBreaker = {};  // { [symbol]: { failures: N, pausedAt: ISO } }

const r2 = n => Math.round(n * 100) / 100;

async function alp(method, path, body) {
  const opts = { method, url: BASE + path, headers: { ...HDR }, json: true };
  if (body) opts.body = JSON.stringify(body);
  if (body) opts.headers['Content-Type'] = 'application/json';
  return await this.helpers.httpRequest(opts);
}

async function tg(text) {
  try {
    await this.helpers.httpRequest({
      method: 'POST', url: TG_URL,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT, text, parse_mode: 'HTML' }),
      json: true
    });
  } catch (_) {}
}

// ═══════════════════════════════════════════════════════════════════════════
// C-5 FIX: Atomic stop replacement using Alpaca PATCH endpoint
// Returns the new order object on success, or null on failure.
//
// Strategy:
//   1. PATCH (atomic): Update stop_price on existing order. Single API call,
//      zero gap. Works when only the price changes (same qty).
//   2. OVERLAP-SAFE FALLBACK: If PATCH fails (qty mismatch, order state issue),
//      place the new stop FIRST, confirm it's accepted, THEN cancel the old.
//      Brief overlap of two stops is harmless (worst case: both fire → Alpaca
//      rejects the second as "insufficient qty"). The position is NEVER naked.
//   3. CIRCUIT BREAKER: If both methods fail, increment failure counter.
//      After CIRCUIT_BREAKER_THRESHOLD consecutive failures, pause the symbol.
// ═══════════════════════════════════════════════════════════════════════════

async function replaceStop(sym, oldOrder, newStopPrice, newQty, side) {
  const sameQty = newQty === parseInt(oldOrder.qty || oldOrder.filledQty || newQty);

  // ── Attempt 1: Atomic PATCH (only if qty unchanged) ────────────────
  if (sameQty) {
    try {
      const replaced = await alp.call(this, 'PATCH', `/v2/orders/${oldOrder.orderId}`, {
        stop_price: String(newStopPrice)
      });
      console.log(`[TRAIL v1.7] ${sym}: ATOMIC REPLACE stop → $${newStopPrice} (order ${replaced.id})`);

      // Reset circuit breaker on success
      if (state.circuitBreaker[sym]) delete state.circuitBreaker[sym];

      return { success: true, method: 'atomic_patch', newOrderId: replaced.id, newStopPrice };
    } catch (patchErr) {
      console.warn(`[TRAIL v1.7] ${sym}: PATCH failed (${patchErr.message}), falling back to overlap-safe`);
    }
  }

  // ── Attempt 2: Overlap-safe (place new FIRST, then cancel old) ─────
  try {
    // Step A: Place the new stop order while old one still active
    const newOrder = await alp.call(this, 'POST', '/v2/orders', {
      symbol:        sym,
      qty:           String(newQty),
      side:          side,
      type:          'stop',
      stop_price:    String(newStopPrice),
      time_in_force: 'gtc'
    });
    console.log(`[TRAIL v1.7] ${sym}: OVERLAP-SAFE new stop placed at $${newStopPrice} (order ${newOrder.id})`);

    // Step B: Verify the new order is accepted before cancelling old
    // Brief pause for order to reach exchange
    await new Promise(r => setTimeout(r, 200));

    let verified = false;
    try {
      const check = await alp.call(this, 'GET', `/v2/orders/${newOrder.id}`);
      verified = ['new', 'accepted', 'pending_new', 'held'].includes(check.status);
    } catch (_) {
      // If we can't verify, proceed anyway — the order was accepted by API
      verified = true;
    }

    if (!verified) {
      console.error(`[TRAIL v1.7] ${sym}: new stop order not in accepted state — aborting cancel of old`);
      // Don't cancel old — let both coexist (safe: overlap)
      return { success: true, method: 'overlap_unverified', newOrderId: newOrder.id, newStopPrice, warning: 'old stop not cancelled' };
    }

    // Step C: Cancel the old stop (position is protected by new stop)
    try {
      await alp.call(this, 'DELETE', `/v2/orders/${oldOrder.orderId}`);
      console.log(`[TRAIL v1.7] ${sym}: old stop ${oldOrder.orderId} cancelled (overlap-safe)`);
    } catch (cancelErr) {
      // Old order may have already filled or been cancelled — that's fine
      console.warn(`[TRAIL v1.7] ${sym}: old stop cancel failed (${cancelErr.message}) — may already be gone`);
    }

    // Reset circuit breaker on success
    if (state.circuitBreaker[sym]) delete state.circuitBreaker[sym];

    return { success: true, method: 'overlap_safe', newOrderId: newOrder.id, newStopPrice };

  } catch (overlapErr) {
    console.error(`[TRAIL v1.7] ${sym}: OVERLAP-SAFE also failed: ${overlapErr.message}`);
  }

  // ── Both methods failed — circuit breaker ──────────────────────────
  if (!state.circuitBreaker[sym]) state.circuitBreaker[sym] = { failures: 0 };
  state.circuitBreaker[sym].failures += 1;
  state.circuitBreaker[sym].lastFailure = new Date().toISOString();

  if (state.circuitBreaker[sym].failures >= CIRCUIT_BREAKER_THRESHOLD) {
    state.circuitBreaker[sym].pausedAt = new Date().toISOString();

    await tg.call(this,
      `🚨 <b>CIRCUIT BREAKER — ${sym}</b>\n` +
      `Stop replacement failed ${CIRCUIT_BREAKER_THRESHOLD}x consecutively.\n` +
      `<b>Trailing PAUSED for ${sym}.</b> Old stop remains in place.\n` +
      `Manual intervention required. Check Alpaca dashboard.\n` +
      `Reset: clear circuitBreaker.${sym} in workflow static data.\n` +
      `<i>Trail Manager v1.7 safety system</i>`
    );

    console.error(`[TRAIL v1.7] ${sym}: CIRCUIT BREAKER TRIPPED — trailing paused after ${CIRCUIT_BREAKER_THRESHOLD} failures`);
  }

  return { success: false, method: 'all_failed', error: 'Both PATCH and overlap-safe replacement failed' };
}


// ── 1. Fetch positions and open stop orders ─────────────────────────────
let positions, orders;
try {
  positions = await alp.call(this, 'GET', '/v2/positions');
  orders    = await alp.call(this, 'GET', '/v2/orders?status=open&limit=200');
} catch (e) {
  console.error('[TRAIL v1.7] Alpaca fetch failed:', e.message);
  return [{ json: { error: e.message } }];
}

// ── FILL DETECTION — detect positions closed since last run ────────────────
if (!state.knownPositions) state.knownPositions = {};
const CHANNEL_ID = 'REDACTED_CHANNEL_ID';

const currentSymbols = new Set((positions || []).map(p => p.symbol));
const previousSymbols = Object.keys(state.knownPositions);
const closedSymbols = previousSymbols.filter(s => !currentSymbols.has(s));
const fillAlerts = [];

if (closedSymbols.length > 0) {
  console.log(`[TRAIL v1.7] Detected ${closedSymbols.length} closed position(s): ${closedSymbols.join(', ')}`);

  let recentFills = [];
  try {
    recentFills = await alp.call(this, 'GET', '/v2/account/activities/FILL?direction=desc&page_size=50');
  } catch (_) {}

  for (const sym of closedSymbols) {
    const prev = state.knownPositions[sym];
    const entry = prev.entry || 0;
    const qty   = prev.qty || 0;
    const side  = prev.side || 'long';

    const exitFill = recentFills.find(f =>
      f.symbol === sym && (f.side === 'sell' || f.side === 'buy') &&
      f.side !== (side === 'long' ? 'buy' : 'sell')
    );
    const exitPrice = exitFill ? parseFloat(exitFill.price) : 0;
    const exitTime  = exitFill ? exitFill.transaction_time : '';
    const exitTimeET = exitTime
      ? new Date(exitTime).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true })
      : '?';

    const isLong  = side === 'long';
    const pnl     = isLong ? (exitPrice - entry) * Math.abs(qty) : (entry - exitPrice) * Math.abs(qty);
    const pnlPct  = entry > 0 ? ((exitPrice - entry) / entry * 100 * (isLong ? 1 : -1)) : 0;
    const pnlSign = pnl >= 0 ? '+' : '';
    const icon    = pnl >= 0 ? '✅' : '🔴';
    const tierInfo = state.trailState[sym] ? `Tier ${state.trailState[sym].tier}` : 'Initial stop';

    const msg =
      `${icon} <b>POSITION CLOSED — ${sym}</b>\n` +
      `${side.toUpperCase()} ${Math.abs(qty)} shares\n` +
      `Entry: $${entry.toFixed(2)} → Exit: $${exitPrice.toFixed(2)} at ${exitTimeET}\n` +
      `<b>P&L: ${pnlSign}$${pnl.toFixed(2)} (${pnlSign}${pnlPct.toFixed(1)}%)</b>\n` +
      `Stop tier at exit: ${tierInfo}`;

    await tg.call(this, msg);

    try {
      await this.helpers.httpRequest({
        method: 'POST', url: TG_URL,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: CHANNEL_ID, text: msg, parse_mode: 'HTML' }),
        json: true
      });
    } catch (_) {}

    fillAlerts.push({
      type: 'FILL_DETECTED', sym, side, qty: Math.abs(qty),
      entry, exit: exitPrice, pnl: r2(pnl), pnlPct: r2(pnlPct), exitTime: exitTimeET
    });

    // Clean up all state for closed position (including circuit breaker)
    delete state.trailState[sym];
    delete state.scaledOut[sym];
    delete state.circuitBreaker[sym];
    console.log(`[TRAIL v1.7] ${sym}: closed — P&L ${pnlSign}$${pnl.toFixed(2)}, state cleaned`);
  }
}

// Update known positions snapshot for next run
state.knownPositions = {};
for (const p of (positions || [])) {
  state.knownPositions[p.symbol] = {
    entry: parseFloat(p.avg_entry_price),
    qty:   parseFloat(p.qty),
    side:  parseFloat(p.qty) >= 0 ? 'long' : 'short',
    price: parseFloat(p.current_price)
  };
}

if (!positions || positions.length === 0) {
  console.log('[TRAIL v1.7] No open positions.');
  if (fillAlerts.length > 0) return fillAlerts.map(a => ({ json: a }));
  return [{ json: { message: 'No open positions', fills: fillAlerts.length } }];
}

// Build stop map: symbol → { orderId, stopPrice, type, qty }
const stopMap = {};
for (const o of orders) {
  if (['stop', 'stop_limit', 'trailing_stop'].includes(o.type)) {
    stopMap[o.symbol] = {
      orderId:   o.id,
      stopPrice: parseFloat(o.stop_price || 0),
      type:      o.type,
      side:      o.side,
      qty:       o.qty  // store qty for atomic replace comparison
    };
  }
}

// ── 2. Fetch ATR for all symbols using daily bars ───────────────────────
const symbols = positions.map(p => p.symbol).join(',');
let barsData = {};
try {
  const resp = await this.helpers.httpRequest({
    method: 'GET',
    url: DATA + `/v2/stocks/bars?symbols=${symbols}&timeframe=1Day&limit=20&feed=sip`,
    headers: HDR, json: true
  });
  barsData = resp.bars || {};
} catch (e) {
  console.warn('[TRAIL v1.7] Bars fetch failed, using 2% proxy ATR:', e.message);
}

function calcATR(bars) {
  if (!bars || bars.length < 2) return null;
  let sum = 0;
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].h, l = bars[i].l, pc = bars[i - 1].c;
    const tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    sum += tr;
  }
  return sum / (bars.length - 1);
}

// ═══════════════════════════════════════════════════════════════════════════
// v1.6 AUTO-SEED (preserved from v1.6)
// ═══════════════════════════════════════════════════════════════════════════
const autoSeeded = [];

if (SCALE_OUT_MODE) {
  for (const pos of positions) {
    const sym    = pos.symbol;
    const entry  = parseFloat(pos.avg_entry_price);
    const current = parseFloat(pos.current_price);
    const qty    = parseFloat(pos.qty);
    const isLong = qty > 0;
    const absQty = Math.abs(qty);

    if (state.scaledOut[sym]) {
      if (state.scaledOut[sym].retroactive && !state.scaledOut[sym].autoSeeded) {
        state.scaledOut[sym].autoSeeded = true;
        console.log(`[TRAIL v1.7] UPGRADE: ${sym} legacy retro-seed → marked autoSeeded for 50% T2 sell`);
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
      state.scaledOut[sym] = {
        qty: halfQty,
        price: current,
        time: new Date().toISOString(),
        autoSeeded: true
      };

      if (!state.trailState[sym] || state.trailState[sym].tier < 1) {
        state.trailState[sym] = { tier: 1, lastStopSet: isLong ? r2(entry - 0.05) : r2(entry + 0.05) };
      }

      autoSeeded.push(sym);
      console.log(`[TRAIL v1.7] AUTO-SEED: ${sym} past T1 ($${r2(t1)}) without scaledOut → seeded (${halfQty}sh synthetic)`);
    }
  }

  if (autoSeeded.length > 0) {
    await tg.call(this,
      `🔧 <b>AUTO-SEED — ${autoSeeded.length} position(s)</b>\n` +
      `${autoSeeded.join(', ')} were past Tier 1 without scale-out state.\n` +
      `Seeded as "Tier 1 done" — Tier 2 exit (sell ~50%) now armed.\n` +
      `<i>Trail Manager v1.7 auto-seed</i>`
    );
  }
}

// ── State consistency audit (defensive) ─────────────────────────────────
const orphanedScaleOut = Object.keys(state.scaledOut).filter(s => !currentSymbols.has(s) && !state.scaledOut[s].tier2Done);
for (const orphan of orphanedScaleOut) {
  console.log(`[TRAIL v1.7] AUDIT: removing orphaned scaledOut entry for ${orphan}`);
  delete state.scaledOut[orphan];
}
const orphanedTrail = Object.keys(state.trailState).filter(s => !currentSymbols.has(s));
for (const orphan of orphanedTrail) {
  console.log(`[TRAIL v1.7] AUDIT: removing orphaned trailState entry for ${orphan}`);
  delete state.trailState[orphan];
}
// Also clean up circuit breaker entries for positions that no longer exist
const orphanedCB = Object.keys(state.circuitBreaker).filter(s => !currentSymbols.has(s));
for (const orphan of orphanedCB) {
  console.log(`[TRAIL v1.7] AUDIT: removing orphaned circuitBreaker entry for ${orphan}`);
  delete state.circuitBreaker[orphan];
}

// ── 3. Trail logic per position ─────────────────────────────────────────
const actions = [];
const skipped = [];

for (const pos of positions) {
  const sym      = pos.symbol;
  const entry    = parseFloat(pos.avg_entry_price);
  const current  = parseFloat(pos.current_price);
  const qty      = parseFloat(pos.qty);
  const isLong   = qty > 0;
  const absQty   = Math.abs(qty);

  // ── CIRCUIT BREAKER CHECK ─────────────────────────────────────────
  if (state.circuitBreaker[sym] && state.circuitBreaker[sym].pausedAt) {
    skipped.push(`${sym} (circuit breaker — paused at ${state.circuitBreaker[sym].pausedAt})`);
    console.log(`[TRAIL v1.7] ${sym}: SKIPPED — circuit breaker active since ${state.circuitBreaker[sym].pausedAt}`);
    continue;
  }

  // ── AUTO-PLACE MISSING STOP (v1.3) ─────────────────────────────────
  const existingStop = stopMap[sym];
  if (!existingStop) {
    const bars = barsData[sym];
    let atr_miss = calcATR(bars);
    if (!atr_miss || atr_miss <= 0) atr_miss = entry * 0.02;

    let missStop = isLong ? r2(entry - 1.5 * atr_miss) : r2(entry + 1.5 * atr_miss);
    const missSide = isLong ? 'sell' : 'buy';

    let stopAdjusted = false;
    if (isLong && missStop >= current) {
      missStop = r2(current * 0.97);
      stopAdjusted = true;
    } else if (!isLong && missStop <= current) {
      missStop = r2(current * 1.03);
      stopAdjusted = true;
    }

    try {
      const missOrder = await alp.call(this, 'POST', '/v2/orders', {
        symbol:        sym,
        qty:           String(absQty),
        side:          missSide,
        type:          'stop',
        stop_price:    String(missStop),
        time_in_force: 'gtc'
      });

      console.log(`[TRAIL v1.7] ${sym}: AUTO-PLACED stop at $${missStop}`);
      state.trailState[sym] = { tier: 0, lastStopSet: missStop };

      actions.push({
        type: 'AUTO_STOP_PLACED', sym, side: isLong ? 'long' : 'short',
        qty: absQty, entry, current, stopPrice: missStop, atr: r2(atr_miss), adjusted: stopAdjusted
      });

      await tg.call(this,
        `🛡️ <b>AUTO STOP PLACED — ${sym}</b>\n` +
        `${isLong ? 'LONG' : 'SHORT'} ${absQty} shares @ $${entry.toFixed(2)}\n` +
        `<b>Stop: $${missStop.toFixed(2)}</b> (1.5×ATR = $${r2(atr_miss)})\n` +
        `No existing stop detected — auto-protected by Trail Manager v1.7${stopAdjusted ? ' (adjusted → 3% buffer)' : ''}`
      );

      try {
        await this.helpers.httpRequest({
          method: 'POST', url: TG_URL,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: CHANNEL_ID, text:
            `🛡️ <b>AUTO STOP — ${sym}</b> | ${isLong ? 'LONG' : 'SHORT'} ${absQty}sh @ $${entry.toFixed(2)} | Stop: $${missStop.toFixed(2)}`,
            parse_mode: 'HTML' }),
          json: true
        });
      } catch (_) {}

    } catch (e) {
      console.error(`[TRAIL v1.7] ${sym}: FAILED to auto-place stop: ${e.message}`);
      skipped.push(sym + ' (auto-place failed: ' + e.message.substring(0, 50) + ')');
    }
    continue;
  }

  // Skip trailing_stop type — Alpaca handles those natively
  if (existingStop.type === 'trailing_stop') {
    skipped.push(sym + ' (native trail)');
    continue;
  }

  // Calculate ATR
  const bars = barsData[sym];
  let atr = calcATR(bars);
  if (!atr || atr <= 0) atr = entry * 0.02;

  // Trail state for this ticker
  if (!state.trailState[sym]) {
    state.trailState[sym] = { tier: 0, lastStopSet: existingStop.stopPrice };
  }
  const ts = state.trailState[sym];

  // ── Calculate tier thresholds ─────────────────────────────────────
  const BUF = 0.05;
  const t1_trigger = isLong ? entry + 1.5 * atr : entry - 1.5 * atr;
  const t1_stop    = isLong ? r2(entry - BUF)   : r2(entry + BUF);

  const t2_scaleout_trigger = isLong ? entry + 2.5 * atr : entry - 2.5 * atr;
  const t2_trigger = isLong ? entry + 3.0 * atr : entry - 3.0 * atr;
  const t2_stop    = isLong ? r2(entry + 1.5 * atr) : r2(entry - 1.5 * atr);

  const t3_trigger = isLong ? entry + 4.5 * atr : entry - 4.5 * atr;
  const t3_stop    = isLong ? r2(entry + 3.0 * atr) : r2(entry - 3.0 * atr);

  // ── Determine new tier ────────────────────────────────────────────
  let newTier = ts.tier;
  let newStop = null;

  if (isLong) {
    if (current >= t3_trigger && ts.tier < 3)      { newTier = 3; newStop = t3_stop; }
    else if (current >= t2_trigger && ts.tier < 2)  { newTier = 2; newStop = t2_stop; }
    else if (current >= t1_trigger && ts.tier < 1)  { newTier = 1; newStop = t1_stop; }
  } else {
    if (current <= t3_trigger && ts.tier < 3)       { newTier = 3; newStop = t3_stop; }
    else if (current <= t2_trigger && ts.tier < 2)  { newTier = 2; newStop = t2_stop; }
    else if (current <= t1_trigger && ts.tier < 1)  { newTier = 1; newStop = t1_stop; }
  }

  if (!newStop || newTier === ts.tier) continue;

  // ═══════════════════════════════════════════════════════════════════
  // C-5 FIX: Replace the stop using atomic or overlap-safe method
  // OLD (v1.6, DANGEROUS):
  //   await alp.call(this, 'DELETE', '/v2/orders/' + existingStop.orderId);
  //   await new Promise(r => setTimeout(r, 500));  // 500ms+ UNPROTECTED
  //   await alp.call(this, 'POST', '/v2/orders', { ... });
  //
  // NEW (v1.7, SAFE):
  //   replaceStop() handles atomic PATCH → overlap-safe fallback → circuit breaker
  // ═══════════════════════════════════════════════════════════════════

  try {
    let remainQty = absQty;
    let scaledThisRun = false;

    // ── TIER 1 SCALE-OUT: sell 50% ──────────────────────────────────
    if (SCALE_OUT_MODE && newTier === 1 && !state.scaledOut[sym]) {
      const sellQty = Math.floor(absQty / 2);
      if (absQty <= 3) {
        state.scaledOut[sym] = {
          qty: 0, price: current, time: new Date().toISOString(), singleShare: true
        };
        console.log(`[TRAIL v1.7] ${sym}: small position (${absQty}sh) — skip Tier 1 sell, breakeven + Tier 2`);

        await tg.call(this,
          `🛡️ <b>TIER 1 — ${sym} (${absQty}sh)</b>\n` +
          `Small position — skip scale-out, stop raised to breakeven $${newStop.toFixed(2)}\n` +
          `Full exit at Tier 2 (entry + 2.5×ATR = $${r2(isLong ? entry + 2.5*atr : entry - 2.5*atr).toFixed(2)})\n` +
          `<i>Scale-Out v1.7</i>`
        );

        actions.push({
          type: 'TIER1_SMALL_POS', sym, entry, current, newStop,
          tier2Target: r2(isLong ? entry + 2.5*atr : entry - 2.5*atr)
        });
      }
      if (sellQty >= 1 && absQty > 3) {
        const scaleOutSide = isLong ? 'sell' : 'buy';
        try {
          const scaleOrder = await alp.call(this, 'POST', '/v2/orders', {
            symbol:        sym,
            qty:           String(sellQty),
            side:          scaleOutSide,
            type:          'market',
            time_in_force: 'day'
          });

          remainQty = absQty - sellQty;
          state.scaledOut[sym] = {
            qty: sellQty, price: current, time: new Date().toISOString()
          };
          scaledThisRun = true;

          const banked = isLong ? r2((current - entry) * sellQty) : r2((entry - current) * sellQty);
          console.log(`[TRAIL v1.7] ${sym}: SCALE OUT — sold ${sellQty}/${absQty} @ ~$${current} — banked ~$${banked}`);

          await tg.call(this,
            `💰 <b>SCALE OUT — ${sym}</b>\n` +
            `Sold ${sellQty} of ${absQty} shares (50%) at ~$${current.toFixed(2)}\n` +
            `<b>Banked: ~$${banked.toFixed(2)}</b> (${r2(banked / (entry * sellQty) * 100)}%)\n` +
            `Remaining: ${remainQty} shares — trailing with stop at $${newStop}\n` +
            `\n<i>Scale-Out Mode v1.7 — locking profits at Tier 1</i>`
          );

          try {
            await this.helpers.httpRequest({
              method: 'POST', url: TG_URL,
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: CHANNEL_ID, text:
                `💰 <b>SCALE OUT — ${sym}</b> | Sold ${sellQty}/${absQty}sh @ ~$${current.toFixed(2)} | Banked ~$${banked.toFixed(2)} | Rest trailing`,
                parse_mode: 'HTML' }),
              json: true
            });
          } catch (_) {}

          actions.push({
            type: 'SCALE_OUT', sym, side: isLong ? 'long' : 'short',
            soldQty: sellQty, remainQty, price: current, banked, entry, tier: newTier
          });

        } catch (scaleErr) {
          console.error(`[TRAIL v1.7] ${sym}: scale-out FAILED: ${scaleErr.message}`);
          remainQty = absQty;
        }
      }
    }

    // ── TIER 2 SCALE-OUT: sell ~50% at entry + 2.5×ATR ──────────────
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
          const exitOrder = await alp.call(this, 'POST', '/v2/orders', {
            symbol:        sym,
            qty:           String(t2SellQty),
            side:          scaleOutSide,
            type:          'market',
            time_in_force: 'day'
          });

          const t2Banked = isLong ? r2((current - entry) * t2SellQty) : r2((entry - current) * t2SellQty);
          scaledThisRun = true;

          if (wasAutoSeeded && t2SellQty < remainQty) {
            remainQty = remainQty - t2SellQty;
            state.scaledOut[sym].autoSeeded = false;
            state.scaledOut[sym].qty = t2SellQty;
            state.scaledOut[sym].price = current;
            state.scaledOut[sym].realT1Time = new Date().toISOString();

            console.log(`[TRAIL v1.7] ${sym}: AUTO-SEED SCALE OUT — sold ${t2SellQty}/${absQty} @ ~$${current} (first real sell)`);

            await tg.call(this,
              `💰 <b>SCALE OUT — ${sym} (auto-seeded)</b>\n` +
              `Sold ${t2SellQty} of ${absQty} shares (50%) at ~$${current.toFixed(2)}\n` +
              `<b>Banked: ~$${t2Banked.toFixed(2)}</b>\n` +
              `Remaining: ${remainQty} shares — trailing with stop at $${newStop}\n` +
              `\n<i>Scale-Out v1.7 — catch-up sell (T1 was missed)</i>`
            );

            try {
              await this.helpers.httpRequest({
                method: 'POST', url: TG_URL,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: CHANNEL_ID, text:
                  `💰 <b>SCALE OUT — ${sym}</b> | Sold ${t2SellQty}/${absQty}sh @ ~$${current.toFixed(2)} | Banked ~$${t2Banked.toFixed(2)} | Rest trailing`,
                  parse_mode: 'HTML' }),
                json: true
              });
            } catch (_) {}

            actions.push({
              type: 'AUTO_SEED_SCALE_OUT', sym, side: isLong ? 'long' : 'short',
              soldQty: t2SellQty, remainQty, price: current, banked: t2Banked,
              entry, tier: newTier
            });

          } else {
            const t1Banked = state.scaledOut[sym].qty * (isLong ? (state.scaledOut[sym].price - entry) : (entry - state.scaledOut[sym].price));
            const totalBanked = r2(t1Banked + t2Banked);

            state.scaledOut[sym].tier2Done = true;
            state.scaledOut[sym].tier2Price = current;
            state.scaledOut[sym].tier2Time = new Date().toISOString();
            remainQty = 0;

            console.log(`[TRAIL v1.7] ${sym}: FULL EXIT — sold remaining ${t2SellQty}sh @ ~$${current}`);

            await tg.call(this,
              `🏁 <b>FULL EXIT — ${sym}</b>\n` +
              `Sold remaining ${t2SellQty} shares at ~$${current.toFixed(2)}\n` +
              `\n📊 <b>Trade Summary</b>\n` +
              `  Tier 1: sold ${state.scaledOut[sym].qty}sh @ $${state.scaledOut[sym].price.toFixed(2)}\n` +
              `  Tier 2: sold ${t2SellQty}sh @ ~$${current.toFixed(2)}\n` +
              `  Entry:  $${entry.toFixed(2)}\n` +
              `  <b>Total P&L: ~$${totalBanked.toFixed(2)}</b>\n` +
              `\n<i>Scale-Out Mode v1.7 — position fully closed</i>`
            );

            try {
              await this.helpers.httpRequest({
                method: 'POST', url: TG_URL,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: CHANNEL_ID, text:
                  `🏁 <b>FULL EXIT — ${sym}</b> | All ${t2SellQty}sh sold @ ~$${current.toFixed(2)} | Total P&L: ~$${totalBanked.toFixed(2)}`,
                  parse_mode: 'HTML' }),
                json: true
              });
            } catch (_) {}

            actions.push({
              type: 'FULL_EXIT', sym, side: isLong ? 'long' : 'short',
              exitPrice: current, totalBanked, entry,
              tier1: state.scaledOut[sym], tier: 2
            });
          }

        } catch (exitErr) {
          console.error(`[TRAIL v1.7] ${sym}: Tier 2 exit FAILED: ${exitErr.message}`);
        }
      }
    }

    // Skip placing new stop if position was fully exited
    if (remainQty <= 0) {
      state.trailState[sym] = { tier: newTier, lastStopSet: newStop };
      continue;
    }

    // ═══════════════════════════════════════════════════════════════════
    // C-5 FIX: Use replaceStop() instead of cancel-wait-place
    // ═══════════════════════════════════════════════════════════════════
    const stopSide = isLong ? 'sell' : 'buy';
    const result = await replaceStop.call(this, sym, existingStop, newStop, remainQty, stopSide);

    if (result.success) {
      console.log(`[TRAIL v1.7] ${sym}: stop updated to $${newStop} (Tier ${newTier}) via ${result.method}`);
      state.trailState[sym] = { tier: newTier, lastStopSet: newStop };

      const tierLabels = ['Initial', 'Breakeven + Scale Out', 'Lock +1.5×ATR', 'Lock +3×ATR'];
      const gain = isLong ? r2(current - entry) : r2(entry - current);
      const gainPct = r2(gain / entry * 100);

      if (!scaledThisRun) {
        actions.push({
          sym, tier: newTier, tierLabel: tierLabels[newTier],
          oldStop: existingStop.stopPrice, newStop,
          entry, current, atr: r2(atr), gain, gainPct,
          replaceMethod: result.method  // track which method was used
        });
      }

      if (!scaledThisRun) await tg.call(this,
        `🔄 <b>TRAIL STOP RAISED — ${sym}</b>\n` +
        `Tier ${newTier}: ${tierLabels[newTier]}\n` +
        `Entry: $${entry.toFixed(2)} → Current: $${current.toFixed(2)} (+${gainPct}%)\n` +
        `Old stop: $${existingStop.stopPrice.toFixed(2)} → <b>New: $${newStop.toFixed(2)}</b>\n` +
        `ATR: $${r2(atr)} | Gain locked: $${gain.toFixed(2)}/share\n` +
        `<i>Method: ${result.method}</i>`
      );
    } else {
      // replaceStop failed — circuit breaker may have tripped
      console.error(`[TRAIL v1.7] ${sym}: stop replacement FAILED — old stop remains in place`);
      actions.push({ sym, tier: newTier, error: result.error, replaceMethod: result.method });
    }

  } catch (e) {
    console.error(`[TRAIL v1.7] ${sym}: FAILED to update stop:`, e.message);
    actions.push({ sym, tier: newTier, error: e.message });
  }
}

if (actions.length === 0 && autoSeeded.length === 0) {
  console.log(`[TRAIL v1.7] No trail adjustments needed. Skipped: ${skipped.join(', ')}`);
}

const allResults = [...fillAlerts, ...actions];
if (autoSeeded.length > 0) {
  allResults.push({ json: { type: 'AUTO_SEED', symbols: autoSeeded, count: autoSeeded.length } });
}
return allResults.length > 0
  ? allResults.map(a => a.json ? a : { json: a })
  : [{ json: { message: 'No adjustments or fills', checked: positions.length, skipped, fills: 0, autoSeeded: 0 } }];
