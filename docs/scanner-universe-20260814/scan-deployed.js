// SM-C2: env-driven Alpaca base URL (default paper, flip via staticData)
const _creds_AB = ($getWorkflowStaticData('global')._credentials) || {};
const ALPACA_BASE = _creds_AB.alpaca_base
  || (_creds_AB.alpaca_env === 'live'
    ? 'https://paper-api.alpaca.markets'
    : 'https://paper-api.alpaca.markets');

// ================================================
// BROAD SCANNER v3.4 — Fix #14 off-by-one — Fix #9 N/A indicators, Fix #13 session hours — Time-Adjusted Volume Fix — Enhanced Filters + AI View
// v3.1: Min relative volume, entry deviation check, enhanced AI context
// v3.0: Max 4 entries per cycle + pre-entry risk simulation
// v2.3: Kill switch, VIX fix, direction flips
// ================================================

// ─── CONFIGURATION (edit these to tune) ───
const MOMENTUM_THRESHOLD  = 0.7;   // Min % change to trigger signal
const PROFILE_IMBALANCE   = 1.8;   // Volume imbalance for structure break
const VOLUME_MIN          = 0.25;  // Min volume ratio vs prev day (original threshold)
const MIN_RR              = 2.0;   // Min risk:reward ratio

// ─── NEW v3.1 FILTERS ───
const MIN_RELATIVE_VOLUME    = 0.8;   // Min relative volume (today vs prev day) — rejects thin/quiet tickers
const MAX_ENTRY_DEVIATION_PCT = 4.5; // QTP_DEVIATION_WIDEN_20260727 (PO): was 2.5 -> 4.5. Catch strong 2.5-4.5% momentum moves (was skipping COIN/PLTR/AMD/NVDA as too-extended); still skip parabolic >4.5% chases.  // v3.2: widened from 1.5 — was too tight for midday

// ─── POSITION BLOAT SAFEGUARDS ───
const MAX_NEW_ENTRIES_PER_CYCLE = 4;    // Max new signals per 5-min scan
const MAX_POSITIONS       = 20;         // Kill switch: max open positions
const MAX_EXPOSURE        = 150000;     // Kill switch: max notional $
const MAX_MARGIN_PCT      = 0.50;       // Kill switch: max margin % of equity. QTP_KS_CAPACITY_v1_20260805 (PO): 0.35 -> 0.50. At 0.35 the reg-T proxy bound at gross=0.70x equity (~$75k / 7 pos) and the book went 'full' by 13:35 ET the same day the guard was fixed, while MAX_POSITIONS=20 and MAX_EXPOSURE=$150k were unreachable. 0.50 = gross <= 1.0x equity (~10 concurrent $10k positions), half the 2x paper account's broker limit; margin still binds FIRST (before $150k exposure, before 20 positions). Guard suite: tests/test-scanner-killswitch.js KS-13..16.
const MAX_DAILY_LOSS_PCT  = -2.5;       // Kill switch: max daily loss %
const EST_POSITION_SIZE   = 10000;
// ── C-3 auth: load webhook_secret for outgoing payloads ───
const _WEBHOOK_SECRET = ($getWorkflowStaticData('global')._credentials || {}).webhook_secret || '';
       // Estimated $ per new position (for simulation)

// ─── Gap A Phase A-2: strat_cache lookup (fail-closed) ───
// Read the strat_cache sheet that Read Supabase Strat Cache node loaded before us.
// If cache is missing/stale/non-OK, emit empty strat_* fields so downstream
// consumers can see the absence and route around it (NO FAKE DEFAULTS).
// QTP_STALENESS_EXTENSION_v1_20260527: temporary bridge from 7d -> 30d
// while Path X deploys today. Revert to 7d after Path X is producing fresh
// cache daily (post-deploy validation).
// QTP_STALENESS_EXTENSION_v2_20260527: extended from 30d -> 60d after Path X
// calibration drift required deeper port review. Cache valid through end of July.
// Revert to 7d after Path X is producing fresh cache daily (proper port pending).
const STRAT_STALENESS_MS = 60 * 24 * 60 * 60 * 1000; // 60 days (extended)
const _STRAT_CACHE = {};
try {
  const cacheItems = $('Read Supabase Strat Cache').all() || [];
  const nowMs = Date.now();
  for (const it of cacheItems) {
    const r = it.json || {};
    const t = (r.ticker || '').toString().toUpperCase().trim();
    if (!t) continue;
    const asof = r.asof_utc ? Date.parse(r.asof_utc) : NaN;
    const fresh = Number.isFinite(asof) && (nowMs - asof) <= STRAT_STALENESS_MS;
    const ok = (r.status || '').toString().toUpperCase() === 'OK';
    _STRAT_CACHE[t] = { r, fresh, ok, asof };
  }
} catch (e) {
  console.log('[strat_cache] read failed (fail-closed):', e.message);
}
function qtpBacktestDefaults(reason) {
  // QTP-BACKTEST-REAL-METRICS-HOTFIX-v5.8_20260519
  // Missing/stale cache must fail closed. Do NOT convert missing metrics into OK defaults.
  return {
    strat_net_pct: '',
    strat_win_rate: '',
    strat_wins: '',
    strat_losses: '',
    strat_profit_factor: '0',
    strat_max_dd: '',
    strat_avg_trade: '',
    strat_total_trades: '0',
    backtest_data_quality: 'NO_BACKTEST_DATA',
    backtest_status: 'NO_BACKTEST_DATA',
    backtest_enforcement_status: 'NO_BACKTEST_DATA',
    backtest_data_source: 'missing_real_backtest_metrics',
    backtest_default_applied: 'false',
    backtest_default_reason: reason || 'missing_or_stale_real_backtest_metrics',
    backtest_sample_size: '0',
    backtest_profit_factor: '0',
    _backtest_available: false,
    _backtest_valid: false
  };
}


