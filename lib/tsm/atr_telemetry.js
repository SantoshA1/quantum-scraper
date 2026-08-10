'use strict';
/**
 * QTP_TSM_ATR_TELEMETRY_v1_20260806 — spec-mirror of the TSM's ATR telemetry emitter
 * (workflow vFnPjyx8srnzcYgV, "Trail Stops" Code node).
 *
 * WHY (2026-08-06 RCA): `QTP_TSM_REAL_ATR_ON` gates the tier ladder's ATR model, but its
 * effect was UNOBSERVABLE — `atrModel` has never appeared in a single one of 17,700+ TSM
 * audit events, and the flag's own value lives only in n8n $vars (not readable from SQL).
 * Worse, this morning's 09:30 ET run showed 5/6 positions exiting via the ORPHAN path
 * (code @42774) and 1 via nested-OCO (@56499) — both short-circuit thousands of lines
 * BEFORE the ATR block (@72066). Nobody could tell, from the database, whether the flag
 * was on, whether the 08-04 bars-window fix was delivering real ATR, or which symbols the
 * REAL-mode clamp would skip.
 *
 * WHAT: an ISOLATED observer branch (deployed 2026-08-06 with the market open, governance
 * 186) — a separate Code node off the same 15-min trigger, so the live Trail Stops risk
 * node stays byte-for-byte unmodified (sha b6bf74f0f301d0e6 verified pre/post). It writes
 * one row per cycle to quantum.tsm_atr_telemetry recording, per symbol:
 *   - bars actually received (proves/refutes the 08-04 bars-window fix, per cycle)
 *   - the ATR the engine WOULD use and its model (REAL / LEGACY_BARS / PROXY_2PCT)
 *   - the REAL-mode ATR-14 and its clamp verdict (PASS / BELOW_FLOOR / ABOVE_CAP / NO_BARS)
 *     — so a flag flip's per-symbol consequence is known BEFORE flipping
 *   - the flag's own state (first time it is visible in SQL at all)
 *
 * SAFETY CONTRACT (non-negotiable — this is telemetry beside a live risk workflow):
 *   - the risk node is NOT edited; the observer is a parallel branch that shares only the
 *     trigger, so it cannot alter stop management even if it fails outright
 *   - fail-silent: any error writes a note='observer_failed: ...' row instead of throwing
 *
 * WHAT IT FOUND IN ITS FIRST CYCLE (exec 524246, 14:00:22Z) — and two claims it corrected:
 *   - real_atr_flag = TRUE. The flag was already ON; it had been unreadable from SQL, and
 *     an inference about it had leaked into a recommendation. Measure, don't infer.
 *   - ORPHAN_ELIGIBLE positions do NOT bypass the tier ladder: the orphan block is a
 *     read-only diagnostic loop running before the main loop. Proof: exec 524111 shows
 *     XPEV in the orphan list AND a tier-1 advance with atr=0.53 (4.27% = REAL, not proxy).
 *   - bars_fix_healthy = true, 33 bars/symbol: the 08-04 bars-window fix is delivering.
 *   - AES real ATR 0.27% < the 0.4% clamp floor -> SKIP_BELOW_FLOOR: silently unmanaged.
 */

const PROXY_PCT = 0.02;
const CLAMP_FLOOR_PCT = 0.004;   // REAL-mode: ATR must be >= 0.4% of entry
const CLAMP_CAP_PCT = 0.06;      // ... and <= 6%
const REAL_ATR_LOOKBACK_BARS = 15;
const VERSION = 'QTP_TSM_ATR_TELEMETRY_v1_20260806';

/** Same ATR as the live engine: mean true range over consecutive bars. */
function calcATR(bars) {
  if (!bars || bars.length < 2) return null;
  let sum = 0;
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].h, l = bars[i].l, pc = bars[i - 1].c;
    sum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  return sum / (bars.length - 1);
}

/** REAL-mode clamp verdict for a candidate ATR — what the flag would do to this symbol. */
function clampVerdict(atr, entry) {
  if (!(atr > 0) || !(entry > 0)) return 'NO_BARS';
  if (atr < entry * CLAMP_FLOOR_PCT) return 'BELOW_FLOOR';
  if (atr > entry * CLAMP_CAP_PCT) return 'ABOVE_CAP';
  return 'PASS';
}

