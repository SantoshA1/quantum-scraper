// NODE — Format Telegram Message (v24 — Swing/Scalp labels + Compact + Smart Split)
// v23: Adds "Swing" or "Scalp" label to ALL message headers based on timeframe
// v22 features retained: compact layout, auto-split at 3900 chars, HTML parse_mode
// ═══ v24: CHANNEL GATE — only send if Alpaca actually placed an order ════
// Rule: Channel messages go out ONLY when alpaca_status = 'PLACED'.
// If Alpaca skipped (quality gate), errored, or wasn't reached → silent.
// Also enforces a 60-second per-ticker channel dedup to prevent TradingView
// webhook retry spam from sending duplicate messages.
const _v24sig  = $input.first().json;
const _v24State = $getWorkflowStaticData('global');

// Gate 1 — Alpaca must have placed a real order
let _alpacaStatus = (_v24sig.alpaca_status || '').toUpperCase();
// v24.1: accept all Alpaca order-placed statuses (pending_new/accepted/new/filled)
const _PLACED_STATUSES = new Set(['PLACED','PENDING_NEW','ACCEPTED','NEW','FILLED','PARTIALLY_FILLED']);

// QTP_TG_EXEC_META_RECOVERY_SUPABASE_20260515
// Notification-only recovery from broker-confirmed order_events after duplicate SKIPPED output. No order/risk logic is changed.
// Supabase order recovery context is attached by Format Supabase Telegram Recovery Context.
if (!_PLACED_STATUSES.has(_alpacaStatus) && _alpacaStatus === 'SKIPPED' && /dedup/i.test(String(_v24sig.alpaca_reason || ''))) {
  try {
    const r = _v24sig._supabase_tg_recovery_order || null;
    if (r && r.order_status) {
      _v24sig.alpaca_status = String(r.order_status || 'PENDING_NEW').toUpperCase();
      _v24sig.alpaca_entry_id = r.broker_order_id || r.order_id || _v24sig.alpaca_entry_id;
      _v24sig.alpaca_order_id = r.broker_order_id || r.order_id || _v24sig.alpaca_order_id;
      _v24sig.alpaca_qty = r.requested_quantity || _v24sig.alpaca_qty;
      _v24sig.alpaca_side = String(r.side || _v24sig.alpaca_side || '').toLowerCase();
      _v24sig.alpaca_fresh_price = r.avg_fill_price || _v24sig.alpaca_fresh_price;
      _v24sig.alpaca_reason = 'Broker-confirmed order notification recovered from Supabase order_events after duplicate SKIPPED output';
      _v24sig._telegram_recovered_broker_order = true;
      _v24sig._force_channel_delivery = true;
      _alpacaStatus = String(_v24sig.alpaca_status || '').toUpperCase();
      console.log('[FMT TG v24.2] RECOVERED broker-confirmed order notification via Supabase status=' + _alpacaStatus);
    }
  } catch (e) { console.log('[FMT TG v24.2] Supabase broker-confirmed recovery skipped: ' + String(e?.message || e).slice(0, 300)); }
}
if (!_PLACED_STATUSES.has(_alpacaStatus)) {
  console.log('[FMT TG v24] BLOCKED — alpaca_status=' + _alpacaStatus + ' ticker=' + (_v24sig.ticker||'?'));
  return [];
}

// QTP_CHANNEL_DEDUP_v4.2.5.5 — 10-minute user-channel dedup for same ticker/action/price.
// Notification-only. Does not affect Alpaca, VC Gate, Bias Filter, Risk Gate, or exits.
if (!_v24State._chanDedup) _v24State._chanDedup = {};
const _dedup = _v24State._chanDedup;
const _dedupTicker = String(_v24sig.ticker || _v24sig.symbol || 'UNKNOWN').toUpperCase();
const _dedupExec = String(_v24sig.execution || _v24sig.signal || _v24sig.action || 'UNKNOWN').toUpperCase();
const _dedupPrice = Number(_v24sig.price || _v24sig.close || _v24sig.entry || 0);
const _dedupPxBucket = Number.isFinite(_dedupPrice) ? (Math.round(_dedupPrice * 100) / 100).toFixed(2) : 'NA';
const _dedupKey = `qtp_user_channel_${_dedupTicker}_${_dedupExec}_${_dedupPxBucket}`;
const _lastSentMs = Number(_dedup[_dedupKey] || 0);
const _DEDUP_MS = 10 * 60 * 1000;
if (Date.now() - _lastSentMs < _DEDUP_MS) {
  console.log('[FMT TG v4.2.5.5] DEDUP — suppress duplicate user alert within 10m for ' + _dedupKey);
  return [];
}
_dedup[_dedupKey] = Date.now();
// Prune dedup entries older than 30 min to keep state lean
for (const k of Object.keys(_dedup)) {
  if (Date.now() - Number(_dedup[k] || 0) > 30 * 60 * 1000) delete _dedup[k];
}
// ════════════════════════════════════════════════════════════════════════
// v24 guards passed — proceed to format and send to channel