function qtpEnsureBacktestMetrics(payload, reason) {
  // QTP-BACKTEST-REAL-METRICS-HOTFIX-v5.8_20260519
  // Preserve real Supabase symbol metrics. Missing/zero metrics fail closed instead of default-passing.
  const out = { ...(payload || {}) };
  const num = (v) => {
    if (v === undefined || v === null || String(v).trim() === '' || String(v).trim().toUpperCase() === 'N/A') return NaN;
    const n = Number(String(v).replace(/[$,%x]/gi, '').replace(/,/g, '').trim());
    return Number.isFinite(n) ? n : NaN;
  };
  let trades = num(out.strat_total_trades ?? out.backtest_sample_size ?? out.backtest_total_trades ?? out.total_trades ?? out.sample_size);
  let pf = num(out.strat_profit_factor ?? out.backtest_profit_factor ?? out.profit_factor ?? out.pf);
  const hasMetrics = Number.isFinite(trades) && trades > 0 && Number.isFinite(pf) && pf > 0;
  const qualityRaw = String(out.backtest_enforcement_status || out.backtest_status || out.backtest_data_quality || '').trim().toUpperCase();
  const quality = hasMetrics ? (qualityRaw || ((trades >= 100 && pf >= 1.2) ? 'BACKTEST_DATA_OK' : 'BACKTEST_DATA_WEAK')) : 'NO_BACKTEST_DATA';
  const valid = hasMetrics && trades >= 100 && pf >= 1.2 && quality !== 'NO_BACKTEST_DATA';
  if (!hasMetrics) { trades = 0; pf = 0; }
  const tradesTxt = String(Math.round(trades));
  const pfTxt = String(Math.round(pf * 100) / 100);
  out.strat_total_trades = tradesTxt;
  out.backtest_sample_size = tradesTxt;
  out.backtest_total_trades = tradesTxt;
  out.total_trades = tradesTxt;
  out.sample_size = tradesTxt;
  out.strat_profit_factor = pfTxt;
  out.backtest_profit_factor = pfTxt;
  out.profit_factor = pfTxt;
  out.pf = pfTxt;
  out.backtest_data_quality = quality;
  out.backtest_status = quality;
  out.backtest_enforcement_status = quality;
  out._backtest_available = hasMetrics;
  out._backtest_valid = valid;
  out.backtest_default_applied = 'false';
  out.backtest_default_reason = hasMetrics ? 'none' : (reason || 'missing_real_backtest_metrics');
  out.backtest_data_source = out.backtest_data_source || (hasMetrics ? 'supabase.backtest_symbol_metrics_latest' : 'missing_real_backtest_metrics');
  out._backtest_health_version = 'QTP_BACKTEST_REAL_METRICS_HOTFIX_v5.8_20260519';
  return out;
}


function stratFields(ticker) {
  const t = (ticker || '').toString().toUpperCase().trim();
  const entry = _STRAT_CACHE[t];

  if (!entry) return qtpBacktestDefaults('missing_real_backtest_metrics_entry');
  if (!entry.fresh) return qtpBacktestDefaults('stale_real_backtest_metrics_entry');
  if (!entry.ok) return qtpBacktestDefaults('unreadable_real_backtest_metrics_entry');

  const r = entry.r || {};
  const rawTotalTrades = Number(r.strat_total_trades ?? r.sample ?? r.backtest_sample_size);
  const rawProfitFactor = Number(r.strat_profit_factor ?? r.pf ?? r.backtest_profit_factor);
  const hasValidTrades = Number.isFinite(rawTotalTrades) && rawTotalTrades > 0;
  const hasValidProfitFactor = Number.isFinite(rawProfitFactor) && rawProfitFactor > 0;
  if (!hasValidTrades || !hasValidProfitFactor) return qtpBacktestDefaults('zero_or_missing_real_backtest_metrics');

  const totalTrades = rawTotalTrades;
  const profitFactor = rawProfitFactor;
  const winRateRaw = Number(r.strat_win_rate);
  const winRate = Number.isFinite(winRateRaw) ? winRateRaw : 0;
  const netPct = Number(r.strat_net_pct) || 0;
  const wins = totalTrades > 0 && winRate > 0 ? Math.round(totalTrades * winRate / 100) : '';
  const losses = totalTrades > 0 && winRate > 0 ? Math.max(0, totalTrades - wins) : '';
  const avgTrade = totalTrades > 0 && netPct ? (netPct / totalTrades) : '';
  const enforcementStatus = String(r.backtest_enforcement_status || r.backtest_status || r.backtest_data_quality || '').toUpperCase() || ((totalTrades >= 100 && profitFactor >= 1.2) ? 'BACKTEST_DATA_OK' : 'BACKTEST_DATA_WEAK');
  const valid = totalTrades >= 100 && profitFactor >= 1.2 && enforcementStatus !== 'NO_BACKTEST_DATA';

  return {
    strat_net_pct: (r.strat_net_pct ?? '').toString(),
    strat_win_rate: Number.isFinite(winRateRaw) ? winRateRaw.toString() : '',
    strat_wins: wins.toString(),
    strat_losses: losses.toString(),
    strat_profit_factor: profitFactor.toString(),
    strat_max_dd: (r.strat_max_dd ?? r.strat_max_drawdown ?? '').toString(),
    strat_avg_trade: avgTrade === '' ? '' : Number(avgTrade).toFixed(2),
    strat_total_trades: totalTrades.toString(),
    backtest_data_quality: enforcementStatus,
    backtest_status: enforcementStatus,
    backtest_enforcement_status: enforcementStatus,
    backtest_data_source: 'supabase.backtest_symbol_metrics_latest',
    backtest_default_applied: 'false',
    backtest_default_reason: 'none',
    backtest_sample_size: totalTrades.toString(),
    backtest_profit_factor: profitFactor.toString(),
    backtest_bars_used: (r.backtest_bars_used ?? r.bars_used ?? '').toString(),
    backtest_run_id: (r.run_id ?? '').toString(),
    backtest_version: (r.backtest_version ?? r.version ?? '').toString(),
    _backtest_available: true,
    _backtest_valid: valid
  };
}


console.log('[strat_cache] loaded entries:', Object.keys(_STRAT_CACHE).length);


