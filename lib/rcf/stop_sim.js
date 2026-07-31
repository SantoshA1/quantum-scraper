'use strict';
/**
 * QTP_RCF_STOP_SIM_v1_20260731 — pure spec-mirror of the Conclave-mandated stop-simulated
 * scoring for the RCF blocked-BUY shadow (live: wf vMwHuEl54Gc2858j "Polygon Backfill Compute").
 *
 * Ruling: drift-only (close-to-close) evidence is INADMISSIBLE for veto policy, because the
 * live book exits ~73% of losses via a ~1%-wide protective stop. This simulation converts
 * drift into realized P&L:
 *   entry  = block-day close (labeled optimistic proxy)
 *   stop   = entry*(1-w) for a LONG, at w in {0.9%, 1.0%, 1.2%}
 *   day+1: if the LOW pierces the stop -> stopped; fill = min(open, stop) (gap-through at open)
 *   else day+2: same test; else unstopped -> ride to the +2d close (no TP leg, matches live)
 *   same-bar ambiguity resolved conservatively (stop checked before any favorable assumption)
 *   MFE/MAE from the two-day highs/lows.
 */
function stopSimLong({ entry, d1, d2, widthPct }) {
  const E = Number(entry);
  const w = Number(widthPct);
  if (!(E > 0) || !(w > 0) || !d1) return { ret: null, stopped: null };
  const stop = E * (1 - w);
  if (Number(d1.l) <= stop) {
    const fill = Number(d1.o) < stop ? Number(d1.o) : stop; // gap-through realizes at open
    return { ret: (fill / E - 1) * 100, stopped: true };
  }
  if (!d2) return { ret: null, stopped: null }; // immature — cannot score yet
  if (Number(d2.l) <= stop) {
    const fill = Number(d2.o) < stop ? Number(d2.o) : stop;
    return { ret: (fill / E - 1) * 100, stopped: true };
  }
  return { ret: (Number(d2.c) / E - 1) * 100, stopped: false };
}

function mfeMae({ entry, d1, d2 }) {
  const E = Number(entry);
  if (!(E > 0) || !d1 || !d2) return { mfe: null, mae: null };
  return {
    mfe: (Math.max(Number(d1.h), Number(d2.h)) / E - 1) * 100,
    mae: (Math.min(Number(d1.l), Number(d2.l)) / E - 1) * 100,
  };
}

module.exports = { stopSimLong, mfeMae };
