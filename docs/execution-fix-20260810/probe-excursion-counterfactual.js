// QTP EXCURSION COUNTERFACTUAL PROBE — 2026-08-10 (read-only; no orders; no writes)
// n8n workflow DBlNKVkMum20ja5o, execution 546937, archived immediately after.
//
// Settles two questions with 1-MINUTE bars over each trade's ACTUAL holding window — the
// resolution daily bars could not give, and which the stop-width brief explicitly named as
// the missing measurement.
//   Q1  Does a trade ever travel far enough for the TSM's tier-1 trail to engage?
//       T1 fires at max(1.5 x dailyATR14 / entry, 0.7%). Compare against MFE.
//   Q2  THE COUNTERFACTUAL: the live 1.2% entry stop did not exist for any of these trades.
//       Would it have fired? For every WINNER, if MAE reached 1.2% at any point before the
//       real exit, the current configuration would have converted that winner into a loss.
//
// CONSERVATIVE BY CONSTRUCTION: bars are requested with start = the entry timestamp, so the
// partial bar containing the fill is EXCLUDED. That understates both excursions, which biases
// AGAINST the hypothesis that the tight stop is harmful. Deliberate — a number used to argue
// for loosening a risk control should err toward not arguing for it.
//
// Consolidated feed (no feed override) — measured 2026-08-10 to be SIP for historical bars on
// this account. Credentials referenced via $vars by NAME only; never read, logged or exported.
// Trade set: analysis/trades_20260810.json, pulled under the same R3 filters Gate-K uses.
// Spec-mirror lib/analysis/excursion.js · suite tests/test-excursion-counterfactual.js (16/16).
const K = $vars.ALPACA_API_KEY || $vars.ALPACA_KEY_ID;
const S = $vars.ALPACA_SECRET_KEY || $vars.ALPACA_SECRET;
const H = { 'APCA-API-KEY-ID': K, 'APCA-API-SECRET-KEY': S };
const DATA = 'https://data.alpaca.markets';
const CLAMP_PCT = 1.2;      // the live entry stop
const T1_FLOOR_PCT = 0.7;   // QTP_TSM_T1_FLOOR_PCT default
const get = async (u) => { try { return { ok:true, body: await this.helpers.httpRequest({ method:'GET', url:u, headers:H, json:true, timeout:20000 }) }; } catch (e) { return { ok:false, msg:String(e.message||e).slice(0,160) }; } };
const T = /* analysis/trades_20260810.json, as [sym,side,entry,stop,target,entryISO,exitISO,exitReason,R,pnl] */ [];

// daily ATR-14 at entry, one batched fetch
const syms = Array.from(new Set(T.map(r=>r[0])));
let daily = {};
for (let i=0;i<syms.length;i+=12) {
  const r = await get(DATA + '/v2/stocks/bars?symbols=' + syms.slice(i,i+12).join(',') + '&timeframe=1Day&start=2026-05-15&limit=10000&adjustment=all&sort=asc');
  if (r.ok) Object.assign(daily, r.body.bars || {});
}
const atr14 = (b,i) => { if (i<14) return null; let s=0; for (let k=i-13;k<=i;k++) s+=Math.max(b[k].h-b[k].l, Math.abs(b[k].h-b[k-1].c), Math.abs(b[k].l-b[k-1].c)); return s/14; };
const r3 = n => n==null?null:Math.round(n*1000)/1000;
const med = a => { const x=[...a].sort((p,q)=>p-q), n=x.length; return n?(n%2?x[(n-1)/2]:(x[n/2-1]+x[n/2])/2):null; };

