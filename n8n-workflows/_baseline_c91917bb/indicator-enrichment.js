// Indicator Enrichment v1 — Backfills missing technical indicators from Polygon
// Runs after Gap News Detector, before Signal State Machine
// Only fetches what's missing — zero overhead for fully-populated TradingView alerts

// ── Stable signal timestamp — set ONCE at pipeline entry, preserved by all
// downstream nodes via {...prev}. Log Alert to Sheet uses this as the
// appendOrUpdate row key so VC/Grok enrichment updates the SAME row.
const _rawItem = $input.first().json;
const item = {
  ..._rawItem,
  _signal_timestamp: _rawItem._signal_timestamp || new Date().toISOString()
};


// QTP-CHART-VISION-REALTIME v4.2.20 — dynamic TradingView widget screenshot + xAI Responses image understanding.
// Additive/fail-open. Does not change VC Gate, Bias Filter, Risk Gate, Pause Guard, Alpaca routing, or protective exits.
async function qtpChartVisionShadow(input) {
  const out = { ...(input || {}) };
  try {
    let rawTicker = String(out.ticker || out.symbol || out.sym || '').toUpperCase().trim();
    let exchange = String(out.exchange || out.primary_exchange || '').toUpperCase().trim();
    if (rawTicker.includes(':')) { const parts = rawTicker.split(':'); exchange = exchange || parts[0]; rawTicker = parts[1] || rawTicker; }
    const tickerClean = rawTicker.replace(/[^A-Z0-9.\-]/g, '');
    const knownNasdaq = new Set(['AAPL','MSFT','NVDA','AMZN','META','GOOGL','GOOG','TSLA','AVGO','COST','NFLX','AMD','ADBE','PEP','CSCO','TMUS','INTU','QCOM','AMAT','TXN','ISRG','BKNG','VRTX','PANW','MU','LRCX','ADI','KLAC','MELI','CRWD','CDNS','SNPS','MRVL','ORLY','MAR','ABNB','PYPL','FTNT','REGN','ASML','NTNX','OLED','NDAQ']);
    exchange = exchange || (knownNasdaq.has(tickerClean) ? 'NASDAQ' : 'NYSE');
    if (!tickerClean) { out.chart_vision_enabled = false; out.chart_vision_status = 'SKIPPED_NO_TICKER'; out.chart_vision_call_mode = 'SKIPPED_NO_TICKER'; out.chart_vision_version = 'QTP_CHART_VISION_REALTIME_v4.4.0_CCPRIMARY_20260706'; return out; }
    const chartSymbol = `${exchange}:${tickerClean}`;
    const chartPageUrl = `https://www.tradingview.com/chart/00rMdbml/?symbol=${encodeURIComponent(chartSymbol)}`;
    const chartEmbedUrl = `https://www.tradingview.com/widgetembed/?symbol=${encodeURIComponent(chartSymbol)}&interval=5&theme=dark&style=1&timezone=America%2FNew_York&withdateranges=1&hide_side_toolbar=0&allow_symbol_change=0&save_image=1`;
    const screenshotUrl = `https://image.thum.io/get/width/1280/crop/900/noanimate/${chartEmbedUrl}`;
    out.chart_symbol = chartSymbol; out.tradingview_chart_url = out.tradingview_chart_url || chartPageUrl; out.chart_page_url = out.chart_page_url || chartPageUrl; out.chart_embed_url = chartEmbedUrl; out.chart_url = out.chart_url || chartPageUrl; out.chart_image_url = screenshotUrl; out.chart_screenshot_url = screenshotUrl;
    out.chart_url_version = 'QTP_DYNAMIC_TRADINGVIEW_WIDGET_SCREENSHOT_URL_v4.2.20'; out.chart_vision_version = 'QTP_CHART_VISION_REALTIME_v4.4.0_CCPRIMARY_20260706'; out.chart_vision_enabled = true; out.chart_vision_status = 'SCREENSHOT_URL_BUILT'; out.chart_vision_provider = 'xai_responses_image_understanding'; out.chart_screenshot_provider = 'image.thum.io_tradingview_widget';
    const mode = String((typeof $vars !== 'undefined' && ($vars.QTP_CHART_VISION_MODE || $vars.qtp_chart_vision_mode)) || out.qtp_chart_vision_mode || 'realtime').toLowerCase();
    const testVision = out.qtp_chart_vision_test === true || String(out.qtp_chart_vision_test || '').toLowerCase() === 'true' || out.chart_vision_force === true || String(out.chart_vision_force || '').toLowerCase() === 'true';
    const alertType = String(out.alert_type || out.source || '').toUpperCase(); const execution = String(out.execution || out.signal || out.side || out.action || out.direction || '').toUpperCase();
    const isEntryCandidate = ['BUY','SELL','LONG','SHORT','BULLISH','BEARISH'].includes(execution); const isNoise = alertType.includes('HEARTBEAT') || execution === 'STAND ASIDE' || execution === 'NEUTRAL' || execution === 'HOLD';
    if (mode === 'off' || mode === 'disabled') { out.chart_vision_call_mode = 'DISABLED_BY_QTP_CHART_VISION_MODE'; return out; }
    if (!testVision && !isEntryCandidate) { out.chart_vision_call_mode = 'REALTIME_SKIPPED_NON_ENTRY'; out.chart_vision_status = isNoise ? 'SKIPPED_HEARTBEAT_OR_NEUTRAL' : 'SKIPPED_NON_ENTRY'; return out; }
    const creds = (($getWorkflowStaticData('global') || {})._credentials) || {};
    const apiKey = String((typeof $vars !== 'undefined' && ($vars.XAI_API_KEY || $vars.xai_api_key)) || creds.xai_api_key || out.xai_api_key || '').trim();
    if (!apiKey) { out.chart_vision_call_mode = 'SKIPPED_NO_XAI_KEY_FAIL_OPEN'; out.chart_vision_status = 'SKIPPED_NO_XAI_KEY'; return out; }
    const model = String((typeof $vars !== 'undefined' && $vars.XAI_VISION_MODEL) || creds.xai_vision_model || 'grok-4.3').trim(); out.chart_vision_model = model; out.chart_vision_call_mode = testVision ? 'TEST_FLAG_REALTIME_WIDGET_SCREENSHOT_RESPONSES' : 'REALTIME_WIDGET_SCREENSHOT_RESPONSES';
    const prompt = `Analyze this live TradingView 5-minute widget screenshot for ${chartSymbol}. Return strict JSON only with keys: chart_score number 0-100, trend BULLISH/BEARISH/NEUTRAL, pattern short string, confidence number 0-100, risk_flags array, summary one sentence. If chart is not visible, set pattern to NO_CHART_VISIBLE and confidence to 0. This is advisory enrichment only and must not assume execution.`;
    let response;
try {
  const cc = await this.helpers.httpRequest({ method: 'POST', url: 'https://api.x.ai/v1/chat/completions', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: { model, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: screenshotUrl, detail: 'high' } }, { type: 'text', text: prompt }] }], temperature: 0 }, json: true, timeout: 15000 });
  response = { output_text: (cc && cc.choices && cc.choices[0] && cc.choices[0].message && cc.choices[0].message.content) || '' };
  out.chart_vision_api = 'chat_completions_primary';
} catch (e1) {
  out.chart_vision_primary_error = String((e1 && e1.response && e1.response.body && JSON.stringify(e1.response.body)) || (e1 && e1.message) || e1).slice(0, 400);
  response = await this.helpers.httpRequest({ method: 'POST', url: 'https://api.x.ai/v1/responses', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: { model, input: [{ role: 'user', content: [{ type: 'input_image', image_url: screenshotUrl, detail: 'high' }, { type: 'input_text', text: prompt }] }], temperature: 0, store: false }, json: true, timeout: 15000 });
  out.chart_vision_api = 'responses_secondary';
}
    let text = response?.output_text || ''; if (!text && Array.isArray(response?.output)) { for (const o of response.output) { if (Array.isArray(o.content)) { for (const c of o.content) { if (c.text) text += c.text; if (c.type === 'output_text' && c.text) text += c.text; } } } } text = text || JSON.stringify(response).slice(0, 2000);
    out.chart_vision_raw = String(text).slice(0, 4000);
    let parsed = {}; try { let cleaned = String(text).replace(/```json|```/g, '').trim(); const dup = cleaned.indexOf('}{'); if (dup > 0) cleaned = cleaned.slice(0, dup + 1); parsed = JSON.parse(cleaned); } catch (e) { parsed = {}; }
    out.chart_vision_score = Number(parsed.chart_score ?? parsed.chart_vision_score ?? parsed.score ?? 0); out.chart_vision_trend = String(parsed.trend ?? parsed.chart_vision_trend ?? 'UNKNOWN'); out.chart_vision_pattern = String(parsed.pattern ?? parsed.chart_vision_pattern ?? 'UNKNOWN'); out.chart_vision_confidence = Number(parsed.confidence ?? parsed.chart_vision_confidence ?? 0); out.chart_vision_risk_flags = Array.isArray(parsed.risk_flags) ? parsed.risk_flags.join('; ') : String(parsed.risk_flags || parsed.chart_vision_red_flags || ''); out.chart_vision_summary = String(parsed.summary || parsed.chart_vision_summary || '').slice(0, 800); out.chart_vision_status = 'ANALYZED_REALTIME_WIDGET_SCREENSHOT'; out.chart_vision_completed_at = new Date().toISOString();
  } catch (e) { out.chart_vision_status = 'ERROR_FAIL_OPEN'; out.chart_vision_error = String((e && e.response && e.response.body && JSON.stringify(e.response.body)) || (e && e.response && e.response.data && JSON.stringify(e.response.data)) || (e && e.message) || e).slice(0, 900); out.chart_vision_fail_open_alert = true; out.chart_vision_call_mode = out.chart_vision_call_mode || 'REALTIME_WIDGET_SCREENSHOT_RESPONSES_ERROR_FAIL_OPEN'; out.chart_vision_version = 'QTP_CHART_VISION_REALTIME_v4.4.0_CCPRIMARY_20260706'; }
  return out;
}

