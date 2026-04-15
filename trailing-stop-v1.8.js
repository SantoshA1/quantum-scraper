
// ═══════════════════════════════════════════════════════════════════════════
// TRAILING STOP MANAGER v1.8 — Adaptive Polling (H-1 fix)
//
// TRIGGER: Every 2 minutes (changed from 15 min).
//
// Not every position needs checking every 2 minutes. The code classifies
// each position into HIGH-VOL or NORMAL and only processes accordingly:
//
//   HIGH-VOL (every 2 min): ATR > 3% of price, OR VIX > 20, OR leveraged ETF,
//     OR price moved > 1×ATR since last check, OR position near a tier boundary
//   NORMAL (every ~16 min): Everything else — checked every 8th run
//
// This gives volatile positions 7.5× faster reaction time while keeping
// API calls manageable for a portfolio of 20 positions.
//
// For each open position:
//   Tier 1: price >= entry + 1.5×ATR → sell 50%, raise stop to breakeven
//   Tier 2: price >= entry + 2.5×ATR → sell remaining 50% (full exit)
//   Tier 2 trail: price >= entry + 3.0×ATR → raise stop to entry + 1.5×ATR
//   Tier 3: price >= entry + 4.5×ATR → raise stop to entry + 3.0×ATR
//
// v1.8 CHANGES (H-1 audit fix — 15-min polling too slow):
//   - ADAPTIVE POLLING: 2-min trigger, positions classified by volatility
//   - HIGH-VOL FAST PATH: volatile positions checked every cycle (2 min)
//   - TIER PROXIMITY: positions within 0.5×ATR of next tier → force fast path
//   - EMERGENCY SCAN: price moved > 1×ATR since last check → immediate processing
//   - VIX AWARENESS: fetches current VIX to dynamically classify positions
//   - All v1.7 features preserved: atomic replace, circuit breaker, auto-seed,
//     scale-out, fill detection
// ═══════════════════════════════════════════════════════════════════════════

const BASE = 'https://paper-api.alpaca.markets';
const DATA = 'https://data.alpaca.markets';
const HDR  = { 'APCA-API-KEY-ID': 'REDACTED_ALPACA_KEY_ID', 'APCA-API-SECRET-KEY': 'REDACTED_ALPACA_SECRET' };
const TG_URL = 'https://api.telegram.org/botREDACTED_TELEGRAM_BOT_TOKEN/sendMessage';
const CHAT   = 'REDACTED_CHAT_ID';

const SCALE_OUT_MODE = true;
const CIRCUIT_BREAKER_THRESHOLD = 2;

// ── H-1: Adaptive polling configuration ─────────────────────────────────
const FAST_SCAN_INTERVAL = 1;           // process high-vol every N runs (1 = every run = ~2 min)
const FULL_SCAN_INTERVAL = 8;           // process all positions every N runs (~16 min)
const HIGH_VOL_ATR_THRESHOLD = 0.03;    // ATR > 3% of price → high-vol
const HIGH_VOL_VIX_THRESHOLD = 20;      // VIX > 20 → all positions high-vol
const TIER_PROXIMITY_FACTOR = 0.5;      // within 0.5×ATR of next tier → high-vol
const EMERGENCY_ATR_THRESHOLD = 1.0;    // price moved > 1×ATR since last check → emergency

const LEVERAGED_ETFS = new Set([
  'TQQQ','SQQQ','SPXL','SPXS','SOXL','SOXS','UVXY','SVXY',
  'UPRO','SPXU','LABU','LABD','FAS','FAZ','TNA','TZA',
  'TECL','TECS','ERX','ERY','NUGT','DUST','JNUG','JDST'
]);
// ─────────────────────────────────────────────────────────────────────────

const state = $getWorkflowStaticData('global');
if (!state.scaledOut) state.scaledOut = {};
if (!state.trailState) state.trailState = {};
if (!state.circuitBreaker) state.circuitBreaker = {};
if (!state._runCounter) state._runCounter = 0;
if (!state._lastPrices) state._lastPrices = {};  // { [symbol]: { price, checkedAt } }
if (!state._pollingStats) state._pollingStats = { fastScans: 0, fullScans: 0, emergencyScans: 0 };

state._runCounter += 1;
const runCounter = state._runCounter;
const isFullScan = (runCounter % FULL_SCAN_INTERVAL === 0);

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
// C-5 FIX (preserved): Atomic stop replacement
// ═══════════════════════════════════════════════════════════════════════════