const rows = [];
for (const [sym,side,e,st,tp,eiso,xiso,rz,R,pnl] of T) {
  const db = daily[sym] || [];
  let di=-1; for (let k=0;k<db.length;k++){ if (String(db[k].t).slice(0,10) < eiso.slice(0,10)) di=k; else break; }
  const a = atr14(db, di);
  const bars = await get(DATA + '/v2/stocks/bars?symbols=' + sym + '&timeframe=1Min&start=' + encodeURIComponent(eiso) + '&end=' + encodeURIComponent(xiso) + '&limit=10000&adjustment=all&sort=asc');
  const mb = (bars.ok && bars.body.bars && bars.body.bars[sym]) || [];
  const long = side === 'buy';
  let mfe = 0, mae = 0, firstBreachIdx = null;
  for (let k=0;k<mb.length;k++) {
    const fav = long ? (mb[k].h - e) : (e - mb[k].l);   // long profits on the HIGH, short on the LOW
    const adv = long ? (e - mb[k].l) : (mb[k].h - e);
    if (fav > mfe) mfe = fav;
    if (adv > mae) mae = adv;
    if (firstBreachIdx === null && adv / e * 100 >= CLAMP_PCT) firstBreachIdx = k;  // FIRST touch
  }
  const mfePct = e>0 ? mfe/e*100 : null, maePct = e>0 ? mae/e*100 : null;
  const t1Pct = (a>0 && e>0) ? Math.max(1.5*a/e*100, T1_FLOOR_PCT) : null;
  rows.push({ sym, side, exit_reason: rz, R, pnl, minute_bars: mb.length, bars_ok: bars.ok,
    entry: e, atr14: r3(a), atr14_pct: r3(a&&e? a/e*100 : null),
    mfe_pct: r3(mfePct), mae_pct: r3(maePct),
    mfe_in_ATR: r3(a? mfe/a : null), mae_in_ATR: r3(a? mae/a : null),
    t1_threshold_pct: r3(t1Pct),
    reached_t1: (t1Pct!=null && mfePct!=null) ? (mfePct >= t1Pct) : null,
    clamped_stop_would_fire: maePct!=null ? (maePct >= CLAMP_PCT) : null,
    minutes_to_first_breach: firstBreachIdx, hold_minutes: mb.length,
    breach_frac_of_hold: (firstBreachIdx!=null && mb.length) ? r3(firstBreachIdx/mb.length) : null,
    is_winner: R > 0 });
}

const ok = rows.filter(r=>r.bars_ok && r.minute_bars > 0);
const W = ok.filter(r=>r.is_winner), L = ok.filter(r=>!r.is_winner);
const killed = W.filter(r=>r.clamped_stop_would_fire);
const t1 = ok.filter(r=>r.reached_t1);
return [{ json: {
  probe:'EXCURSION_COUNTERFACTUAL_v1', at:new Date().toISOString(),
  n_trades: rows.length, n_with_minute_bars: ok.length,
  no_bars: rows.filter(r=>!r.bars_ok || r.minute_bars===0).map(r=>r.sym+':'+(r.bars_ok?'empty':'fetch_failed')),
  Q1_tier1: { reached_t1: t1.length, of: ok.length,
    median_t1_threshold_pct: r3(med(ok.filter(r=>r.t1_threshold_pct!=null).map(r=>r.t1_threshold_pct))),
    median_mfe_pct: r3(med(ok.map(r=>r.mfe_pct))),
    median_mfe_in_ATR: r3(med(ok.filter(r=>r.mfe_in_ATR!=null).map(r=>r.mfe_in_ATR))),
    winners_reaching_t1: W.filter(r=>r.reached_t1).length, of_winners: W.length },
  Q2_counterfactual: {
    winners: W.length,
    winners_the_1p2_stop_would_have_killed: killed.length,
    killed_symbols: killed.map(r=>r.sym+' (R'+r.R+', MAE '+r.mae_pct+'%)'),
    winner_pnl_at_risk: r3(killed.reduce((x,y)=>x+y.pnl,0)),
    total_winner_pnl: r3(W.reduce((x,y)=>x+y.pnl,0)),
    losers_that_also_breached: L.filter(r=>r.clamped_stop_would_fire).length, of_losers: L.length,
    all_trades_breaching_1p2: ok.filter(r=>r.clamped_stop_would_fire).length,
    median_mae_pct: r3(med(ok.map(r=>r.mae_pct))),
    median_mae_in_ATR: r3(med(ok.filter(r=>r.mae_in_ATR!=null).map(r=>r.mae_in_ATR))),
    median_breach_frac_of_hold: r3(med(ok.filter(r=>r.breach_frac_of_hold!=null).map(r=>r.breach_frac_of_hold))) },
  rows
} }];