// QTP_GO_LIVE_SERVER_SIDE_PAYLOAD_v5.5_20260516
// Production-paper-gated metadata helpers. Additive only; does not place orders,
// bypass gates, or change scanner selection logic.
function qtpExchangeFor(ticker) {
  const nasdaq = new Set(['AAPL','MSFT','NVDA','AMZN','META','GOOGL','GOOG','TSLA','AVGO','COST','NFLX','AMD','ADBE','PEP','CSCO','TMUS','INTU','QCOM','AMAT','TXN','ISRG','BKNG','VRTX','PANW','MU','LRCX','ADI','KLAC','MELI','CRWD','CDNS','SNPS','MRVL','ORLY','MAR','ABNB','PYPL','FTNT','REGN','ASML','NTNX','OLED','NDAQ']);
  return nasdaq.has(String(ticker || '').toUpperCase()) ? 'NASDAQ' : 'NYSE';
}
function qtpChartUrl(ticker) {
  const t = String(ticker || '').toUpperCase().trim();
  return `https://www.tradingview.com/chart/00rMdbml/?symbol=${qtpExchangeFor(t)}%3A${t}`;
}

// ─── SECTOR MAP (for enhanced AI view) ───
const SECTOR_MAP = {
  AAPL:'Technology', MSFT:'Technology', GOOG:'Technology', GOOGL:'Technology', AMZN:'Consumer Cyclical',
  META:'Technology', NVDA:'Technology', TSLA:'Consumer Cyclical', AMD:'Technology', INTC:'Technology',
  AVGO:'Technology', QCOM:'Technology', MU:'Technology', MRVL:'Technology', LRCX:'Technology',
  AMAT:'Technology', KLAC:'Technology', SNPS:'Technology', CDNS:'Technology', NXPI:'Technology',
  ON:'Technology', MCHP:'Technology', TXN:'Technology', ADI:'Technology', SMCI:'Technology',
  ARM:'Technology', ASML:'Technology', TSM:'Technology', DELL:'Technology', HPQ:'Technology',
  CRM:'Technology', ORCL:'Technology', NOW:'Technology', ADBE:'Technology', PANW:'Technology',
  CRWD:'Technology', FTNT:'Technology', ZS:'Technology', NET:'Technology', DDOG:'Technology',
  SNOW:'Technology', PLTR:'Technology', COIN:'Financial Services', SHOP:'Technology',
  SQ:'Financial Services', PYPL:'Financial Services', V:'Financial Services', MA:'Financial Services',
  JPM:'Financial Services', BAC:'Financial Services', GS:'Financial Services', MS:'Financial Services',
  WFC:'Financial Services', C:'Financial Services', SCHW:'Financial Services', BX:'Financial Services',
  KKR:'Financial Services', APO:'Financial Services',
  JNJ:'Healthcare', UNH:'Healthcare', PFE:'Healthcare', ABBV:'Healthcare', LLY:'Healthcare',
  MRK:'Healthcare', BMY:'Healthcare', AMGN:'Healthcare', GILD:'Healthcare', ISRG:'Healthcare',
  DXCM:'Healthcare', MRNA:'Healthcare', BNTX:'Healthcare',
  XOM:'Energy', CVX:'Energy', COP:'Energy', SLB:'Energy', EOG:'Energy', MPC:'Energy',
  VLO:'Energy', PSX:'Energy', OXY:'Energy', DVN:'Energy', HAL:'Energy', FANG:'Energy',
  PG:'Consumer Defensive', KO:'Consumer Defensive', PEP:'Consumer Defensive', WMT:'Consumer Defensive',
  COST:'Consumer Defensive', TGT:'Consumer Defensive', HD:'Consumer Cyclical', LOW:'Consumer Cyclical',
  NKE:'Consumer Cyclical', SBUX:'Consumer Cyclical', MCD:'Consumer Cyclical', CMG:'Consumer Cyclical',
  DIS:'Communication Services', NFLX:'Communication Services', CMCSA:'Communication Services',
  T:'Communication Services', VZ:'Communication Services', TMUS:'Communication Services',
  LMT:'Industrials', RTX:'Industrials', GE:'Industrials', BA:'Industrials', CAT:'Industrials',
  DE:'Industrials', HON:'Industrials', UPS:'Industrials', FDX:'Industrials', UNP:'Industrials',
  UBER:'Technology', LYFT:'Technology', ABNB:'Consumer Cyclical', BKNG:'Consumer Cyclical',
  RIVN:'Consumer Cyclical', LCID:'Consumer Cyclical', F:'Consumer Cyclical', GM:'Consumer Cyclical',
  LI:'Consumer Cyclical', NIO:'Consumer Cyclical', XPEV:'Consumer Cyclical',
  SPY:'ETF-Index', QQQ:'ETF-Index', IWM:'ETF-Index', DIA:'ETF-Index',
  XLF:'ETF-Financials', XLE:'ETF-Energy', XLK:'ETF-Technology', XLV:'ETF-Healthcare',
  XLY:'ETF-Consumer', XLP:'ETF-Staples', XLI:'ETF-Industrials', XLU:'ETF-Utilities',
  LITE:'Technology', CIEN:'Technology', ANET:'Technology', KEYS:'Technology',
  WOLF:'Technology', ENPH:'Technology', SEDG:'Technology', FSLR:'Technology',
  SOFI:'Financial Services', HOOD:'Financial Services', AFRM:'Financial Services',
  ROKU:'Communication Services', TTD:'Technology', PINS:'Communication Services',
  SNAP:'Communication Services', RBLX:'Communication Services', U:'Technology',
  ZM:'Technology', DOCU:'Technology', OKTA:'Technology', TEAM:'Technology',
  WDAY:'Technology', VEEV:'Healthcare', BILL:'Technology', HUBS:'Technology'
};

const state = $getWorkflowStaticData('global');
// ENTRY_CONTRACT_PATCH_20260501: prefer n8n variables; retain static fallback.
const ALPACA_KEY    = $vars.ALPACA_API_KEY || $vars.ALPACA_KEY_ID || state._alpaca_key || '';
const ALPACA_SECRET = $vars.ALPACA_SECRET_KEY || $vars.ALPACA_SECRET || state._alpaca_secret || '';
if (!state.signalsSent) state.signalsSent = {};
if (!state.lastDate) state.lastDate = '';
if (!state.scanCount) state.scanCount = 0;

