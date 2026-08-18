
// ── QTP_LLM_SELF_METERING_v1_20260722: exact token/cost log per Anthropic call (fail-open). ──
const QTP_SB_METER_URL = 'https://vdmtwmwpxvohodyrdlon.supabase.co/rest/v1/llm_usage_log';
const QTP_SB_METER_KEY = 'REDACTED0HEADER0BY0GOV227B.REDACTED0PAYLOAD0ROTATE0THIS0SUPABASE0KEY.REDACTED0SIG';  // fixture redaction gov 227b: JWT-shaped Supabase key removed before commit — flagged for the hardcoded-secrets rotation pass
async function qtpMeterLLM(helpers, site, tkr, model, resp) {
  try {
    let u = resp;
    if (typeof u === 'string') { try { u = JSON.parse(u); } catch (pe) { u = null; } }
    u = u && u.usage;
    if (!u) return;
    const inT = Number(u.input_tokens || 0), outT = Number(u.output_tokens || 0);
    if (!(inT + outT > 0)) return;
    const pin = Number((typeof $vars !== 'undefined' && $vars.ANTHROPIC_PRICE_IN_PER_MTOK) || 15);
    const pout = Number((typeof $vars !== 'undefined' && $vars.ANTHROPIC_PRICE_OUT_PER_MTOK) || 75);
    const cost = (inT * pin + outT * pout) / 1e6;
    await helpers.httpRequest({ method: 'POST', url: QTP_SB_METER_URL, headers: { apikey: QTP_SB_METER_KEY, Authorization: 'Bearer ' + QTP_SB_METER_KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify({ call_site: site, model: String(model || ''), ticker: String(tkr || '').slice(0, 12), input_tokens: inT, output_tokens: outT, cost_usd: cost }), timeout: 4000 });
  } catch (me) {}
}

// QTP_CHART_READ_DATA_v1_20260722 (analyst v2.4, PO 'go'): pixel-free daily-chart read replaces the
// broken screenshot vision path. Computes full swing-trader structure from Polygon daily bars
// (trend/MAs/ADX, RSI+divergence, MACD, swing sequences, S/R in ATRs, open gaps, volume character,
// RS vs sector, ex-div + earnings-unknown event risk), Opus reads it, fields land on the existing
// chart_vision_* contract (overwrites enrichment's screenshot shadow downstream). Fail-open.
// Harness-verified execs 435818/435871. Any ticker; runs only on analyzed (post-Bias/SSM) signals.
// QTP_MKT_CONTEXT_v1_20260722 (analyst v2.3): index/sector tape context in prompt + _mkt_* telemetry.
// QTP_ANTHROPIC_MIGRATION_v1.1_20260720 (temperature REMOVED: claude-opus-4-8 400s on explicit temperature).
// Contract preserved: choices[0].message.content + AIJSON tail + _grok_ai_* telemetry names.
const QTP_ANTHROPIC_KEY = String((typeof $vars !== 'undefined' && ($vars.ANTHROPIC_API_KEY || $vars.anthropic_api_key)) || ((($getWorkflowStaticData('global') || {})._credentials || {}).anthropic_api_key) || '').trim();
const QTP_ANTHROPIC_MODEL = String((typeof $vars !== 'undefined' && ($vars.ANTHROPIC_MODEL || $vars.anthropic_model)) || 'claude-opus-4-8').trim();
function qtpAnthropicKeyLooksReal(k) { return typeof k === 'string' && k.startsWith('sk-ant-') && k.length >= 40 && !/PLACEHOLDER|CHANGEME|YOUR[_-]?KEY|EXAMPLE|XXXX/i.test(k); }
function qtpAnthropicText(resp) { if (!resp || !Array.isArray(resp.content)) return ''; let t = ''; for (const b of resp.content) { if (b && b.type === 'text' && b.text) t += b.text; } return t.trim(); }

const item = $input.first().json;

if (!item || !item.ticker) {
  return [{ json: { ...item, choices: [{ message: { content: 'AI analysis unavailable (no signal payload)' } }], _grok_ai_called: false } }];
}

const API_KEY = QTP_ANTHROPIC_KEY;
if (!qtpAnthropicKeyLooksReal(API_KEY)) {
  console.error('[CLAUDE AI ANALYSIS] ANTHROPIC_API_KEY missing/placeholder — passing through without analysis');
  return [{
    json: {
      ...item,
      choices: [{ message: { content: 'AI analysis unavailable (anthropic_api_key missing or placeholder)' } }],
      _grok_ai_called: false,
      _grok_ai_error: 'anthropic_api_key missing or placeholder',
      _ai_provider: 'anthropic', _ai_model: QTP_ANTHROPIC_MODEL
    }
  }];
}

const ticker = item.ticker || 'UNKNOWN';
const execution = item.execution || 'UNKNOWN';
const signalDir = item.signal || 'UNKNOWN';
const price = item.price || '0';
const tf = item.timeframe || '?';
const regime = item.regime || 'UNKNOWN';
const bullScore = item.bull_score || '0';
const bearScore = item.bear_score || '0';
const rsi = item.rsi || 'N/A';
const adx = item.adx || 'N/A';
const macd = item.macd_hist || 'N/A';
const vix = item.vix || 'N/A';
const spyStatus = item.spy_status || 'UNKNOWN';
const qqqStatus = item.qqq_status || 'UNKNOWN';
const caStatus = item.cross_asset_status || 'UNKNOWN';
const optRegime = item.opt_regime || item.options_regime || 'NO_DATA';
const dpRegime = item.dp_regime || 'UNKNOWN';
const caRegime = item.ca_regime || 'UNKNOWN';
const btNet = item.strat_net_pct || '0';
const btTrades = item.strat_total_trades || '0';
const btWr = item.strat_win_rate || '0';
const btSynthetic = String(item.backtest_default_applied ?? '').toLowerCase() === 'true';
const btLine = btSynthetic ? 'SYNTHETIC PLACEHOLDER (defaults injected; NO real trade history exists - disregard backtest entirely, judge on live signal data only)' : `${btNet}% net, ${btTrades} trades, ${btWr}% WR`;
const smRoute = item._sm_route || 'UNKNOWN';
const smAction = item._sm_action || 'UNKNOWN';
const smConf = item._sm_max_confidence || '?';
const smContra = item._sm_contradiction_details || 'none';

// ── QTP_MKT_CONTEXT_v1_20260722: index/sector tape (advisory-only, fail-open) ──
function qtpSicToSector(sic) {
  if (!sic || !isFinite(sic)) return null; const s = Math.floor(sic);
  if (s >= 1300 && s <= 1389) return 'XLE'; if (s >= 1000 && s <= 1499) return 'XLB';
  if (s >= 1500 && s <= 1799) return 'XLI'; if (s >= 2000 && s <= 2199) return 'XLP';
  if (s >= 2200 && s <= 2399) return 'XLY'; if (s >= 2400 && s <= 2799) return 'XLB';
  if (s >= 2830 && s <= 2836) return 'XLV'; if (s >= 2800 && s <= 2899) return 'XLB';
  if (s >= 2900 && s <= 2999) return 'XLE'; if (s >= 3000 && s <= 3199) return 'XLY';
  if (s >= 3200 && s <= 3499) return 'XLB'; if (s >= 3570 && s <= 3579) return 'XLK';
  if (s >= 3500 && s <= 3599) return 'XLI'; if (s >= 3600 && s <= 3699) return 'XLK';
  if (s >= 3711 && s <= 3716) return 'XLY'; if (s >= 3700 && s <= 3799) return 'XLI';
  if (s >= 3826 && s <= 3851) return 'XLV'; if (s >= 3800 && s <= 3899) return 'XLK';
  if (s >= 3900 && s <= 3999) return 'XLY'; if (s >= 4000 && s <= 4799) return 'XLI';
  if (s >= 4800 && s <= 4899) return 'XLC'; if (s >= 4900 && s <= 4999) return 'XLU';
  if (s >= 5000 && s <= 5199) return 'XLI'; if (s >= 5200 && s <= 5999) return 'XLY';
  if (s === 6798) return 'XLRE'; if (s >= 6500 && s <= 6599) return 'XLRE';
  if (s >= 6000 && s <= 6999) return 'XLF'; if (s >= 7000 && s <= 7099) return 'XLY';
  if (s >= 7370 && s <= 7379) return 'XLK'; if (s >= 7800 && s <= 7999) return 'XLC';
  if (s >= 7100 && s <= 7699) return 'XLI'; if (s >= 8000 && s <= 8099) return 'XLV';
  if (s >= 8100 && s <= 8999) return 'XLI'; return null;
}
let _mkt = { _mkt_ctx_version: 'QTP_MKT_CONTEXT_v1_20260722', _mkt_ctx_ok: false };
let mktLine = 'unavailable';
try {
  const _aKey = String((typeof $vars !== 'undefined' && ($vars.ALPACA_API_KEY || $vars.ALPACA_KEY_ID)) || '');
  const _aSec = String((typeof $vars !== 'undefined' && ($vars.ALPACA_SECRET || $vars.ALPACA_SECRET_KEY)) || '');
  if (_aKey && _aSec) {
    let secEtf = null, sicCode = null;
    try {
      const _pk = item._polygon_key;
      if (_pk) {
        const _ov = await this.helpers.httpRequest({ method: 'GET', url: 'https://api.polygon.io/v3/reference/tickers/' + encodeURIComponent(ticker) + '?apiKey=' + _pk, json: true, timeout: 5000 });
        sicCode = Number((_ov && _ov.results && _ov.results.sic_code) || 0);
        secEtf = qtpSicToSector(sicCode);
      }
    } catch (_se) {}
    const _syms = ['SPY', 'QQQ', 'DIA', 'IWM'].concat(secEtf ? [secEtf] : []);
    const _snap = await this.helpers.httpRequest({ method: 'GET', url: 'https://data.alpaca.markets/v2/stocks/snapshots?symbols=' + _syms.join(',') + '&feed=iex', headers: { 'APCA-API-KEY-ID': _aKey, 'APCA-API-SECRET-KEY': _aSec }, json: true, timeout: 6000 });
    const _pct = {};
    for (const s of _syms) {
      const _t = (_snap && (_snap[s] || (_snap.snapshots && _snap.snapshots[s]))) || null;
      const _prev = _t && _t.prevDailyBar && _t.prevDailyBar.c;
      const _last = _t && ((_t.latestTrade && _t.latestTrade.p) || (_t.minuteBar && _t.minuteBar.c) || (_t.dailyBar && _t.dailyBar.c));
      if (_prev > 0 && _last > 0) _pct[s] = Number(((_last / _prev - 1) * 100).toFixed(2));
    }
    if (_pct.SPY !== undefined && _pct.QQQ !== undefined) {
      const _eu = String(execution).toUpperCase();
      const _dir = ['BUY', 'LONG', 'BULLISH'].includes(_eu) ? 1 : (['SELL', 'SHORT', 'BEARISH'].includes(_eu) ? -1 : 0);
      const _benchSym = (secEtf && _pct[secEtf] !== undefined) ? secEtf : 'SPY';
      const _benchPct = _pct[_benchSym];
      let _align = 'NEUTRAL_TAPE';
      if (_dir !== 0 && Math.abs(_benchPct) >= 0.15) _align = (_dir * _benchPct > 0) ? 'WITH_TAPE' : 'AGAINST_TAPE';
      const _fmt = function (v) { return (v > 0 ? '+' : '') + v.toFixed(2) + '%'; };
      mktLine = 'SPY ' + _fmt(_pct.SPY) + ' | QQQ ' + _fmt(_pct.QQQ) + (_pct.DIA !== undefined ? ' | DIA ' + _fmt(_pct.DIA) : '') + (_pct.IWM !== undefined ? ' | IWM ' + _fmt(_pct.IWM) : '') + (secEtf && _pct[secEtf] !== undefined ? ' | sector ' + secEtf + ' ' + _fmt(_pct[secEtf]) : ' | sector: unmapped') + ' -> trade is ' + _align.replace(/_/g, ' ');
      Object.assign(_mkt, { _mkt_ctx_ok: true, _mkt_spy_pct: _pct.SPY, _mkt_qqq_pct: _pct.QQQ, _mkt_dia_pct: _pct.DIA ?? null, _mkt_iwm_pct: _pct.IWM ?? null, _mkt_sector_etf: secEtf, _mkt_sector_pct: secEtf ? (_pct[secEtf] ?? null) : null, _mkt_sic_code: sicCode || null, _mkt_alignment: _align, _mkt_benchmark: _benchSym });
    }
  } else { _mkt._mkt_ctx_err = 'no_alpaca_vars'; }
} catch (_me) { _mkt._mkt_ctx_err = String(_me.message || _me).slice(0, 200); }

// ── QTP_CHART_READ_DATA_v1_20260722: pixel-free daily chart read (advisory-only, fail-open) ──
async function qtpChartRead(helpers, tkr, pk, secEtf, anthKey, anthModel) {
  const F = { chart_vision_version: 'QTP_CHART_READ_DATA_v1_20260722', chart_vision_status: 'DATA_READ_FAILED_FAIL_OPEN', chart_read_ok: false };
  let line = 'unavailable';
  try {
    const t0 = Date.now();
    const toD = new Date().toISOString().slice(0, 10);
    const frD = new Date(Date.now() - 280 * 864e5).toISOString().slice(0, 10);
    const g = (url, tmo) => helpers.httpRequest({ method: 'GET', url, json: true, timeout: tmo || 12000 });
    const agg = await g('https://api.polygon.io/v2/aggs/ticker/' + encodeURIComponent(tkr) + '/range/1/day/' + frD + '/' + toD + '?adjusted=true&sort=asc&limit=250&apiKey=' + pk);
    const bars = (agg.results || []).slice(-120);
    if (bars.length < 60) { F.chart_vision_status = 'DATA_READ_INSUFFICIENT_BARS'; return { F, line }; }
    const C = bars.map(b => b.c), H = bars.map(b => b.h), L = bars.map(b => b.l), O = bars.map(b => b.o), V = bars.map(b => b.v), T = bars.map(b => new Date(b.t).toISOString().slice(0, 10));
    const n = bars.length, last = n - 1, prev = n - 2;
    const r2 = x => Math.round(x * 100) / 100;
    const pct = (a, b) => r2((a / b - 1) * 100);
    const sma = (arr, w, i) => { const s = arr.slice(i - w + 1, i + 1); return s.reduce((a, b) => a + b, 0) / s.length; };
    function emaSeries(arr, w) { const k = 2 / (w + 1); const o2 = [arr[0]]; for (let i = 1; i < arr.length; i++) o2.push(arr[i] * k + o2[i - 1] * (1 - k)); return o2; }
    function rsiSeries(arr, w) { const rs = new Array(arr.length).fill(null); let gg = 0, ll = 0; for (let i = 1; i <= w; i++) { const d = arr[i] - arr[i - 1]; if (d > 0) gg += d; else ll -= d; } gg /= w; ll /= w; rs[w] = 100 - 100 / (1 + (ll === 0 ? 100 : gg / ll)); for (let i = w + 1; i < arr.length; i++) { const d = arr[i] - arr[i - 1]; gg = (gg * (w - 1) + Math.max(d, 0)) / w; ll = (ll * (w - 1) + Math.max(-d, 0)) / w; rs[i] = 100 - 100 / (1 + (ll === 0 ? 100 : gg / ll)); } return rs; }
    let trS = 0, pS = 0, mS = 0; const dxArr = []; let tr0 = 0, p0 = 0, m0 = 0;
    for (let i = 1; i < n; i++) {
      const tr = Math.max(H[i] - L[i], Math.abs(H[i] - C[i - 1]), Math.abs(L[i] - C[i - 1]));
      const up = H[i] - H[i - 1], dn = L[i - 1] - L[i];
      const pdm = (up > dn && up > 0) ? up : 0, mdm = (dn > up && dn > 0) ? dn : 0;
      if (i <= 14) { tr0 += tr; p0 += pdm; m0 += mdm; if (i === 14) { trS = tr0; pS = p0; mS = m0; } continue; }
      trS = trS - trS / 14 + tr; pS = pS - pS / 14 + pdm; mS = mS - mS / 14 + mdm;
      const pdi = 100 * pS / trS, mdi = 100 * mS / trS;
      dxArr.push(100 * Math.abs(pdi - mdi) / Math.max(pdi + mdi, 1e-9));
    }
    let adxV = null; if (dxArr.length >= 14) { adxV = dxArr.slice(0, 14).reduce((a, b) => a + b, 0) / 14; for (let i = 14; i < dxArr.length; i++) adxV = (adxV * 13 + dxArr[i]) / 14; adxV = r2(adxV); }
    const sma20 = sma(C, 20, last), sma50 = sma(C, 50, last), sma100 = sma(C, Math.min(100, n), last);
    const sma20p = sma(C, 20, last - 10), sma50p = sma(C, 50, last - 10);
    const slope = (a, b) => a > b ? 'rising' : 'falling';
    let atrS = 0; for (let i = n - 14; i < n; i++) atrS += Math.max(H[i] - L[i], Math.abs(H[i] - C[i - 1]), Math.abs(L[i] - C[i - 1])); const atr = atrS / 14;
    const rsiArr = rsiSeries(C, 14); const rsiV = r2(rsiArr[last]);
    const e12 = emaSeries(C, 12), e26 = emaSeries(C, 26);
    const macdLine = C.map((_, i) => e12[i] - e26[i]); const sig = emaSeries(macdLine, 9);
    const hist = r2(macdLine[last] - sig[last]); const histPrev = r2(macdLine[prev] - sig[prev]);
    let crossAgo = null; for (let i = last; i > last - 15 && i > 0; i--) { const h1 = macdLine[i] - sig[i], h0 = macdLine[i - 1] - sig[i - 1]; if ((h1 > 0) !== (h0 > 0)) { crossAgo = last - i; break; } }
    const swings = [];
    for (let i = 2; i < n - 2; i++) {
      if (H[i] > H[i-1] && H[i] > H[i-2] && H[i] > H[i+1] && H[i] > H[i+2]) swings.push({ t: T[i], type: 'H', px: H[i] });
      if (L[i] < L[i-1] && L[i] < L[i-2] && L[i] < L[i+1] && L[i] < L[i+2]) swings.push({ t: T[i], type: 'L', px: L[i] });
    }
    const hsAll = swings.filter(s => s.type === 'H').slice(-3), lsAll = swings.filter(s => s.type === 'L').slice(-3);
    const gaps = [];
    for (let i = 1; i < n; i++) { const gp = (O[i] / C[i-1] - 1) * 100; if (Math.abs(gp) >= 0.8) { const filled = gp > 0 ? (Math.min(...L.slice(i)) <= C[i-1]) : (Math.max(...H.slice(i)) >= C[i-1]); gaps.push({ t: T[i], g: r2(gp), edge: r2(C[i-1]), filled }); } }
    const openGaps = gaps.filter(x => !x.filled).slice(-4);
    const sw8 = swings.slice(-8);
    const levels = sw8.map(s => s.px).concat(openGaps.map(x => x.edge));
    const px = C[last];
    const supports = [...new Set(levels.filter(v => v < px))].sort((a, b) => b - a).slice(0, 2);
    const resist = [...new Set(levels.filter(v => v > px))].sort((a, b) => a - b).slice(0, 2);
    const atrDist = v => r2(Math.abs(v - px) / atr);
    const vol20 = V.slice(-20).reduce((a, b) => a + b, 0) / 20; const rvol = r2(V[last] / vol20);
    let upV = 0, dnV = 0; for (let i = n - 20; i < n; i++) { if (C[i] > C[i - 1]) upV += V[i]; else if (C[i] < C[i - 1]) dnV += V[i]; }
    const udRatio = r2(upV / Math.max(dnV, 1));
    const rng = H[last] - L[last]; const closeLoc = rng > 0 ? r2((C[last] - L[last]) / rng * 100) : 50;
    const inside = H[last] < H[prev] && L[last] > L[prev];
    const nr7 = rng <= Math.min(...bars.slice(-7).map(b => b.h - b.l));
    const openGapPct = pct(O[last], C[prev]);
    let divFlag = 'none detected';
    const low20idx = C.slice(-20).indexOf(Math.min(...C.slice(-20))) + (n - 20);
    const high20idx = C.slice(-20).indexOf(Math.max(...C.slice(-20))) + (n - 20);
    if (C[last] <= C[low20idx] * 1.005 && low20idx !== last && rsiArr[last] > rsiArr[low20idx] + 2) divFlag = 'POSSIBLE BULLISH DIVERGENCE (price at/near 20d low, RSI higher than at that low)';
    if (C[last] >= C[high20idx] * 0.995 && high20idx !== last && rsiArr[last] < rsiArr[high20idx] - 2) divFlag = 'POSSIBLE BEARISH DIVERGENCE (price at/near 20d high, RSI lower than at that high)';
    let rsLine = 'unavailable';
    if (secEtf) {
      try {
        const sa = await g('https://api.polygon.io/v2/aggs/ticker/' + secEtf + '/range/1/day/' + frD + '/' + toD + '?adjusted=true&sort=asc&limit=250&apiKey=' + pk);
        const sc = (sa.results || []).slice(-120).map(b => b.c); const m = sc.length - 1;
        if (m >= 20) { const rs5 = r2(pct(C[last], C[last - 5]) - pct(sc[m], sc[m - 5])); const rs20 = r2(pct(C[last], C[last - 20]) - pct(sc[m], sc[m - 20])); rsLine = 'vs sector ' + secEtf + ': 5-day ' + (rs5 > 0 ? '+' : '') + rs5 + ' pts, 20-day ' + (rs20 > 0 ? '+' : '') + rs20 + ' pts (negative = weaker than sector)'; }
      } catch (e2) {}
    }
    let evLine = '';
    try { const dv = await g('https://api.polygon.io/v3/reference/dividends?ticker=' + encodeURIComponent(tkr) + '&ex_dividend_date.gte=' + toD + '&order=asc&sort=ex_dividend_date&limit=1&apiKey=' + pk, 6000); const d0 = dv.results && dv.results[0]; if (d0) evLine += 'Next ex-dividend: ' + d0.ex_dividend_date + ' ($' + d0.cash_amount + '/sh — shorts held through it PAY this). '; else evLine += 'No upcoming ex-dividend found. '; } catch (e3) { evLine += 'Ex-dividend: unavailable. '; }
    let earnLine = 'Earnings date: UNAVAILABLE from data feed — treat as unknown risk within a 2-10 day hold.';
    try { const bz = await g('https://api.polygon.io/benzinga/v1/earnings?ticker=' + encodeURIComponent(tkr) + '&date.gte=' + toD + '&order=asc&limit=1&apiKey=' + pk, 6000); const e0 = bz.results && bz.results[0]; if (e0 && e0.date) earnLine = 'Next earnings: ' + e0.date + (e0.time ? ' (' + e0.time + ')' : '') + '.'; } catch (e4) {}
    const narrative = [
      'PROFESSIONAL DAILY-CHART READ — ' + tkr + ' (' + n + ' sessions to ' + T[last] + '). ATR14 $' + r2(atr) + ' (' + r2(atr / px * 100) + '%).',
      'SESSION: O=' + r2(O[last]) + ' H=' + r2(H[last]) + ' L=' + r2(L[last]) + ' C=' + r2(px) + ' (' + pct(px, C[prev]) + '% day). Opened ' + (openGapPct > 0 ? '+' : '') + openGapPct + '% vs prev close. Close at ' + closeLoc + '% of day range (0=low,100=high). Range ' + r2(rng / atr) + 'x ATR.' + (inside ? ' INSIDE DAY.' : '') + (nr7 ? ' NR7 (narrowest range in 7 — compression).' : ''),
      'Prev session: H=' + r2(H[prev]) + ' L=' + r2(L[prev]) + ' C=' + r2(C[prev]) + '.',
      'TREND: 5d ' + pct(px, C[last - 5]) + '%, 20d ' + pct(px, C[last - 20]) + '%, 60d ' + pct(px, C[last - 60]) + '%.',
      'Swing highs: ' + (hsAll.map(s => r2(s.px) + ' (' + s.t + ')').join(' -> ') || 'n/a') + '. Swing lows: ' + (lsAll.map(s => r2(s.px) + ' (' + s.t + ')').join(' -> ') || 'n/a') + '. (Classify the structure yourself: trending, converging, breaking.)',
      'MAs: SMA20 ' + r2(sma20) + ' (' + slope(sma20, sma20p) + ', price ' + pct(px, sma20) + '%), SMA50 ' + r2(sma50) + ' (' + slope(sma50, sma50p) + ', price ' + pct(px, sma50) + '%), SMA100 ' + r2(sma100) + ' (price ' + pct(px, sma100) + '%). Stack: ' + (px < sma20 && sma20 < sma50 ? 'bearish (price<20<50)' : px > sma20 && sma20 > sma50 ? 'bullish (price>20>50)' : 'mixed') + '.',
      'ADX14: ' + adxV + ' (' + (adxV >= 25 ? 'TRENDING — momentum entries can hold' : adxV >= 20 ? 'transitional' : 'CHOP — favor mean-reversion, fade extremes') + ').',
      'MOMENTUM: RSI14 ' + rsiV + '. Divergence: ' + divFlag + '. MACD hist ' + hist + ' (' + (hist > histPrev ? 'rising' : 'falling') + (crossAgo !== null ? ', last signal cross ' + crossAgo + ' sessions ago' : '') + ').',
      'LEVELS (ATR distance): supports ' + (supports.map(v => r2(v) + ' (' + atrDist(v) + ' ATR below)').join(', ') || 'none mapped') + '; resistances ' + (resist.map(v => r2(v) + ' (' + atrDist(v) + ' ATR above)').join(', ') || 'none mapped') + '.',
      'Ranges: 20d ' + r2(Math.min(...L.slice(-20))) + '-' + r2(Math.max(...H.slice(-20))) + '; 60d ' + r2(Math.min(...L.slice(-60))) + '-' + r2(Math.max(...H.slice(-60))) + '; ' + n + 'd ' + r2(Math.min(...L)) + '-' + r2(Math.max(...H)) + '. Price ' + pct(px, Math.max(...H)) + '% from ' + n + 'd high, +' + pct(px, Math.min(...L)) + '% from ' + n + 'd low.',
      'Open (unfilled) gaps: ' + (openGaps.length ? openGaps.map(x => x.t + ' ' + (x.g > 0 ? '+' : '') + x.g + '% (edge ' + x.edge + ')').join('; ') : 'none') + '.',
      'VOLUME: today ' + rvol + 'x 20d avg. Up-day vs down-day volume (20d): ' + udRatio + ' (>1 accumulation, <1 distribution).',
      'RELATIVE STRENGTH: ' + rsLine + '.',
      'EVENT RISK: ' + evLine + earnLine
    ].join('\n');
    F.chart_read_narrative = narrative.slice(0, 1800);
    const cprompt = 'You are a professional swing trader reading a DAILY chart for a 2-10 day hold. Below is the complete computed structure of the chart (exact data, replaces a chart image). Weigh: trend structure quality (classify the swing sequences yourself), whether the ADX regime supports momentum vs mean-reversion, momentum/divergence, structural room to the next level (risk:reward in ATRs), volume character, relative strength, and event risk. Return STRICT JSON only with keys: chart_score number 0-100 (favorability of the LONG side; below 50 favors short), trend BULLISH/BEARISH/NEUTRAL, pattern short string, confidence number 0-100, key_support number, key_resistance number, swing_room string (one line: structural R:R for the favored direction, in ATRs), risk_flags array of short strings, summary one sentence. Advisory enrichment only.\n\n' + narrative;
    const resp = await helpers.httpRequest({ method: 'POST', url: 'https://api.anthropic.com/v1/messages', headers: { 'x-api-key': anthKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }, body: JSON.stringify({ model: anthModel, max_tokens: 600, messages: [{ role: 'user', content: cprompt }] }), timeout: 22000 });
    await qtpMeterLLM(helpers, 'chart_read', tkr, anthModel, resp);
    let t = ''; if (resp && Array.isArray(resp.content)) { for (const b of resp.content) { if (b && b.type === 'text' && b.text) t += b.text; } }
    const p = JSON.parse(t.replace(/```json|```/g, '').trim());
    F.chart_vision_score = Number(p.chart_score) || 0;
    F.chart_vision_trend = String(p.trend || 'UNKNOWN');
    F.chart_vision_pattern = String(p.pattern || 'UNKNOWN').slice(0, 200);
    F.chart_vision_confidence = Number(p.confidence) || 0;
    F.chart_vision_risk_flags = Array.isArray(p.risk_flags) ? p.risk_flags.join('; ').slice(0, 500) : String(p.risk_flags || '');
    F.chart_vision_summary = String(p.summary || '').slice(0, 800);
    F.chart_key_support = Number(p.key_support) || null;
    F.chart_key_resistance = Number(p.key_resistance) || null;
    F.chart_swing_room = String(p.swing_room || '').slice(0, 300);
    F.chart_vision_status = 'ANALYZED_DATA_READ';
    F.chart_vision_call_mode = 'DATA_READ_POLYGON_DAILY';
    F.chart_vision_provider = 'anthropic_text_over_computed_structure';
    F.chart_vision_completed_at = new Date().toISOString();
    F.chart_read_ok = true;
    F._chart_read_ms = Date.now() - t0;
    line = 'trend ' + F.chart_vision_trend + ', long-score ' + F.chart_vision_score + '/100, pattern "' + F.chart_vision_pattern + '", support ' + F.chart_key_support + ' / resistance ' + F.chart_key_resistance + ', room: ' + F.chart_swing_room + ', flags: ' + F.chart_vision_risk_flags;
  } catch (ce) { F.chart_read_error = String(ce.message || ce).slice(0, 250); }
  return { F: F, line: line };
}
let _chartF = {}; let chartLine = 'unavailable';
try {
  if (item._polygon_key) {
    const _cr = await qtpChartRead(this.helpers, ticker, item._polygon_key, (_mkt && _mkt._mkt_sector_etf) || null, API_KEY, QTP_ANTHROPIC_MODEL);
    _chartF = _cr.F; chartLine = _cr.line;
  } else { _chartF = { chart_vision_status: 'DATA_READ_SKIPPED_NO_POLYGON_KEY', chart_read_ok: false }; }
} catch (_cfe) { _chartF = { chart_read_error: String(_cfe).slice(0, 200), chart_read_ok: false }; }

let grokResponse = null;
let grokError = null;
let content = '';

try {
  const systemPrompt = 'You are a senior quantitative trading analyst. Given a signal snapshot, produce a concise 150-200 word analytical summary covering: (1) direction conviction and key contradictions, (2) market regime alignment, (3) options/dark-pool/cross-asset context, (4) notable risks. When an Index/Sector tape line is provided, explicitly assess whether the trade direction goes WITH or AGAINST the index/sector tape; counter-tape trades require stronger evidence and deserve lower confidence unless the contradicting evidence is compelling. When a Daily chart read line is provided, weigh its trend, structural room (risk:reward) and risk flags; trades against the chart structure or with poor structural room deserve lower confidence. Write prose (not JSON). Be direct, evidence-based, and highlight red flags. End your analysis with one final line in exactly this format: AIJSON:{"action":"BUY"|"SELL"|"HOLD","confidence":<0-100>,"bull_score":<0-100>,"bear_score":<0-100>,"risk_note":"<max 12 words>"}';
  const requestBody = {
    model: QTP_ANTHROPIC_MODEL,
    max_tokens: 600,
    system: systemPrompt,
    messages: [
      {
        role: 'user',
        content: `Analyze this signal:
Ticker: ${ticker} | Timeframe: ${tf}
Direction: ${execution} (${signalDir}) @ $${price}
Scores: Bull ${bullScore}, Bear ${bearScore} | Regime: ${regime}
Indicators: RSI ${rsi}, ADX ${adx}, MACD ${macd}, VIX ${vix}
Market: SPY ${spyStatus}, QQQ ${qqqStatus}, Cross-Asset ${caStatus}
Index/Sector tape: ${mktLine}
Daily chart read: ${chartLine}
Options regime: ${optRegime} | Dark Pool: ${dpRegime} | CA regime: ${caRegime}
Backtest: ${btLine}
State Machine: route=${smRoute} action=${smAction} confidence=${smConf}/9
Contradictions flagged upstream: ${smContra}`
      }
    ]
  };

  grokResponse = await this.helpers.httpRequest({
    method: 'POST',
    url: 'https://api.anthropic.com/v1/messages',
    headers: {
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(requestBody),
    timeout: 25000
  });
} catch (e) {
  grokError = e.message || String(e);
  console.error('[CLAUDE AI ANALYSIS] Anthropic call failed:', grokError);
}

if (grokResponse) { await qtpMeterLLM(this.helpers, 'analyst', ticker, QTP_ANTHROPIC_MODEL, grokResponse); }
const _claudeText = qtpAnthropicText(grokResponse);
if (_claudeText) {
  content = _claudeText;
} else if (grokError) {
  content = `AI analysis unavailable (anthropic error: ${grokError})`;
} else {
  content = 'AI analysis unavailable (no content returned)';
}

if (content.length > 2000) content = content.substring(0, 2000);

const _aiStruct = { ai_json_parsed: false, ai_struct_version: 'QTP_GROK_AI_STRUCT_v1.0_20260702' };
try {
  const _aim = String(content || '').match(/AIJSON:\s*(\{[\s\S]*?\})\s*$/);
  if (_aim) {
    const _aij = JSON.parse(_aim[1]);
    Object.assign(_aiStruct, {
      ai_action: String(_aij.action || '').toUpperCase() || null,
      ai_confidence: Number.isFinite(Number(_aij.confidence)) ? Number(_aij.confidence) : null,
      ai_bull_score: Number.isFinite(Number(_aij.bull_score)) ? Number(_aij.bull_score) : null,
      ai_bear_score: Number.isFinite(Number(_aij.bear_score)) ? Number(_aij.bear_score) : null,
      ai_risk_note: String(_aij.risk_note || '').slice(0, 120),
      ai_json_parsed: true
    });
  }
} catch (_aie) { _aiStruct.ai_json_parse_error = String(_aie).slice(0, 200); }

return [{
  json: {
    ...item,
    choices: [{ message: { content } }],
    _grok_ai_called: Boolean(grokResponse && !grokError),
    _grok_ai_error: grokError || null,
    _grok_ai_content_len: content.length,
    _ai_provider: 'anthropic', _ai_model: QTP_ANTHROPIC_MODEL,
    ..._aiStruct,
    ..._mkt,
    ..._chartF
  }
}];