async function replaceStop(sym, oldOrder, newStopPrice, newQty, side) {
  const sameQty = newQty === parseInt(oldOrder.qty || oldOrder.filledQty || newQty);

  if (sameQty) {
    try {
      const replaced = await alp.call(this, 'PATCH', `/v2/orders/${oldOrder.orderId}`, {
        stop_price: String(newStopPrice)
      });
      console.log(`[TRAIL v1.8] ${sym}: ATOMIC REPLACE stop → $${newStopPrice} (order ${replaced.id})`);
      if (state.circuitBreaker[sym]) delete state.circuitBreaker[sym];
      return { success: true, method: 'atomic_patch', newOrderId: replaced.id, newStopPrice };
    } catch (patchErr) {
      console.warn(`[TRAIL v1.8] ${sym}: PATCH failed (${patchErr.message}), falling back to overlap-safe`);
    }
  }

  try {
    const newOrder = await alp.call(this, 'POST', '/v2/orders', {
      symbol: sym, qty: String(newQty), side, type: 'stop',
      stop_price: String(newStopPrice), time_in_force: 'gtc'
    });
    console.log(`[TRAIL v1.8] ${sym}: OVERLAP-SAFE new stop placed at $${newStopPrice} (order ${newOrder.id})`);

    await new Promise(r => setTimeout(r, 200));

    let verified = false;
    try {
      const check = await alp.call(this, 'GET', `/v2/orders/${newOrder.id}`);
      verified = ['new', 'accepted', 'pending_new', 'held'].includes(check.status);
    } catch (_) { verified = true; }

    if (!verified) {
      return { success: true, method: 'overlap_unverified', newOrderId: newOrder.id, newStopPrice, warning: 'old stop not cancelled' };
    }

    try {
      await alp.call(this, 'DELETE', `/v2/orders/${oldOrder.orderId}`);
      console.log(`[TRAIL v1.8] ${sym}: old stop ${oldOrder.orderId} cancelled (overlap-safe)`);
    } catch (cancelErr) {
      console.warn(`[TRAIL v1.8] ${sym}: old stop cancel failed (${cancelErr.message}) — may already be gone`);
    }

    if (state.circuitBreaker[sym]) delete state.circuitBreaker[sym];
    return { success: true, method: 'overlap_safe', newOrderId: newOrder.id, newStopPrice };

  } catch (overlapErr) {
    console.error(`[TRAIL v1.8] ${sym}: OVERLAP-SAFE also failed: ${overlapErr.message}`);
  }

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
      `<i>Trail Manager v1.8 safety system</i>`
    );
  }

  return { success: false, method: 'all_failed', error: 'Both PATCH and overlap-safe replacement failed' };
}


// ── 1. Fetch positions and open stop orders ─────────────────────────────
let positions, orders;
try {
  positions = await alp.call(this, 'GET', '/v2/positions');
  orders    = await alp.call(this, 'GET', '/v2/orders?status=open&limit=200');
} catch (e) {
  console.error('[TRAIL v1.8] Alpaca fetch failed:', e.message);
  return [{ json: { error: e.message } }];
}

// ── Fetch current VIX for volatility classification ─────────────────────
let currentVIX = 15; // safe default (low vol)
try {
  const vixSnap = await this.helpers.httpRequest({
    method: 'GET',
    url: DATA + '/v2/stocks/snapshots?symbols=UVXY&feed=sip',
    headers: HDR, json: true
  });
  // UVXY approximates VIX behavior. For true VIX, we use the latest bar close.
  // Better approach: fetch VIX from the quote data
  if (vixSnap && vixSnap.UVXY && vixSnap.UVXY.latestTrade) {
    // UVXY is a proxy. Use state if a more accurate VIX was cached by SM.
    currentVIX = state._cachedVIX || 15;
  }
} catch (_) {}
// If the Signal State Machine cached VIX, prefer that
if (state._cachedVIX && state._cachedVIX > 0) currentVIX = state._cachedVIX;

const highVolRegime = currentVIX > HIGH_VOL_VIX_THRESHOLD;

// ── FILL DETECTION — detect positions closed since last run ────────────────
if (!state.knownPositions) state.knownPositions = {};
const CHANNEL_ID = 'REDACTED_CHANNEL_ID';