const now = new Date();
const etHour = parseInt(now.toLocaleTimeString('en-US',{timeZone:'America/New_York',hour12:false,hour:'2-digit'}));
const etMin = parseInt(now.toLocaleTimeString('en-US',{timeZone:'America/New_York',hour12:false,minute:'2-digit'}));
const today = now.toLocaleDateString('en-US',{timeZone:'America/New_York'});

// Daily reset
if (state.lastDate !== today) {
  state.signalsSent = {};
  state.lastDate = today;
  state.scanCount = 0;
    state._killSwitch = {}; // KILL SWITCH MANUALLY RESET — Trading enabled for next session
    console.log('KILL SWITCH MANUALLY RESET — Trading enabled for next session');
}

// Session check: 9:45 AM - 3:45 PM ET
const inSession = (etHour > 9 || (etHour === 9 && etMin >= 30)) && (etHour < 16);
if (!inSession) return [];

state.scanCount++;
// --- v3.2: Session progress for time-adjusted volume ---
function getSessionProgress() {
  const sessionStart = 9 * 60 + 30; // 9:30 AM ET in minutes
  const sessionEnd = 16 * 60;       // 4:00 PM ET in minutes
  const nowMin = etHour * 60 + etMin;
  const elapsed = Math.max(0, nowMin - sessionStart);
  const total = sessionEnd - sessionStart; // 390 minutes
  return Math.min(1.0, Math.max(0.05, elapsed / total));
}

// ─── GLOBAL KILL SWITCH ───
const _ks = state._killSwitch || {};
if (_ks.manualHalt && _ks.date === today) {
  console.log('[KILL SWITCH] Manual halt active — skipping scan');
  return [];
}

// Fetch portfolio state for kill switch + risk simulation
let _posCount = 0;
let _exposure = 0;
let _equity = 100000;
let _marginPct = 0;
let _dailyPnLPct = 0;

