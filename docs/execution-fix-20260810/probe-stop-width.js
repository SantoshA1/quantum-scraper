// QTP STOP-WIDTH EVIDENCE PROBE — 2026-08-10 (read-only; no orders)
// Answers: how wide is the entry stop in units of CONSOLIDATED ATR-14, what would the live
// 1.2% clamp make it, and after a stop fired did price come back through the entry?
//
// METHOD NOTE, and it is load-bearing: recovery is measured on sessions STRICTLY AFTER the
// exit session. An earlier pass included the exit session and reported 79% same-session
// recovery; that is not a claim daily bars can support, because a daily bar cannot say
// whether the session's high came before or after the stop fired. The strictly-after window
// can only UNDERSTATE the effect, which is the right direction for a number used to argue
// for loosening a risk control.
//
// Data feed: the DEFAULT bars feed. Measured on 2026-08-10 to be consolidated (SIP) on this
// account for historical bars — default_matches_sip true on all 8 probed symbols, and
// feed=iex returns different, thinner bars. The TSM hard-codes feed=iex and is therefore
// computing ATR from ~5-9% of volume; see docs/EXECUTION-FIX-RESULT-20260810.md.
//
// SECURITY: credentials referenced via $vars by NAME only; never read, logged or exported.
// Run as a manual-trigger Code node. Archive after use.
//
// Trade set: analysis/trades_20260810.json — public.trade_ledger under the same R3 filters
// Gate-K uses (90d, non-quarantined lineage, risk_amount > 0, stop and fill present).
// Columns: [symbol, side, entry_fill, intended_stop, intended_target, entry_date, exit_date,
//           exit_reason, r_multiple, net_pnl]
const K = $vars.ALPACA_API_KEY || $vars.ALPACA_KEY_ID;
const S = $vars.ALPACA_SECRET_KEY || $vars.ALPACA_SECRET;
const H = { 'APCA-API-KEY-ID': K, 'APCA-API-SECRET-KEY': S };
const DATA = 'https://data.alpaca.markets';
const T = require('./trades_20260810.json');   // in n8n, paste the array inline here

const syms = Array.from(new Set(T.map(r => r[0])));
let bars = {};
for (let i = 0; i < syms.length; i += 12) {
  const r = await this.helpers.httpRequest({ method:'GET', json:true, timeout:15000, headers:H,
    url: DATA + '/v2/stocks/bars?symbols=' + syms.slice(i, i+12).join(',')
       + '&timeframe=1Day&start=2026-05-15&limit=10000&adjustment=all&sort=asc' });
  Object.assign(bars, r.bars || {});
}
const atr14 = (b, i) => { if (i < 14) return null; let s = 0;
  for (let k = i-13; k <= i; k++) s += Math.max(b[k].h-b[k].l, Math.abs(b[k].h-b[k-1].c), Math.abs(b[k].l-b[k-1].c));
  return s/14; };
const med = a => { const x=[...a].sort((p,q)=>p-q), n=x.length; return n ? (n%2 ? x[(n-1)/2] : (x[n/2-1]+x[n/2])/2) : null; };
const r2 = n => n == null ? null : Math.round(n*100)/100;

const rows = [];
for (const [sym, side, e, s, tp, ed, xd, rz, R, pnl] of T) {
  const b = bars[sym] || []; if (!b.length) continue;
  const day = z => String(z.t).slice(0,10);
  let ei = -1; for (let k=0;k<b.length;k++){ if (day(b[k]) <  ed) ei = k; else break; }
  let xi = -1; for (let k=0;k<b.length;k++){ if (day(b[k]) <= xd) xi = k; else break; }
  const a = atr14(b, ei); if (!a) continue;
  const long = side === 'buy';
  const recovAfter = n => { if (xi < 0) return null; const hi = Math.min(xi+n, b.length-1);
    if (xi+1 > hi) return null;                      // too few sessions -> unknown, never a "no"
    for (let k = xi+1; k <= hi; k++) if (long ? b[k].h >= e : b[k].l <= e) return true; return false; };
  const hitTAfter = n => { if (xi < 0 || tp == null) return null; const hi = Math.min(xi+n, b.length-1);
    if (xi+1 > hi) return null;
    for (let k = xi+1; k <= hi; k++) if (long ? b[k].h >= tp : b[k].l <= tp) return true; return false; };
  rows.push({ sym, rz, R, pnl, atrPct: a/e*100, sdATR: Math.abs(e-s)/a,
    tdATR: tp ? Math.abs(tp-e)/a : null, clampATR: (e*0.012)/a,
    n1: recovAfter(1), n3: recovAfter(3), n5: recovAfter(5), t5: hitTAfter(5) });
}
const ST = rows.filter(r => r.rz === 'stop');
const cnt = (arr,k) => ({ yes: arr.filter(r=>r[k]===true).length, no: arr.filter(r=>r[k]===false).length, unknown: arr.filter(r=>r[k]===null).length });
const sum = (a,f) => a.reduce((x,y)=>x+f(y), 0);
const W = rows.filter(r=>r.R>0), L = rows.filter(r=>r.R<=0);
return [{ json: {
  probe: 'STOP_WIDTH_AGG_v3_strictly_after_exit', n_all: rows.length, n_stopped: ST.length,
  atr14_pct_of_entry: { min:r2(Math.min(...rows.map(r=>r.atrPct))), median:r2(med(rows.map(r=>r.atrPct))), max:r2(Math.max(...rows.map(r=>r.atrPct))) },
  stop_dist_in_ATR_as_traded:       { min:r2(Math.min(...rows.map(r=>r.sdATR))),    median:r2(med(rows.map(r=>r.sdATR))),    max:r2(Math.max(...rows.map(r=>r.sdATR))) },
  stop_dist_in_ATR_under_1p2_clamp: { min:r2(Math.min(...rows.map(r=>r.clampATR))), median:r2(med(rows.map(r=>r.clampATR))), max:r2(Math.max(...rows.map(r=>r.clampATR))) },
  median_tightening_factor: r2(med(rows.map(r=>r.sdATR/r.clampATR))),
  n_trades_the_clamp_tightens: rows.filter(r=>r.clampATR < r.sdATR).length,
  target_dist_in_ATR_median: r2(med(rows.filter(r=>r.tdATR).map(r=>r.tdATR))),
  stopped_price_back_through_entry_AFTER_exit: { next_1_session: cnt(ST,'n1'), next_3_sessions: cnt(ST,'n3'), next_5_sessions: cnt(ST,'n5') },
  loss_on_stops_that_recovered_within_3_after: r2(sum(ST.filter(r=>r.n3===true), r=>r.pnl)),
  loss_on_stops_that_did_not_recover_within_5_after: r2(sum(ST.filter(r=>r.n5===false), r=>r.pnl)),
  stopped_then_hit_ORIGINAL_target_within_5_after: cnt(ST,'t5'),
  winners: { n:W.length, median_stop_in_ATR:r2(med(W.map(r=>r.sdATR))) },
  losers:  { n:L.length, median_stop_in_ATR:r2(med(L.map(r=>r.sdATR))) }
} }];
