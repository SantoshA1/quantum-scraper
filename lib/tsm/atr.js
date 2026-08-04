'use strict';
/**
 * ATR spec-mirror + the 2026-08-03 finding (QTP_TSM_ATR_PROXY_BUG):
 * The live TSM fetches daily bars WITHOUT a `start` param and with a small shared `limit`
 * (Alpaca applies `limit` across ALL symbols), so it receives ~1 bar per symbol. calcATR
 * needs >=2 bars -> returns null -> the engine silently falls back to entry*0.02 ("2% proxy").
 * Result: every symbol trades with a fake uniform 2% ATR (verified live: AES real 0.36% vs
 * XPEV real 4.29%, both proxied to 2.00%). Tier triggers and bracket stops inherit the fake.
 * The fix (start param + limit>=symbols*days) is Conclave-gated; the dead-zone shadow now
 * records real_atr nightly for the decision.
 */
function calcATR(bars) {
  if (!bars || bars.length < 2) return null; // <- the live fallback trigger
  let s = 0;
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].h, l = bars[i].l, pc = bars[i - 1].c;
    s += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  return s / (bars.length - 1);
}
/** Engine behavior: real ATR when available, else the 2% proxy. */
function engineAtr(bars, entry) {
  const a = calcATR(bars);
  return (a && a > 0) ? a : Number(entry) * 0.02;
}

/**
 * QTP_TSM_REAL_ATR_v1_20260803 (Conclave A1a+A2, flag-gated default OFF) — decision mirror.
 * Under REAL mode: ATR-14 from corrected bars, frozen at entry for the trade's life,
 * clamped to 0.4%–6% of price; on invalid -> SKIP (never the 2% proxy). Flag off -> legacy engineAtr.
 * @returns {atr:number|null, model:'REAL'|'PROXY', skip:boolean, frozen?:object}
 */
function realAtrDecision({ flagOn, bars, legacyBars, entry, frozen }) {
  const E = Number(entry);
  if (!flagOn) return { atr: engineAtr(legacyBars, E), model: 'PROXY', skip: false };
  if (frozen && frozen.model === 'REAL' && Math.abs(frozen.entry - E) < Math.max(0.01, E * 0.002)) {
    return { atr: frozen.atr, model: 'REAL', skip: false, frozen };
  }
  const ra = calcATR((bars || []).slice(-15));
  if (ra && ra > 0 && ra >= E * 0.004 && ra <= E * 0.06) {
    return { atr: ra, model: 'REAL', skip: false, frozen: { atr: ra, model: 'REAL', entry: E } };
  }
  return { atr: null, model: 'REAL', skip: true }; // invalid -> skip tier update, NO proxy
}

/** Conclave A1a trigger floor: T1 move = max(1.5*ATR, floorPct of entry) when REAL mode is on. */
function t1Move({ flagOn, atr, entry, floorPct = 0.7 }) {
  const base = 1.5 * Number(atr);
  return flagOn ? Math.max(base, Number(entry) * (floorPct / 100)) : base;
}

module.exports = { calcATR, engineAtr, realAtrDecision, t1Move };