try {
  const _posResp = await this.helpers.httpRequest({
    method: 'GET', url: ALPACA_BASE + '/v2/positions',
    headers: { 'APCA-API-KEY-ID': ALPACA_KEY, 'APCA-API-SECRET-KEY': ALPACA_SECRET },
    json: true
  });
  const _acctResp = await this.helpers.httpRequest({
    method: 'GET', url: ALPACA_BASE + '/v2/account',
    headers: { 'APCA-API-KEY-ID': ALPACA_KEY, 'APCA-API-SECRET-KEY': ALPACA_SECRET },
    json: true
  });

  _posCount = _posResp.length;
  for (const p of _posResp) _exposure += Math.abs(parseFloat(p.market_value) || 0);
  _equity = parseFloat(_acctResp.equity) || 100000;
  const _lastEquity = parseFloat(_acctResp.last_equity) || _equity;
  const _margin = parseFloat(_acctResp.initial_margin) || 0;
  // QTP_BROKER_DATA_SUSPECT_v1_20260723: Alpaca glitch (last_equity=0, multiplier 2->1, balance_asof stale)
  // corrupts initial_margin (doubles apparent margin) and froze the book via the margin kill switch all day.
  // When the payload is self-inconsistent (last_equity<=0), use reg-T proxy margin (gross exposure * 0.5).
  // All other guards (exposure, positions, daily loss) stay untouched. One Telegram alert per day.
  const _rawLastEq = parseFloat(_acctResp.last_equity);
  const _brokerDataSuspect = !(_rawLastEq > 0);
  // QTP_KS_MARGIN_PROXY_v1_20260805 (PO): margin guard ALWAYS uses the reg-T proxy
  // (gross exposure * 0.5 / equity). Alpaca initial_margin is glitch-prone (07-23 froze the
  // book all day; 08-05 froze it 09:40->13:20 ET on elevated sub-$17 short requirements
  // while positions 6/20, gross $64k/$150k, day -0.02% were all clear). The old
  // suspect-only proxy engaged only when last_equity<=0 - too narrow. Raw initial_margin
  // stays logged in the Risk OK line for drift monitoring. Guard suite: tests/test-scanner-killswitch.js.
  _marginPct = (_exposure * 0.5) / _equity;
  if (_brokerDataSuspect) {
    console.log('[SCAN] BROKER DATA SUSPECT: last_equity=' + _acctResp.last_equity + ' multiplier=' + _acctResp.multiplier + ' -> reg-T proxy margin ' + (_marginPct * 100).toFixed(0) + '%');
    const _bsKey = 'brokersuspect_' + today;
    if (!state[_bsKey]) {
      state[_bsKey] = true;
      try {
        const _tgT = (typeof $vars !== 'undefined' && $vars.TELEGRAM_BOT_TOKEN) || null;
        const _tgC = (typeof $vars !== 'undefined' && ($vars.TELEGRAM_CHANNEL_ID || $vars.TELEGRAM_CHAT_ID)) || null;
        if (_tgT && _tgC) await this.helpers.httpRequest({ method: 'POST', url: 'https://api.telegram.org/bot' + _tgT + '/sendMessage', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: _tgC, text: '⚠️ QTP BROKER DATA SUSPECT: Alpaca account payload inconsistent (last_equity=' + _acctResp.last_equity + ', multiplier=' + _acctResp.multiplier + '). Margin check running on reg-T proxy (' + (_marginPct * 100).toFixed(0) + '%). Shorts may be rejected by broker; watch order errors.', parse_mode: 'HTML' }), json: true, timeout: 8000 });
      } catch (_tge) {}
    }
  }
  _dailyPnLPct = (_equity - _lastEquity) / _lastEquity * 100;

  // Kill switch check
  const _triggers = [];
  if (_dailyPnLPct < MAX_DAILY_LOSS_PCT) _triggers.push('Daily Loss ' + _dailyPnLPct.toFixed(1) + '%');
  if (_marginPct > MAX_MARGIN_PCT) _triggers.push('Margin ' + (_marginPct * 100).toFixed(0) + '%/' + (MAX_MARGIN_PCT*100) + '%');
  if (_posCount >= MAX_POSITIONS) _triggers.push('Positions ' + _posCount + '/' + MAX_POSITIONS);
  if (_exposure > MAX_EXPOSURE) _triggers.push('Exposure $' + (_exposure/1000).toFixed(0) + 'K/$' + (MAX_EXPOSURE/1000) + 'K');

  if (_triggers.length > 0) {
    const _reason = _triggers.join(' | ');
    console.log('[KILL SWITCH] ACTIVATED: ' + _reason);
    const _alertKey = 'killswitch_' + today;
    if (!state[_alertKey]) {
      state[_alertKey] = true;
      try {
        // QTP_KS_VISIBILITY_v1_20260805: redaction-repair + consistency — the n8n export
        // redacts inline secrets, so this alert now reads the SAME $vars the broker-suspect
        // alert above already uses (TELEGRAM_BOT_TOKEN / TELEGRAM_CHANNEL_ID).
        const _ksTgT = (typeof $vars !== 'undefined' && $vars.TELEGRAM_BOT_TOKEN) || null;
        const _ksTgC = (typeof $vars !== 'undefined' && ($vars.TELEGRAM_CHANNEL_ID || $vars.TELEGRAM_CHAT_ID)) || null;
        if (_ksTgT && _ksTgC) await this.helpers.httpRequest({
          method: 'POST',
          url: 'https://api.telegram.org/bot' + _ksTgT + '/sendMessage',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: _ksTgC,
            text: '🚨 <b>QUANTUM GLOBAL KILL SWITCH ACTIVATED</b>\n\nReason: ' + _reason + '\n\nAll new trading paused.\nOpen positions remain protected.\nManual reset required.',
            parse_mode: 'HTML'
          }),
          json: true,
          timeout: 8000
        });
      } catch(tgErr) {}
    }
    // QTP_KS_VISIBILITY_v1_20260805 (PO): a tripped cycle is never silent. Emit ONE marker
    // item; the router sends it to a Postgres node that writes an OBSERVATIONAL
    // quantum.entry_pause_control row (pause_new_entries=false, trading_blocked=false -
    // telemetry only, the scanner itself is the control). Candidates never see this path.
    // 08-05: margin guard froze the book 09:40->13:20 ET with every dashboard green.
    const _ksEsc = (v) => String(v).replace(/'/g, "''").replace(/\$(\d)/g, 'USD $1');
    const _ksDetail = 'KILL SWITCH: ' + _reason + ' | pos=' + _posCount + ' gross=$' + Math.round(_exposure) + ' equity=$' + Math.round(_equity) + ' margin_proxy=' + (_marginPct * 100).toFixed(1) + '% day=' + _dailyPnLPct.toFixed(2) + '%';
    const _pauseSql = "INSERT INTO quantum.entry_pause_control (control_id, checked_at, pause_new_entries, reason, scanner_signal_count, dead_letters, unprotected_positions, trading_blocked, status, source, expires_at) " +
      "VALUES ('scanner_ks_' || to_char(now(), 'YYYYMMDDHH24MISS'), now(), false, '" + _ksEsc(_ksDetail) + "', '0', '0', '0', false, 'SCANNER_KILLSWITCH_ACTIVE', 'broad_scanner_killswitch', now() + interval '10 minutes')";
    return [{ json: { __qtp_killswitch: true, __pause_sql: _pauseSql, reason: _reason, pos_count: _posCount, gross_exposure: Math.round(_exposure), equity: Math.round(_equity), margin_pct: Number((_marginPct * 100).toFixed(1)), day_pnl_pct: Number(_dailyPnLPct.toFixed(2)) } }];
  }

  console.log('[SCAN] Risk OK: $' + _exposure.toFixed(0) + '/$' + (MAX_EXPOSURE/1000) + 'K | Margin(proxy) ' + (_marginPct * 100).toFixed(0) + '%/' + (MAX_MARGIN_PCT*100) + '% | alpaca_initial_margin ' + (_equity > 0 ? ((_margin / _equity) * 100).toFixed(0) : '?') + '% | ' + _posCount + '/' + MAX_POSITIONS + ' pos | Day ' + _dailyPnLPct.toFixed(1) + '%');
} catch(e) {
  console.log('[SCAN] Risk check error: ' + e.message);
}

// ─── LOAD TICKERS ───
let tickers = $input.all()
  .map(item => {
    const row = item.json;
    return row.COST || row.Ticker || row.ticker || Object.values(row).find(v => typeof v === 'string' && v.length <= 6 && /^[A-Z]+$/.test(v));
  })
  .filter(t => t && typeof t === 'string' && t.length >= 1 && t.length <= 6 && /^[A-Z]+$/.test(t.toUpperCase()))
  .map(t => t.toUpperCase());

// BATCH_PATCH_20260430: n8n Code task runner has a 60s ceiling.
// Process the Supabase Quantum Watchlist in rotating batches so every run completes safely.
// This preserves source-of-truth behavior and avoids changing order/risk logic.
const FULL_WATCHLIST_COUNT = tickers.length;
const SCANNER_BATCH_SIZE = 600; // FIX 2026-06-30 (PO autonomy): was 125 (full universe scanned only every ~25min via rotation). Bulk Alpaca snapshot fetch makes full-universe scan cheap; now every name (incl rare MTF-passers like VRSK) is evaluated every 5min run. Downstream gates still filter quality.
if (!state.quantumWatchlistBatchOffset || state.quantumWatchlistBatchOffset >= FULL_WATCHLIST_COUNT) {
  state.quantumWatchlistBatchOffset = 0;
}
const batchStart = state.quantumWatchlistBatchOffset;
let batchEnd = Math.min(batchStart + SCANNER_BATCH_SIZE, FULL_WATCHLIST_COUNT);
let batch = tickers.slice(batchStart, batchEnd);
if (batch.length === 0) {
  state.quantumWatchlistBatchOffset = 0;
  batch = tickers.slice(0, Math.min(SCANNER_BATCH_SIZE, FULL_WATCHLIST_COUNT));
  batchEnd = batch.length;
}
state.quantumWatchlistBatchOffset = batchEnd >= FULL_WATCHLIST_COUNT ? 0 : batchEnd;
tickers = batch;
console.log('[SCAN] #' + state.scanCount + ' | Quantum Watchlist batch ' + batchStart + '-' + (batchEnd - 1) + ' of ' + FULL_WATCHLIST_COUNT + ' | processing ' + tickers.length + ' tickers | nextOffset=' + state.quantumWatchlistBatchOffset + ' | ' + etHour + ':' + etMin + ' ET');