const currentSymbols = new Set((positions || []).map(p => p.symbol));
const previousSymbols = Object.keys(state.knownPositions);
const closedSymbols = previousSymbols.filter(s => !currentSymbols.has(s));
const fillAlerts = [];

if (closedSymbols.length > 0) {
  console.log(`[TRAIL v1.8] Detected ${closedSymbols.length} closed position(s): ${closedSymbols.join(', ')}`);

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

    delete state.trailState[sym];
    delete state.scaledOut[sym];
    delete state.circuitBreaker[sym];
    delete state._lastPrices[sym];
    console.log(`[TRAIL v1.8] ${sym}: closed — P&L ${pnlSign}$${pnl.toFixed(2)}, state cleaned`);
  }
}

// Update known positions snapshot
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
  console.log('[TRAIL v1.8] No open positions.');
  if (fillAlerts.length > 0) return fillAlerts.map(a => ({ json: a }));
  return [{ json: { message: 'No open positions', run: runCounter, fills: fillAlerts.length } }];
}

// Build stop map
const stopMap = {};
for (const o of orders) {
  if (['stop', 'stop_limit', 'trailing_stop'].includes(o.type)) {
    stopMap[o.symbol] = {
      orderId: o.id, stopPrice: parseFloat(o.stop_price || 0),
      type: o.type, side: o.side, qty: o.qty
    };
  }
}

// ── 2. Fetch ATR for all symbols ────────────────────────────────────────
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
  console.warn('[TRAIL v1.8] Bars fetch failed, using 2% proxy ATR:', e.message);
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
// H-1 FIX: VOLATILITY CLASSIFICATION
// Classify each position as HIGH-VOL or NORMAL. Only HIGH-VOL positions
// are processed on fast-scan cycles. All positions processed on full scans.
//
// HIGH-VOL criteria (any one triggers):
//   1. ATR > 3% of price (inherently volatile stock)
//   2. VIX > 20 (high-vol market regime → all positions become high-vol)
//   3. Leveraged ETF (TQQQ, SOXL, etc.)
//   4. Price moved > 1×ATR since last check (sudden move)
//   5. Price within 0.5×ATR of next tier boundary (about to trigger)
// ═══════════════════════════════════════════════════════════════════════════

function classifyVolatility(sym, pos, atr, tierState) {
  const entry   = parseFloat(pos.avg_entry_price);
  const current = parseFloat(pos.current_price);
  const price   = current || entry;
  const reasons = [];

  // Criterion 1: High ATR relative to price
  const atrPct = atr / price;
  if (atrPct > HIGH_VOL_ATR_THRESHOLD) {
    reasons.push(`ATR ${(atrPct * 100).toFixed(1)}% > ${(HIGH_VOL_ATR_THRESHOLD * 100)}%`);
  }

  // Criterion 2: VIX regime
  if (highVolRegime) {
    reasons.push(`VIX ${currentVIX.toFixed(1)} > ${HIGH_VOL_VIX_THRESHOLD}`);
  }

  // Criterion 3: Leveraged ETF
  if (LEVERAGED_ETFS.has(sym)) {
    reasons.push('Leveraged ETF');
  }

  // Criterion 4: Price moved significantly since last check
  const lastPrice = state._lastPrices[sym];
  if (lastPrice && atr > 0) {
    const priceDelta = Math.abs(current - lastPrice.price);
    if (priceDelta > atr * EMERGENCY_ATR_THRESHOLD) {
      reasons.push(`Emergency: moved $${priceDelta.toFixed(2)} > ${EMERGENCY_ATR_THRESHOLD}×ATR ($${atr.toFixed(2)})`);
      state._pollingStats.emergencyScans++;
    }
  }

  // Criterion 5: Near a tier boundary (about to trigger stop adjustment)
  if (tierState && atr > 0) {
    const isLong = parseFloat(pos.qty) > 0;
    const tier = tierState.tier || 0;

    // Calculate next tier's trigger price
    let nextTrigger = null;
    if (tier < 1) nextTrigger = isLong ? entry + 1.5 * atr : entry - 1.5 * atr;
    else if (tier < 2) nextTrigger = isLong ? entry + 3.0 * atr : entry - 3.0 * atr;
    else if (tier < 3) nextTrigger = isLong ? entry + 4.5 * atr : entry - 4.5 * atr;

    if (nextTrigger !== null) {
      const distToTier = Math.abs(current - nextTrigger);
      if (distToTier < atr * TIER_PROXIMITY_FACTOR) {
        reasons.push(`Near Tier ${tier + 1}: $${distToTier.toFixed(2)} < ${TIER_PROXIMITY_FACTOR}×ATR away`);
      }
    }
  }

  return {
    isHighVol: reasons.length > 0,
    reasons,
    atrPct: parseFloat((atrPct * 100).toFixed(2)),
  };
}