const r4 = (n) => (n == null ? null : Math.round(Number(n) * 10000) / 10000);
const pct = (a, e) => (a > 0 && e > 0 ? Math.round((a / e) * 1000000) / 10000 : null);

/**
 * Build the telemetry payload.
 * positions: [{symbol, avg_entry_price, qty}] · barsData/realBars: {SYM: [bars]}
 * Pure: no I/O, no mutation of inputs.
 */
function buildAtrTelemetry({ positions, barsData, realBars, realAtrOn, t1FloorPct }) {
  const rows = [];
  for (const p of positions || []) {
    const sym = p && p.symbol;
    if (!sym) continue;
    const entry = Number(p.avg_entry_price) || 0;
    const lb = (barsData && barsData[sym]) || [];
    const rb = (realBars && realBars[sym]) || [];
    const atrLegacy = calcATR(lb);
    const atrReal = calcATR(rb.slice(-REAL_ATR_LOOKBACK_BARS));
    // What the engine actually uses THIS cycle, under the current flag state.
    let model, atrUsed;
    if (realAtrOn) {
      const v = clampVerdict(atrReal, entry);
      model = v === 'PASS' ? 'REAL' : 'SKIP_' + v;
      atrUsed = v === 'PASS' ? atrReal : null;
    } else if (atrLegacy > 0) {
      model = 'LEGACY_BARS'; atrUsed = atrLegacy;      // the 08-04 bars fix delivering
    } else {
      model = 'PROXY_2PCT'; atrUsed = entry * PROXY_PCT; // the original silent fallback
    }
    rows.push({
      sym, entry: r4(entry), qty: Number(p.qty) || 0,
      legacy_bars: lb.length, real_bars: rb.length,
      atr_legacy: r4(atrLegacy), atr_legacy_pct: pct(atrLegacy, entry),
      atr_real: r4(atrReal), atr_real_pct: pct(atrReal, entry),
      real_clamp: clampVerdict(atrReal, entry),
      atr_used: r4(atrUsed), atr_used_pct: pct(atrUsed, entry), model,
      proxy_atr_pct: PROXY_PCT * 100,
      // what a flag flip would do to this symbol's T1, in %
      t1_pct_if_real: atrReal > 0 && entry > 0
        ? Math.round(Math.max(1.5 * atrReal / entry * 100, Number(t1FloorPct) || 0.7) * 100) / 100 : null,
      t1_pct_now: atrUsed > 0 && entry > 0
        ? Math.round((realAtrOn ? Math.max(1.5 * atrUsed / entry * 100, Number(t1FloorPct) || 0.7)
                                : 1.5 * atrUsed / entry * 100) * 100) / 100 : null,
    });
  }
  const withBars = rows.filter((r) => r.legacy_bars >= REAL_ATR_LOOKBACK_BARS).length;
  return {
    type: 'ATR_TELEMETRY', sym: 'PORTFOLIO',
    real_atr_flag: !!realAtrOn,                       // <- the flag, finally visible in SQL
    t1_floor_pct: Number(t1FloorPct) || 0.7,
    positions: rows.length,
    legacy_bars_ok: withBars,
    bars_fix_healthy: rows.length > 0 && withBars === rows.length,
    would_skip_if_flag_on: rows.filter((r) => r.real_clamp !== 'PASS').map((r) => r.sym + ':' + r.real_clamp),
    symbols: rows,
    version: VERSION,
  };
}

/**
 * QTP_TSM_ATR_FEED_SHADOW_v2_20260810 — the consolidated-vs-IEX shadow.
 *
 * WHY: all four of the TSM's daily-bars calls hard-code `&feed=iex`, including the REAL_ATR-14
 * fetch that sets the tier ladder. Measured 2026-08-10 on the live book: IEX carries only
 * 4.9%-9.1% of consolidated volume on these names, so its daily bars miss the extremes and
 * ATR-14 comes out LOW on every symbol tested — by 2.27% (XPEV) to 10.45% (AES), mean ~7.5%.
 *
 * The fix is free: on this account the DEFAULT bars feed IS consolidated for historical bars
 * (`default_matches_sip` true on all 8 probed symbols; `feed=iex` returns different bars).
 * Only the REAL-TIME quote path is IEX-gated. So this is not a subscription question — it is
 * a parameter that is throwing away data the account already has.
 *
 * WHY SHADOW FIRST rather than just deleting the parameter: ATR feeds the T1/T2 trail tiers
 * and the REAL-mode clamp. A ~7.5% ATR rise moves live stop tiers on open positions. The
 * observer branch is the one place that can prove the per-symbol tier delta without touching
 * the risk node, so it proves it first and the parameter comes out afterwards.
 *
 * Pure. Takes both bar sets and reports the delta; decides nothing.
 */