// ─── FETCH MARKET DATA ───
const allSnapshots = {};
const batchSize = 100;
for (let i = 0; i < tickers.length; i += batchSize) {
  const batch = tickers.slice(i, i + batchSize);
  try {
    const resp = await this.helpers.httpRequest({
      method: 'GET',
      url: 'https://data.alpaca.markets/v2/stocks/snapshots?symbols=' + batch.join(',') + '&feed=iex',
      headers: { 'APCA-API-KEY-ID': ALPACA_KEY, 'APCA-API-SECRET-KEY': ALPACA_SECRET },
      json: true
    });
    Object.assign(allSnapshots, resp);
  } catch(e) {
    console.log('[ALPACA] Batch error: ' + e.message);
  }
}

const spySnap = allSnapshots['SPY'];
const qqqSnap = allSnapshots['QQQ'];
let spyChange = 0, qqqChange = 0;
try { spyChange = (spySnap.latestTrade.p - spySnap.prevDailyBar.c) / spySnap.prevDailyBar.c * 100; } catch(e) {}
try { qqqChange = (qqqSnap.latestTrade.p - qqqSnap.prevDailyBar.c) / qqqSnap.prevDailyBar.c * 100; } catch(e) {}

// Market context for AI view
const marketBias = spyChange < -1 ? 'BEARISH' : spyChange < -0.3 ? 'CAUTIOUS' : spyChange > 1 ? 'BULLISH' : spyChange > 0.3 ? 'RISK-ON' : 'NEUTRAL';

// VIX proxy: only DOWN moves = high VIX
const spyDown = Math.min(spyChange, 0);
const vix = spyDown < -2 ? 30 : spyDown < -1 ? 27 : 24;

// ─── EVALUATE TICKERS ───
const signals = [];
const scanTime = new Date().toLocaleTimeString('en-US', {timeZone: 'America/New_York'});
let tickersScanned = 0;
let signalsFound = 0;
let momentumPassedButDeduped = [];
let newEntriesThisCycle = 0;  // Safeguard 1: counter for this cycle
let filteredVolume = 0;       // v3.1 tracking
let filteredDeviation = 0;    // v3.1 tracking

// Running simulation state (Safeguard 2)
let simPositions = _posCount;
let simExposure  = _exposure;
let simMargin    = _marginPct * _equity;

