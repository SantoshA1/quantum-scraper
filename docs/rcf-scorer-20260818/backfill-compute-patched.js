// Conclave ruling 07-31 #2: drift-only DEPRECATED as deciding metric. This node computes
// STOP-SIMULATED scoring per the Q2 spec: long entry = block-day close; protective stop at a
// 0.9%/1.0%/1.2% sensitivity band; stop evaluated on NEXT-DAY INTRADAY LOWS (+1d then +2d);
// gap-through realizes at the open (not the intended stop); unstopped winners ride to the +2d
// close (no TP leg, matches live); same-bar ambiguity resolved conservatively (stop checked first);
// MFE/MAE recorded. Drift columns kept for continuity.
//
// v2 gov 226 (2026-08-18), three changes, PO-authorized:
//  1. DATA SOURCE: Polygon grouped-daily (whole US market per day, ~30 calls, HARD-CODED api key
//     literal in this node) -> Alpaca multi-symbol daily bars, keys read from n8n variables BY
//     NAME ($vars.ALPACA_API_KEY / ALPACA_SECRET_KEY, same proven pattern as the Regime Service
//     and the Taken-Trade Stop-Sim). The old key literal is gone from the bytes; rotate it.
//     Trading-day calendar now anchors on SPY's bar dates (SPY trades every session).
//  2. FAIL LOUD: the old per-day try/catch silently dropped failed days from the calendar,
//     which shifted +1d/+2d indexing onto WRONG days, and COALESCE guards then froze the wrong
//     numbers forever. Any fetch failure now throws — the execution fails visibly, pending rows
//     simply retry tomorrow, and nothing half-right is ever written.
//  3. +6d HORIZON (the real ~5.6-day mean holding period, the measurement the PO actually
//     authorized): fwd6_close / hypo_6d_ret_pct, plus a walk-forward 1.0%-stop simulation over
//     d1..d6 (ss6_ret_10 / ss6_stopped_10) — gap-through realizes at the open, unstopped exits
//     at the d6 close. A row's 6d fields stay NULL until the horizon matures; the pending query
//     keeps re-selecting it until they fill.
const rows=$input.all().map(i=>i.json).filter(r=>r&&r.id!=null);
const r4=x=>Math.round(x*10000)/10000;
const snapSql="INSERT INTO quantum.rcf_shadow_verdict_daily (snap_day,horizon,n,mean_ret_pct,would_win_pct,profit_factor)\nSELECT (now() AT TIME ZONE 'America/New_York')::date,horizon,n,mean_ret_pct,would_win_pct,profit_factor FROM quantum.v_rcf_shadow_verdict\nON CONFLICT (snap_day,horizon) DO UPDATE SET n=EXCLUDED.n,mean_ret_pct=EXCLUDED.mean_ret_pct,would_win_pct=EXCLUDED.would_win_pct,profit_factor=EXCLUDED.profit_factor,captured_at=now();";
if(!rows.length){return [{json:{sql:snapSql,n:0,note:'no pending rows'}}];}

let AK=null, AS=null;
try{ if(typeof $vars!=='undefined'&&$vars){ AK=$vars.ALPACA_API_KEY||$vars.ALPACA_KEY_ID||null; AS=$vars.ALPACA_SECRET||$vars.ALPACA_SECRET_KEY||null; } }catch(e){}
if(!AK||!AS){ throw new Error('RCF_SCORER_NO_ALPACA_CRED: n8n variables ALPACA_API_KEY/ALPACA_SECRET_KEY missing. No silent fallback (gov 226).'); }

