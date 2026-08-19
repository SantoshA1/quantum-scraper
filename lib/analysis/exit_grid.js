'use strict';
/**
 * QTP_E1_EXIT_GRID_ENGINE_v1_20260819 (gov 233)
 * Pure, deterministic exit-policy grid engine. No I/O, no clocks, no randomness.
 *
 * Conventions (locked; the Maya suite pins each one):
 *  - bars: ascending array of {d:'YYYY-MM-DD', o,h,l,c}, unique days, gaps allowed
 *    (holidays) — day indexing is by BAR position, not calendar.
 *  - entry: {dir:'long'|'short', entryDay:'YYYY-MM-DD', entryPx}
 *    Day0 = entryDay. Evaluation starts at the first bar STRICTLY AFTER entryDay:
 *    the intraday sequence of day0 is unknowable from daily bars, and the same rule
 *    is applied to every cohort and every cell, so relative comparisons stand.
 *  - ATR14 = simple mean of the last 14 true ranges computed over bars STRICTLY
 *    BEFORE entryDay (no lookahead). Needs >= 15 pre-bars, else null and the trade
 *    is excluded from atr-stop cells only.
 *  - stopSpec: {kind:'pct', v} | {kind:'atr', v} | {kind:'none'}
 *  - exitSpec: {kind:'time', days:N} | {kind:'target2R', days:N} (2R needs a stop;
 *    with stop 'none' the combination is invalid and the trade set is empty)
 *  - Per-day resolution order, CONSERVATIVE:
 *      1) gap at open through the stop  -> STOP filled at the OPEN (worse price)
 *      2) gap at open through the target -> TARGET filled at the OPEN
 *      3) intraday stop reachable  -> STOP at stop price (stop-first: even if the
 *         target was also reachable the same day, the loss is taken)
 *      4) intraday target reachable -> TARGET at target price
 *      5) last day (i === days) -> exit at close
 *  - Maturity rule: a trade enters a cell only if bars cover day1..dayN. Immature
 *    or bar-starved trades return {excluded: reason} for that cell.
 *  - Returns are percent on entry notional: long (exit/entry - 1)*100,
 *    short (entry - exit)/entry*100.
 */

// ENGINE_START gov233_e1 — everything between the sentinels is embedded VERBATIM in the
// one-shot n8n runner node and byte-verified at deploy (region diff must be exit 0).
function splitBars(bars, entryDay) {
  const pre = [], post = [];
  for (const b of bars) {
    if (b.d < entryDay) pre.push(b);
    else if (b.d > entryDay) post.push(b);
  }
  return { pre, post };
}

function atr14(preBars) {
  if (!preBars || preBars.length < 15) return null;
  const w = preBars.slice(-15);
  let sum = 0;
  for (let i = 1; i < w.length; i++) {
    const prevC = w[i - 1].c;
    const tr = Math.max(w[i].h - w[i].l, Math.abs(w[i].h - prevC), Math.abs(w[i].l - prevC));
    sum += tr;
  }
  return sum / 14;
}

function stopPrice(entry, stopSpec, atr) {
  if (stopSpec.kind === 'none') return null;
  if (stopSpec.kind === 'pct') {
    const off = entry.entryPx * (stopSpec.v / 100);
    return entry.dir === 'long' ? entry.entryPx - off : entry.entryPx + off;
  }
  if (stopSpec.kind === 'atr') {
    if (atr === null) return undefined; // excluded from this cell
    const off = stopSpec.v * atr;
    return entry.dir === 'long' ? entry.entryPx - off : entry.entryPx + off;
  }
  throw new Error('unknown stopSpec ' + JSON.stringify(stopSpec));
}

function retPct(entry, exitPx) {
  return entry.dir === 'long'
    ? (exitPx / entry.entryPx - 1) * 100
    : (entry.entryPx - exitPx) / entry.entryPx * 100;
}