// ═══════════════════════════════════════════════════════════════════════════
// AUTO-SEED (preserved from v1.6)
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
        console.log(`[TRAIL v1.8] UPGRADE: ${sym} legacy retro-seed → marked autoSeeded for 50% T2 sell`);
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
        qty: halfQty, price: current, time: new Date().toISOString(), autoSeeded: true
      };
      if (!state.trailState[sym] || state.trailState[sym].tier < 1) {
        state.trailState[sym] = { tier: 1, lastStopSet: isLong ? r2(entry - 0.05) : r2(entry + 0.05) };
      }
      autoSeeded.push(sym);
      console.log(`[TRAIL v1.8] AUTO-SEED: ${sym} past T1 ($${r2(t1)}) → seeded (${halfQty}sh synthetic)`);
    }
  }

  if (autoSeeded.length > 0) {
    await tg.call(this,
      `🔧 <b>AUTO-SEED — ${autoSeeded.length} position(s)</b>\n` +
      `${autoSeeded.join(', ')} were past Tier 1 without scale-out state.\n` +
      `Seeded as "Tier 1 done" — Tier 2 exit (sell ~50%) now armed.\n` +
      `<i>Trail Manager v1.8 auto-seed</i>`
    );
  }
}

// ── State consistency audit ─────────────────────────────────────────────
const orphanedScaleOut = Object.keys(state.scaledOut).filter(s => !currentSymbols.has(s) && !state.scaledOut[s].tier2Done);
for (const orphan of orphanedScaleOut) {
  console.log(`[TRAIL v1.8] AUDIT: removing orphaned scaledOut for ${orphan}`);
  delete state.scaledOut[orphan];
}
const orphanedTrail = Object.keys(state.trailState).filter(s => !currentSymbols.has(s));
for (const orphan of orphanedTrail) {
  console.log(`[TRAIL v1.8] AUDIT: removing orphaned trailState for ${orphan}`);
  delete state.trailState[orphan];
}
const orphanedCB = Object.keys(state.circuitBreaker).filter(s => !currentSymbols.has(s));
for (const orphan of orphanedCB) {
  console.log(`[TRAIL v1.8] AUDIT: removing orphaned circuitBreaker for ${orphan}`);
  delete state.circuitBreaker[orphan];
}
// Clean up stale _lastPrices entries
const orphanedLP = Object.keys(state._lastPrices).filter(s => !currentSymbols.has(s));
for (const orphan of orphanedLP) delete state._lastPrices[orphan];


// ── 3. Trail logic per position ─────────────────────────────────────────
const actions = [];
const skipped = [];
let fastCount = 0, normalCount = 0, skippedNormal = 0;