const _creds_IE = ($getWorkflowStaticData('global')._credentials) || {};
const POLYGON_KEY = _creds_IE.polygon_key;
if (!POLYGON_KEY) throw new Error('SE-C1: polygon_key missing from staticData._credentials');

// Determine if enrichment is needed
const needsRsi    = !item.rsi    || item.rsi    === 'N/A' || item.rsi    === 0 || item.rsi    === '0';
const needsMacd   = !item.macd_hist || item.macd_hist === 'N/A' || item.macd_hist === 0 || item.macd_hist === '0';
const needsSma50  = !item.sma50  || item.sma50  === 'N/A' || item.sma50  === 0 || item.sma50  === '0';
const needsEma200 = !item.ema200 || item.ema200 === 'N/A' || item.ema200 === 0 || item.ema200 === '0';
const needsVwap   = !item.vwap   || item.vwap   === 'N/A' || item.vwap   === 0 || item.vwap   === '0';

const ticker = item.ticker;
if (!ticker || ticker === 'UNKNOWN') return [{ json: await qtpChartVisionShadow.call(this, item) }];

// If everything is present, pass through immediately — no API calls
if (!needsRsi && !needsMacd && !needsSma50 && !needsEma200 && !needsVwap) {
  console.log('[ENRICH] All indicators present for', ticker, '— pass-through');
  return [{ json: await qtpChartVisionShadow.call(this, item) }];
}