function simulate(entry, bars, stopSpec, exitSpec) {
  const { pre, post } = splitBars(bars, entry.entryDay);
  const days = exitSpec.days;
  if (!Number.isInteger(days) || days < 1) return { excluded: 'bad_exit_spec' };
  if (post.length < days) return { excluded: 'immature_window' };

  const atr = atr14(pre);
  const stopPx = stopPrice(entry, stopSpec, atr);
  if (stopPx === undefined) return { excluded: 'no_atr' };

  let targetPx = null;
  if (exitSpec.kind === 'target2R') {
    if (stopPx === null) return { excluded: 'target_needs_stop' };
    const r = Math.abs(entry.entryPx - stopPx);
    targetPx = entry.dir === 'long' ? entry.entryPx + 2 * r : entry.entryPx - 2 * r;
  }

  const long = entry.dir === 'long';
  for (let i = 1; i <= days; i++) {
    const b = post[i - 1];
    // 1) gap through stop at the open
    if (stopPx !== null && (long ? b.o <= stopPx : b.o >= stopPx)) {
      return { ret_pct: retPct(entry, b.o), exit_kind: 'stop', exit_day_index: i, gap_through: true };
    }
    // 2) gap through target at the open
    if (targetPx !== null && (long ? b.o >= targetPx : b.o <= targetPx)) {
      return { ret_pct: retPct(entry, b.o), exit_kind: 'target', exit_day_index: i, gap_through: true };
    }
    // 3) intraday stop (stop-first, conservative)
    if (stopPx !== null && (long ? b.l <= stopPx : b.h >= stopPx)) {
      return { ret_pct: retPct(entry, stopPx), exit_kind: 'stop', exit_day_index: i, gap_through: false };
    }
    // 4) intraday target
    if (targetPx !== null && (long ? b.h >= targetPx : b.l <= targetPx)) {
      return { ret_pct: retPct(entry, targetPx), exit_kind: 'target', exit_day_index: i, gap_through: false };
    }
    // 5) time exit on the last day
    if (i === days) {
      return { ret_pct: retPct(entry, b.c), exit_kind: 'time', exit_day_index: i, gap_through: false };
    }
  }
  /* istanbul ignore next */ throw new Error('unreachable');
}

function aggregate(results) {
  const inc = results.filter((r) => !r.excluded);
  const n = inc.length;
  const wins = inc.filter((r) => r.ret_pct > 0).length;
  let pos = 0, neg = 0;
  for (const r of inc) { if (r.ret_pct > 0) pos += r.ret_pct; else neg += -r.ret_pct; }
  const round = (x, k = 4) => Math.round(x * 10 ** k) / 10 ** k;
  return {
    n,
    excluded: results.length - n,
    wins,
    win_rate: n ? round(wins / n) : null,
    sum_pos_pct: round(pos),
    sum_neg_pct: round(neg),
    pf: neg > 0 ? round(pos / neg) : (pos > 0 ? 999.9999 : null),
    expectancy_pct: n ? round((pos - neg) / n) : null,
    stop_rate: n ? round(inc.filter((r) => r.exit_kind === 'stop').length / n) : null,
    target_rate: n ? round(inc.filter((r) => r.exit_kind === 'target').length / n) : null,
    time_rate: n ? round(inc.filter((r) => r.exit_kind === 'time').length / n) : null,
    gap_through_stops: inc.filter((r) => r.exit_kind === 'stop' && r.gap_through).length,
  };
}

const DEFAULT_STOPS = [
  { key: 'pct_1.0', kind: 'pct', v: 1.0 },
  { key: 'pct_2.0', kind: 'pct', v: 2.0 },
  { key: 'pct_2.5', kind: 'pct', v: 2.5 },
  { key: 'pct_3.0', kind: 'pct', v: 3.0 },
  { key: 'atr_1.5', kind: 'atr', v: 1.5 },
  { key: 'atr_2.5', kind: 'atr', v: 2.5 },
  { key: 'none', kind: 'none' },
];
const DEFAULT_EXITS = [
  { key: 'time_1d', kind: 'time', days: 1 },
  { key: 'time_2d', kind: 'time', days: 2 },
  { key: 'time_3d', kind: 'time', days: 3 },
  { key: 'time_5d', kind: 'time', days: 5 },
  { key: 'target2R_5d', kind: 'target2R', days: 5 },
];

function runGrid(trades, barsBySymbol, stops = DEFAULT_STOPS, exits = DEFAULT_EXITS) {
  const cells = [];
  for (const stop of stops) {
    for (const exit of exits) {
      if (exit.kind === 'target2R' && stop.kind === 'none') continue; // R undefined
      const results = trades.map((t) => {
        const bars = barsBySymbol[t.symbol];
        if (!bars || bars.length === 0) return { excluded: 'no_bars' };
        return simulate(t, bars, stop, exit);
      });
      cells.push({ stop_key: stop.key, exit_key: exit.key, ...aggregate(results) });
    }
  }
  return cells;
}

// ENGINE_END gov233_e1

module.exports = { splitBars, atr14, stopPrice, retPct, simulate, aggregate, runGrid, DEFAULT_STOPS, DEFAULT_EXITS };