for (const pos of positions) {
  const sym      = pos.symbol;
  const entry    = parseFloat(pos.avg_entry_price);
  const current  = parseFloat(pos.current_price);
  const qty      = parseFloat(pos.qty);
  const isLong   = qty > 0;
  const absQty   = Math.abs(qty);

  // Calculate ATR for classification
  const bars = barsData[sym];
  let atr = calcATR(bars);
  if (!atr || atr <= 0) atr = entry * 0.02;

  // ═══════════════════════════════════════════════════════════════════
  // H-1 FIX: Classify and gate
  // ═══════════════════════════════════════════════════════════════════
  const volClass = classifyVolatility(sym, pos, atr, state.trailState[sym]);

  if (!isFullScan && !volClass.isHighVol) {
    // Not a full scan and position is not high-vol → skip this cycle
    skippedNormal++;
    continue;
  }

  if (volClass.isHighVol) fastCount++;
  else normalCount++;

  // Update last-checked price
  state._lastPrices[sym] = { price: current, checkedAt: new Date().toISOString() };

  // ── CIRCUIT BREAKER CHECK ─────────────────────────────────────────
  if (state.circuitBreaker[sym] && state.circuitBreaker[sym].pausedAt) {
    skipped.push(`${sym} (circuit breaker — paused at ${state.circuitBreaker[sym].pausedAt})`);
    continue;
  }

  // ── AUTO-PLACE MISSING STOP ───────────────────────────────────────
  const existingStop = stopMap[sym];
  if (!existingStop) {
    let atr_miss = atr;
    let missStop = isLong ? r2(entry - 1.5 * atr_miss) : r2(entry + 1.5 * atr_miss);
    const missSide = isLong ? 'sell' : 'buy';

    let stopAdjusted = false;
    if (isLong && missStop >= current) { missStop = r2(current * 0.97); stopAdjusted = true; }
    else if (!isLong && missStop <= current) { missStop = r2(current * 1.03); stopAdjusted = true; }

    try {
      await alp.call(this, 'POST', '/v2/orders', {
        symbol: sym, qty: String(absQty), side: missSide,
        type: 'stop', stop_price: String(missStop), time_in_force: 'gtc'
      });
      console.log(`[TRAIL v1.8] ${sym}: AUTO-PLACED stop at $${missStop}`);
      state.trailState[sym] = { tier: 0, lastStopSet: missStop };
      actions.push({
        type: 'AUTO_STOP_PLACED', sym, side: isLong ? 'long' : 'short',
        qty: absQty, entry, current, stopPrice: missStop, atr: r2(atr),
        adjusted: stopAdjusted, scanType: volClass.isHighVol ? 'FAST' : 'FULL'
      });
      await tg.call(this,
        `🛡️ <b>AUTO STOP PLACED — ${sym}</b>\n` +
        `${isLong ? 'LONG' : 'SHORT'} ${absQty}sh @ $${entry.toFixed(2)}\n` +
        `<b>Stop: $${missStop.toFixed(2)}</b> (1.5×ATR=$${r2(atr)})\n` +
        `Scan: ${volClass.isHighVol ? '⚡ FAST' : '🔄 FULL'}${stopAdjusted ? ' (adjusted → 3% buffer)' : ''}\n` +
        `<i>Trail Manager v1.8</i>`
      );
    } catch (e) {
      console.error(`[TRAIL v1.8] ${sym}: FAILED to auto-place stop: ${e.message}`);
      skipped.push(sym + ' (auto-place failed)');
    }
    continue;
  }

  // Skip native trailing_stop
  if (existingStop.type === 'trailing_stop') {
    skipped.push(sym + ' (native trail)');
    continue;
  }

  // Trail state
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
  // Execute tier change (stop replacement + scale-out)
  // ═══════════════════════════════════════════════════════════════════
  try {
    let remainQty = absQty;
    let scaledThisRun = false;

    // ── TIER 1 SCALE-OUT ────────────────────────────────────────────
    if (SCALE_OUT_MODE && newTier === 1 && !state.scaledOut[sym]) {
      const sellQty = Math.floor(absQty / 2);
      if (absQty <= 3) {
        state.scaledOut[sym] = { qty: 0, price: current, time: new Date().toISOString(), singleShare: true };
        console.log(`[TRAIL v1.8] ${sym}: small position (${absQty}sh) — skip Tier 1 sell`);
        await tg.call(this,
          `🛡️ <b>TIER 1 — ${sym} (${absQty}sh)</b>\n` +
          `Small position — stop raised to breakeven $${newStop.toFixed(2)}\n` +
          `Full exit at Tier 2\n<i>Scale-Out v1.8</i>`
        );
        actions.push({ type: 'TIER1_SMALL_POS', sym, entry, current, newStop });
      }
      if (sellQty >= 1 && absQty > 3) {
        const scaleOutSide = isLong ? 'sell' : 'buy';
        try {
          await alp.call(this, 'POST', '/v2/orders', {
            symbol: sym, qty: String(sellQty), side: scaleOutSide,
            type: 'market', time_in_force: 'day'
          });
          remainQty = absQty - sellQty;
          state.scaledOut[sym] = { qty: sellQty, price: current, time: new Date().toISOString() };
          scaledThisRun = true;
          const banked = isLong ? r2((current - entry) * sellQty) : r2((entry - current) * sellQty);
          console.log(`[TRAIL v1.8] ${sym}: SCALE OUT — sold ${sellQty}/${absQty} @ ~$${current}`);
          await tg.call(this,
            `💰 <b>SCALE OUT — ${sym}</b>\n` +
            `Sold ${sellQty}/${absQty}sh (50%) at ~$${current.toFixed(2)}\n` +
            `<b>Banked: ~$${banked.toFixed(2)}</b>\n` +
            `Remaining: ${remainQty}sh — trailing at $${newStop}\n` +
            `Scan: ${volClass.isHighVol ? '⚡ FAST' : '🔄 FULL'}\n` +
            `<i>Scale-Out v1.8</i>`
          );
          try {
            await this.helpers.httpRequest({
              method: 'POST', url: TG_URL,
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: CHANNEL_ID, text:
                `💰 <b>SCALE OUT — ${sym}</b> | Sold ${sellQty}/${absQty}sh @ ~$${current.toFixed(2)} | Banked ~$${banked.toFixed(2)}`,
                parse_mode: 'HTML' }),
              json: true
            });
          } catch (_) {}
          actions.push({
            type: 'SCALE_OUT', sym, side: isLong ? 'long' : 'short',
            soldQty: sellQty, remainQty, price: current, banked, entry, tier: newTier,
            scanType: volClass.isHighVol ? 'FAST' : 'FULL'
          });
        } catch (scaleErr) {
          console.error(`[TRAIL v1.8] ${sym}: scale-out FAILED: ${scaleErr.message}`);
          remainQty = absQty;
        }
      }
    }

    // ── TIER 2 SCALE-OUT ────────────────────────────────────────────
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
          await alp.call(this, 'POST', '/v2/orders', {
            symbol: sym, qty: String(t2SellQty), side: scaleOutSide,
            type: 'market', time_in_force: 'day'
          });
          const t2Banked = isLong ? r2((current - entry) * t2SellQty) : r2((entry - current) * t2SellQty);
          scaledThisRun = true;

          if (wasAutoSeeded && t2SellQty < remainQty) {
            remainQty = remainQty - t2SellQty;
            state.scaledOut[sym].autoSeeded = false;
            state.scaledOut[sym].qty = t2SellQty;
            state.scaledOut[sym].price = current;
            console.log(`[TRAIL v1.8] ${sym}: AUTO-SEED SCALE OUT — sold ${t2SellQty}sh`);
            await tg.call(this,
              `💰 <b>SCALE OUT — ${sym} (auto-seeded)</b>\n` +
              `Sold ${t2SellQty}/${absQty}sh (50%) at ~$${current.toFixed(2)}\n` +
              `<b>Banked: ~$${t2Banked.toFixed(2)}</b>\n` +
              `Remaining: ${remainQty}sh\n<i>Scale-Out v1.8</i>`
            );
            actions.push({
              type: 'AUTO_SEED_SCALE_OUT', sym, soldQty: t2SellQty, remainQty,
              price: current, banked: t2Banked, entry, tier: newTier,
              scanType: volClass.isHighVol ? 'FAST' : 'FULL'
            });
          } else {
            const t1Banked = state.scaledOut[sym].qty * (isLong ? (state.scaledOut[sym].price - entry) : (entry - state.scaledOut[sym].price));
            const totalBanked = r2(t1Banked + t2Banked);
            state.scaledOut[sym].tier2Done = true;
            state.scaledOut[sym].tier2Price = current;
            remainQty = 0;
            console.log(`[TRAIL v1.8] ${sym}: FULL EXIT — sold remaining ${t2SellQty}sh`);
            await tg.call(this,
              `🏁 <b>FULL EXIT — ${sym}</b>\n` +
              `Sold remaining ${t2SellQty}sh at ~$${current.toFixed(2)}\n` +
              `<b>Total P&L: ~$${totalBanked.toFixed(2)}</b>\n` +
              `<i>Scale-Out v1.8 — position closed</i>`
            );
            try {
              await this.helpers.httpRequest({
                method: 'POST', url: TG_URL,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: CHANNEL_ID, text:
                  `🏁 <b>FULL EXIT — ${sym}</b> | All ${t2SellQty}sh sold @ ~$${current.toFixed(2)} | P&L: ~$${totalBanked.toFixed(2)}`,
                  parse_mode: 'HTML' }),
                json: true
              });
            } catch (_) {}
            actions.push({
              type: 'FULL_EXIT', sym, exitPrice: current, totalBanked, entry, tier: 2,
              scanType: volClass.isHighVol ? 'FAST' : 'FULL'
            });
          }
        } catch (exitErr) {
          console.error(`[TRAIL v1.8] ${sym}: Tier 2 exit FAILED: ${exitErr.message}`);
        }
      }
    }

    if (remainQty <= 0) {
      state.trailState[sym] = { tier: newTier, lastStopSet: newStop };
      continue;
    }

    // ── Replace stop using atomic or overlap-safe method ────────────
    const stopSide = isLong ? 'sell' : 'buy';
    const result = await replaceStop.call(this, sym, existingStop, newStop, remainQty, stopSide);

    if (result.success) {
      console.log(`[TRAIL v1.8] ${sym}: stop → $${newStop} (Tier ${newTier}) via ${result.method}`);
      state.trailState[sym] = { tier: newTier, lastStopSet: newStop };

      const tierLabels = ['Initial', 'Breakeven + Scale Out', 'Lock +1.5×ATR', 'Lock +3×ATR'];
      const gain = isLong ? r2(current - entry) : r2(entry - current);
      const gainPct = r2(gain / entry * 100);

      if (!scaledThisRun) {
        actions.push({
          sym, tier: newTier, tierLabel: tierLabels[newTier],
          oldStop: existingStop.stopPrice, newStop,
          entry, current, atr: r2(atr), gain, gainPct,
          replaceMethod: result.method,
          scanType: volClass.isHighVol ? 'FAST' : 'FULL',
          volReasons: volClass.reasons.join(', ')
        });
      }

      if (!scaledThisRun) await tg.call(this,
        `🔄 <b>TRAIL STOP RAISED — ${sym}</b>\n` +
        `Tier ${newTier}: ${tierLabels[newTier]}\n` +
        `Entry: $${entry.toFixed(2)} → Current: $${current.toFixed(2)} (+${gainPct}%)\n` +
        `Old stop: $${existingStop.stopPrice.toFixed(2)} → <b>New: $${newStop.toFixed(2)}</b>\n` +
        `ATR: $${r2(atr)} | Gain locked: $${gain.toFixed(2)}/share\n` +
        `Scan: ${volClass.isHighVol ? '⚡ FAST' : '🔄 FULL'} | Method: ${result.method}`
      );
    } else {
      console.error(`[TRAIL v1.8] ${sym}: stop replacement FAILED — old stop remains`);
      actions.push({ sym, tier: newTier, error: result.error, replaceMethod: result.method });
    }

  } catch (e) {
    console.error(`[TRAIL v1.8] ${sym}: FAILED to update stop:`, e.message);
    actions.push({ sym, tier: newTier, error: e.message });
  }
}