// Determine timespan for RSI/MACD based on signal timeframe
const tf = (item.timeframe || '').toString().toUpperCase();
const isScalp = ['1','1M','3','3M','5','5M','15','15M'].includes(tf);
const indTimespan = isScalp ? 'minute' : 'day';

const enriched = { ...item };

// Helper: safe fetch
async function safeFetch(url) {
  try {
    return await this.helpers.httpRequest({ method: 'GET', url, timeout: 5000 });
  } catch (e) {
    console.error('[ENRICH] Fetch error:', e.message);
    return null;
  }
}

// Fetch RSI (14)
if (needsRsi) {
  const url = `https://api.polygon.io/v1/indicators/rsi/${ticker}?timespan=${indTimespan}&adjusted=true&window=14&series_type=close&order=desc&limit=1&apiKey=${POLYGON_KEY}`;
  const data = await safeFetch.call(this, url);
  const v = data?.results?.values?.[0]?.value;
  if (v !== undefined) enriched.rsi = parseFloat(v).toFixed(2);
  console.log('[ENRICH] RSI', ticker, '=', enriched.rsi);
}

// Fetch MACD histogram (12/26/9)
if (needsMacd) {
  const url = `https://api.polygon.io/v1/indicators/macd/${ticker}?timespan=${indTimespan}&adjusted=true&short_window=12&long_window=26&signal_window=9&series_type=close&order=desc&limit=1&apiKey=${POLYGON_KEY}`;
  const data = await safeFetch.call(this, url);
  const v = data?.results?.values?.[0]?.histogram;
  if (v !== undefined) enriched.macd_hist = parseFloat(v).toFixed(4);
  console.log('[ENRICH] MACD', ticker, '=', enriched.macd_hist);
}

