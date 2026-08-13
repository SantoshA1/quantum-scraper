const HDR = { 'APCA-API-KEY-ID': $vars.ALPACA_API_KEY, 'APCA-API-SECRET-KEY': $vars.ALPACA_SECRET_KEY };
const DATA = 'https://data.alpaca.markets/v2/stocks/bars';
const START = '2026-04-14', END = '2026-08-13';
const syms = $input.all().map(i => String(i.json.sym)).filter(s => /^[A-Za-z.\-]{1,6}$/.test(s));
const CHUNK = 100;
const rows = [];
const diag = { chunks: 0, symbols_req: syms.length, symbols_got: 0, pages: 0, errors: [] };
for (let i = 0; i < syms.length; i += CHUNK) {
  const part = syms.slice(i, i + CHUNK);
  diag.chunks++;
  let token = null, guard = 0;
  do {
    guard++;
    const qs = 'symbols=' + part.join(',') + '&timeframe=1Day&start=' + START + '&end=' + END + '&adjustment=split&feed=iex&limit=10000' + (token ? '&page_token=' + encodeURIComponent(token) : '');
    let resp;
    try {
      resp = await this.helpers.httpRequest({ method: 'GET', url: DATA + '?' + qs, headers: HDR, json: true });
    } catch (e) {
      diag.errors.push('chunk' + diag.chunks + ':' + String(e.message || e).slice(0, 100));
      break;
    }
    diag.pages++;
    const bars = (resp && resp.bars) || {};
    for (const sym of Object.keys(bars)) {
      const arr = bars[sym] || [];
      if (arr.length) diag.symbols_got++;
      for (const b of arr) {
        rows.push({ symbol: sym, d: String(b.t).slice(0, 10), o: Number(b.o), h: Number(b.h), l: Number(b.l), c: Number(b.c), v: Number(b.v || 0) });
      }
    }
    token = (resp && resp.next_page_token) || null;
  } while (token && guard < 25);
}
const BATCH = 2000;
const out = [];
for (let i = 0; i < rows.length; i += BATCH) {
  const vals = rows.slice(i, i + BATCH).map(function (r) {
    const s = r.symbol.replace(/[^A-Za-z.\-]/g, '');
    return "('" + s + "','" + r.d + "'," + r.o + ',' + r.h + ',' + r.l + ',' + r.c + ',' + r.v + ",'iex')";
  }).join(',');
  out.push({ json: { batch_no: out.length + 1, n_rows: Math.min(BATCH, rows.length - i), sql: 'INSERT INTO quantum.scorer_bars_daily (symbol,d,o,h,l,c,v,feed) VALUES ' + vals + ' ON CONFLICT (symbol,d,feed) DO NOTHING;' } });
}
const logSql = 'INSERT INTO quantum.scorer_bars_ingest_log (chunk_no,symbols_req,symbols_got,bars_written,first_d,last_d,note) VALUES (' + diag.chunks + ',' + diag.symbols_req + ',' + diag.symbols_got + ',' + rows.length + ",'" + START + "','" + END + "','pages=" + diag.pages + ' errors=' + diag.errors.length + "');";
out.push({ json: { batch_no: 0, n_rows: 0, summary: true, total_rows: rows.length, diag: diag, sql: logSql } });
return out;