const vcGateData = $input.first().json;
// Reconstruct Perplexity response from VC Gate passthrough
// v24: Read Grok analysis from multiple possible sources
// choices comes from VC Agent Gatekeeper v3 (VC Gate call) or Grok Signal Analyzer v3 (signal analysis)
let rawAnalysis = '';
try {
  const grokChoices = vcGateData.choices ||
    (vcGateData._pplx_response && vcGateData._pplx_response.choices) ||
    [];
  const rawContent = (grokChoices[0] && grokChoices[0].message && grokChoices[0].message.content) || '';
  if (rawContent) {
    try {
      // Parse Grok JSON and format as human-readable text
      // (prevents raw API blobs — sanitizeMD would mangle [ → ( and _ → space)
      const parsed = JSON.parse(rawContent);
      const fmt = (v) => v ? String(v).toUpperCase() : 'N/A';
      const pct = (v) => {
        if (v === undefined || v === null || v === '') return 'N/A';
        const n = parseFloat(v);
        if (!Number.isFinite(n)) return 'N/A';
        return Math.round(n > 1 ? n : n * 100) + '%';
      };
      const tags = Array.isArray(parsed.regime_tags)
        ? parsed.regime_tags.map(t => String(t).toUpperCase()).join(', ')
        : (parsed.regime_tags ? fmt(parsed.regime_tags) : 'N/A');
      rawAnalysis = [
        'Sentiment: ' + fmt(parsed.sentiment) + ' | Action: ' + fmt(parsed.trade_action),
        'Confidence: ' + pct(parsed.confidence) + ' | Verdict: ' + fmt(parsed.signal_verdict),
        'Options: ' + fmt(parsed.options_flow) + ' | Cross-Asset: ' + fmt(parsed.cross_asset),
        'SPY Corr: ' + (parsed.spy_correlation !== undefined ? parsed.spy_correlation : 'N/A') + ' | Regime: ' + tags
      ].join('\n');
    } catch (_) {
      rawAnalysis = rawContent; // fallback: display as-is if not parseable JSON
    }
  }
  if (!rawAnalysis) rawAnalysis = 'AI analysis in progress';
} catch (e) {
  rawAnalysis = 'AI analysis unavailable';
}
// Signal data now comes via VC Gate passthrough (all fields preserved)
const prev = vcGateData;
const ticker = prev.ticker || 'UNKNOWN';
const alertType = prev.alert_type || 'SIGNAL_CHANGE';
const NL = String.fromCharCode(10);

// Timeframe-based label: Daily/4H/1H = Swing, 5m/15m = Scalp
const tf = (prev.timeframe || '').toString().toUpperCase();
const isScalp = (tf === '5' || tf === '5M' || tf === '15' || tf === '15M' || tf === '1' || tf === '1M' || tf === '3' || tf === '3M');
const stratLabel = isScalp ? 'Scalp' : 'Swing';

// Data Quality — timestamp and staleness
const dqTimestamp = prev._dq_data_timestamp || new Date().toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true });
const dqMarket = prev._dq_market_status || 'UNKNOWN';
const dqStale = prev._dq_data_is_stale;
const dqNote = prev._dq_staleness_note || '';
const dqScore = prev._dq_quality_score || '?';


// ─── EXECUTION GUARD ───
// Only send Telegram messages for actual BUY/SELL executions (not STAND ASIDE/N/A)
const _execCheck = (prev.execution || '').toString().toUpperCase().trim();
if (_execCheck === 'STAND ASIDE' || _execCheck === '' || _execCheck === 'N/A' || _execCheck === '0') {
  return [];  // No Telegram for neutral/exit signals
}

// ─── TEST MODE GATE ───
// If test_mode is true in the signal payload, skip Telegram delivery
const testMode = prev.test_mode || false;
if (testMode) {
  return [];  // Empty = Send Telegram + Send to Channel won't fire
}