// Fetch SMA50 (daily)
if (needsSma50) {
  const url = `https://api.polygon.io/v1/indicators/sma/${ticker}?timespan=day&adjusted=true&window=50&series_type=close&order=desc&limit=1&apiKey=${POLYGON_KEY}`;
  const data = await safeFetch.call(this, url);
  const v = data?.results?.values?.[0]?.value;
  if (v !== undefined) enriched.sma50 = parseFloat(v).toFixed(2);
  console.log('[ENRICH] SMA50', ticker, '=', enriched.sma50);
}

// Fetch EMA200 (daily)
if (needsEma200) {
  const url = `https://api.polygon.io/v1/indicators/ema/${ticker}?timespan=day&adjusted=true&window=200&series_type=close&order=desc&limit=1&apiKey=${POLYGON_KEY}`;
  const data = await safeFetch.call(this, url);
  const v = data?.results?.values?.[0]?.value;
  if (v !== undefined) enriched.ema200 = parseFloat(v).toFixed(2);
  console.log('[ENRICH] EMA200', ticker, '=', enriched.ema200);
}

// Fetch VWAP (from daily aggregate bar — field is 'vw' in Polygon aggs)
if (needsVwap) {
  const today = new Date().toISOString().split('T')[0];
  const aggUrl = `https://api.polygon.io/v2/aggs/ticker/${ticker}/range/1/day/${today}/${today}?adjusted=true&apiKey=${POLYGON_KEY}`;
  const aggData = await safeFetch.call(this, aggUrl);
  let v = aggData?.results?.[0]?.vw;
  // Fallback: try snapshot endpoint if agg not available yet (pre-market)
  if (!v || v === 0) {
    const snapUrl = `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/${ticker}?apiKey=${POLYGON_KEY}`;
    const snapData = await safeFetch.call(this, snapUrl);
    v = snapData?.ticker?.day?.vwap || snapData?.ticker?.min?.av;
  }
  if (v !== undefined && v !== 0) enriched.vwap = parseFloat(v).toFixed(2);
  console.log('[ENRICH] VWAP', ticker, '=', enriched.vwap);
}

enriched._enriched = true;
enriched._enriched_fields = ['rsi','macd','sma50','ema200','vwap'].filter((f,i) => [
  needsRsi && enriched.rsi !== item.rsi,
  needsMacd && enriched.macd_hist !== item.macd_hist,
  needsSma50 && enriched.sma50 !== item.sma50,
  needsEma200 && enriched.ema200 !== item.ema200,
  needsVwap && enriched.vwap !== item.vwap
][i]).join(',');

console.log('[ENRICH] Done for', ticker, '— filled:', enriched._enriched_fields || 'none');
// Fix #17 Batch 2 (hotfix): expose polygon_key to downstream HTTP nodes
enriched._polygon_key = POLYGON_KEY;
return [{ json: await qtpChartVisionShadow.call(this, enriched) }];