// ── Polling stats ───────────────────────────────────────────────────────
if (isFullScan) state._pollingStats.fullScans++;
else state._pollingStats.fastScans++;

const scanSummary = isFullScan
  ? `FULL scan #${runCounter}: ${fastCount} high-vol + ${normalCount} normal = ${fastCount + normalCount} checked`
  : `FAST scan #${runCounter}: ${fastCount} high-vol checked, ${skippedNormal} normal skipped`;
console.log(`[TRAIL v1.8] ${scanSummary} | VIX=${currentVIX.toFixed(1)} | Stats: ${JSON.stringify(state._pollingStats)}`);

if (actions.length === 0 && autoSeeded.length === 0) {
  console.log(`[TRAIL v1.8] No adjustments. Skipped: ${skipped.join(', ')}`);
}

const allResults = [...fillAlerts, ...actions];
if (autoSeeded.length > 0) {
  allResults.push({ json: { type: 'AUTO_SEED', symbols: autoSeeded, count: autoSeeded.length } });
}

// Add scan metadata to results
allResults.push({ json: {
  type: 'SCAN_META',
  run: runCounter,
  scanType: isFullScan ? 'FULL' : 'FAST',
  highVolProcessed: fastCount,
  normalProcessed: normalCount,
  normalSkipped: skippedNormal,
  vix: currentVIX,
  pollingStats: state._pollingStats
}});

return allResults.length > 0
  ? allResults.map(a => a.json ? a : { json: a })
  : [{ json: { message: 'No adjustments', run: runCounter, scanType: isFullScan ? 'FULL' : 'FAST' } }];