function buildFeedShadow({ positions, iexBars, sipBars, t1FloorPct }) {
  const rows = [];
  for (const p of positions || []) {
    const sym = p && p.symbol;
    if (!sym) continue;
    const entry = Number(p.avg_entry_price) || 0;
    const bi = ((iexBars && iexBars[sym]) || []).slice(-REAL_ATR_LOOKBACK_BARS);
    const bs = ((sipBars && sipBars[sym]) || []).slice(-REAL_ATR_LOOKBACK_BARS);
    const ai = calcATR(bi), as = calcATR(bs);
    const floor = Number(t1FloorPct) || 0.7;
    const t1 = (a) => (a > 0 && entry > 0 ? Math.round(Math.max(1.5 * a / entry * 100, floor) * 100) / 100 : null);
    rows.push({
      sym, entry: r4(entry),
      bars_iex: bi.length, bars_sip: bs.length,
      atr_iex: r4(ai), atr_iex_pct: pct(ai, entry),
      atr_sip: r4(as), atr_sip_pct: pct(as, entry),
      // negative = IEX understates, which is the direction thin-venue bars should err in
      atr_iex_vs_sip_pct_diff: (ai > 0 && as > 0) ? Math.round((ai - as) / as * 1000000) / 10000 : null,
      clamp_iex: clampVerdict(ai, entry), clamp_sip: clampVerdict(as, entry),
      // the thing that actually changes on a live position if the parameter is removed
      t1_pct_iex: t1(ai), t1_pct_sip: t1(as),
      t1_delta_pct_points: (t1(ai) != null && t1(as) != null) ? Math.round((t1(as) - t1(ai)) * 100) / 100 : null,
      // a clamp verdict that FLIPS is the one case where the feed change alters whether a
      // symbol is managed at all, rather than merely how widely
      clamp_verdict_flips: clampVerdict(ai, entry) !== clampVerdict(as, entry),
    });
  }
  const withBoth = rows.filter((r) => r.atr_iex_vs_sip_pct_diff != null);
  const diffs = withBoth.map((r) => r.atr_iex_vs_sip_pct_diff);
  return {
    type: 'ATR_FEED_SHADOW', sym: 'PORTFOLIO',
    positions: rows.length,
    n_comparable: withBoth.length,
    iex_understates_on: withBoth.filter((r) => r.atr_iex_vs_sip_pct_diff < 0).length,
    iex_overstates_on: withBoth.filter((r) => r.atr_iex_vs_sip_pct_diff > 0).length,
    mean_atr_diff_pct: diffs.length ? Math.round(diffs.reduce((a, b) => a + b, 0) / diffs.length * 10000) / 10000 : null,
    worst_atr_diff_pct: diffs.length ? Math.min(...diffs) : null,
    max_t1_delta_pct_points: rows.length
      ? Math.max(...rows.map((r) => Math.abs(r.t1_delta_pct_points || 0))) : null,
    clamp_verdict_flips: rows.filter((r) => r.clamp_verdict_flips).map((r) => r.sym + ':' + r.clamp_iex + '->' + r.clamp_sip),
    symbols: rows,
    version: SHADOW_VERSION,
  };
}

const SHADOW_VERSION = 'QTP_TSM_ATR_FEED_SHADOW_v2_20260810';

module.exports = { PROXY_PCT, CLAMP_FLOOR_PCT, CLAMP_CAP_PCT, REAL_ATR_LOOKBACK_BARS, VERSION,
  SHADOW_VERSION, calcATR, clampVerdict, buildAtrTelemetry, buildFeedShadow };
