'use strict';
/**
 * QTP taken-trade stop-sim spec-mirror (Conclave #3 Q6; live wf NvaywOT4h0mSrFAg "Simulate Bands").
 * Replays a CLOSED real trade entry->actual-exit-day on daily bars under the real-ATR tier ladder
 * with a stop-cap band: stop checked FIRST each day (conservative same-day ordering), gap-through
 * realizes at the open, tier advances on the day's favorable extreme (0.10*ATR epsilon),
 * T1 = breakeven+/-0.05 with the 0.7% trigger floor, T2 lock 1.5*ATR, T3 lock 3*ATR, stops
 * only tighten. Survivors ride to the exit-day close (no TP leg). Relative band evidence only —
 * it does NOT model signal-flip/protective/scale-out exits the real book uses.
 */
function simBand({ side, entry, qty, atr, capPct, bars, floorPct = 0.007 }) {
  const L = String(side) === 'long';
  const E = Number(entry), q = Number(qty), eps = 0.10 * atr, BUF = 0.05;
  const r4 = (x) => Math.round(x * 10000) / 10000;
  const stopDist = Math.min(capPct, (1.5 * atr) / E) * E;
  let stop = L ? E - stopDist : E + stopDist;
  let tier = 0;
  const t1Move = Math.max(1.5 * atr, E * floorPct);
  const trig = [null, t1Move, 3 * atr, 4.5 * atr];
  const lock = [null,
    () => (L ? r4(E - BUF) : r4(E + BUF)),
    () => (L ? r4(E + 1.5 * atr) : r4(E - 1.5 * atr)),
    () => (L ? r4(E + 3 * atr) : r4(E - 3 * atr))];
  for (const b of bars) {
    const hit = L ? b.l <= stop : b.h >= stop;
    if (hit) {
      const fill = L ? Math.min(b.o, stop) : Math.max(b.o, stop); // gap-through at open
      return { reason: tier > 0 ? 'trail_stop' : 'stop', pnl: r4((L ? fill - E : E - fill) * q), tier };
    }
    const fav = L ? b.h : b.l;
    for (let t = 3; t > tier; t--) {
      const need = L ? E + trig[t] : E - trig[t];
      const ok = L ? fav - eps >= need : fav + eps <= need;
      if (ok) { tier = t; stop = L ? Math.max(stop, lock[t]()) : Math.min(stop, lock[t]()); break; }
    }
  }
  const last = bars[bars.length - 1];
  return { reason: 'rode_to_exit', pnl: r4((L ? last.c - E : E - last.c) * q), tier };
}
/** Band C (pre-registered B1): min(1.5*ATR, 2.5%) floored at 0.6% — as a fraction of entry. */
function bandC(atr, entry) { return Math.min(Math.max((1.5 * atr) / entry, 0.006), 0.025); }
module.exports = { simBand, bandC };
