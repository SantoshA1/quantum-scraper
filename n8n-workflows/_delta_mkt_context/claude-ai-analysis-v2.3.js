
// QTP_MKT_CONTEXT_v1_20260722 (analyst v2.3, PO-directed): index/sector tape context in prompt +
// _mkt_* telemetry. Advisory-only, fail-open (two extra HTTP calls, both try/caught; on any failure
// the prompt says 'unavailable' and the pipeline continues unchanged). Harness-verified exec 435485.
// QTP_ANTHROPIC_MIGRATION_v1.1_20260720 (temperature REMOVED: claude-opus-4-8 400s on explicit temperature; bisected exec 421425): xAI/Grok -> Anthropic Claude Opus 4.8 (PO-authorized).
// Contract preserved: output shape choices[0].message.content + AIJSON tail + _grok_ai_* telemetry
// field NAMES kept (downstream parsers/audit reference them); _ai_provider/_ai_model added.
const QTP_ANTHROPIC_KEY = String((typeof $vars !== 'undefined' && ($vars.ANTHROPIC_API_KEY || $vars.anthropic_api_key)) || ((($getWorkflowStaticData('global') || {})._credentials || {}).anthropic_api_key) || '').trim();
const QTP_ANTHROPIC_MODEL = String((typeof $vars !== 'undefined' && ($vars.ANTHROPIC_MODEL || $vars.anthropic_model)) || 'claude-opus-4-8').trim();
// Seed-then-publish doctrine (07-08 Telegram incident): reject placeholder-shaped keys, not just missing.
function qtpAnthropicKeyLooksReal(k) { return typeof k === 'string' && k.startsWith('sk-ant-') && k.length >= 40 && !/PLACEHOLDER|CHANGEME|YOUR[_-]?KEY|EXAMPLE|XXXX/i.test(k); }
function qtpAnthropicText(resp) { if (!resp || !Array.isArray(resp.content)) return ''; let t = ''; for (const b of resp.content) { if (b && b.type === 'text' && b.text) t += b.text; } return t.trim(); }
// Claude AI Analysis v2.0 (was Grok AI Analysis v1.0) — Replaces stub "return $input.all()"
// Purpose: Produce narrative analysis of the enriched signal for consumption
// by VC Agent Gatekeeper (reads choices[0].message.content as rawAnalysis).
// Failure mode: non-fatal — on any Anthropic error, pass through with a safe
// placeholder so the VC pipeline continues (VC downstream already handles
// 'AI analysis unavailable' gracefully).

const item = $input.first().json;

// Guard: if no ticker / no signal payload, bail through
if (!item || !item.ticker) {
  return [{ json: { ...item, choices: [{ message: { content: 'AI analysis unavailable (no signal payload)' } }], _grok_ai_called: false } }];
}

// Fetch credential from staticData (n8n Cloud: $env blocked)
const API_KEY = QTP_ANTHROPIC_KEY;
if (!qtpAnthropicKeyLooksReal(API_KEY)) {
  // Non-fatal: let the pipeline proceed without AI color (same degradation as pre-migration)
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

// Build compact signal context for the prompt
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
// SYNTHETIC-BACKTEST LABELING v1 (20260721): PAPER_DEFAULT stats (sample=150/pf=1.45/win=0)
// were presented to the analyst as real history and anchored HOLD verdicts (WMT 07-21).
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

let grokResponse = null;
let grokError = null;
let content = '';

try {
  const systemPrompt = 'You are a senior quantitative trading analyst. Given a signal snapshot, produce a concise 150-200 word analytical summary covering: (1) direction conviction and key contradictions, (2) market regime alignment, (3) options/dark-pool/cross-asset context, (4) notable risks. When an Index/Sector tape line is provided, explicitly assess whether the trade direction goes WITH or AGAINST the index/sector tape; counter-tape trades require stronger evidence and deserve lower confidence unless the contradicting evidence is compelling. Write prose (not JSON). Be direct, evidence-based, and highlight red flags. End your analysis with one final line in exactly this format: AIJSON:{"action":"BUY"|"SELL"|"HOLD","confidence":<0-100>,"bull_score":<0-100>,"bear_score":<0-100>,"risk_note":"<max 12 words>"}';
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

const _claudeText = qtpAnthropicText(grokResponse);
if (_claudeText) {
  content = _claudeText;
} else if (grokError) {
  content = `AI analysis unavailable (anthropic error: ${grokError})`;
} else {
  content = 'AI analysis unavailable (no content returned)';
}

// Trim defensively to 2000 chars — VC Gatekeeper will substring(0,2000) anyway
if (content.length > 2000) content = content.substring(0, 2000);

// QTP_GROK_AI_STRUCT_v1.0_20260702 - advisory/observability only.
// Parses the AIJSON tail line into structured fields. NOT wired into any
// gate, decision, or Telegram formatting logic. Fail-soft: never throws.
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
    // Pass-through in the shape VC Agent Gatekeeper expects: choices[0].message.content
    choices: [{ message: { content } }],
    _grok_ai_called: Boolean(grokResponse && !grokError),
    _grok_ai_error: grokError || null,
    _grok_ai_content_len: content.length,
    _ai_provider: 'anthropic', _ai_model: QTP_ANTHROPIC_MODEL,
    ..._aiStruct,
    ..._mkt
  }
}];