// QTP_REGIME_V2_SECTORS_20260722 (PO-directed): index-level context for regime detection.
// v2 FIX: v1 daily-bars call had NO start param -> Alpaca returned only today's partial bar ->
//   spyPrev==spyLast -> day returns were 0.0000 and trend was CHOP on EVERY row since 07-08.
//   Now uses the snapshot endpoint (prevDailyBar), same pattern as the Broad Scanner.
// v2 ADD: DIA, IWM + 11 SPDR sector ETFs persisted into inputs.sectors (jsonb, no schema change)
//   + sector breadth counts. TAG-ONLY unchanged: nothing gates on this.
const helpers = this.helpers;
const gate = $('Market Hours Gate').first().json;
const thesisRow = ($input.first() && $input.first().json) ? $input.first().json : {};
let key = null;
let secret = null;
let keySource = null;
try {
  if (typeof $vars !== 'undefined' && $vars) {
    key = $vars.ALPACA_API_KEY || $vars.ALPACA_KEY_ID || null;
    secret = $vars.ALPACA_SECRET || $vars.ALPACA_SECRET_KEY || null;
    if (key) { key = String(key); }
    if (secret) { secret = String(secret); }
    keySource = 'vars.ALPACA';
  }
} catch (e) { }
if (!key || !secret) { throw new Error('REGIME_SVC_NO_ALPACA_CRED: seed n8n instance variables ALPACA_API_KEY (or ALPACA_KEY_ID) and ALPACA_SECRET (or ALPACA_SECRET_KEY). No silent fallback.'); }
const today = gate.trade_date;
async function getJson(url, name) {
  const res = await helpers.httpRequest({ url: url, method: 'GET', headers: { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret }, json: true, timeout: 20000 });
  if (!res) throw new Error('REGIME_SVC_EMPTY_RESPONSE: ' + name);
  return res;
}
const dataBase = 'https://data.alpaca.markets';
const ETFS = ['SPY','QQQ','DIA','IWM','XLK','XLF','XLV','XLE','XLY','XLP','XLI','XLU','XLB','XLRE','XLC'];
const SECTOR_ONLY = ['XLK','XLF','XLV','XLE','XLY','XLP','XLI','XLU','XLB','XLRE','XLC'];
const snapResp = await getJson(dataBase + '/v2/stocks/snapshots?symbols=' + ETFS.join(',') + '&feed=iex', 'SNAPSHOTS');
function snapFor(sym) { return (snapResp && (snapResp[sym] || (snapResp.snapshots && snapResp.snapshots[sym]))) || null; }
function lastPx(s) { return (s && ((s.latestTrade && s.latestTrade.p) || (s.minuteBar && s.minuteBar.c) || (s.dailyBar && s.dailyBar.c))) || 0; }
function dayPct(sym, required) {
  const s = snapFor(sym);
  const prev = s && s.prevDailyBar && s.prevDailyBar.c;
  const last = lastPx(s);
  if (!(prev > 0) || !(last > 0)) {
    if (required) throw new Error('REGIME_SVC_NO_SNAPSHOT: ' + sym);
    return null;
  }
  return (last / prev - 1) * 100;
}
const spyRet = dayPct('SPY', true);
const qqqRet = dayPct('QQQ', true);
const sectors = {};
for (const s of ETFS) { if (s === 'SPY' || s === 'QQQ') continue; const p = dayPct(s, false); if (p !== null) sectors[s] = Number(p.toFixed(2)); }
const sectorsUp = SECTOR_ONLY.filter(function (k) { return sectors[k] > 0; }).length;
const sectorsDn = SECTOR_ONLY.filter(function (k) { return sectors[k] < 0; }).length;
// Intraday 5-min bars: SPY only, for realized-vol label (unchanged logic).
const barsResp = await getJson(dataBase + '/v2/stocks/bars?symbols=SPY&timeframe=5Min&start=' + today + 'T00:00:00Z&limit=1000&adjustment=all&feed=iex', 'INTRADAY_BARS');
const barsMap = (barsResp && barsResp.bars) ? barsResp.bars : {};
const spyBars = Array.isArray(barsMap.SPY) ? barsMap.SPY : [];
if (spyBars.length === 0) { throw new Error('REGIME_SVC_NO_BARS: SPY returned no 5-min bars for ' + today); }
const spySnap = snapFor('SPY');
const qqqSnap = snapFor('QQQ');
const spyLast = lastPx(spySnap);
const qqqLast = lastPx(qqqSnap);
const spyPrevC = spySnap.prevDailyBar.c;
const qqqPrevC = qqqSnap.prevDailyBar.c;
let trend = 'CHOP';
if (spyRet >= 0.25 && qqqRet >= 0.25) trend = 'RISK_ON';
else if (spyRet <= -0.25 && qqqRet <= -0.25) trend = 'RISK_OFF';
const closes = spyBars.map(function (b) { return b.c; });
const rets = [];
for (let i = 1; i < closes.length; i++) { if (closes[i] > 0 && closes[i - 1] > 0) { rets.push(Math.log(closes[i] / closes[i - 1])); } }
const tail = rets.slice(-24);
if (tail.length < 2) { throw new Error('REGIME_SVC_INSUFFICIENT_BARS: only ' + closes.length + ' SPY 5-min bars for ' + today); }
const mean = tail.reduce(function (a, b) { return a + b; }, 0) / tail.length;
const variance = tail.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / tail.length;
const rvolBp = Math.sqrt(variance) * 10000;
let vol = 'NORMAL';
if (rvolBp < 8) { vol = 'LOW'; } else if (rvolBp <= 16) { vol = 'NORMAL'; } else if (rvolBp <= 30) { vol = 'ELEVATED'; } else { vol = 'EXTREME'; }
const blockKey = today + 'x' + trend + 'x' + vol;
const thesisRaw = (thesisRow.market_regime === undefined || thesisRow.market_regime === null) ? null : String(thesisRow.market_regime);
const thesisNorm = thesisRaw ? thesisRaw.trim().toUpperCase() : null;
const knownVocab = ['RISK_ON', 'RISK_OFF', 'CHOP'];
let agreement = null;
if (thesisNorm && knownVocab.indexOf(thesisNorm) >= 0) { agreement = (thesisNorm === trend); }
const methodVersion = 'QTP_REGIME_V2_SECTORS_20260722';
const nBars = spyBars.length;
const inputs = { spyPrev: spyPrevC, spyLast: spyLast, qqqPrev: qqqPrevC, qqqLast: qqqLast, nBars: nBars, sectors: sectors, sectors_up: sectorsUp, sectors_dn: sectorsDn };
const notes = 'exec_mode=' + (gate.exec_mode || 'unknown') + '; key_source=' + keySource + '; rvol_window=' + tail.length + '; v2_snapshot_prevclose_fix';
function sq(s) { return String(s).replace(/\$/g, '').replace(/'/g, "''"); }
function num(x, name) { if (!isFinite(x)) { throw new Error('REGIME_SVC_NAN: ' + name); } return Number(x.toFixed(4)); }
const spyRetR = num(spyRet, 'spy_day_ret_pct');
const qqqRetR = num(qqqRet, 'qqq_day_ret_pct');
const rvolR = num(rvolBp, 'spy_rvol_5m_bp');
const thesisSql = thesisRaw ? ("'" + sq(thesisRaw) + "'") : 'NULL';
const agreementSql = agreement === null ? 'NULL' : (agreement ? 'TRUE' : 'FALSE');
const inputsSql = sq(JSON.stringify(inputs));
const insertSql = "INSERT INTO quantum.regime_state (regime_id, trade_date, trend_regime, volatility_regime, regime_block_key, spy_day_ret_pct, qqq_day_ret_pct, spy_rvol_5m_bp, thesis_regime, thesis_agreement, method_version, inputs, notes) " +
  "SELECT '" + sq(gate.regime_id) + "', '" + sq(today) + "'::date, '" + sq(trend) + "', '" + sq(vol) + "', '" + sq(blockKey) + "', " + spyRetR + ", " + qqqRetR + ", " + rvolR + ", " + thesisSql + ", " + agreementSql + ", '" + methodVersion + "', '" + inputsSql + "'::jsonb, '" + sq(notes) + "' " +
  "WHERE NOT EXISTS (SELECT 1 FROM quantum.regime_state WHERE regime_id = '" + sq(gate.regime_id) + "');";
return [{ json: { regime_id: gate.regime_id, trade_date: today, trend_regime: trend, volatility_regime: vol, regime_block_key: blockKey, spy_day_ret_pct: spyRetR, qqq_day_ret_pct: qqqRetR, spy_rvol_5m_bp: rvolR, sectors: sectors, sectors_up: sectorsUp, sectors_dn: sectorsDn, thesis_regime: thesisRaw, thesis_agreement: agreement, method_version: methodVersion, n_bars: nBars, insert_sql: insertSql } }];
