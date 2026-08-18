// QTP Overnight Gap Exposure v1 — gov 226, 2026-08-18. PO-authorized measurement
// ("measure it first, then decide"): every night a position is held, what did the overnight
// gap do to it, and how often did the open land BEYOND the protective stop — the exposure a
// stop order cannot cover, which carried 59% of all losses on 11% of trades (5-of-46 gap-
// throughs incl. SHW -2.13R) per COHORT-REVIEW-20260814.
//
// ADVISORY ONLY: reads trade_ledger + Alpaca daily bars, writes quantum.overnight_gap_exposure.
// No trading-path table is touched. Idempotent: INSERT ... ON CONFLICT (trade_id, night_date)
// DO NOTHING, so re-runs and the nightly schedule converge on the same rows.
//
// Conventions (documented, deliberately conservative):
//  - A "night" is keyed by the MORNING it resolves (night_date = the day whose open realizes
//    the gap). Nights strictly AFTER entry_day through end_day inclusive — a same-day
//    round-trip has zero nights and produces zero rows. The exit-morning gap IS included:
//    the position was held through that night.
//  - gap_pct           = (open / prior_close - 1) * 100, raw and signed.
//  - adverse_gap_pct   = direction-adjusted loss: long  -> (prior_close - open)/prior_close*100
//                                                   short -> (open - prior_close)/prior_close*100
//    (positive = the gap moved AGAINST the position).
//  - stop_dist_pct     = room between prior close and the stop going into the night:
//                        long -> (prior_close - stop)/prior_close*100 (negative = the stop was
//                        already above the close, e.g. a trailing stop locked in profit).
//  - gap_through_stop  = the open landed beyond the stop (long: open <= stop; short: open >= stop)
//                        while stop_level is known. breach_pct = how far beyond, % of stop level.
//  - FAIL LOUD: missing $vars keys or any bars-fetch failure throws; the execution fails
//    visibly and simply retries next night. Nothing partial is guessed (gov 226 doctrine —
//    the silent-catch calendar-shift bug in the RCF scorer is the witness).
const VERSION='QTP_GAP_EXPOSURE_v1_gov226_20260818';
const rows=$input.all().map(i=>i.json).filter(r=>r&&r.trade_id&&r.symbol&&r.entry_day&&r.end_day);
if(!rows.length){ return [{json:{sql:'SELECT 1;',n:0,note:'no trades in window'}}]; }

let AK=null, AS=null;
try{ if(typeof $vars!=='undefined'&&$vars){ AK=$vars.ALPACA_API_KEY||$vars.ALPACA_KEY_ID||null; AS=$vars.ALPACA_SECRET||$vars.ALPACA_SECRET_KEY||null; } }catch(e){}
if(!AK||!AS){ throw new Error('GAP_EXPOSURE_NO_ALPACA_CRED: n8n variables ALPACA_API_KEY/ALPACA_SECRET_KEY missing. No silent fallback.'); }

const symbols=[...new Set(rows.map(r=>String(r.symbol).toUpperCase()))].filter(s=>/^[A-Z.]{1,6}$/.test(s));
const minDay=rows.map(r=>r.entry_day).sort()[0];
const startD=new Date(minDay+'T00:00:00Z'); startD.setUTCDate(startD.getUTCDate()-6);
const start=startD.toISOString().slice(0,10);
const fetchSyms=[...new Set(['SPY',...symbols])];
const barsBySym={};
for(let i=0;i<fetchSyms.length;i+=60){
  const batch=fetchSyms.slice(i,i+60);
  let pageToken=null;
  do{
    const url='https://data.alpaca.markets/v2/stocks/bars?symbols='+batch.join(',')
      +'&timeframe=1Day&start='+start+'T00:00:00Z&limit=10000&adjustment=all&feed=iex'
      +(pageToken?('&page_token='+encodeURIComponent(pageToken)):'');
    const resp=await this.helpers.httpRequest({method:'GET',url,
      headers:{'APCA-API-KEY-ID':AK,'APCA-API-SECRET-KEY':AS},json:true,timeout:30000});
    const bm=(resp&&resp.bars)||{};
    for(const sym of Object.keys(bm)){ (barsBySym[sym]=barsBySym[sym]||[]).push(...bm[sym]); }
    pageToken=(resp&&resp.next_page_token)||null;
  }while(pageToken);
}
if(!Array.isArray(barsBySym.SPY)||!barsBySym.SPY.length){ throw new Error('GAP_EXPOSURE_NO_CALENDAR: SPY daily bars empty from '+start); }
const tdays=barsBySym.SPY.map(b=>String(b.t).slice(0,10)).sort();
const barMap={};
for(const sym of Object.keys(barsBySym)){
  for(const b of barsBySym[sym]){
    const d=String(b.t).slice(0,10);
    (barMap[d]=barMap[d]||{})[sym]={o:b.o,h:b.h,l:b.l,c:b.c};
  }
}
const r4=x=>Math.round(x*10000)/10000;
const nn=x=>(x===null||x===undefined||!isFinite(x))?'NULL':String(r4(x));
const q=s=>"'"+String(s).replace(/'/g,"''")+"'";
const inserts=[];
for(const t of rows){
  const sym=String(t.symbol).toUpperCase();
  const isLong=String(t.side).toLowerCase().indexOf('buy')===0;
  const stop=Number(t.stop_level)||null;
  const iEntry=tdays.indexOf(t.entry_day);
  if(iEntry<0) continue; // entry day not a known session — refuse to guess
  for(let k=iEntry+1;k<tdays.length;k++){
    const d=tdays[k]; if(d>t.end_day) break;
    const bar=(barMap[d]||{})[sym];
    // prior close: walk back to the nearest earlier session with a bar for this symbol
    let prior=null;
    for(let p=k-1;p>=0&&p>=k-4;p--){ const pb=(barMap[tdays[p]]||{})[sym]; if(pb){prior=pb;break;} }
    if(!bar||!prior||!(prior.c>0)||!(bar.o>0)) continue;
    const gap=(bar.o/prior.c-1)*100;
    const adverse=isLong?((prior.c-bar.o)/prior.c*100):((bar.o-prior.c)/prior.c*100);
    let stopDist=null, through=null, breach=null;
    if(stop&&stop>0){
      stopDist=isLong?((prior.c-stop)/prior.c*100):((stop-prior.c)/prior.c*100);
      through=isLong?(bar.o<=stop):(bar.o>=stop);
      breach=through?(isLong?((stop-bar.o)/stop*100):((bar.o-stop)/stop*100)):0;
    }
    inserts.push('INSERT INTO quantum.overnight_gap_exposure '
      +'(trade_id, symbol, side, night_date, prior_close, open_px, gap_pct, adverse_gap_pct, '
      +'stop_level, stop_dist_pct, gap_through_stop, breach_pct, entry_price, qty, score_version) VALUES ('
      +q(t.trade_id)+'::uuid, '+q(sym)+', '+q(isLong?'long':'short')+', '+q(d)+'::date, '
      +nn(prior.c)+', '+nn(bar.o)+', '+nn(gap)+', '+nn(adverse)+', '
      +nn(stop)+', '+nn(stopDist)+', '+(through===null?'NULL':String(through))+', '+nn(breach)+', '
      +nn(Number(t.entry_price)||null)+', '+nn(Number(t.qty)||null)+', '+q(VERSION)+') '
      +'ON CONFLICT (trade_id, night_date) DO NOTHING;');
  }
}
const sql=inserts.length?inserts.join(String.fromCharCode(10)):'SELECT 1;';
return [{json:{sql,n:inserts.length,trades:rows.length,tdays:tdays.length}}];