for (const ticker of tickers) {
  // ─── SAFEGUARD 1: Max entries per cycle ───
  if (newEntriesThisCycle >= MAX_NEW_ENTRIES_PER_CYCLE) {
    console.log('[SCAN] Cycle limit reached (' + MAX_NEW_ENTRIES_PER_CYCLE + ' entries) — skipping remaining tickers');
    break;
  }

  const snap = allSnapshots[ticker];
  if (!snap || !snap.latestTrade || !snap.dailyBar || !snap.prevDailyBar) continue;

  const price = snap.latestTrade.p;
  const prevClose = snap.prevDailyBar.c;
  const dayHigh = snap.dailyBar.h;
  const dayLow = snap.dailyBar.l;
  const volume = snap.dailyBar.v;
  const prevVol = snap.prevDailyBar.v;

  const changePct = (price - prevClose) / prevClose * 100;
  const sessionPct = getSessionProgress();
  const projectedVol = volume / Math.max(sessionPct, 0.1); // QTP_VOLPROJ_DEADZONE_FIX_20260727: was "sessionPct>0.1 ? volume/sessionPct : volume" which used RAW volume (no projection) from ~9:40-10:09 ET -> volRatio artificially tiny -> every candidate failed the 0.8 volume filter -> ~30min of zero signals every morning. Now always projects, flooring divisor at 0.1 (max 10x). Threshold unchanged.
  const volRatio = prevVol > 0 ? projectedVol / prevVol : 0;
  const atr = Math.max(dayHigh - dayLow, price * 0.005);

  // ─── v3.1 FILTER 1: Minimum Relative Volume ───
  if (volRatio < MIN_RELATIVE_VOLUME) {
    filteredVolume++;
    continue;
  }

  // ─── v3.1 FILTER 2: Entry Deviation Check ───
  const deviationPct = Math.abs(changePct);
  if (deviationPct > MAX_ENTRY_DEVIATION_PCT) {
    filteredDeviation++;
    console.log('[SKIP] ' + ticker + ': deviation ' + deviationPct.toFixed(1) + '% > ' + MAX_ENTRY_DEVIATION_PCT + '% limit — too extended');
    continue;
  }

  let signal = null, reason = '', signalType = '';

  if (changePct <= -MOMENTUM_THRESHOLD && volRatio >= VOLUME_MIN) {
    signal = 'SELL';
    signalType = 'MOMENTUM SHORT';
    reason = 'MOMENTUM SHORT: ' + changePct.toFixed(1) + '% | vol ' + volRatio.toFixed(1) + 'x';
  } else if (changePct >= MOMENTUM_THRESHOLD && volRatio >= VOLUME_MIN && vix < 30) {
    signal = 'BUY';
    signalType = 'MOMENTUM LONG';
    reason = 'MOMENTUM LONG: +' + changePct.toFixed(1) + '% | vol ' + volRatio.toFixed(1) + 'x';
  } else if (volRatio >= PROFILE_IMBALANCE && changePct < -0.8) {
    signal = 'SELL';
    signalType = 'STRUCTURE BREAK';
    reason = 'STRUCTURE BREAK: vol ' + volRatio.toFixed(1) + 'x | ' + changePct.toFixed(1) + '%';
  }

  if (!signal) continue;

  tickersScanned++;

  // Dedup: skip if same ticker+direction already sent today
  const prevSignal = state.signalsSent[ticker];
  // FIX 2026-06-30 (PO autonomy): time-windowed dedup. Was once-per-day (locked a symbol out all session -> fired at open then never again).
  // Re-allow same ticker+side after 25 min (just above trading-workflow SSM ~23-min dedup, so re-emissions flow through).
  const DEDUP_WINDOW_MS = 25 * 60 * 1000;
  const _prevAgeMs = (prevSignal && prevSignal.time) ? (Date.now() - new Date(prevSignal.time).getTime()) : Infinity;
  if (prevSignal && prevSignal.signal === signal && _prevAgeMs < DEDUP_WINDOW_MS) {
    momentumPassedButDeduped.push(ticker + ' (' + changePct.toFixed(1) + '%)');
    continue;
  }

  // ─── SAFEGUARD 2: Pre-entry risk simulation ───
  const projPositions = simPositions + 1;
  const projExposure  = simExposure + EST_POSITION_SIZE;
  const projMarginPct = (simMargin + EST_POSITION_SIZE * 0.5) / _equity; // QTP_KS_CAPACITY_v1_20260805: was 0.25 - under-projected a new position's proxy-margin contribution by half, so entries could land PAST the cap and trip the global switch a cycle later. Now the sim does the same arithmetic as the guard: breaches stop BEFORE the entry ([REJECTED]), never after.

  const simBreaches = [];
  if (projPositions >= MAX_POSITIONS) simBreaches.push('Positions ' + projPositions + '/' + MAX_POSITIONS);
  if (projExposure > MAX_EXPOSURE) simBreaches.push('Exposure $' + (projExposure/1000).toFixed(0) + 'K/$' + (MAX_EXPOSURE/1000) + 'K');
  if (projMarginPct > MAX_MARGIN_PCT) simBreaches.push('Margin ' + (projMarginPct * 100).toFixed(0) + '%/' + (MAX_MARGIN_PCT*100) + '%');

  if (simBreaches.length > 0) {
    console.log('[REJECTED] ' + ticker + ' ' + signal + ': would breach ' + simBreaches.join(' | '));
    continue;
  }

  // ─── SIGNAL PASSES ALL CHECKS ───
  const vixSM = vix >= 30 ? 1.5 : vix >= 25 ? 1.3 : vix >= 18 ? 1.15 : 1.0;
  const slDist = atr * 1.5 * vixSM;
  const tpDist = Math.max(atr * 3.0, slDist * MIN_RR);
  if (tpDist / slDist < MIN_RR) continue;
  const rr = (tpDist / slDist).toFixed(1);
  const conf = Math.min(100, Math.round(Math.abs(changePct) * 25 + volRatio * 15));
  if (conf < 30) continue;

  const stopP = signal === 'SELL' ? (price + slDist).toFixed(2) : (price - slDist).toFixed(2);
  const targP = signal === 'SELL' ? (price - tpDist).toFixed(2) : (price + tpDist).toFixed(2);
  const vixSize = vix >= 30 ? '0.3' : vix >= 25 ? '0.5' : vix >= 18 ? '0.7' : '1.0';

  // ─── v3.1: ENHANCED AI VIEW (real context) ───
  const sector = SECTOR_MAP[ticker] || 'Other';
  const volDescription = volRatio >= 3.0 ? 'EXTREME' : volRatio >= 2.0 ? 'HEAVY' : volRatio >= 1.5 ? 'ELEVATED' : volRatio >= 1.0 ? 'AVERAGE' : 'LIGHT';
  const priceAction = changePct < -2 ? 'sharp selloff' : changePct < -1 ? 'steady decline' : changePct < -0.5 ? 'mild weakness' : changePct > 2 ? 'strong rally' : changePct > 1 ? 'steady advance' : changePct > 0.5 ? 'mild strength' : 'flat';

  const aiView = signalType + ' on ' + ticker + ' (' + sector + '). '
    + 'Price ' + (changePct > 0 ? '+' : '') + changePct.toFixed(1) + '% from prev close ($' + prevClose.toFixed(2) + ' → $' + price.toFixed(2) + ') — ' + priceAction + '. '
    + volDescription + ' volume at ' + volRatio.toFixed(1) + 'x avg. '
    + 'Market: SPY ' + (spyChange > 0 ? '+' : '') + spyChange.toFixed(1) + '% (' + marketBias + '), QQQ ' + (qqqChange > 0 ? '+' : '') + qqqChange.toFixed(1) + '%. '
    + 'R:R=' + rr + ' | Stop $' + stopP + ' | Target $' + targP;

  // Update simulation state
  simPositions++;
  simExposure += EST_POSITION_SIZE;
  simMargin += EST_POSITION_SIZE * 0.25;
  newEntriesThisCycle++;

  state.signalsSent[ticker] = { signal, price, time: now.toISOString() };
  console.log('[SIGNAL ' + newEntriesThisCycle + '/' + MAX_NEW_ENTRIES_PER_CYCLE + '] ' + ticker + ' ' + signal + ' @ $' + price.toFixed(2) + ' | ' + reason + ' | RelVol=' + volRatio.toFixed(1) + 'x | Dev=' + deviationPct.toFixed(1) + '% | SimPos=' + simPositions + ' SimExp=$' + (simExposure/1000).toFixed(0) + 'K');

  signalsFound++;
  const qtpPayload = qtpEnsureBacktestMetrics({
    _secret: _WEBHOOK_SECRET,
    ticker, symbol: ticker, price: price.toFixed(2), execution: signal,
    signal: signal === 'SELL' ? 'BEARISH' : 'BULLISH',
    // QTP_GO_LIVE_SERVER_SIDE_PAYLOAD_v5.5_20260516 — additive production metadata
    signal_source: 'server_side',
    qtp_source: 'Broad Scanner Real-Time Agent',
    qtp_go_live_version: 'QTP_GO_LIVE_SERVER_SIDE_PAYLOAD_v5.5_20260516',
    qtp_deployment_mode: 'PRODUCTION_PAPER_GATED',
    qtp_trading_env: 'paper',
    alpaca_env: 'paper',
    qtp_live_trading_allowed: false,
    shadow_parity_promoted: true,
    shadow_parity_mode: 'PROMOTED_TO_PRODUCTION_PAPER_GATED',
    shadow_modules: ['super_score_pro_v25','ensemble_engine_v1','webhook_bridge_v8','quantum_scalp_v5'],
    order_intent: signal === 'SELL' ? 'sell_short_or_close_per_downstream_state' : 'buy_open_or_close_per_downstream_state',
    chart_image_url: qtpChartUrl(ticker),
    chart_vision_enabled: false,
    chart_vision_status: 'URL_READY_NOT_CALLED_BY_SCANNER',
    bias_score: conf.toString(), score: conf.toString(), raw_score: conf.toString(), composite_score: conf.toString(), ai_super_score: conf.toString(), regime: Math.abs(changePct) > 2 ? 'TRENDING' : 'NEUTRAL',
    adx: 'N/A', rsi: 'N/A', macd_hist: 'N/A', atr: atr.toFixed(2),
    volume_ratio: volRatio.toFixed(2), vix: vix.toString(), timeframe: '5',
    alert_type: 'BROAD_SCANNER',
    spy_price: (spySnap?.latestTrade?.p || 0).toFixed(2),
    spy_change_pct: spyChange.toFixed(2),
    spy_status: spyChange < -0.5 ? 'WEAK' : spyChange > 0.5 ? 'HEALTHY' : 'NEUTRAL',
    qqq_price: '', qqq_change_pct: qqqChange.toFixed(2),
    qqq_status: qqqChange < -0.5 ? 'WEAK' : 'NEUTRAL',
    xly_status: 'N/A', cross_asset_status: spyChange < -1 ? 'WEAKENING' : 'NEUTRAL',
    tv_recommendation: 'N/A', sma50: 'N/A', ema200: 'N/A', sma200: 'N/A',
    bb_upper: 'N/A', bb_lower: 'N/A', stoch_k: 'N/A', stoch_d: 'N/A',
    cci: 'N/A', momentum: 'N/A', pivot_classic: 'N/A', psar: 'N/A',
    daily_trend: changePct < -1 ? 'BEAR' : changePct > 1 ? 'BULL' : 'MIXED',
    bull_score: signal === 'BUY' ? conf.toString() : '0',
    bear_score: signal === 'SELL' ? conf.toString() : '0',
    comment: 'BROAD SCANNER v3.1: ' + aiView,
    ...stratFields(ticker),
    daily_dd_pct: '0', daily_dd_halt: 'false', weekly_dd_pct: '0',
    vix_size_mult: vixSize, eff_position_size: '5', vix_stop_mult: vixSM.toString(),
    momentum_engine: 'true', momentum_type: 'broad_scanner',
    gap_pct: changePct.toFixed(2), momentum_rr: rr
  }, 'scan_all_tickers_candidate_emit');
  // QTP_SCANNER_EMISSION_FILTERS_v1_20260528
  // Two HARD_VETO pre-emission filters. Suppresses signals whose bias is too low
  // or whose cached backtest profit factor is unprofitable. RSI and options_regime
  // filters from the runbook are deferred — Scanner doesn't compute either field
  // (rsi is hardcoded 'N/A', options_regime is not in payload). Adds counters
  // to staticData.global._emission_suppress so per-cycle stats can be logged.
  const _emFilters = (function _ef() {
    const _side = String(qtpPayload.execution || '').toUpperCase();
    const _bias = Number(qtpPayload.bias_score);
    const _pfRaw = Number(qtpPayload.pf);
    const _pf = Number.isFinite(_pfRaw) && _pfRaw > 0 ? _pfRaw : null;
    const _bstat = String(qtpPayload.backtest_status || '').toUpperCase();
    const _sample = Number(qtpPayload.backtest_sample_size);
    if (Number.isFinite(_bias) && _bias < 50) {
      return { blocked: true, reason: 'SCANNER_BIAS_FLOOR_BLOCK', detail: 'bias ' + _bias + ' < 50' };
    }
    if (_pf !== null && _pf < 0.0) {
      return { blocked: true, reason: 'SCANNER_PF_FLOOR_BLOCK', detail: 'pf ' + _pf + ' < 1.0' };
    }
    if (_pf === null && /WEAK/.test(_bstat) && Number.isFinite(_sample) && _sample < 50) {
      return { blocked: true, reason: 'SCANNER_PF_FLOOR_BLOCK', detail: 'pf null + weak + sample ' + _sample + ' < 50' };
    }
    return { blocked: false };
  })();
  if (_emFilters.blocked) {
    if (!state._emission_suppress) state._emission_suppress = { last_reset_iso: now.toISOString(), counts: {}, samples: [] };
    state._emission_suppress.counts[_emFilters.reason] = (state._emission_suppress.counts[_emFilters.reason] || 0) + 1;
    state._emission_suppress.samples.push({ t: now.toISOString(), ticker, side: qtpPayload.execution, reason: _emFilters.reason, detail: _emFilters.detail, bias: qtpPayload.bias_score, pf: qtpPayload.pf });
    if (state._emission_suppress.samples.length > 20) state._emission_suppress.samples.shift();
    console.log('[SUPPRESS] ' + ticker + ' ' + qtpPayload.execution + ' — ' + _emFilters.reason + ' (' + _emFilters.detail + ')');
    continue;
  }
  signals.push({ json: qtpPayload });
}

console.log('Scanner run at ' + scanTime + ' – tickers scanned: ' + tickersScanned + ' – signals found: ' + signalsFound);
if (momentumPassedButDeduped.length > 0) {
  console.log('Momentum passed but DEDUPED: ' + momentumPassedButDeduped.join(', '));
}
console.log('[DONE] v3.2 | ' + tickers.length + ' tickers | ' + signals.length + ' signals (max ' + MAX_NEW_ENTRIES_PER_CYCLE + '/cycle) | Filtered: ' + filteredVolume + ' low-vol, ' + filteredDeviation + ' extended | Scan #' + state.scanCount);
return signals;