// Nuclear sanitization — strip ALL markdown from AI text
function sanitizeMD(text) {
  if (!text) return '';
  text = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let s = text;
  s = s.replace(/\*\*/g, '');
  s = s.replace(/\*/g, '');
  s = s.replace(/__/g, '');
  s = s.replace(/_/g, ' ');
  s = s.replace(/`{3}[\s\S]*?`{3}/g, '');
  s = s.replace(/`/g, "'");
  s = s.replace(/\[([^\]]*?)\]\([^)]*?\)/g, '$1');
  s = s.replace(/\[/g, '(');
  s = s.replace(/\]/g, ')');
  s = s.replace(/~/g, '-');
  s = s.replace(/#/g, '');
  s = s.replace(/\n{3,}/g, NL + NL);
  return s.trim();
}

const analysis = sanitizeMD(rawAnalysis);

function val(v) {
  if (v === undefined || v === null || v === '' || v === 0 || v === '0') return 'n/a';
  return String(v);
}

function num(v, prefix, suffix) {
  prefix = prefix || '';
  suffix = suffix || '';
  if (v === undefined || v === null || v === '' || v === 0 || v === '0' || v === 'N/A') return 'n/a';
  return prefix + v + suffix;
}

// Timestamp
let timeStr = '';
try {
  const ts = prev.timestamp;
  if (ts && ts !== '0' && ts !== '') {
    const n = parseInt(ts);
    if (!isNaN(n) && n > 1000000000) {
      timeStr = new Date(n).toLocaleString('en-US', { timeZone: 'America/New_York' });
    } else {
      timeStr = new Date(ts).toLocaleString('en-US', { timeZone: 'America/New_York' });
    }
  } else {
    timeStr = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  }
} catch(e) {
  timeStr = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
}

// Market tone (compact)
function marketTone() {
  const cs = prev.cross_asset_status;
  if (!cs) return '';
  if (cs === 'SPY_BREAKDOWN' || cs === 'QQQ_BREAKDOWN') return 'Hostile';
  if (cs === 'ALL_ALIGNED') {
    const exec = prev.bayesian_execution || prev.execution;
    if (exec === 'STAND ASIDE') return 'Cautious';
    return 'Aligned';
  }
  return 'Cautious';
}

// Market line (compact)
function marketLine() {
  if (!prev.spy_status && !prev.qqq_status) return '';
  const spyTag = prev.spy_status === 'BREAKING_DOWN' ? 'SPY DN' : prev.spy_status === 'HEALTHY' ? 'SPY OK' : 'SPY WK';
  const qqqTag = prev.qqq_status === 'BREAKING_DOWN' ? 'QQQ DN' : prev.qqq_status === 'HEALTHY' ? 'QQQ OK' : 'QQQ WK';
  const vixStr = prev.vix ? ' VIX ' + prev.vix : '';
  const tone = marketTone();
  return spyTag + ' | ' + qqqTag + vixStr + (tone ? ' | ' + tone : '');
}

// MTF (compact)
function mtfLine() {
  if (!prev.mtf_bull_count && !prev.mtf_bear_count) return '';
  return 'Bull ' + (prev.mtf_bull_count || 0) + '/4 | Bear ' + (prev.mtf_bear_count || 0) + '/4';
}

// Regime (compact)
function regimeLine() {
  if (!prev.vix_regime && !prev.trending) return '';
  const t = prev.strong_trend ? 'STRONG' : prev.trending ? 'TREND' : 'FLAT';
  return t + ' | VIX: ' + (prev.vix_regime || '?') + ' | ' + (prev.tradeable_environment ? 'TRADEABLE' : 'NO TRADE');
}

// Bayesian (compact)
function bayesianLine() {
  if (!prev.bayesian_score && !prev.bayesian_bucket) return '';
  return (prev.bayesian_score || 0) + ' (' + (prev.bayesian_bucket || '?') + '/' + (prev.bayesian_grade || '?') + ')';
}

// Strategy Performance (one line) — uses stratLabel for Swing/Scalp
function stratLine() {
  const np = prev.strat_net_pct;
  const wr = prev.strat_win_rate;
  if (!np && np !== '0' && !wr && wr !== '0') return '';
  const label = isScalp ? 'Scalp v4' : 'Swing v7';
  let l = label + ': ' + ((np !== '' && np !== undefined) ? np + '%' : '?');
  l += ' WR ' + ((wr !== '' && wr !== undefined) ? wr + '%' : '?');
  l += ' PF ' + (prev.strat_profit_factor || '?');
  l += ' DD ' + ((prev.strat_max_dd !== '' && prev.strat_max_dd !== undefined) ? prev.strat_max_dd + '%' : '?');
  l += ' (' + (prev.strat_total_trades || '?') + 'T)';
  return l;
}

// Cross-Asset (compact — 2 lines max)
function crossAssetCompact() {
  if (!prev.ca_regime) return '';
  const score = prev.ca_composite_score !== undefined ? prev.ca_composite_score : '?';
  const regime = prev.ca_regime || '?';
  const align = prev.ca_signal_alignment || '?';
  const conf = prev.ca_regime_confidence || '';
  let l = regime + ' ' + score + '/100';
  if (conf) l += ' (' + conf + ')';
  l += ' | ' + align;
  const p = [];
  if (prev.ca_broad_health) p.push('Mkt:' + prev.ca_broad_health);
  if (prev.ca_vix_term) p.push('VIX:' + prev.ca_vix_term);
  if (prev.ca_sector_rotation) p.push('Sec:' + prev.ca_sector_rotation);
  if (prev.ca_risk_appetite) p.push('Risk:' + prev.ca_risk_appetite);
  if (p.length > 0) l += NL + p.join(' | ');
  return l;
}

// Options Flow (compact — 2-3 lines max)
function optionsCompact() {
  if (!prev.opt_regime || prev.opt_regime === 'UNAVAILABLE' || prev.opt_regime === 'API_ERROR' || prev.opt_regime === 'NO_DATA') return '';
  let l = prev.opt_regime;
  if (prev.opt_regime_confidence) l += ' (' + prev.opt_regime_confidence + ')';
  l += ' | GEX ' + (prev.opt_net_gex || '?') + ' ' + (prev.opt_gex_sign || '');
  l += NL + 'P/C ' + (prev.opt_pc_ratio_oi || '?') + ' | MaxPain ' + (prev.opt_max_pain || '?') + ' (' + (prev.opt_max_pain_dist || '?') + ') | Skew ' + (prev.opt_iv_skew || '?');
  if (prev.opt_unusual_count > 0) {
    l += NL + 'Unusual: ' + prev.opt_unusual_count + ' (' + (prev.opt_unusual_bias || '?') + ')';
  }
  return l;
}

// Dark Pool (compact — 2 lines max)
function darkPoolCompact() {
  if (!prev.dp_regime || prev.dp_regime === 'NO_PRICE') return '';
  let l = prev.dp_regime;
  if (prev.dp_regime_confidence) l += ' (' + prev.dp_regime_confidence + ')';
  l += ' | Short ' + (prev.dp_short_ratio || '?') + ' ' + (prev.dp_short_signal || '');
  l += ' | Inst ' + (prev.dp_institutional_score || '?') + '/100';
  l += NL + 'Vol ' + (prev.dp_vol_profile || '?') + ' | A/D ' + (prev.dp_ad_pattern || '?') + ' | ' + (prev.dp_pv_divergence || '?');
  return l;
}

// Truncate text to fit
function truncate(text, max) {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf('.', max);
  if (cut > max * 0.5) return text.substring(0, cut + 1) + ' (...)';
  return text.substring(0, max) + '...';
}

const MAX_MSG = 3900;
let results = [];

if (alertType === 'BULL_SWEEP' || alertType === 'BEAR_SWEEP') {
  const sweepDir = alertType === 'BULL_SWEEP' ? 'BULL SWEEP' : 'BEAR SWEEP';
  const mkt = marketLine();
  let msg = '<b>' + ticker + ' | ' + stratLabel + ' ' + sweepDir + ' | AI</b>' + NL;
  if (mkt) msg += mkt + NL;
  msg += NL + truncate(analysis, MAX_MSG - msg.length - 50) + NL + NL + timeStr + ' EST';
  results.push({ json: { message: msg } });

} else if (alertType === 'STRONG_SETUP') {
  const bayExec = prev.bayesian_execution || prev.execution || 'STAND ASIDE';
  const mkt = marketLine();
  const bayes = bayesianLine();
  let msg = '<b>' + ticker + ' | ' + stratLabel + ' STRONG SETUP | ' + bayExec + '</b>' + NL;
  msg += '$' + prev.price;
  if (bayes) msg += ' | Bayes: ' + bayes;
  msg += NL;
  if (mkt) msg += mkt + NL;
  msg += NL + truncate(analysis, MAX_MSG - msg.length - 50) + NL + NL + timeStr + ' EST';
  results.push({ json: { message: msg } });

} else {
  // SIGNAL_CHANGE — build data part + AI part
  const execution = prev.bayesian_execution || prev.execution || 'STAND ASIDE';
  const prevExec = prev.previous_execution || 'N/A';

  // Header with Swing/Scalp label
  let data = '<b>' + ticker + ' | ' + stratLabel + ' SIGNAL CHANGE | ' + execution + '</b>' + NL;
  data += prevExec + ' -> ' + execution + ' | $' + prev.price + NL;

  // Day range + volume
  const dayRange = (prev.daily_low && prev.daily_low !== 0 && prev.daily_high && prev.daily_high !== 0)
    ? '$' + prev.daily_low + '-$' + prev.daily_high : 'n/a';
  data += 'Range: ' + dayRange;
  if (prev.avg_volume && prev.avg_volume > 0 && prev.volume && prev.volume > 0) {
    data += ' | Vol ' + (prev.volume / prev.avg_volume * 100).toFixed(0) + '% avg';
  }
  data += NL + NL;

  // Core metrics (compact grid)
  data += 'Bias ' + val(prev.bias_score ? prev.bias_score + '%' : '') + ' | Exec ' + val(prev.exec_score ? prev.exec_score + '%' : '') + ' | ' + val(prev.grade) + NL;
  data += 'RSI ' + num(prev.rsi) + ' | MACD ' + (prev.macd_hist !== undefined && prev.macd_hist !== null && prev.macd_hist !== '' ? prev.macd_hist : 'n/a') + ' | ADX ' + num(prev.adx) + NL;
  
  const sma50 = (prev.sma50 && prev.sma50 !== 0) ? '$' + prev.sma50 : 'n/a';
  const ema200 = (prev.ema200 && prev.ema200 !== 0) ? '$' + prev.ema200 : 'n/a';
  data += 'SMA50 ' + sma50 + ' | EMA200 ' + ema200 + ' | VWAP ' + num(prev.vwap, '$') + NL;
  data += 'Smart$ ' + val(prev.smart_money) + ' | Liq ' + val(prev.liquidity) + ' | OB ' + val(prev.order_block) + NL;

  // Phase 1
  const bayes = bayesianLine();
  const mtf = mtfLine();
  const regime = regimeLine();
  const mkt = marketLine();
  const strat = stratLine();

  if (bayes || mtf || regime || strat || mkt) {
    data += NL;
    if (bayes) data += 'Bayes: ' + bayes + NL;
    if (mtf) data += 'MTF: ' + mtf + NL;
    if (regime) data += regime + NL;
    if (strat) data += strat + NL;
    if (mkt) data += 'MKT: ' + mkt + NL;
  }

  // Phase 2 sections
  const ca = crossAssetCompact();
  const opt = optionsCompact();
  const dp = darkPoolCompact();

  if (ca || opt || dp) {
    if (ca) { data += NL + '<b>CROSS-ASSET</b>' + NL + ca + NL; }
    if (opt) { data += NL + '<b>OPTIONS</b>' + NL + opt + NL; }
    if (dp) { data += NL + '<b>DARK POOL</b>' + NL + dp + NL; }
  }

  const footer = NL + timeStr + ' EST';
  const aiHeader = NL + '<b>AI ANALYSIS</b>' + NL;

  // Check if everything fits in one message
  const totalLen = data.length + aiHeader.length + analysis.length + footer.length;
  
  if (totalLen <= MAX_MSG) {
    results.push({ json: { message: data + aiHeader + analysis + footer } });
  } else {
    let msg1 = data;
    if (msg1.length > MAX_MSG - 50) {
      msg1 = msg1.substring(0, MAX_MSG - 50) + NL + '(...)';
    }
    msg1 += footer;
    results.push({ json: { message: msg1 } });

    let msg2 = '<b>' + ticker + ' | ' + stratLabel + ' AI ANALYSIS</b>' + NL + NL;
    msg2 += truncate(analysis, MAX_MSG - msg2.length - footer.length - 10);
    msg2 += footer;
    results.push({ json: { message: msg2 } });
  }
}

// Final safety check on all items
for (const r of results) {
  if (r.json.message.length > 4050) {
    r.json.message = r.json.message.substring(0, 4000) + NL + '(truncated)' + NL + timeStr + ' EST';
  }
}


// QTP_TG_EXEC_META_RECOVERY_SUPABASE_20260515: attach routing metadata for Channel Gate.
for (const r of results) {
  r.json.ticker = ticker;
  r.json.symbol = ticker;
  r.json.alpaca_status = _v24sig.alpaca_status;
  r.json.alpaca_entry_id = _v24sig.alpaca_entry_id || _v24sig.alpaca_order_id || '';
  r.json.message_type = _v24sig._telegram_recovered_broker_order ? 'EXECUTION_RECOVERED' : 'EXECUTION_SIGNAL';
  r.json._force_channel_delivery = _v24sig._force_channel_delivery === true;
}
return results;