const symbols=[...new Set(rows.map(r=>String(r.symbol).toUpperCase()))].filter(s=>/^[A-Z.]{1,6}$/.test(s));
const days=[...new Set(rows.map(r=>r.block_day))].sort();
const startD=new Date(days[0]+'T00:00:00Z'); startD.setUTCDate(startD.getUTCDate()-1);
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
if(!Array.isArray(barsBySym.SPY)||!barsBySym.SPY.length){ throw new Error('RCF_SCORER_NO_CALENDAR: SPY daily bars empty from '+start+' — refusing to index horizons against an unknown calendar.'); }
const tdays=barsBySym.SPY.map(b=>String(b.t).slice(0,10)).sort();
const barMap={};
for(const sym of Object.keys(barsBySym)){
  for(const b of barsBySym[sym]){
    const d=String(b.t).slice(0,10);
    (barMap[d]=barMap[d]||{})[sym]={o:b.o,h:b.h,l:b.l,c:b.c};
  }
}
const BANDS=[['09',0.009],['10',0.010],['12',0.012]];
const ups=[];
for(const row of rows){
  const i=tdays.indexOf(row.block_day); if(i<0) continue;
  const sym=String(row.symbol).toUpperCase();
  const b0=(barMap[row.block_day]||{})[sym];
  const E=Number(row.block_close)|| (b0?b0.c:null); if(!E) continue;
  const b1=(barMap[tdays[i+1]]||{})[sym]||null;
  const b2=(barMap[tdays[i+2]]||{})[sym]||null;
  const set=['block_close=COALESCE(block_close,'+r4(E)+')'];
  if(b1){ set.push('fwd1_close=COALESCE(fwd1_close,'+r4(b1.c)+')','hypo_1d_ret_pct=COALESCE(hypo_1d_ret_pct,'+r4((b1.c/E-1)*100)+')','d1_open='+r4(b1.o),'d1_high='+r4(b1.h),'d1_low='+r4(b1.l)); }
  if(b2){ set.push('fwd2_close=COALESCE(fwd2_close,'+r4(b2.c)+')','hypo_2d_ret_pct=COALESCE(hypo_2d_ret_pct,'+r4((b2.c/E-1)*100)+')','d2_open='+r4(b2.o),'d2_high='+r4(b2.h),'d2_low='+r4(b2.l)); }
  if(b1){
    for(const [sfx,w] of BANDS){
      const stop=E*(1-w); let ret=null, stopped=null;
      if(b1.l<=stop){ stopped=true; const fill=(b1.o<stop)?b1.o:stop; ret=(fill/E-1)*100; }
      else if(b2){ if(b2.l<=stop){ stopped=true; const fill=(b2.o<stop)?b2.o:stop; ret=(fill/E-1)*100; } else { stopped=false; ret=(b2.c/E-1)*100; } }
      if(ret!==null){ set.push('ss_ret_'+sfx+'='+r4(ret),'ss_stopped_'+sfx+'='+stopped); }
    }
    if(b2){ set.push('mfe_pct='+r4((Math.max(b1.h,b2.h)/E-1)*100),'mae_pct='+r4((Math.min(b1.l,b2.l)/E-1)*100)); }
  }
  // gov 226: the ~5.6-day-hold horizon. +6d close, and a walk-forward 1.0% stop over d1..d6.
  const b6=(barMap[tdays[i+6]]||{})[sym]||null;
  if(b6){ set.push('fwd6_close=COALESCE(fwd6_close,'+r4(b6.c)+')','hypo_6d_ret_pct=COALESCE(hypo_6d_ret_pct,'+r4((b6.c/E-1)*100)+')'); }
  {
    const stop=E*(1-0.010); let ret=null, stopped=null;
    for(let k=1;k<=6;k++){
      const bk=(barMap[tdays[i+k]]||{})[sym]||null; if(!bk) continue;
      if(bk.l<=stop){ stopped=true; const fill=(bk.o<stop)?bk.o:stop; ret=(fill/E-1)*100; break; }
    }
    if(ret===null&&b6){ stopped=false; ret=(b6.c/E-1)*100; }
    if(ret!==null){ set.push('ss6_ret_10=COALESCE(ss6_ret_10,'+r4(ret)+')','ss6_stopped_10=COALESCE(ss6_stopped_10,'+stopped+')'); }
  }
  set.push('computed_at=now()');
  ups.push('UPDATE quantum.rcf_shadow SET '+set.join(', ')+' WHERE id='+row.id+';');
}
const sql=(ups.join(String.fromCharCode(10))||'SELECT 1;')+String.fromCharCode(10)+snapSql;
return [{json:{sql,n:ups.length,tdays:tdays.length,symbols:fetchSyms.length}}];