// Conclave ruling 07-31 #2: drift-only DEPRECATED as deciding metric. This node now also computes
// STOP-SIMULATED scoring per the Q2 spec: long entry = block-day close; protective stop at a
// 0.9%/1.0%/1.2% sensitivity band; stop evaluated on NEXT-DAY INTRADAY LOWS (+1d then +2d);
// gap-through realizes at the open (not the intended stop); unstopped winners ride to the +2d
// close (no TP leg, matches live); same-bar ambiguity resolved conservatively (stop checked first);
// MFE/MAE recorded. Drift columns kept for continuity.
const PK='REDACTED_BY_GOV226_ROTATE_THIS_KEY_0';  // fixture redaction 2026-08-18: real literal removed before commit; key still lives in n8n version history bf5285f3 — ROTATE IT
const rows=$input.all().map(i=>i.json).filter(r=>r&&r.id!=null);
const r4=x=>Math.round(x*10000)/10000;
const snapSql="INSERT INTO quantum.rcf_shadow_verdict_daily (snap_day,horizon,n,mean_ret_pct,would_win_pct,profit_factor)\nSELECT (now() AT TIME ZONE 'America/New_York')::date,horizon,n,mean_ret_pct,would_win_pct,profit_factor FROM quantum.v_rcf_shadow_verdict\nON CONFLICT (snap_day,horizon) DO UPDATE SET n=EXCLUDED.n,mean_ret_pct=EXCLUDED.mean_ret_pct,would_win_pct=EXCLUDED.would_win_pct,profit_factor=EXCLUDED.profit_factor,captured_at=now();";
if(!rows.length){return [{json:{sql:snapSql,n:0,note:'no pending rows'}}];}
const days=[...new Set(rows.map(r=>r.block_day))].sort();
const cal=[]; for(let d=new Date(days[0]+'T00:00:00Z'); d<=new Date(); d.setUTCDate(d.getUTCDate()+1)) cal.push(d.toISOString().slice(0,10));
const barMap={}; const tdays=[];
for(const d of cal){ try{ const r=await this.helpers.httpRequest({method:'GET',url:'https://api.polygon.io/v2/aggs/grouped/locale/us/market/stocks/'+d+'?adjusted=true&apiKey='+PK,json:true,timeout:30000}); const res=r.results||[]; if(res.length){ const m={}; for(const b of res) m[b.T]={o:b.o,h:b.h,l:b.l,c:b.c}; barMap[d]=m; tdays.push(d); } }catch(e){} }
const BANDS=[['09',0.009],['10',0.010],['12',0.012]];
const ups=[];
for(const row of rows){
  const i=tdays.indexOf(row.block_day); if(i<0) continue;
  const b0=(barMap[row.block_day]||{})[row.symbol];
  const E=Number(row.block_close)|| (b0?b0.c:null); if(!E) continue;
  const b1=(barMap[tdays[i+1]]||{})[row.symbol]||null;
  const b2=(barMap[tdays[i+2]]||{})[row.symbol]||null;
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
  set.push('computed_at=now()');
  ups.push('UPDATE quantum.rcf_shadow SET '+set.join(', ')+' WHERE id='+row.id+';');
}
const sql=(ups.join(String.fromCharCode(10))||'SELECT 1;')+String.fromCharCode(10)+snapSql;
return [{json:{sql,n:ups.length,tdays:tdays.length}}];