// QTP_EXT_HOURS_SSM_SESSION_GATE_v2_20260527
// Replaces the legacy 09:30-only hard silence with 04:00-20:00 ET session logic.
// Extended-hours entries are allowed only when the upstream mode gate has set
// extended_hours_execution_allowed=true. STAND ASIDE neutral refresh suppression
// remains below this block and is not changed.
const _tgToken = (typeof $vars !== 'undefined' && $vars.TELEGRAM_BOT_TOKEN) ? $vars.TELEGRAM_BOT_TOKEN : ''; // QTP_TG_TOKEN_VAR_v2_20260713 — literal fallback removed (rotation hygiene); in-code sends fail-soft if var empty — remove literal fallback after rotation
{
  const __raw = $input.first().json || {};
  const __d = (__raw.body && typeof __raw.body === 'object') ? __raw.body : __raw;
  const __ticker = String(__d.ticker || __d.symbol || '').toUpperCase();
  const __execution = String(__d.execution || __d.signal || __d.action || __d.direction || '').toUpperCase();
  const __hasSignalShape = !!(__ticker || __d.alert_type) && !!(__execution || __d.signal || __d.action || __d.direction);
  const __alertType = String(__d.alert_type || __d.source || '').toUpperCase();
  const __isTradingViewLike = __hasSignalShape && !__alertType.includes('RISK') && !__alertType.includes('FILL') && !__alertType.includes('GTC_POLL') && !__alertType.includes('HEARTBEAT');
  const __isDirectional = ['BUY','SELL','LONG','SHORT','BULLISH','BEARISH'].includes(__execution);
  const __session = String(__d.market_session || '').toUpperCase();
  const __isExt = __d.is_extended_hours === true || String(__d.is_extended_hours || '').toLowerCase() === 'true';
  const __extAllowed = __d.extended_hours_execution_allowed === true || String(__d.extended_hours_execution_allowed || '').toLowerCase() === 'true';
  const __clockTradable = __d.session_tradable_clock === true || String(__d.session_tradable_clock || '').toLowerCase() === 'true';
  const __now = new Date();
  const __et = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(__now).reduce((a,p)=>(a[p.type]=p.value,a),{});
  const __h = Number(__et.hour), __m = Number(__et.minute);
  const __minute = __h * 60 + __m;
  const __weekdayOk = !['Sat','Sun'].includes(__et.weekday);
  const __inFullTradingWindow = __weekdayOk && __minute >= 240 && __minute < 1200; // 04:00-20:00 ET
  let __blocked = __isTradingViewLike && __isDirectional && (!__inFullTradingWindow || !__clockTradable || (__isExt && !__extAllowed));
  const __rp = (__d && __d.raw_payload && typeof __d.raw_payload === 'object') ? __d.raw_payload : {};
  const __isHarnessTest = ((__d && __d.harness === true) || (__rp && __rp.harness === true)) && ((__d && __d.is_test_injection === true) || (__rp && __rp.is_test_injection === true));
  if (__isHarnessTest) { __blocked = false; }
  console.log('[SESSION_GATE_HARNESS_BYPASS] symbol=' + (__d.symbol || 'UNKNOWN') + ' is_test_injection=true harness=true alert_type=' + (__d.alert_type || 'UNKNOWN'));
  if (__blocked) {
    const output = { ...__d };
    output.route = 'SUPPRESSED_DIAGNOSTIC_ONLY';
    output._sm_route = 'SKIP';
    output._sm_action = 'SUPPRESSED_DIAGNOSTIC_ONLY';
    output.ssm_reason = __isExt && !__extAllowed
      ? 'Extended-hours signal suppressed because qtp_full_extended_hours_mode is disabled'
      : 'TradingView/webhook signal suppressed outside 04:00-20:00 ET trading window';
    output._sm_reason = output.ssm_reason;
    output.blocked_stage = 'SESSION_TIME_FILTER';
    output._vc_pass = false;
    output._vc_verdict = 'SESSION_SUPPRESSED';
    output.vc_verdict = 'SESSION_SUPPRESSED';
    output.gate_decision = 'SESSION_SUPPRESSED';
    output.feedback = 'SESSION_SUPPRESSED: Session gate blocked this directional webhook before VC/MTF/Risk routing.';
    output.vc_feedback = output.feedback;
    output.ai_feedback = output.feedback;
    output.parser_version = output.parser_version || 'QTP_CYCLE_007_17_NODE_HARDENED_20260511';
    output.qtp_session_gate_version = 'QTP_EXT_HOURS_SSM_SESSION_GATE_v2_20260527';
    output.qtp_cycle_version = output.qtp_cycle_version || 'QTP_CYCLE_007_17_NODE_HARDENED_20260511';
    return [{ json: output }];
  }
}

// QTP_CYCLE_007_17_NODE_HARDENED_20260511 — Patch 5: after-hours STAND ASIDE session-refresh suppression.
{
  const __raw = $input.first().json || {};
  const __d = (__raw.body && (__raw.body.ticker || __raw.body.symbol)) ? __raw.body : __raw;
  const execution = String(__d.execution || __d.signal || __d.action || __d.direction || '').toUpperCase();
  const __now = new Date();
  const __et = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short' }).formatToParts(__now).reduce((a,p)=>(a[p.type]=p.value,a),{});
  const __hour = Number(__et.hour);
  const __minute = Number(__et.minute);
  const is_after_hours = ['Sat','Sun'].includes(__et.weekday) || (__hour < 9 || (__hour === 9 && __minute < 30) || __hour >= 16);
  if (execution === 'STAND ASIDE' && is_after_hours) {
    const output = { ...__d };
    output.route = 'SUPPRESSED_DIAGNOSTIC_ONLY';
    output._sm_route = 'SKIP';
    output._sm_action = 'SUPPRESSED_DIAGNOSTIC_ONLY';
    output.ssm_reason = 'Session refresh suppressed by Cycle 007 after-hours neutral filter';
    output._sm_reason = output.ssm_reason;
    output.blocked_stage = 'SESSION_OR_NEUTRAL_FILTER';
    output._vc_stand_aside_neutral = true;
    output._vc_pass = false;
    output._vc_verdict = 'NEUTRAL_SUPPRESSED';
    output.vc_verdict = 'NEUTRAL_SUPPRESSED';
    output.feedback = 'NEUTRAL_SUPPRESSED: After-hours / neutral refresh suppressed by Cycle 007 session filter. Audit only.';
    output.parser_version = 'QTP_CYCLE_007_17_NODE_HARDENED_20260511';
    output.qtp_cycle_version = 'QTP_CYCLE_007_17_NODE_HARDENED_20260511';
    return [{ json: output }];
  }
}

// ============================================================
// SIGNAL STATE MACHINE v5.20 — Cancel-before-close fix for 403 — Per-Ticker Kill Switch — P3 fixes: cooldown, log caps, off-by-one, pruning, sync — Fix #11 log caps, Fix #14 off-by-one — activePositions pruning.1 — activePositions pruning — Portfolio Sync
// ============================================================
// Changes from v5.5:
//   v5.6: SCORE-GATED HEARTBEAT ROUTING
//     - Heartbeat fires on every bar (pipeline stays fed)
//     - Only promotes to FULL route when raw_score > HEARTBEAT_SCORE_THRESHOLD
//     - Below threshold → internal heartbeat only (SKIP)
//     - Adds _heartbeat_promoted flag for downstream tagging
//   Previous changes (v5-v5.5):
//   1. PORTFOLIO HEAT LIMIT — Max 4 concurrent positions, max 2 same-direction
//      state.activePositions = {} keyed by ticker
//      HARD contradiction when MAX_CONCURRENT reached
//      SOFT contradiction when MAX_SAME_DIRECTION reached
//   2. DAILY P&L HALT — Parse daily_dd_pct, daily_dd_halt, weekly_dd_pct
//      HARD contradiction when daily_dd_halt === "true"
//      SYSTEM-WIDE DD HALT when 3+ tickers report halt
//      Resets on date change
//   3. CORRELATION FILTER — Correlated group awareness
//      MEGA_TECH / MEME_GROWTH / DEFENSIVE / INDEX groups
//      SOFT contradiction for same-direction correlated positions
//   4. VIX-REGIME-AWARE POSITION TRACKING
//      Parse vix_size_mult, eff_position_size, vix_stop_mult
//      Store in activePositions; compute portfolio_heat_pct
//      -1 factor for VIX-reduced sizing
//      SOFT contradiction when heat > 30%
//   5. NEW OUTPUT FIELDS: _sm_active_positions, _sm_same_direction_count,
//      _sm_portfolio_heat_pct, _sm_daily_dd_halt_tickers,
//      _sm_correlation_warning, _sm_daily_pnl_summary
//   6. All v4 features preserved
// ============================================================

// ── Configurable constants ───────────────────────────────────
const MAX_CONCURRENT     = 20;
const MAX_SAME_DIRECTION = 10;
const MAX_HEAT_PCT       = 80;
// v5.6: Score threshold for promoting heartbeats to FULL pipeline
// Heartbeats with raw_score > this value get routed to VC Gate / Alpaca / Telegram
// All others stay internal (SKIP). Scale: 0-100 from Pine Script composite score.
const HEARTBEAT_SCORE_THRESHOLD = 40;

// ── C-3 FIX: Webhook Authentication (CRITICAL) ──────────────
// Validates every inbound request BEFORE any state reads/writes.
// Accepts secret via:
//   1. JSON body field: _secret (TradingView passphrase approach)
//   2. HTTP header: x-webhook-secret (server-to-server calls)
// Fail-closed: missing/invalid secret → AUTH_FAILED, route SKIP.
// Secret stored in staticData._credentials.webhook_secret
// ─────────────────────────────────────────────────────────────
{
  const _authState = $getWorkflowStaticData('global');
  const _authSecret = (_authState._credentials || {}).webhook_secret || '';
  const _authRaw = $input.first().json;
  const _authHeaders = _authRaw.headers || {};
  const _authBody = (_authRaw.body && typeof _authRaw.body === 'object') ? _authRaw.body : _authRaw;

  // Extract secret from payload. By the time data reaches the SSM, upstream
  // nodes (Gap News Detector, Indicator Enrichment) have flattened body fields
  // to top-level and stripped HTTP headers. Check all possible locations:
  //   1. Top-level _secret (flattened by upstream nodes — normal flow)
  //   2. body._secret (direct webhook call without upstream processing)
  //   3. headers.x-webhook-secret (direct webhook call — unlikely but safe)
  // QTP_SSM_AUTH_HANDOFF_20260508
  // Trust upstream Webhook Auth Gate AUTH_OK for known scanner/control alert types only.
  // This preserves fail-closed behavior for unknown external webhooks while preventing
  // sanitized BROAD_SCANNER payloads from being re-failed inside SSM.
  const _handoffAlertType = String(_authRaw.alert_type || _authRaw._alert_type || _authBody.alert_type || '').toUpperCase();
  const _handoffAllowed = ['HEARTBEAT','BROAD_SCANNER','REALTIME_AGENT_HYBRID','POLYGON_NEWS','STRONG_SETUP'].includes(_handoffAlertType);
  const _postAuthIngressOk = String(_authRaw._ingress_source || '').toUpperCase() === 'TRADINGVIEW_MARKET_ALERT'
    && String(_authRaw._tv_payload_shape || '').toLowerCase().includes('ticker')
    && _handoffAllowed;
  const _upstreamAuthOk = (String(_authRaw._auth_status || '').toUpperCase() === 'AUTH_OK' && _handoffAllowed) || _postAuthIngressOk;

  const _incomingSecret = String(
    _authRaw._secret
    || (_authBody._secret)
    || (_authHeaders['x-webhook-secret'])
    || (_upstreamAuthOk ? _authSecret : '')
    || ''
  );
  if (_upstreamAuthOk) {
    _authRaw._auth_method = 'upstream_auth_gate';
    _authRaw._auth_handoff = 'QTP_SSM_AUTH_HANDOFF_20260508';
  }

  // Fail-closed: if no secret configured, block everything (misconfiguration guard)
  if (!_authSecret) {
    return [{ json: {
      _sm_action: 'AUTH_FAILED',
      _sm_route: 'SKIP',
      _auth_reason: 'webhook_secret not configured in staticData._credentials — fail-closed',
      _auth_ts: new Date().toISOString()
    }}];
  }

  // Constant-time comparison (prevent timing attacks)
  let _authMatch = _incomingSecret.length === _authSecret.length;
  for (let i = 0; i < _authSecret.length; i++) {
    if (_incomingSecret.charCodeAt(i) !== _authSecret.charCodeAt(i)) {
      _authMatch = false;
      // Don't break — scan entire string to prevent timing leaks
    }
  }
  if (!_authMatch) {
    // ── PERMANENT FIX: TradingView fingerprint auth (replaces expired bypass) ──
    // TradingView cannot send custom headers or _secret in webhook body.
    // Gap News Detector now propagates _header_webhook_secret and _source_ua.
    // Auth strategy (ordered by strength):
    //   1. _header_webhook_secret (propagated from GND — server-to-server calls)
    //   2. TradingView fingerprint: UA "Go-http-client" + Pine payload shape
    // If neither matches → AUTH_FAILED (fail-closed).

    // Check header secret propagated by Gap News Detector
    const _headerSecret = String(_authRaw._header_webhook_secret || '');
    let _headerMatch = _headerSecret.length === _authSecret.length && _headerSecret.length > 0;
    for (let i = 0; i < _authSecret.length; i++) {
      if (_headerSecret.charCodeAt(i) !== _authSecret.charCodeAt(i)) {
        _headerMatch = false;
      }
    }

    if (_headerMatch) {
      // Header secret matched — trusted server-to-server call
      _authRaw._auth_method = 'header_secret';
      console.log('[AUTH] Passed via x-webhook-secret header (propagated by GND)');
    } else {
      // Fingerprint TradingView: Pine Script alerts carry a distinctive payload shape
      const _bp = _authBody || {};
      const _tvFields = ['bias_score','vix','regime','adx','macd_hist','volume_ratio'];
      const _tvFieldCount = _tvFields.filter(k => _bp[k] !== undefined || _authRaw[k] !== undefined).length;
      const _srcIsTV = String(_bp.source || _authRaw.source || '').toLowerCase().includes('tradingview');
      const _sourceUA = String(_authRaw._source_ua || '');
      const _isGoClient = _sourceUA.startsWith('Go-http-client');
      const _isTradingView = (_tvFieldCount >= 4 && _isGoClient) || _srcIsTV;

      if (_isTradingView) {
        _authRaw._auth_method = 'tv_fingerprint';
        _authRaw._auth_tv_fields = _tvFieldCount;
        console.log('[AUTH] TradingView fingerprint matched (UA=' + _sourceUA + ', fields=' + _tvFieldCount + ')');
      } else {
        return [{ json: {
          _sm_action: 'AUTH_FAILED',
          _sm_route: 'SKIP',
          _auth_reason: 'Invalid or missing webhook secret',
          _auth_ts: new Date().toISOString(),
          _auth_ip: (_authHeaders['x-forwarded-for'] || _authHeaders['x-real-ip'] || 'unknown').toString().split(',')[0].trim()
        }}];
      }
    }
  }
}



// ── Correlation groups ────────────────────────────────────────
const CORRELATION_GROUPS = {
  'MEGA_TECH':    ['NVDA', 'AMD', 'MSFT'],
  'MEME_GROWTH':  ['TSLA', 'CRWV', 'NBIS'],
  'DEFENSIVE':    ['GILD'],
  'INDEX':        ['SPY', 'QQQ']
};

// ── Helper: find correlation group for a ticker ───────────────
function getCorrelationGroup(tkr) {
  for (const groupName of Object.keys(CORRELATION_GROUPS)) {
    if (CORRELATION_GROUPS[groupName].includes(tkr)) return groupName;
  }
  return null;
}

// ── Input & state ─────────────────────────────────────────────
const raw   = $input.first().json;
// v5.5 fix: Handle both direct and body-nested webhook data
const d     = raw.body && raw.body.ticker ? raw.body : raw;
const state = $getWorkflowStaticData('global');

// v5.18: test_mode — any payload with test:true is a synthetic test signal.
// Propagated to all downstream nodes so they can hard-block without side effects.
const _isTestSignal = (d.test === true || d.test === 'true' || d.test_mode === true);


// ── Persistence bootstrap ─────────────────────────────────────
if (!state.signalStates)    state.signalStates    = {};
// v5.5: Clear stale _UNK entries from old parsing bug
if (state.signalStates && state.signalStates['_UNK']) {
  delete state.signalStates['_UNK'];
}
if (!state.auditLog)        state.auditLog        = [];
if (!state.contradictions)  state.contradictions  = [];
if (!state.activePositions) state.activePositions = {};
if (!state.tickerKillList)   state.tickerKillList   = {}; // v5.9: per-ticker kill registry
if (!state.dailyPnL)        state.dailyPnL        = { date: '', totalPnL: 0.0, trades: [], ddHaltTickers: [] };
// v5.17: Daily P&L circuit breaker state
if (!state.circuitBreaker) state.circuitBreaker = { tripped: false, trippedDate: '', pnlPct: 0, lastCheckMs: 0 };

// SSM_STALE_METADATA_CLEANUP_PATCH_20260505:
// Force one fresh broker sync after deployment so stale phantom metadata is
// replaced by Alpaca ground truth on the next execution.
if (!state._ssmStaleMetadataCleanup20260505) {
  state._lastPortfolioSync = 0;
  state._ssmStaleMetadataCleanup20260505 = new Date().toISOString();
}
// v5.1: Prune stale signalStates entries (>7 days old) to prevent unbounded growth
const _pruneNow = Date.now();
const PRUNE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const pruneKeys = Object.keys(state.signalStates).filter(function(key) {
  return _pruneNow - (state.signalStates[key].timestamp || 0) > PRUNE_AGE_MS;
});
for (const key of pruneKeys) {
  delete state.signalStates[key];
}





// v5.8 — P3 fixes: cooldown, log caps, off-by-one, pruning, sync — Fix #11 log caps, Fix #14 off-by-one: Prune stale activePositions (>48h without Alpaca sync refresh)
const _POS_PRUNE_AGE_MS = 48 * 60 * 60 * 1000;
const _stalePosKeys = Object.keys(state.activePositions).filter(function(key) {
  const pos = state.activePositions[key];
  const lastSeen = pos.syncTime || pos.entryTime || 0;
  return !pos.syncedFromAlpaca && (_pruneNow - lastSeen > _POS_PRUNE_AGE_MS);
});
if (_stalePosKeys.length > 0) {
  console.log('[PRUNE] Removing ' + _stalePosKeys.length + ' stale activePositions: ' + _stalePosKeys.join(','));
  for (const key of _stalePosKeys) {
    delete state.activePositions[key];
  }
}



// ── v5.7: PORTFOLIO SYNC — Reconcile activePositions with Alpaca ──
// Runs every 30s. Replaces internal position map with Alpaca ground truth.
const _SYNC_KEY    = (($getWorkflowStaticData('global')._credentials||{}).alpaca_api_key || '');
const _SYNC_SECRET = (($getWorkflowStaticData('global')._credentials||{}).alpaca_secret_key || '');

// Fix #17 Batch 1 (2026-04-19): fail-closed Alpaca creds
if (!_SYNC_KEY || !_SYNC_SECRET) throw new Error('Alpaca creds missing from staticData._credentials (fail-closed)');
// SM-C2: env-driven Alpaca base URL (default paper, flip via staticData)
const _creds_AB = ($getWorkflowStaticData('global')._credentials) || {};
const _SYNC_BASE = _creds_AB.alpaca_base
  || (_creds_AB.alpaca_env === 'live'
    ? 'https://paper-api.alpaca.markets'
    : 'https://paper-api.alpaca.markets');
const _SYNC_HEADERS = {
  'APCA-API-KEY-ID':     _SYNC_KEY,
  'APCA-API-SECRET-KEY': _SYNC_SECRET
};

const _syncNow = Date.now();
const _lastSync = state._lastPortfolioSync || 0;
const _SYNC_INTERVAL_MS = 30000;

if (_syncNow - _lastSync > _SYNC_INTERVAL_MS) {
  try {
    const [_alpacaPositions, _alpacaAccount] = await Promise.all([
      this.helpers.httpRequest({
        method: 'GET',
        url: _SYNC_BASE + '/v2/positions',
        headers: _SYNC_HEADERS,
        json: true,
      timeout: 6000
    }),
      this.helpers.httpRequest({
        method: 'GET',
        url: _SYNC_BASE + '/v2/account',
        headers: _SYNC_HEADERS,
        json: true,
      timeout: 6000
    })
    ]);

    const _prevCount = Object.keys(state.activePositions).length;
    const _prevTickers = new Set(Object.keys(state.activePositions));
    const _newPositions = {};

    for (const p of _alpacaPositions) {
      const sym = p.symbol;
      const side = p.side;
      const qty = Math.abs(parseFloat(p.qty) || 0);
      const entry = parseFloat(p.avg_entry_price) || 0;
      const current = parseFloat(p.current_price) || 0;
      const upl = parseFloat(p.unrealized_pl) || 0;
      const mv = Math.abs(parseFloat(p.market_value) || 0);

      _newPositions[sym] = {
        ticker: sym,
        direction: side === 'long' ? 'BUY' : 'SELL',
        entryPrice: entry,
        currentPrice: current,
        qty: qty,
        unrealizedPnL: upl,
        marketValue: mv,
        vixSizeMult: state.activePositions[sym]?.vixSizeMult || 1.0,
        effPositionSize: state.activePositions[sym]?.effPositionSize || mv,
        entryTime: state.activePositions[sym]?.entryTime || _syncNow,
        syncTime: _syncNow,
        syncedFromAlpaca: true
      };
    }

    const _newTickers = new Set(Object.keys(_newPositions));
    const _removed = [..._prevTickers].filter(t => !_newTickers.has(t));
    const _added = [..._newTickers].filter(t => !_prevTickers.has(t));

    if (_removed.length > 0 || _added.length > 0) {
      console.log('[SYNC v5.7] Drift detected:' +
        (_removed.length > 0 ? ' removed=' + _removed.join(',') : '') +
        (_added.length > 0 ? ' added=' + _added.join(',') : '') +
        ' | ' + _prevCount + ' -> ' + _alpacaPositions.length + ' positions');
    }

    state.activePositions = _newPositions;
    state._lastPortfolioSync = _syncNow;

    state._accountSnapshot = {
      equity: parseFloat(_alpacaAccount.equity) || 100000,
      cash: parseFloat(_alpacaAccount.cash) || 0,
      buyingPower: parseFloat(_alpacaAccount.buying_power) || 0,
      marginUsed: parseFloat(_alpacaAccount.initial_margin) || 0,
      marginPct: (parseFloat(_alpacaAccount.initial_margin) || 0) / (parseFloat(_alpacaAccount.equity) || 100000),
      dailyPnLPct: ((parseFloat(_alpacaAccount.equity) || 100000) - (parseFloat(_alpacaAccount.last_equity) || 100000)) / (parseFloat(_alpacaAccount.last_equity) || 100000) * 100,
      positionCount: _alpacaPositions.length,
      totalExposure: Object.values(_newPositions).reduce((s, p) => s + p.marketValue, 0),
      syncTime: _syncNow
    };

    console.log('[SYNC v5.7] OK | ' + _alpacaPositions.length + ' pos | $' +
      state._accountSnapshot.equity.toFixed(0) + ' eq | ' +
      state._accountSnapshot.totalExposure.toFixed(0) + '/' +
      (state._accountSnapshot.equity * 0.8).toFixed(0) + ' exp');

  } catch (_syncErr) {
    console.log('[SYNC v5.7] ERROR: ' + _syncErr.message + ' — using cached state');
  }
}

// ── Helpers ───────────────────────────────────────────────────
const now       = Date.now();
// DAILY RESET + DEDUP FIX - v3.1
const today     = new Date().toLocaleDateString('en-US', {timeZone: 'America/New_York'});

// === DAILY RESET (runs once per new trading day) ===
if (state._lastResetDate !== today) {
  console.log('DAILY RESET — Clearing all signal states for new trading day: ' + today);
  state.signalStates = {};
  state._killSwitchActive = false;
  state._dailyLossTriggered = false;
  state.tickerKillList = {}; // v5.9: clear per-ticker kills on new trading day
  state._lastResetDate = today;
  console.log('Signal states cleared. Kill switch reset. Ready for trading.');
}

const ticker    = (d.ticker    || '').toString().toUpperCase();
const timeframe = (d.timeframe || '').toString().toUpperCase();

// ── ADMIN: Clear kill list / cooldown (send _clear_kill_list in payload) ──
if (d._clear_kill_list) {
  const _clearTickers = d._clear_kill_list.toString().split(',').map(t => t.trim().toUpperCase()).filter(Boolean);
  const _cleared = [];
  for (const _ct of _clearTickers) {
    if (state.tickerKillList && state.tickerKillList[_ct]) {
      delete state.tickerKillList[_ct];
      _cleared.push(_ct + ' (kill list)');
    }
    if (state._reEntryCooldown && state._reEntryCooldown[_ct]) {
      delete state._reEntryCooldown[_ct];
      _cleared.push(_ct + ' (cooldown)');
    }
    if (state._pendingGTCCloses && state._pendingGTCCloses[_ct]) {
      delete state._pendingGTCCloses[_ct];
      _cleared.push(_ct + ' (pending GTC)');
    }
  }
  console.log('[ADMIN v5.15] Cleared: ' + _cleared.join(', '));
  return [{
    json: {
      _sm_action:   'ADMIN_CLEAR',
      _sm_route:    'SKIP',
      _sm_version:  'v5.15',
      _cleared:     _cleared,
      _sm_reason:   'Kill list cleared for: ' + _clearTickers.join(', ')
    }
  }];
}


// ═══════════════════════════════════════════════════════════════════
// v5.17: DAILY P&L CIRCUIT BREAKER
// Pulls real P&L from Alpaca every 60s. If daily loss > 3% of equity,
// ALL new entries are blocked for the rest of the day.
// Auto-resets at day change (above). Only blocks entries — exits/stops
// and STAND ASIDE signals pass through.
// ═══════════════════════════════════════════════════════════════════
const CB_MAX_LOSS_PCT = 3.0;   // Trip at 3% daily loss
const CB_CHECK_INTERVAL = 60000; // Check Alpaca every 60s (not every webhook)

// Skip circuit breaker for non-entry signals
const _cbIsEntry = ['BUY','SELL','BULLISH','BEARISH','LONG','SHORT','SELL SHORT']
  .includes((d.execution || '').toUpperCase());

if (_cbIsEntry) {
  // If already tripped today — instant block (no API call needed)
  if (state.circuitBreaker.tripped && state.circuitBreaker.trippedDate === today) {
    console.log('[CB v5.17] BLOCKED — circuit breaker active (daily loss ' + state.circuitBreaker.pnlPct.toFixed(2) + '%)');
    return [{
      json: {
        ...d,
        _sm_action:  'CIRCUIT_BREAKER',
        _sm_reason:  'Daily P&L circuit breaker: ' + state.circuitBreaker.pnlPct.toFixed(2) + '% loss exceeds ' + CB_MAX_LOSS_PCT + '% threshold',
        _sm_route:   'SKIP',
        _sm_is_heartbeat: false,
        _sm_cb_pnl_pct: state.circuitBreaker.pnlPct,
        ticker, timeframe,
        signal: (d.execution || 'BLOCKED').toUpperCase()
      }
    }];
  }

  // Periodic Alpaca P&L check (throttled to every 60s)
  const _cbNow = Date.now();
  if (_cbNow - (state.circuitBreaker.lastCheckMs || 0) > CB_CHECK_INTERVAL) {
    state.circuitBreaker.lastCheckMs = _cbNow;
    try {
      const _cbAcct = await this.helpers.httpRequest({
        method: 'GET',
        url: _SYNC_BASE + '/v2/account',
        headers: _SYNC_HEADERS,
        json: true,
      timeout: 5000
    });
      const _cbEquity    = parseFloat(_cbAcct.equity || 0);
      const _cbLastEquity = parseFloat(_cbAcct.last_equity || _cbEquity);
      // daily_change = equity - last_equity (Alpaca's last_equity is previous close equity)
      const _cbDailyChange = _cbEquity - _cbLastEquity;
      const _cbDailyPct    = _cbLastEquity > 0 ? (_cbDailyChange / _cbLastEquity) * 100 : 0;

      console.log('[CB v5.17] Daily P&L check: equity=$' + _cbEquity.toFixed(0) +
        ' last=$' + _cbLastEquity.toFixed(0) + ' change=$' + _cbDailyChange.toFixed(0) +
        ' (' + _cbDailyPct.toFixed(2) + '%)');

      // Trip if loss exceeds threshold
      if (_cbDailyPct < -CB_MAX_LOSS_PCT) {
        state.circuitBreaker.tripped     = true;
        state.circuitBreaker.trippedDate = today;
        state.circuitBreaker.pnlPct      = _cbDailyPct;
        state.circuitBreaker.equity      = _cbEquity;
        state.circuitBreaker.trippedAt   = new Date().toISOString();

        console.log('[CB v5.17] *** CIRCUIT BREAKER TRIPPED *** daily loss ' + _cbDailyPct.toFixed(2) + '%');

        // Telegram alert — personal
        const _cbMsg = '⛔ <b>CIRCUIT BREAKER TRIPPED</b>\n' +
          'Daily loss: ' + _cbDailyPct.toFixed(2) + '% (threshold: -' + CB_MAX_LOSS_PCT + '%)\n' +
          'Equity: $' + _cbEquity.toFixed(0) + ' (prev close: $' + _cbLastEquity.toFixed(0) + ')\n' +
          'Change: $' + _cbDailyChange.toFixed(0) + '\n\n' +
          '<b>ALL new entries BLOCKED until tomorrow 9:30 AM ET.</b>\n' +
          'Existing stops and exits continue normally.\n' +
          '<i>Circuit Breaker v5.17</i>';
        try {
          await this.helpers.httpRequest({
            method: 'POST',
            url: 'https://api.telegram.org/bot' + _tgToken + '/sendMessage',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: '6648680513', text: _cbMsg, parse_mode: 'HTML' }),
            json: true
          });
        } catch (_) {}

        // Telegram alert — subscriber channel
        const _cbChMsg = '⛔ <b>TRADING PAUSED</b>\n' +
          'Daily drawdown limit reached (' + _cbDailyPct.toFixed(1) + '%).\n' +
          'No new positions until next trading day.\n' +
          '<i>Quantum Trading System — Risk Management</i>';
        try {
          await this.helpers.httpRequest({
            method: 'POST',
            url: 'https://api.telegram.org/bot' + _tgToken + '/sendMessage',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: '-1003889511940', text: _cbChMsg, parse_mode: 'HTML' }),
            json: true
          });
        } catch (_) {}

        // Block this signal
        return [{
          json: {
            ...d,
            _sm_action:  'CIRCUIT_BREAKER',
            _sm_reason:  'Daily P&L circuit breaker TRIPPED: ' + _cbDailyPct.toFixed(2) + '% loss',
            _sm_route:   'SKIP',
            _sm_is_heartbeat: false,
            _sm_cb_pnl_pct: _cbDailyPct,
            ticker, timeframe,
            signal: (d.execution || 'BLOCKED').toUpperCase()
          }
        }];
      }
    } catch (_cbErr) {
      console.warn('[CB v5.17] Alpaca account check failed (non-blocking): ' + _cbErr.message);
      // Don't block on API failure — let the trade through. Dead-man switch covers API outages.
    }
  }
}
// ═══ END CIRCUIT BREAKER ═══════════════════════════════════════════

// ── v5.9: PER-TICKER KILL LIST — check and prune ──────────────
// Prune expired entries (kills expire after 24h unless permanent)
const _tkNow = Date.now();
const _tkExpiry = 24 * 60 * 60 * 1000;
for (const _kt of Object.keys(state.tickerKillList)) {
  const _ke = state.tickerKillList[_kt];
  if (!_ke.permanent && _tkNow - (_ke.killedAt || 0) > _tkExpiry) {
    console.log('[TICKER-KILL] Expiring kill for ' + _kt + ' (24h elapsed)');
    delete state.tickerKillList[_kt];
  }
}

// Check if THIS ticker is killed — early return with SKIP
if (ticker && state.tickerKillList[ticker]) {
  const _tkEntry = state.tickerKillList[ticker];
  const _tkAge = Math.round((_tkNow - (_tkEntry.killedAt || 0)) / 60000);
  console.log('[TICKER-KILL] ' + ticker + ' is blacklisted (' + _tkAge + 'min ago): ' + _tkEntry.reason);
  return [{
    json: {
      ...d,
      _sm_action:        'TICKER_KILLED',
      _sm_route:         'SKIP',
      _sm_reason:        'Ticker blacklisted: ' + _tkEntry.reason,
      _sm_version:       'v5.9',
      _sm_is_heartbeat:  'false',
      ticker,
      timeframe
    }
  }];
}
// ENTRY_CONTRACT_PATCH_20260501: normalize scanner payload scores conservatively.
function _smNumOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).trim();
  if (!s || s.toUpperCase() === 'N/A') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
function _smFirstFinite(values) {
  for (const v of values) {
    if (v !== null && v !== undefined && Number.isFinite(Number(v))) return Number(v);
  }
  return 0;
}
const _incomingExecution = (d.execution || '').toString().toUpperCase();
const _incomingSignal    = (d.signal    || '').toString().toUpperCase();
const _scoreBull = _smNumOrNull(d.bull_score);
const _scoreBear = _smNumOrNull(d.bear_score);
const _biasScore = _smNumOrNull(d.bias_score);
let _inferredExecution = '';
if (!_incomingExecution && !_incomingSignal && (_scoreBull !== null || _scoreBear !== null)) {
  const b = _scoreBull ?? 0;
  const br = _scoreBear ?? 0;
  if (b >= 60 && b - br >= 15) _inferredExecution = 'BUY';
  else if (br >= 60 && br - b >= 15) _inferredExecution = 'SELL';
}
const execution = (_incomingExecution || _inferredExecution || 'STAND ASIDE').toString().toUpperCase();
const signal    = (_incomingSignal || (execution === 'BUY' ? 'BULLISH' : execution === 'SELL' ? 'BEARISH' : 'NEUTRAL')).toString().toUpperCase();
const alertType = (d.alert_type || 'SIGNAL_CHANGE').toString().toUpperCase();
const comment   = (d.comment   || '').toString().toLowerCase();

// ── New v5/v8 Pine Script fields ──────────────────────────────
const dailyDdPct    = parseFloat(d.daily_dd_pct)     || 0;
const dailyDdHalt   = (d.daily_dd_halt   || '').toString().toLowerCase() === 'true';
const weeklyDdPct   = parseFloat(d.weekly_dd_pct)    || 0;
const vixSizeMult   = parseFloat(d.vix_size_mult)    || 1.0;
const effPositionSz = parseFloat(d.eff_position_size) || 0;
const vixStopMult   = parseFloat(d.vix_stop_mult)    || 1.0;

// ── Heartbeat detection ───────────────────────────────────────
const isHeartbeat = comment.includes('heartbeat') || comment.includes('bar close update');

// ── v5.6: Raw score extraction for heartbeat gating ───────────
// Pine Script sends the composite score (0-100) in several possible fields
const rawScore = _smFirstFinite([_smNumOrNull(d.score), _smNumOrNull(d.ai_super_score), _smNumOrNull(d.raw_score), _smNumOrNull(d.composite_score), _biasScore, Math.max(_scoreBull ?? 0, _scoreBear ?? 0)]);

// ── Direction detection ───────────────────────────────────────
const longValues  = ['LONG', 'BUY', 'BULLISH'];
const shortValues = ['SHORT', 'SELL', 'BEARISH'];
const isLong  = longValues.includes(execution)  || longValues.includes(signal);
const isShort = shortValues.includes(execution) || shortValues.includes(signal);
const direction = isLong ? 'LONG' : isShort ? 'SHORT' : 'NEUTRAL';

const vix         = parseFloat(d.vix)          || 0;
const rsi         = parseFloat(d.rsi)          || 50;
const adx         = parseFloat(d.adx)          || 0;
const macdHist    = parseFloat(d.macd_hist)    || 0;
const relVol      = parseFloat(d.relative_volume || d.volume_ratio) || 1;
const stratNetPct = parseFloat(d.strat_net_pct)   || 0;
const confidence  = parseFloat(d.bayesian_score || d.bias_score || 5);

const spyStatus  = (d.spy_status  || '').toUpperCase();
const qqqStatus  = (d.qqq_status  || '').toUpperCase();
const crossAsset = (d.cross_asset_status || d.ca_regime || '').toUpperCase();
const optRegime  = (d.opt_regime  || '').toUpperCase();
const gexSign    = (d.opt_gex_sign || '').toUpperCase();
const dpSignal   = (d.dp_signal   || d.dark_pool_signal || '').toUpperCase();
const mtfBullOk  = !!(d.mtf_bull_confirmed);
const mtfBearOk  = !!(d.mtf_bear_confirmed);
const priceVsSma50 = (d.price_vs_sma50 || '').toUpperCase();

// ── Daily P&L state — reset on date change ────────────────────
if (state.dailyPnL.date !== today) {
  // v5.17: Reset circuit breaker on new trading day
  if (state.circuitBreaker.tripped && state.circuitBreaker.trippedDate !== today) {
    console.log('[CB v5.17] Circuit breaker RESET — new trading day ' + today);
    state.circuitBreaker = { tripped: false, trippedDate: '', pnlPct: 0, lastCheckMs: 0 };
  }
  state.dailyPnL = { date: today, totalPnL: 0.0, trades: [], ddHaltTickers: [] };
}

// ── Update DD halt ticker tracking (before dedup check) ───────
if (dailyDdHalt && ticker) {
  if (!state.dailyPnL.ddHaltTickers.includes(ticker)) {
    state.dailyPnL.ddHaltTickers.push(ticker);
  }
} else if (!dailyDdHalt && ticker) {
  state.dailyPnL.ddHaltTickers = state.dailyPnL.ddHaltTickers.filter(function(t) { return t !== ticker; });
}
const ddHaltTickersList = state.dailyPnL.ddHaltTickers.slice();
const systemWideDDHalt  = ddHaltTickersList.length >= 3;


// ============================================================
// v5.5: EARLY REGIME GATE — runs BEFORE deduplication
// Blocks obviously toxic signals before any state processing
// This is the "Regime-First Architecture" — top of the pipeline
// ============================================================
const _earlyVix = parseFloat(d.vix) || 0;
const _earlyAdx = parseFloat(d.adx) || 0;
const _earlyExec = (d.execution || 'STAND ASIDE').toString().toUpperCase();
const _earlyIsLong = ['BUY', 'LONG', 'LONG BUY'].includes(_earlyExec);
const _earlyIsShort = ['SELL', 'SHORT', 'SHORT SELL'].includes(_earlyExec);
const _earlyIsEntry = _earlyIsLong || _earlyIsShort;
const _earlySpyStatus = (d.spy_status || '').toUpperCase();
const _earlyQqqStatus = (d.qqq_status || '').toUpperCase();
const _earlySpyBreaking = _earlySpyStatus.includes('BREAKING') || _earlyQqqStatus.includes('BREAKING');
const _earlyDailyTrend = (d.daily_trend || '').toUpperCase();

// HARD REGIME BLOCKS — these signals should never enter the pipeline
const _regimeBlocks = [];

// VIX > 35: extreme panic — no new entries period
if (_earlyIsEntry && _earlyVix > 35) {
  _regimeBlocks.push('EXTREME VIX ' + _earlyVix.toFixed(1) + ' > 35 — market panic, no entries');
}

// ADX < 10: dead market — no directional edge exists
if (_earlyIsEntry && _earlyAdx < 10 && _earlyAdx > 0) {
  _regimeBlocks.push('DEAD ADX ' + _earlyAdx.toFixed(1) + ' < 10 — no directional edge');
}

// LONG in breaking market with VIX > 28
if (_earlyIsLong && _earlySpyBreaking && _earlyVix > 28) {
  _regimeBlocks.push('LONG blocked: SPY/QQQ BREAKING + VIX ' + _earlyVix.toFixed(1) + ' — capitulation regime');
}

// Counter-trend in strong trend (ADX > 40)
if (_earlyAdx > 40) {
  if (_earlyIsLong && _earlyDailyTrend === 'BEAR') {
    _regimeBlocks.push('LONG against BEAR at ADX ' + _earlyAdx.toFixed(0) + ' — fighting a freight train');
  }
  if (_earlyIsShort && _earlyDailyTrend === 'BULL') {
    _regimeBlocks.push('SHORT against BULL at ADX ' + _earlyAdx.toFixed(0) + ' — fighting a freight train');
  }
}

if (_regimeBlocks.length > 0) {
  state.auditLog.push({
    ts: new Date(now).toISOString(),
    ticker: (d.ticker || '?'),
    timeframe: (d.timeframe || '?'),
    execution: _earlyExec,
    action: 'REGIME_BLOCKED',
    reason: _regimeBlocks.join('; ')
  });
  if (state.auditLog.length > 1000) state.auditLog.splice(0, state.auditLog.length - 750);
  
  return [{
    json: {
      _sm_action: 'REGIME_BLOCKED',
      _sm_reason: 'Early regime gate: ' + _regimeBlocks.join('; '),
      _sm_route: 'SKIP',
      _sm_is_heartbeat: false,
      _sm_version: 'v5.6',
      ticker: d.ticker || '?',
      timeframe: d.timeframe || '?',
      signal: _earlyIsLong ? 'LONG' : _earlyIsShort ? 'SHORT' : 'NEUTRAL'
    }
  }];
}

// ── v5.13: RE-ENTRY COOLDOWN CHECK (after blacklist, before kill trigger) ──
// After any successful kill, blocks re-entry signals for N hours.
if (!state._reEntryCooldown) state._reEntryCooldown = {};
const _reCoolHours = parseFloat(
  (state._config && state._config.reEntryCooldownHours) || 24
);
const _reCoolMs       = _reCoolHours * 60 * 60 * 1000;
const _reCoolLastKill = state._reEntryCooldown[ticker] || 0;
const _reCoolActive   = (_tkNow - _reCoolLastKill) < _reCoolMs;

if (_reCoolActive) {
  const _reMinsLeft = Math.round((_reCoolMs - (_tkNow - _reCoolLastKill)) / 60000);
  const _reHrsLeft  = (_reMinsLeft / 60).toFixed(1);
  console.log('[RE-ENTRY v5.13] ' + ticker + ' cooldown active — ' + _reHrsLeft + 'h remaining');
  return [{
    json: {
      ...d,
      _sm_action:       'COOLDOWN_BLOCK',
      _sm_route:        'SKIP',
      _sm_reason:       'Re-entry blocked: ' + ticker + ' in ' + _reHrsLeft + 'h post-kill cooldown',
      _sm_version:      'v5.15',
      _sm_is_heartbeat: 'false',
      ticker, timeframe
    }
  }];
}
// ── END RE-ENTRY COOLDOWN CHECK ────────────────────────────────

// ── v5.21: POST-STAND-ASIDE COOLDOWN CHECK ──────────────────────
// Blocks SAME-DIRECTION re-entry on a ticker for 30 minutes after
// a STAND ASIDE signal. Prevents churn where the strategy exits to
// flat and then immediately re-enters the same side (e.g. TSLA
// 2026-04-20: SELL → STAND ASIDE @14:50Z → SELL @17:07Z via VC race).
// Opposite-direction reversals bypass (different trade). STAND ASIDE
// signals themselves bypass (neutral is safe).
if (!state._postStandAsideCooldown) state._postStandAsideCooldown = {};
const _psaCoolMs = 30 * 60 * 1000;
const _psaNowMs = _tkNow;
const _psaRec = ticker ? state._postStandAsideCooldown[ticker] : null;
{
  // Classify incoming direction (LONG / SHORT / NEUTRAL)
  const _psaUpExec = (d.execution || '').toString().toUpperCase();
  const _psaUpSig  = (d.signal    || '').toString().toUpperCase();
  let _psaInDir = 'NEUTRAL';
  if (['BUY','BULLISH','LONG'].includes(_psaUpExec) || ['BUY','BULLISH'].includes(_psaUpSig)) _psaInDir = 'LONG';
  else if (['SELL','BEARISH','SHORT'].includes(_psaUpExec) || ['SELL','BEARISH'].includes(_psaUpSig)) _psaInDir = 'SHORT';

  if (_psaRec && _psaInDir !== 'NEUTRAL' && _psaUpExec !== 'STAND ASIDE') {
    const _psaAge = _psaNowMs - (_psaRec.ts || 0);
    if (_psaAge < _psaCoolMs) {
      if (_psaRec.prev_direction === _psaInDir) {
        const _psaMinsLeft = Math.ceil((_psaCoolMs - _psaAge) / 60000);
        console.log('[POST-STAND-ASIDE v5.21] ' + ticker + ' same-dir ' + _psaInDir +
          ' blocked — ' + _psaMinsLeft + 'min remaining (stamped ' +
          Math.round(_psaAge/1000) + 's ago)');
        state.auditLog.push({
          ts: new Date(_psaNowMs).toISOString(), ticker, timeframe,
          execution: _psaUpExec, signal: _psaUpSig, action: 'POST_STAND_ASIDE_BLOCK',
          reason: 'Same-dir re-entry within ' + _psaMinsLeft + 'min of STAND ASIDE'
        });
        if (state.auditLog.length > 1000) state.auditLog.splice(0, state.auditLog.length - 750);
        return [{
          json: {
            ...d,
            _sm_action:              'POST_STAND_ASIDE_BLOCK',
            _sm_route:               'SKIP',
            _sm_reason:              'Post-STAND-ASIDE cooldown: ' + ticker + ' blocked same-dir ' + _psaInDir + ' re-entry (' + _psaMinsLeft + 'min remaining of 30min window)',
            _sm_version:             'v5.21',
            _sm_is_heartbeat:        false,
            _sm_psa_cooldown_mins_left: _psaMinsLeft,
            _sm_psa_prev_direction:  _psaRec.prev_direction,
            ticker, timeframe
          }
        }];
      } else {
        // Opposite-direction reversal allowed. Clear stamp so the new trade runs clean.
        console.log('[POST-STAND-ASIDE v5.21] ' + ticker + ' reversal ' + _psaRec.prev_direction +
          '→' + _psaInDir + ' allowed — clearing cooldown stamp');
        delete state._postStandAsideCooldown[ticker];
      }
    } else {
      // Window expired — clean up
      delete state._postStandAsideCooldown[ticker];
    }
  }
}
// ── END POST-STAND-ASIDE COOLDOWN CHECK ────────────────────────



// ── v5.10: PER-TICKER KILL TRIGGER (runs before dedup) ──────
// Requirements: smarter sanitization + Alpaca confirmation + weekly kill stats
// Triggers: _force_kill_ticker=true | gap_pct > 8% | position loss > 8%
{
  const _tkPos   = state.activePositions[ticker] || null;
  const _tkNow2  = Date.now();
  const _tkReasons = [];

  // ── WEEKLY KILL STATS — init + auto-reset every Monday 00:00 ET ──
  if (!state.weeklyKillStats) state.weeklyKillStats = {};
  const _wksDate = new Date(_tkNow2);
  const _wksDayET = parseInt(_wksDate.toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'long' }).split(',')[0] === 'Sunday' ? '0' : '1'); // simple check
  const _wksETDate = _wksDate.toLocaleDateString('en-US', { timeZone: 'America/New_York' });
  // Compute Monday of current week (ET)
  const _wksETDateObj = new Date(_wksDate.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const _wksDow = _wksETDateObj.getDay(); // 0=Sun, 1=Mon ...
  const _wksDaysToMon = _wksDow === 0 ? -6 : 1 - _wksDow; // days to rewind to Monday
  const _wksMondayObj = new Date(_wksETDateObj);
  _wksMondayObj.setDate(_wksMondayObj.getDate() + _wksDaysToMon);
  const _wksMonday = _wksMondayObj.toLocaleDateString('en-US');
  // Reset stats if new week
  if (!state.weeklyKillStats.weekStarting || state.weeklyKillStats.weekStarting !== _wksMonday) {
    console.log('[KILL-STATS] New week — resetting kill stats. Previous: ' + JSON.stringify(state.weeklyKillStats));
    state.weeklyKillStats = { weekStarting: _wksMonday, totalKills: 0, killsByTicker: {}, killsByReason: {} };
  }

  // ── v5.11: Configurable sentiment kill threshold (default -0.75) ─
  const _sentimentKillThreshold = parseFloat(
    (state._config && state._config.sentimentKillThreshold) || -0.75
  );
  // Dedup: only fire SENTIMENT kill once per ticker per 6h
  if (!state._sentimentKillDedup) state._sentimentKillDedup = {};
  const _sentKillKey = ticker + '_sentiment';
  const _sentLastFired = state._sentimentKillDedup[_sentKillKey] || 0;
  const _sentCooldownMs = 6 * 60 * 60 * 1000; // 6 hours

    // ── TRIGGER DETECTION with typed reason objects ──────────────
  let _tkTriggerType = '';
  let _tkTriggerData = {};

  if ((d._force_kill_ticker || '').toString().toLowerCase() === 'true') {
    _tkTriggerType = 'MANUAL';
    _tkTriggerData = { field: '_force_kill_ticker', value: 'true' };
    _tkReasons.push('Manual kill override');
  }

  const _tkGapAbs = Math.abs(parseFloat(d.gap_pct) || 0);
  if (_tkGapAbs > 8.0) {
    if (!_tkTriggerType) { _tkTriggerType = 'GAP'; _tkTriggerData = { gap_pct: _tkGapAbs }; }
    _tkReasons.push('Gap risk ' + _tkGapAbs.toFixed(1) + '%');
  }

  let _tkLossPct3 = 0;
  if (_tkPos) {
    const _tkEntryP = parseFloat(_tkPos.entryPrice || _tkPos.entry || 0);
    const _tkCurrP  = parseFloat(_tkPos.currentPrice || 0);
    if (_tkEntryP > 0 && _tkCurrP > 0) {
      _tkLossPct3 = _tkPos.direction === 'BUY'
        ? (_tkCurrP - _tkEntryP) / _tkEntryP * 100
        : (_tkEntryP - _tkCurrP) / _tkEntryP * 100;
      if (_tkLossPct3 < -8.0) {
        if (!_tkTriggerType) { _tkTriggerType = 'LOSS'; _tkTriggerData = { loss_pct: _tkLossPct3 }; }
        _tkReasons.push('Position loss ' + _tkLossPct3.toFixed(1) + '%');
      }
    }
  }

  // ── v5.11: SENTIMENT trigger ──────────────────────────────────
  const _sentKill     = (d._sentiment_kill || '').toString().toLowerCase() === 'true';
  const _sentScore    = parseFloat(d.sentiment_score || 0);
  const _sentReason   = (d.sentiment_reason || 'Strong negative AI sentiment signal').toString().trim();
  const _sentCooldownOk = (_tkNow2 - _sentLastFired) > _sentCooldownMs;

  if (_sentKill && _sentScore <= _sentimentKillThreshold && _sentCooldownOk) {
    // v5.13: Keyword confidence filter — require >= 2 concrete catalysts
    const _sentKeywords = (state._config && Array.isArray(state._config.sentimentKeywords))
      ? state._config.sentimentKeywords
      : ['war','downgrade','fda','rejection','earnings miss','clinical trial','supply disruption',
         'geopolitical','analyst cut','recall','lawsuit','bankruptcy','default','fraud',
         'investigation','tariff','delisting','sec','restatement','guidance cut','revenue miss'];
    const _sentReasonLower = _sentReason.toLowerCase();
    const _sentMatches = _sentKeywords.filter(kw => _sentReasonLower.includes(kw));
    const _sentMinKeywords = parseInt((state._config && state._config.sentimentMinKeywords) || 2);

    if (_sentMatches.length >= _sentMinKeywords) {
      if (!_tkTriggerType) { _tkTriggerType = 'SENTIMENT'; }
      _tkTriggerData = { sentiment_score: _sentScore, sentiment_reason: _sentReason, matched_keywords: _sentMatches };
      _tkReasons.push('Sentiment kill: score=' + _sentScore.toFixed(2) +
        ' keywords=[' + _sentMatches.join(',') + '] (' + _sentReason.substring(0, 80) + ')');
    } else {
      console.log('[TICKER-KILL v5.13] SENTIMENT too weak for ' + ticker +
        ' — only ' + _sentMatches.length + '/' + _sentMinKeywords + ' keywords matched: [' +
        _sentMatches.join(',') + '] in "' + _sentReason.substring(0, 100) + '"');
    }
  } else if (_sentKill && !_sentCooldownOk) {
    console.log('[TICKER-KILL v5.11] SENTIMENT deduped for ' + ticker + ' — last fired ' +
      Math.round((_tkNow2 - _sentLastFired) / 60000) + 'min ago (cooldown 6h)');
  }

  if (_tkReasons.length > 0) {
    const _tkInternalReason = _tkReasons.join(' | ');
    console.log('[TICKER-KILL v5.10] FIRING for ' + ticker + ' (' + _tkTriggerType + '): ' + _tkInternalReason);

    // ── STEP 1: Add to kill list + update active positions ───────
    state.tickerKillList[ticker] = {
      reason: _tkInternalReason, triggerType: _tkTriggerType,
      triggerData: _tkTriggerData, killedAt: _tkNow2, permanent: false
    };
    delete state.activePositions[ticker];

    // ── v5.12: Market hours check — affects notification wording ──
    const _nowET = new Date(_tkNow2);
    const _etHourNow = parseInt(_nowET.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }));
    const _etMinNow  = parseInt(_nowET.toLocaleString('en-US', { timeZone: 'America/New_York', minute: 'numeric' }));
    const _etDowNow  = _nowET.toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
    const _mktOpenET = (_etHourNow > 9 || (_etHourNow === 9 && _etMinNow >= 30)) && _etHourNow < 16;
    const _isWeekend = _etDowNow === 'Sat' || _etDowNow === 'Sun';
    const _marketIsOpen = _mktOpenET && !_isWeekend;
    // Action wording — different for live market vs after-hours
    const _tkActionWord  = _marketIsOpen ? 'Position closed'          : 'Close order submitted';
    const _tkTimingNote  = _marketIsOpen ? ''                          : ' (executes at next market open)';
    const _tkImpactSuffix = _marketIsOpen
      ? 'No further exposure on ' + ticker + '.'
      : 'A GTC close order has been placed. The position will be closed when markets open. No new signals will fire for ' + ticker + '.';
    console.log('[TICKER-KILL v5.12] Market open: ' + _marketIsOpen + ' | Action: ' + _tkActionWord);

    // ── STEP 2: CANCEL EXISTING ORDERS THEN CLOSE POSITION ──────
  // v5.20: Market hours guard for TICKER-KILL — prevents orphaned after-hours orders.
  // If market is closed, skip Alpaca close and add to _pendingGTCCloses for GTC Re-Check.
  const _tkNowET = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const _tkETDate = new Date(_tkNowET);
  const _tkETMins = _tkETDate.getHours() * 60 + _tkETDate.getMinutes();
  const _tkMarketOpen = _tkETMins >= 570 && _tkETMins < 960 && _tkETDate.getDay() >= 1 && _tkETDate.getDay() <= 5;
  if (!_tkMarketOpen) {
    console.log('[SSM v5.20] TICKER-KILL for ' + ticker + ' deferred — market closed. Adding to _pendingGTCCloses.');
    if (!state._pendingGTCCloses) state._pendingGTCCloses = {};
    state._pendingGTCCloses[ticker] = { reason: _tkReasons.join('; '), timestamp: Date.now(), retryCount: 0 };
    // Still add to kill list so no new entries
    if (!state.tickerKillList) state.tickerKillList = {};
    state.tickerKillList[ticker] = { ts: Date.now(), reasons: _tkReasons };
    // Skip Alpaca close — GTC Re-Check will handle at next market open
  } else {
    // Must cancel open bracket/stop/limit orders before Alpaca allows position close.
    // 403 = existing orders blocking close. Fix: cancel first, then close.
    let _tkClosed = false;
    let _tkClosePrice = null;
    let _tkCloseQty = null;
    let _tkCloseErr = null;
    // SM-C2: env-driven Alpaca base URL (default paper, flip via staticData)
    const _creds_AB = ($getWorkflowStaticData('global')._credentials) || {};
    const _alpacaBase = _creds_AB.alpaca_base
      || (_creds_AB.alpaca_env === 'live'
        ? 'https://paper-api.alpaca.markets'
        : 'https://paper-api.alpaca.markets');
    const _alpacaHdrs = {
      'APCA-API-KEY-ID':     _SYNC_KEY,
      'APCA-API-SECRET-KEY': _SYNC_SECRET,
      'Content-Type':        'application/json'
    };

    // Step 2a: Cancel all open orders for this ticker
    try {
      const _openOrders = await this.helpers.httpRequest({
        method: 'GET',
        url: _alpacaBase + '/v2/orders?status=open&symbols=' + ticker + '&limit=20&nested=true',
        headers: _alpacaHdrs,
        json: true
      });
      const _ordersArr = Array.isArray(_openOrders) ? _openOrders : [];
      if (_ordersArr.length > 0) {
        console.log('[TICKER-KILL v5.15] Cancelling ' + _ordersArr.length + ' open order(s) for ' + ticker + ' before close');
        for (const _ord of _ordersArr) {
          try {
            await this.helpers.httpRequest({
              method: 'DELETE',
              url: _alpacaBase + '/v2/orders/' + _ord.id,
              headers: _alpacaHdrs,
              json: true
            });
          } catch (_cancelErr) { /* order may already be filled/cancelled */ }
        }
        // Brief wait for exchange to process cancellations
        await new Promise(r => setTimeout(r, 1500));
      }
    } catch (_ordFetchErr) {
      console.log('[TICKER-KILL v5.15] Could not fetch open orders: ' + _ordFetchErr.message);
    }

    // Step 2b: Close the position
    try {
      const _tkCloseResp = await this.helpers.httpRequest({
        method: 'DELETE',
        url: _alpacaBase + '/v2/positions/' + ticker + '?time_in_force=gtc',
        headers: _alpacaHdrs,
        json: true,
        returnFullResponse: false
      });
      // Alpaca DELETE /positions/:ticker returns the closing order object
      if (_tkCloseResp && (_tkCloseResp.id || _tkCloseResp.status)) {
        _tkClosed = true;
        _tkClosePrice = _tkCloseResp.filled_avg_price || _tkCloseResp.limit_price || null;
        _tkCloseQty   = _tkCloseResp.qty || null;
        console.log('[TICKER-KILL v5.10] Alpaca confirmed close for ' + ticker +
          ' | order=' + _tkCloseResp.id + ' status=' + _tkCloseResp.status);
      } else {
        // Retry once (500ms delay)
        await new Promise(r => setTimeout(r, 500));
        const _tkRetry = await this.helpers.httpRequest({
          method: 'DELETE',
          url: _alpacaBase + '/v2/positions/' + ticker + '?time_in_force=gtc',
          headers: {
            'APCA-API-KEY-ID': _SYNC_KEY,
            'APCA-API-SECRET-KEY': _SYNC_SECRET
          },
          json: true,
          returnFullResponse: false
        });
        if (_tkRetry && (_tkRetry.id || _tkRetry.status)) {
          _tkClosed = true;
          _tkClosePrice = _tkRetry.filled_avg_price || null;
          console.log('[TICKER-KILL v5.10] Retry succeeded for ' + ticker);
        }
      }
    } catch (_tkCloseErrObj) {
      _tkCloseErr = _tkCloseErrObj.message || String(_tkCloseErrObj);
      const _is404 = _tkCloseErr.includes('404') || _tkCloseErr.includes('not found') || _tkCloseErr.includes('position does not exist');
      if (_is404) {
        // No position to close — treat as success (position already flat)
        _tkClosed = true;
        console.log('[TICKER-KILL v5.10] No open position for ' + ticker + ' (already flat) — treating as closed');
      } else {
        console.log('[TICKER-KILL v5.10] Alpaca close FAILED for ' + ticker + ': ' + _tkCloseErr);
      }
    }

    } // end market-hours else block for TICKER-KILL Alpaca close
  // ── STEP 3: SMART SANITIZED REASON MAPPING ───────────────────
    let _tkSanitized = { reason: '', details: '', impact: '' };

    if (_tkTriggerType === 'MANUAL') {
      _tkSanitized = {
        reason: 'Manual risk management action',
        details: 'Position closed by our risk management system following a manual review.',
        impact: 'Position has been closed. No further exposure on ' + ticker + '.'
      };
    } else if (_tkTriggerType === 'GAP') {
      const _gapPctDisplay = _tkTriggerData.gap_pct ? _tkTriggerData.gap_pct.toFixed(1) + '% intraday gap' : 'significant gap';
      _tkSanitized = {
        reason: 'Unexpected price gap detected',
        details: 'A ' + _gapPctDisplay + ' was detected on ' + ticker + ', exceeding safe entry parameters.',
        impact: 'Position closed to prevent further exposure during volatile price action.'
      };
    } else if (_tkTriggerType === 'LOSS') {
      _tkSanitized = {
        reason: 'Position risk parameters exceeded',
        details: 'Drawdown protection activated after the position moved against our risk model.',
        impact: 'Position closed to protect capital. Risk controls working as intended.'
      };
    } else if (_tkTriggerType === 'SENTIMENT') {
      const _sdScore = _tkTriggerData.sentiment_score !== undefined ? _tkTriggerData.sentiment_score.toFixed(2) : '?';
      // Sanitize AI reason: strip any internal keywords before publishing to channel
      const _sdReason = (_tkTriggerData.sentiment_reason || 'negative market sentiment signal')
        .replace(/(threshold|score|internal|pipeline|webhook|signal agent|n8n)/gi, '')
        .trim().substring(0, 150);
      _tkSanitized = {
        reason: 'Market intelligence risk alert',
        details: 'Our AI analysis detected strong negative market sentiment for ' + ticker +
          '. Sentiment reading: ' + _sdScore + '. ' + _sdReason + '.',
        impact: 'Position closed proactively based on forward-looking risk analysis.'
      };
    } else {
      _tkSanitized = {
        reason: 'Automated risk management action',
        details: 'Multiple risk conditions detected on ' + ticker + '. Position closed proactively.',
        impact: 'No further exposure on ' + ticker + '.'
      };
    }

    // ── STEP 4: SEND NOTIFICATIONS (only after confirmed close) ──
    if (_tkClosed) {
      // Personal TG — full internal detail
      const _tkMsgPersonal = '[TICKER-KILL v5.12] ' + ticker + ' ' + _tkActionWord.toUpperCase() + _tkTimingNote +
        '\nTrigger: ' + _tkTriggerType +
        '\nReason: ' + _tkInternalReason +
        '\nData: ' + JSON.stringify(_tkTriggerData) +
        '\nClose confirmed: ' + (_tkClosePrice ? '$' + _tkClosePrice : 'pending fill') +
        '\nAll other positions unaffected.';
      try {
        await this.helpers.httpRequest({
          method: 'POST',
          url: 'https://api.telegram.org/bot' + _tgToken + '/sendMessage',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: 6648680513, text: _tkMsgPersonal }),
          json: true
        });
      } catch (_e3) { /* silent */ }

      // Channel — fully sanitized, dynamic
      const _tkMsgChannel =
        ticker + ': ' + _tkActionWord + _tkTimingNote + '.' +
        '\nReason: ' + _tkSanitized.reason + '.' +
        '\nDetails: ' + _tkSanitized.details +
        '\nImpact: ' + _tkImpactSuffix +
        '\n\nAll other positions are unaffected and trading as usual.' +
        '\nPipeline status: Normal.' +
        '\n\nWe continue monitoring and sending signals for active tickers.' +
        '\n\nQuantum Trading System';
      try {
        await this.helpers.httpRequest({
          method: 'POST',
          url: 'https://api.telegram.org/bot' + _tgToken + '/sendMessage',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: -1003889511940, text: _tkMsgChannel }),
          json: true
        });
      } catch (_e4) { /* silent */ }

    } else {
      // Close FAILED — personal alert only, no channel notification
      const _tkFailMsg = '[TICKER-KILL v5.10] WARNING: ' + ticker + ' CLOSE FAILED.' +
        '\nReason: ' + _tkInternalReason +
        '\nAlpaca error: ' + (_tkCloseErr || 'unknown') +
        '\nACTION REQUIRED: Check Alpaca and close manually.' +
        '\nTicker blacklisted in SM — no new signals will fire.';
      try {
        await this.helpers.httpRequest({
          method: 'POST',
          url: 'https://api.telegram.org/bot' + _tgToken + '/sendMessage',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: 6648680513, text: _tkFailMsg }),
          json: true
        });
      } catch (_e5) { /* silent */ }
      console.log('[TICKER-KILL v5.10] Notifications suppressed — close not confirmed');
    }

    // ── STEP 5: UPDATE WEEKLY KILL STATS ─────────────────────────
    state.weeklyKillStats.totalKills = (state.weeklyKillStats.totalKills || 0) + 1;

    if (!state.weeklyKillStats.killsByTicker[ticker]) state.weeklyKillStats.killsByTicker[ticker] = 0;
    state.weeklyKillStats.killsByTicker[ticker]++;

    const _wksRKey = _tkTriggerType || 'UNKNOWN';
    if (!state.weeklyKillStats.killsByReason[_wksRKey]) state.weeklyKillStats.killsByReason[_wksRKey] = 0;
    state.weeklyKillStats.killsByReason[_wksRKey]++;

    // v5.11: Update sentiment dedup timestamp
    if (_tkTriggerType === 'SENTIMENT') {
      state._sentimentKillDedup[_sentKillKey] = _tkNow2;
    }
    // v5.14: Deferred cooldown — set immediately only when market is open.
    // When market is closed (GTC order), store as pending and confirm at market open.
    if (!state._reEntryCooldown) state._reEntryCooldown = {};
    if (!state._pendingGTCCloses) state._pendingGTCCloses = {};

    if (_marketIsOpen) {
      // Position fills immediately — set cooldown now
      state._reEntryCooldown[ticker] = _tkNow2;
      console.log('[RE-ENTRY v5.14] Cooldown set immediately (market open, filled now) for ' + ticker);
    } else {
      // GTC order placed — cooldown deferred until position confirmed flat at market open
      state._pendingGTCCloses[ticker] = {
        submittedAt:  _tkNow2,
        triggerType:  _tkTriggerType,
        triggerData:  _tkTriggerData,
        retryCount:   0,
        notified:     false
      };
      console.log('[GTC-PENDING v5.14] Stored pending close for ' + ticker + ' — cooldown deferred until 9:40 AM ET re-check');
    }
    state.weeklyKillStats.lastKill = {
      ticker, triggerType: _tkTriggerType, reason: _tkInternalReason,
      closed: _tkClosed, ts: new Date(_tkNow2).toISOString()
    };
    console.log('[KILL-STATS] Week ' + state.weeklyKillStats.weekStarting + ': ' +
      JSON.stringify(state.weeklyKillStats.killsByReason) + ' | Total: ' + state.weeklyKillStats.totalKills);

    // ── RETURN ────────────────────────────────────────────────────
    return [{
      json: {
        ...d,
        _sm_action:        'TICKER_KILLED',
        _sm_route:         'SKIP',
        _sm_reason:        'Per-ticker kill v5.10 (' + _tkTriggerType + '): ' + _tkInternalReason,
        _sm_version:       'v5.10',
        _sm_is_heartbeat:  'false',
        _tk_closed:        _tkClosed,
        _tk_trigger_type:  _tkTriggerType,
        _tk_channel_reason: _tkSanitized.reason,
        _tk_weekly_kills:  state.weeklyKillStats.totalKills,
        ticker, timeframe
      }
    }];
  }
}
// ── END v5.10 PER-TICKER KILL TRIGGER ──────────────────────────

// ── 1. Deduplication — Enhanced for heartbeats ────────────────
const dedupKey = `${ticker}_${timeframe || 'UNK'}`;
// ============================================================
// v5.3: MARKET HOURS + WEEKEND AWARENESS
// ============================================================
const nowDate = new Date(now);
const nowHourET = parseInt(nowDate.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }));
const nowMinET = parseInt(nowDate.toLocaleString('en-US', { timeZone: 'America/New_York', minute: 'numeric' }));
const nowDayOfWeek = parseInt(nowDate.toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short' }) === 'Sun' ? 0 : nowDate.toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short' }) === 'Sat' ? 6 : nowDate.getDay());
const isWeekendET = (nowDayOfWeek === 0 || nowDayOfWeek === 6);
const marketTimeMinutes = nowHourET * 60 + nowMinET;
const isPreMarket = marketTimeMinutes >= 420 && marketTimeMinutes < 570;  // 7:00-9:30 AM ET
const isRegularHours = marketTimeMinutes >= 570 && marketTimeMinutes < 960; // 9:30 AM - 4:00 PM ET
const isAfterHours = marketTimeMinutes >= 960 && marketTimeMinutes < 1200; // 4:00-8:00 PM ET
const isMarketHours = isRegularHours;
const isExtendedHours = isPreMarket || isAfterHours;
const isScalpTimeframe = ['5', '15', '5M', '15M', '1', '1M', '3', '3M'].includes((timeframe || '').toUpperCase());

const prev     = state.signalStates[dedupKey] || null;
const isScalpCooldown = ['5', '15', '5M', '15M', '1', '1M', '3', '3M'].includes((timeframe || '').toUpperCase());
const COOLDOWN_MS = isScalpCooldown ? 5 * 60 * 1000 : 15 * 60 * 1000; // 5min scalp, 15min swing/daily

let dedupAction = 'FORWARD';
let dedupReason = '';
let routeAction = 'FULL';
// v5.6: Track whether this bar was promoted from heartbeat by score
let heartbeatPromoted = false;
let promotionReason   = '';
// QTP_H1_CORRELATION_KEY_AND_KILL_ATTRIBUTION_20260617
// SSM-local correlation key (stable per execution). NOTE: minted from SSM wall-clock,
// so it intentionally does NOT attempt to match quantum.strategy_signals.signal_id
// (that table is written by an async_shadow process ~4h later with its own ingest ts).
// Used for H2 risk write-back keying and exec_flow_audit correlation within this pipeline.
let _smKillStageAttribution = null;   // first/dominant firing kill switch label (one of 7) for killed items; null for FULL
let _smKillReasonsAll = [];           // full kill-reason list captured for gate_lineage[ssm]
const _smGateLineage = [];            // append-only ordered array, one object per stage reached

if (prev) {
  const timeSinceLast = now - prev.timestamp;
  const sameState = prev.execution === execution && prev.signal === signal;

  if (isHeartbeat) {
    if (sameState) {
      // ============================================================
      // v5.6: SCORE-GATED HEARTBEAT PROMOTION
      // Instead of always discarding same-state heartbeats, check
      // the raw score. If it exceeds the threshold, promote to FULL
      // so the VC Gate / Perplexity / Alpaca / Telegram pipeline
      // evaluates this bar. Otherwise, stay SKIP (internal only).
      // ============================================================
      if (rawScore > HEARTBEAT_SCORE_THRESHOLD) {
        dedupAction = 'FORWARD';
        dedupReason = `Heartbeat PROMOTED: ${dedupKey} score ${rawScore} > ${HEARTBEAT_SCORE_THRESHOLD} (same state ${execution}/${signal})`;
        routeAction = 'FULL';
        heartbeatPromoted = true;
        promotionReason = `raw_score ${rawScore} > ${HEARTBEAT_SCORE_THRESHOLD}`;
      } else {
        dedupAction = 'DISCARD';
        dedupReason = `Heartbeat skip: ${dedupKey} still ${execution}/${signal}, score ${rawScore} <= ${HEARTBEAT_SCORE_THRESHOLD} (${Math.round(timeSinceLast / 1000)}s ago)`;
      }
    } else {
      dedupAction = 'FORWARD';
      dedupReason = `Heartbeat state change: ${dedupKey} ${prev.execution}${String.fromCharCode(8594)}${execution}`;
      // v5.2: EXIT signals (→ STAND ASIDE) get FAST_ONLY, entry signals get FULL
      routeAction = (execution === 'STAND ASIDE') ? 'FAST_ONLY' : 'FULL';
    }
  } else {
    // v5.16: Max dedup window — signals older than 4h treated as fresh (pre-market state reset)
    const MAX_DEDUP_MS = 4 * 60 * 60 * 1000; // 4 hours
    if (sameState && timeSinceLast < MAX_DEDUP_MS) {
      // QTP_WRO_ACTIVE_REFRESH_20260506
      // Conservative active fix: high-score watchlist duplicates are refreshed into the EXISTING normal path.
      // It does not infer direction, does not lower VC >=7, does not bypass Risk Gate/Pause Guard/Alpaca, and does not touch exits.
      const _wroActiveWatchlist = new Set(['MU','NVDA','CRWV','ORCL','SNDK','NBIS','CSTS']);
      const _wroActiveTicker = String(ticker || d.ticker || d.symbol || '').toUpperCase();
      const _wroActiveExec = String(execution || '').toUpperCase();
      const _wroActiveScore = Number(rawScore || d.raw_score || d.score || d.ai_super_score || 0);
      const _wroActiveRefresh = _wroActiveWatchlist.has(_wroActiveTicker)
        && _wroActiveScore >= 65
        && timeSinceLast >= COOLDOWN_MS
        && isRegularHours;
      if (_wroActiveRefresh) {
        dedupAction = 'FORWARD';
        dedupReason = `WRO active refresh: ${dedupKey} high-score watchlist duplicate ${execution}/${signal}, score ${_wroActiveScore}, ${Math.round(timeSinceLast / 1000)}s since last; normal gates still apply`;
        routeAction = (_wroActiveExec === 'STAND ASIDE') ? 'FAST_ONLY' : 'FULL';
      } else {
        dedupAction = 'DISCARD';
        dedupReason = `Duplicate: ${dedupKey} already ${execution}/${signal} (${Math.round(timeSinceLast / 1000)}s ago)`;
      }
    } else if (sameState) {
      // Same state but older than 4h — treat as fresh (session refresh, e.g. pre-market → intraday)
      dedupAction = 'FORWARD';
      dedupReason = `Session refresh: ${dedupKey} ${execution}/${signal} was ${Math.round(timeSinceLast/1000)}s ago (>4h window)`;
      routeAction = 'FULL';
    } else if (timeSinceLast < COOLDOWN_MS && execution !== 'STAND ASIDE') {
      dedupAction = 'DISCARD';
      dedupReason = `Cooldown: ${dedupKey} changed ${prev.execution}${String.fromCharCode(8594)}${execution} but only ${Math.round(timeSinceLast / 1000)}s since last`;
    } else {
      dedupAction = 'FORWARD';
      dedupReason = `State change: ${dedupKey} ${prev.execution}${String.fromCharCode(8594)}${execution}`;
      // v5.2: EXIT signals (→ STAND ASIDE) get FAST_ONLY, entry signals get FULL
      routeAction = (execution === 'STAND ASIDE') ? 'FAST_ONLY' : 'FULL';
    }
  }
} else {
  if (isHeartbeat) {
    dedupAction = 'FORWARD';
    dedupReason = `New ticker heartbeat: ${dedupKey} initial state ${execution}`;
    routeAction = 'FAST_ONLY';
  } else {
    dedupAction = 'FORWARD';
    dedupReason = `New ticker signal: ${dedupKey} initial ${execution}`;
    // v5.2: Only FULL route for actual entries (BUY/SELL), not STAND ASIDE
    routeAction = (execution === 'STAND ASIDE') ? 'FAST_ONLY' : 'FULL';
  }
}

if (dedupAction === 'DISCARD') {
  state.auditLog.push({
    ts: new Date(now).toISOString(), ticker, timeframe,
    execution, signal, action: 'DISCARD', reason: dedupReason,
    isHeartbeat, rawScore
  });
  if (state.auditLog.length > 1000) state.auditLog.splice(0, state.auditLog.length - 750);

  return [{
    json: {
      _sm_action:       'DEDUPLICATED',
      _sm_reason:       dedupReason,
      _sm_route:        'SKIP',
      _sm_is_heartbeat: isHeartbeat,
      _sm_raw_score:    rawScore,
      _sm_version:      'v5.6',
      ticker,
      timeframe,
      signal: direction
    }
  }];
}

// ── 2. VIX Regime Tag ─────────────────────────────────────────
let vixRegime;
if      (vix < 18)  vixRegime = 'LOW';
else if (vix < 25)  vixRegime = 'MEDIUM';
else if (vix < 30)  vixRegime = 'HIGH';
else                vixRegime = 'EXTREME';

// ── 3. Market Regime Tag ──────────────────────────────────────
let marketRegime;
const spyBreaking = spyStatus.includes('BREAKING_DOWN') || qqqStatus.includes('BREAKING_DOWN');
const spyHealthy  = spyStatus.includes('BULL') || spyStatus.includes('HEALTHY') ||
                    spyStatus.includes('TRENDING');
if      (spyBreaking) marketRegime = 'BEAR';
else if (spyHealthy)  marketRegime = 'BULL';
else                  marketRegime = 'CHOP';

const tradeRegimeTag = `${vixRegime}_VIX_${marketRegime}`;


// ============================================================
// ─────────────────────────────

// v5.2: PRE-PIPELINE KILL SWITCHES
// Kill weak signals at the SM level BEFORE they reach the
// expensive FULL pipeline (Perplexity, VC Agent, etc.)
// Only applies to ENTRY signals routed FULL.
// ============================================================
const isStandAside = execution === 'STAND ASIDE' || direction === 'NEUTRAL';
// v5.3: Block scalp signals outside market hours
if (isScalpTimeframe && !isRegularHours && !isStandAside) {
  const timeReason = isWeekendET ? 'Weekend' : isPreMarket ? 'Pre-market' : isAfterHours ? 'After-hours' : 'Off-hours';
  dedupAction = 'DISCARD';
  dedupReason = timeReason + ' scalp signal blocked: ' + dedupKey + ' at ' + nowHourET + ':' + String(nowMinET).padStart(2, '0') + ' ET';
  
  state.auditLog.push({
    ts: new Date(now).toISOString(), ticker, timeframe,
    execution, signal, action: 'TIME_BLOCK',
    reason: dedupReason
  });
  if (state.auditLog.length > 1000) state.auditLog.splice(0, state.auditLog.length - 750);
  
  state.signalStates[dedupKey] = {
    execution, signal, timestamp: now,
    price: d.price || '0', qualityGate: 'TIME_BLOCK', maxConfidence: 0
  };
  
  return [{
    json: {
      _sm_action: 'TIME_BLOCKED',
      _sm_reason: dedupReason,
      _sm_route: 'SKIP',
      _sm_is_heartbeat: isHeartbeat,
      _sm_version: 'v5.6',
      ticker, timeframe, signal: direction || signal
    }
  }];
}

if (routeAction === 'FULL' && !isStandAside) {
  const killReasons = [];
  
  // KILL SWITCH 1: Backtest minimum — need at least 10 trades for any statistical relevance
  // v5.16: Skip for scanner signals (BROAD_SCANNER/SENTIMENT_AGENT) — no backtest data available
  const isScannerAlert = (alertType === 'BROAD_SCANNER' || alertType === 'SENTIMENT_AGENT' || alertType.startsWith('REALTIME_AGENT'));
  const totalTrades = parseInt(d.strat_total_trades) || 0;
  const profitFactor = parseFloat(d.strat_profit_factor) || 0;
  if (!isScannerAlert && totalTrades < 10) {
    killReasons.push('Backtest insufficient: ' + totalTrades + ' trades (min 10)');
  }
  // PF < 1.0 means negative expectancy — no business sending this to subscribers
  if (!isScannerAlert && totalTrades >= 10 && profitFactor < 1.0) {
    killReasons.push('Negative expectancy: PF=' + profitFactor.toFixed(2) + ' (need >= 1.0)');
  }
  
  // KILL SWITCH 2: VIX regime — no new entries when VIX > 30 (extreme fear)
  if (vix > 30) {
    killReasons.push('VIX extreme: ' + vix.toFixed(1) + ' > 30 (halt new entries)');
  }
  
  // KILL SWITCH 3: ADX too low for directional signals — chop kills profits
  // v5.15.1: ADX = N/A means scanner signal — unknown, skip ADX gate
  const _adxRaw = String(d.adx || '').trim();
  const adxLevel = (_adxRaw === 'N/A' || _adxRaw === '' || _adxRaw === '0') ? -1 : (parseFloat(_adxRaw) || -1);
  const adxKnown = adxLevel >= 0; // Only apply ADX gates when we have real data
  if (adxKnown && adxLevel < 15 && (isLong || isShort)) {
    killReasons.push('ADX too low for directional: ' + adxLevel.toFixed(1) + ' < 15 (chop regime)');
  }
  
  // KILL SWITCH 4: SPY/QQQ both breaking down — no LONG entries
  const _spyBreaking = (d.spy_status || '').includes('BREAKING') || (d.qqq_status || '').includes('BREAKING');
  if (isLong && _spyBreaking) {
    killReasons.push('SPY/QQQ BREAKING DOWN — no longs allowed');
  }
  
  // KILL SWITCH 5: Daily drawdown halt active
  const _ddHalt = String(d.daily_dd_halt).toLowerCase() === 'true';
  if (_ddHalt) {
    killReasons.push('Daily DD halt active — no new entries');
  }
  

  // KILL SWITCH 6: REGIME-STRATEGY COMPATIBILITY (v5.4)
  // Block signals inappropriate for current market regime
  // This is the "regime-first architecture" — highest impact filter
  const _regimeTag = vixRegime + '_' + marketRegime;
  
  // NO mean-reversion LONGS in HIGH_VIX_BEAR
  if (isLong && vix > 25 && marketRegime === 'BEAR') {
    killReasons.push('Regime block: LONG in HIGH_VIX_BEAR (' + _regimeTag + ') — no MR longs in fear');
  }
  
  // NO counter-trend trades in STRONG_TREND regime
  // adxLevel already declared in kill switch 3
  const dailyTrend = (d.daily_trend || '').toUpperCase();
  if (adxKnown && adxLevel > 35) {
    // Strong trend — only trade WITH the trend
    if (isLong && dailyTrend === 'BEAR') {
      killReasons.push('Regime block: LONG against BEAR daily trend with ADX ' + adxLevel.toFixed(0) + ' (strong trend — trade WITH it)');
    }
    if (isShort && dailyTrend === 'BULL') {
      killReasons.push('Regime block: SHORT against BULL daily trend with ADX ' + adxLevel.toFixed(0) + ' (strong trend — trade WITH it)');
    }
  }
  
  // NO directional trades in extreme chop (ADX < 12)
  if (adxKnown && adxLevel < 12 && (isLong || isShort)) {
    killReasons.push('Regime block: Directional trade with ADX ' + adxLevel.toFixed(0) + ' < 12 (extreme chop — no edge)');
  }


  // KILL SWITCH 7: ATR VOLATILITY GATE (v5.4)
  // If ATR as % of price is extreme, the stock is too volatile for normal sizing
  const _atrKS = parseFloat(d.atr) || 0;
  const _priceKS = parseFloat(d.price) || 1;
  const atrPct = (_atrKS / _priceKS) * 100;
  
  if (atrPct > 8) {
    killReasons.push('Extreme volatility: ATR ' + atrPct.toFixed(1) + '% of price (> 8% — untradeable)');
  }

  // If ANY kill switch triggered, suppress the killed ENTRY.
  // QTP_H3_KILLSWITCH_REROUTE_20260617: FAST_ONLY is reserved for STAND-ASIDE exits only.
  // A killed ENTRY must NOT be routed to Alpaca Position Closer (where it died as
  // SKIPPED "Not an exit signal"). Route killed entries to SKIP (terminal-suppress).
  // Defensive ternary preserves FAST_ONLY for the stand-aside case (cannot occur here
  // because this whole block is gated on !isStandAside, but kept for contract fidelity).
  if (killReasons.length > 0) {
    routeAction = isStandAside ? 'FAST_ONLY' : 'SKIP';
    // QTP_H1_KILL_ATTRIBUTION_20260617: capture first/dominant firing switch + full list
    _smKillReasonsAll = killReasons.slice();
    _smKillStageAttribution = killReasons[0];
    dedupReason += ' | KILLED by kill switches (route=' + routeAction + '): ' + killReasons.join('; ');
    
    // Log the kill
    state.auditLog.push({
      ts: new Date(now).toISOString(), ticker, timeframe,
      execution, signal, action: 'KILL_SWITCH',
      reason: killReasons.join('; '),
      kill_count: killReasons.length
    });
    if (state.auditLog.length > 1000) state.auditLog.splice(0, state.auditLog.length - 750);
  }
}

// ── 4. Portfolio Heat Calculations ────────────────────────────
// SSM_ALPACA_SYNCED_PORTFOLIO_GATE_PATCH_20260504
// Portfolio gates must use broker-confirmed positions only.
// Previous behavior upserted every incoming BUY/SELL candidate into
// state.activePositions before Alpaca confirmed an entry; killed/rejected
// candidates accumulated as phantom positions and falsely tripped heat gates.
const isActiveSignal   = isLong || isShort;
// isStandAside already defined in v5.2 kill switches section above

if (isStandAside && ticker && state.activePositions[ticker] && !state.activePositions[ticker].syncedFromAlpaca) {
  // Remove only non-broker phantom state. Real broker positions are reconciled by Alpaca sync above.
  delete state.activePositions[ticker];
}

// Do NOT upsert current BUY/SELL candidate here. Alpaca sync is the only source
// of truth for activePositions used by heat/same-direction gates.

// Snapshot broker-confirmed counts for contradiction evaluation
const _brokerActivePositions = {};
// SSM_FRESH_SYNC_METADATA_FILTER_PATCH_20260505:
// Some stale closed symbols carried syncedFromAlpaca=true from older syncs.
// Require a fresh syncTime from the latest successful Alpaca sync window.
const _freshSyncFloor = Math.max(0, (state._lastPortfolioSync || 0) - 5000);
for (const [_sym, _pos] of Object.entries(state.activePositions || {})) {
  const _syncTime = Number(_pos && _pos.syncTime) || 0;
  if (_pos && _pos.syncedFromAlpaca === true && _syncTime >= _freshSyncFloor) {
    _brokerActivePositions[_sym] = { ..._pos, ticker: _pos.ticker || _sym };
  }
}
// Prune display/state metadata to the freshly broker-confirmed map. This does
// not loosen gates; it removes stale phantom entries from debug output and
// future calculations.
state.activePositions = _brokerActivePositions;
const activePosCount  = Object.keys(_brokerActivePositions).length;
const activePosList   = Object.values(_brokerActivePositions);
const activePosTickers = Object.keys(_brokerActivePositions).join(',');

// Same-direction count (excluding the current ticker to avoid double-counting)
const sameDirCount = activePosList.filter(function(p) {
  return p.ticker !== ticker && p.direction === direction;
}).length;

// v5.20 fix: gate count must exclude current ticker to avoid off-by-one KILL
// (activePosCount includes the just-upserted current ticker, so without this
// any new-ticker BUY when already at cap-1 would falsely fire the HARD gate).
const activePosCountForGate = activePosList.filter(function(p) {
  return p.ticker !== ticker;
}).length;

// Portfolio heat: sum of all eff_position_size
let portfolioHeatPct = 0;
activePosList.forEach(function(p) {
  portfolioHeatPct += (parseFloat(p.eff_position_size) || 0);
});
portfolioHeatPct = parseFloat(portfolioHeatPct.toFixed(2));

// ── 5. Contradiction Detection — HARD vs SOFT ─────────────────
const hardContradictions = [];
const softContradictions = [];

// HARD: Cross-asset hostile / crisis
if (crossAsset === 'HOSTILE' || crossAsset === 'CRISIS') {
  hardContradictions.push(`Cross-asset ${crossAsset}`);
}
// HARD: SPY or QQQ breaking down on a LONG
if (isLong && spyBreaking) {
  hardContradictions.push(`SPY/QQQ BREAKING_DOWN vs LONG`);
}
// HARD: VIX > 30 on a LONG
if (isLong && vix > 30) {
  hardContradictions.push(`VIX ${vix.toFixed(1)} > 30 vs LONG`);
}
// HARD: Gamma squeeze down vs LONG
if (isLong && (gexSign === 'NEGATIVE' && optRegime.includes('SQUEEZE_DOWN'))) {
  hardContradictions.push(`GAMMA_SQUEEZE_DOWN vs LONG`);
}
// HARD: Regime not tradeable
if (d.tradeable_environment === false || d.tradeable_environment === 'false') {
  hardContradictions.push(`Environment not tradeable`);
}
// HARD: Daily drawdown halt (from Pine Script)
if (dailyDdHalt) {
  hardContradictions.push(`Daily drawdown halt active (DD: ${dailyDdPct.toFixed(2)}%)`);
}
// HARD: Portfolio heat limit (concurrent positions) — v5.20: use activePosCountForGate to exclude current ticker
if (isActiveSignal && activePosCountForGate >= MAX_CONCURRENT) {
  hardContradictions.push(`Portfolio heat limit: ${activePosCountForGate}/${MAX_CONCURRENT} positions active (excluding current ${ticker})`);
}

// SOFT: Cross-asset RISK_OFF vs LONG
if (isLong && crossAsset === 'RISK_OFF') {
  softContradictions.push(`Cross-asset RISK_OFF vs LONG`);
}
// SOFT: Elevated VIX 25-30
if (vix >= 25 && vix <= 30) {
  softContradictions.push(`Elevated VIX ${vix.toFixed(1)} (25-30)`);
}
// SOFT: Dark pool distribution
const dpDistribution = dpSignal.includes('DISTRIBUTION') ||
                       dpSignal.includes('SELLING') ||
                       dpSignal.includes('BEARISH');
if (isLong && dpDistribution) {
  softContradictions.push(`Dark pool DISTRIBUTION vs LONG`);
}
// SOFT: RSI overbought/oversold
if ((isLong && rsi > 70) || (isShort && rsi < 30)) {
  softContradictions.push(`RSI ${rsi.toFixed(1)} extreme vs ${direction}`);
}
// SOFT: Negative backtest
if (stratNetPct < 0) {
  softContradictions.push(`Negative backtest (${stratNetPct.toFixed(1)}%)`);
}
// SOFT: VIX > 30 on SHORT
if (isShort && vix > 30) {
  softContradictions.push(`VIX ${vix.toFixed(1)} > 30 (short ${String.fromCharCode(8212)} macro tailwind)`);
}
// HARD: Same-direction limit (v5.17: upgraded from soft to hard)
if (isActiveSignal && sameDirCount >= MAX_SAME_DIRECTION) {
  hardContradictions.push(`Same-direction limit: ${sameDirCount}/${MAX_SAME_DIRECTION} already ${direction}`);
}
// HARD: Portfolio heat limit (v5.17: upgraded from soft to hard)
// With real money, NEVER allow new positions when heat exceeds threshold.
// This is the last line of defense before capital allocation.
if (isActiveSignal && portfolioHeatPct > MAX_HEAT_PCT) {
  hardContradictions.push(`Portfolio heat ${portfolioHeatPct}% > ${MAX_HEAT_PCT}% cap`);
}

// ── 6. Correlation Filter ─────────────────────────────────────
let correlationWarning = 'none';
if (isActiveSignal && ticker) {
  const tickerGroup = getCorrelationGroup(ticker);
  if (tickerGroup) {
    const groupMembers = CORRELATION_GROUPS[tickerGroup];
    // Find any active position in the same group + same direction (excluding self)
    const correlatedMatch = activePosList.find(function(p) {
      return p.ticker !== ticker &&
             groupMembers.includes(p.ticker) &&
             p.direction === direction;
    });
    if (correlatedMatch) {
      correlationWarning = `Correlated position: ${correlatedMatch.ticker} already ${direction} in ${tickerGroup} group`;
      softContradictions.push(correlationWarning);
    }
  }
}

// ── System-wide DD halt note (add to smReason later) ──────────
// Will be appended in smReason build below

const totalHard        = hardContradictions.length;
const allContradictions = [...hardContradictions, ...softContradictions];

// ── 7. KILL Gate ──────────────────────────────────────────────
// v5.17: Portfolio-level blocks (heat, position count, same-direction)
// are INSTANT KILL — single hard contradiction is enough.
// Other hard contradictions still need 2+ to kill.
const KILL_THRESHOLD = 2;
const _hasPortfolioBlock = hardContradictions.some(c =>
  c.includes('heat') || c.includes('Portfolio') || c.includes('Same-direction')
);
const killed = _hasPortfolioBlock || (totalHard >= KILL_THRESHOLD);

if (killed) {
  state.signalStates[dedupKey] = {
    execution, signal, alertType, timestamp: now,
    price: d.price || '0', qualityGate: 'KILL', maxConfidence: 0
  };

  const entry = {
    ts: new Date(now).toISOString(), ticker, timeframe, direction,
    hard: hardContradictions, soft: softContradictions
  };
  state.contradictions.push(entry);
  if (state.contradictions.length > 1000) state.contradictions.splice(0, state.contradictions.length - 750);

  state.auditLog.push({ ts: entry.ts, ticker, timeframe, action: 'KILLED',
    reason: hardContradictions.join(' | ') });
  if (state.auditLog.length > 1000) state.auditLog.splice(0, state.auditLog.length - 750);

  return [{
    json: {
      ...d,
      _sm_action:                'KILLED',
      _sm_reason:                `KILL gate triggered ${String.fromCharCode(8212)} ${totalHard} HARD contradictions`,
      _sm_route:                 'SKIP',
      _sm_is_heartbeat:          isHeartbeat,
      _sm_heartbeat_promoted:    false,
      _sm_raw_score:             rawScore,
      _sm_contradiction_details: hardContradictions.join(' | '),
      _sm_soft_contradictions:   softContradictions.join(' | ') || 'none',
      _sm_vix_regime:            vixRegime,
      _sm_market_regime:         marketRegime,
      _sm_trade_regime_tag:      tradeRegimeTag,
      _sm_prev_execution:        prev ? prev.execution : 'NONE',
      _sm_prev_signal:           prev ? prev.signal : 'NONE',
      _sm_seconds_since_last:    prev ? Math.round((now - prev.timestamp) / 1000) : 0,
      // v5 portfolio fields
      _sm_active_positions:      activePosCount,
    _sm_active_tickers:        activePosTickers,
    test_mode:                 _isTestSignal,
      _sm_same_direction_count:  sameDirCount,
      _sm_portfolio_heat_pct:    portfolioHeatPct,
      _sm_daily_dd_halt_tickers: ddHaltTickersList.join(',') || 'none',
      _sm_correlation_warning:   correlationWarning,
      _sm_daily_pnl_summary:     `Date: ${today} | DD Halt Tickers: ${ddHaltTickersList.length} | SystemWideHalt: ${systemWideDDHalt}`,
      _sm_version:               'v5.19',
      ticker, timeframe, signal: direction
    }
  }];
}

// ── v5.17: Telegram alert when portfolio heat or same-direction blocks ─────
// Fires only once per trading day per block type to avoid spam.
if (killed) {
  const _heatBlocked = hardContradictions.some(c => c.includes('heat') || c.includes('Same-direction'));
  if (_heatBlocked) {
    if (!state._heatAlertSentToday) state._heatAlertSentToday = {};
    const _heatAlertKey = today + '_' + ticker;
    if (!state._heatAlertSentToday[_heatAlertKey]) {
      state._heatAlertSentToday[_heatAlertKey] = Date.now();
      try {
        await this.helpers.httpRequest({
          method: 'POST',
          url: 'https://api.telegram.org/bot' + _tgToken + '/sendMessage',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: '6648680513',
            text: `⚠️ <b>SIGNAL BLOCKED — Portfolio Heat</b>\n` +
                  `Ticker: ${ticker} (${direction})\n` +
                  `Heat: ${portfolioHeatPct}% / ${MAX_HEAT_PCT}% cap\n` +
                  `Active: ${activePosCount} positions, ${sameDirCount} same-direction\n` +
                  `Reason: ${hardContradictions.filter(c => c.includes('heat') || c.includes('Same-direction')).join(', ')}\n` +
                  `<i>New signals blocked until heat drops below ${MAX_HEAT_PCT}%</i>`,
            parse_mode: 'HTML'
          }),
          json: true
        });
      } catch (_tgErr) { /* silent */ }
    }
  }
  // Clean stale alert keys (keep only today's)
  for (const k of Object.keys(state._heatAlertSentToday || {})) {
    if (!k.startsWith(today)) delete state._heatAlertSentToday[k];
  }
}

// ── 8. Confidence Caps ────────────────────────────────────────
let rawConfidence = Math.min(confidence, 9);
let capReason     = '';

// GEX contradicts technicals
const gexContradictsLong  = isLong  && gexSign === 'NEGATIVE';
const gexContradictsShort = isShort && gexSign === 'POSITIVE';
if (gexContradictsLong || gexContradictsShort) {
  if (rawConfidence > 6) { rawConfidence = 6; capReason = `Cap 6 (GEX contradicts ${direction})`; }
}

// Cross-asset HOSTILE → 3
if (crossAsset === 'HOSTILE') {
  if (rawConfidence > 3) { rawConfidence = 3; capReason = 'Cap 3 (Cross-asset HOSTILE)'; }
}
// Cross-asset RISK_OFF + LONG → 7
if (isLong && crossAsset === 'RISK_OFF') {
  if (rawConfidence > 7) { rawConfidence = 7; capReason = 'Cap 7 (Cross-asset RISK_OFF vs LONG)'; }
}
// VIX > 30 + LONG → 4
if (isLong && vix > 30) {
  if (rawConfidence > 4) { rawConfidence = 4; capReason = `Cap 4 (VIX ${vix.toFixed(1)} >30 vs LONG)`; }
}
// VIX 25-30 + LONG → 7
if (isLong && vix >= 25 && vix <= 30) {
  if (rawConfidence > 7) { rawConfidence = 7; capReason = `Cap 7 (VIX ${vix.toFixed(1)} 25-30 vs LONG)`; }
}
// SPY/QQQ BREAKING_DOWN + LONG → 3
if (isLong && spyBreaking) {
  if (rawConfidence > 3) { rawConfidence = 3; capReason = 'Cap 3 (SPY/QQQ BREAKING_DOWN vs LONG)'; }
}
// Dark pool DISTRIBUTION + LONG → 6
if (isLong && dpDistribution) {
  if (rawConfidence > 6) { rawConfidence = 6; capReason = 'Cap 6 (Dark pool DISTRIBUTION vs LONG)'; }
}

// 9/10 gate — ALL criteria must pass
if (rawConfidence >= 9) {
  const rsiOk       = rsi >= 30 && rsi <= 70;
  const macdAligned = isLong ? macdHist > 0 : macdHist < 0;
  const adxOk       = adx > 20;
  const smaOk       = isLong ? priceVsSma50 === 'ABOVE' : priceVsSma50 === 'BELOW';
  const vixOk       = vix < 25;
  const caOk        = crossAsset !== 'RISK_OFF' && crossAsset !== 'HOSTILE';
  const optOk       = optRegime.includes('BULLISH') && isLong ||
                      optRegime.includes('BEARISH') && isShort ||
                      optRegime.includes('CONTRARIAN_LONG') && isLong ||
                      optRegime.includes('CONTRARIAN_SHORT') && isShort;
  const dpOk        = !dpDistribution;

  const nineGatePassed = rsiOk && macdAligned && adxOk && smaOk && vixOk && caOk && optOk && dpOk;
  if (!nineGatePassed) {
    rawConfidence = 8;
    const fails = [];
    if (!rsiOk)       fails.push(`RSI ${rsi.toFixed(0)} out of 30-70`);
    if (!macdAligned) fails.push(`MACD histogram not aligned`);
    if (!adxOk)       fails.push(`ADX ${adx.toFixed(0)} ${String.fromCharCode(8804)} 20`);
    if (!smaOk)       fails.push(`Price not ${isLong ? 'above' : 'below'} SMA50`);
    if (!vixOk)       fails.push(`VIX ${vix.toFixed(1)} ${String.fromCharCode(8805)} 25`);
    if (!caOk)        fails.push(`Cross-asset not neutral`);
    if (!optOk)       fails.push(`Options not aligned`);
    if (!dpOk)        fails.push(`Dark pool distribution`);
    capReason = `Cap 8 (9/10 gate failed: ${fails.join(', ')})`;
  }
}

const finalConfidence = Math.round(rawConfidence);

// ── 9. Factor Attribution ─────────────────────────────────────
const boosts     = [];
const reductions = [];
let netAdj = 0;

if ((isLong  && (optRegime.includes('BULLISH') || optRegime.includes('CONTRARIAN_LONG'))) ||
    (isShort && (optRegime.includes('BEARISH') || optRegime.includes('CONTRARIAN_SHORT')))) {
  boosts.push(`+1 Options aligned (${optRegime})`); netAdj += 1;
}
if (adx > 25) {
  boosts.push(`+1 Strong trend (ADX ${adx.toFixed(0)})`); netAdj += 1;
}
if ((isLong && mtfBullOk) || (isShort && mtfBearOk)) {
  boosts.push(`+1 MTF confluence confirmed`); netAdj += 1;
}
if (relVol > 1.2) {
  boosts.push(`+1 Volume above avg (${relVol.toFixed(2)}x)`); netAdj += 1;
}

if (isLong && crossAsset === 'RISK_OFF') {
  reductions.push(`-1 Cross-asset RISK_OFF`); netAdj -= 1;
}
if (isLong && dpDistribution) {
  reductions.push(`-1 Dark pool DISTRIBUTION`); netAdj -= 1;
}
if (vix > 25) {
  reductions.push(`-1 VIX elevated (${vix.toFixed(1)})`); netAdj -= 1;
}
if ((isLong && rsi > 70) || (isShort && rsi < 30)) {
  reductions.push(`-1 RSI extreme (${rsi.toFixed(0)})`); netAdj -= 1;
}
if (stratNetPct < 0) {
  reductions.push(`-2 Negative backtest (${stratNetPct.toFixed(1)}%)`); netAdj -= 2;
}
// v5: VIX-reduced sizing factor
if (vixSizeMult < 1.0) {
  reductions.push(`-1 VIX-reduced sizing (${vixSizeMult}x)`); netAdj -= 1;
}

const capNote = capReason ? ` | Cap: ${capReason}` : ` | Cap: none`;
const factorAttribution = [
  ...boosts,
  ...reductions,
  `Net adjustment: ${netAdj >= 0 ? '+' : ''}${netAdj}${capNote}`
].join(' | ');

// ── 10. Quality Gate ──────────────────────────────────────────
const qualityGate = finalConfidence >= 6 && totalHard === 0 ? 'PASS' : 'REVIEW';

// ── 11. Build reason string ───────────────────────────────────
let smReason = `${dedupReason} | ${direction} on ${ticker} ${timeframe} | Confidence ${finalConfidence}/9`;
if (heartbeatPromoted) {
  smReason += ` | HEARTBEAT PROMOTED (score ${rawScore} > ${HEARTBEAT_SCORE_THRESHOLD})`;
}
if (allContradictions.length > 0) {
  smReason += ` | Contradictions: ${allContradictions.join('; ')}`;
}
if (capReason) smReason += ` | ${capReason}`;
if (systemWideDDHalt) smReason += ` | SYSTEM-WIDE DD HALT (${ddHaltTickersList.join(',')})`;

// ── 12. Daily P&L summary ─────────────────────────────────────
const dailyPnlSummary = `Date: ${today} | PnL: ${state.dailyPnL.totalPnL.toFixed(2)} | Trades: ${state.dailyPnL.trades.length} | DD Halt Tickers: ${ddHaltTickersList.length} | SystemWideHalt: ${systemWideDDHalt}`;

// ── 13. Update state for future dedup ─────────────────────────
state.signalStates[dedupKey] = {
  execution, signal, alertType, timestamp: now,
  price: d.price || '0', qualityGate, maxConfidence: finalConfidence
};

// ── v5.21: POST-STAND-ASIDE COOLDOWN STAMP ──────────────────────
// If current signal is STAND ASIDE and prev existed with a directional
// state, stamp cooldown so same-dir re-entries are blocked for 30 min.
// Uses the `prev` captured at top of dedup section and `execution`/`direction` from above.
if (!state._postStandAsideCooldown) state._postStandAsideCooldown = {};
if (ticker && execution === 'STAND ASIDE' && prev) {
  // Classify the direction we're exiting FROM
  const _psaPrevExec = String(prev.execution || '').toUpperCase();
  const _psaPrevSig  = String(prev.signal    || '').toUpperCase();
  let _psaPrevDir = 'NEUTRAL';
  if (['BUY','BULLISH','LONG'].includes(_psaPrevExec) || ['BUY','BULLISH'].includes(_psaPrevSig)) _psaPrevDir = 'LONG';
  else if (['SELL','BEARISH','SHORT'].includes(_psaPrevExec) || ['SELL','BEARISH'].includes(_psaPrevSig)) _psaPrevDir = 'SHORT';
  if (_psaPrevDir !== 'NEUTRAL') {
    state._postStandAsideCooldown[ticker] = { ts: now, prev_direction: _psaPrevDir };
    console.log('[POST-STAND-ASIDE v5.21] Stamped cooldown for ' + ticker +
      ' (exiting ' + _psaPrevDir + ' → STAND ASIDE) — same-dir re-entry blocked for 30min');
  }
}
// Prune stale entries (> 1h) and cap size at 200
{
  const _psaCoolMs2 = 30 * 60 * 1000;
  const _psaNow2 = Date.now();
  const _psaKeys = Object.keys(state._postStandAsideCooldown);
  for (const k of _psaKeys) {
    const rec = state._postStandAsideCooldown[k];
    if (!rec || (_psaNow2 - (rec.ts || 0)) > (2 * _psaCoolMs2)) delete state._postStandAsideCooldown[k];
  }
  const _psaKeys2 = Object.keys(state._postStandAsideCooldown);
  if (_psaKeys2.length > 200) {
    _psaKeys2.sort((a,b) => (state._postStandAsideCooldown[a].ts||0) - (state._postStandAsideCooldown[b].ts||0));
    const del = _psaKeys2.slice(0, _psaKeys2.length - 200);
    for (const k of del) delete state._postStandAsideCooldown[k];
  }
}
// ── END POST-STAND-ASIDE COOLDOWN STAMP ────────────────────────


// ── 14. Audit Log ─────────────────────────────────────────────
state.auditLog.push({
  ts:          new Date(now).toISOString(),
  ticker,
  timeframe,
  direction,
  confidence:  finalConfidence,
  rawScore,
  action:      qualityGate === 'KILL' ? 'KILLED' : 'FORWARD',
  route:       routeAction,
  isHeartbeat,
  heartbeatPromoted,
  hardCount:   totalHard,
  softCount:   softContradictions.length,
  regime:      tradeRegimeTag,
  reason:      smReason,
  activePositions: activePosCount,
  portfolioHeat:   portfolioHeatPct
});
if (state.auditLog.length > 1000) state.auditLog.splice(0, state.auditLog.length - 750);

// Contradiction log
state.contradictions.push({
  ts: new Date(now).toISOString(),
  ticker, direction,
  contradictionCount: allContradictions.length,
  maxConfidence:      finalConfidence,
  gate:               qualityGate,
  details:            allContradictions.join('; ') || 'none',
  vix, regime: crossAsset, optRegime,
  portfolioHeat: portfolioHeatPct,
  ddHaltTickers: ddHaltTickersList.join(',') || 'none'
});
if (state.contradictions.length > 1000) state.contradictions.splice(0, state.contradictions.length - 750);


// QTP_WRO_SHADOW_STALE_NEUTRAL_DIAGNOSTIC_20260506
// Diagnostic-only: marks watchlist stale-neutral momentum candidates for forensics.
// Does NOT alter _sm_action, _sm_route, VC score, Risk Gate, Alpaca route, or protective exits.
const _wroWatchlist = new Set(['MU','NVDA','CRWV','ORCL','SNDK','NBIS','CSTS']);
const _wroTicker = String(ticker || d.ticker || d.symbol || '').toUpperCase();
const _wroSignal = String(d.execution || d.signal || direction || '').toUpperCase();
const _wroDaily = String(d.daily_trend || d.dailyTrend || '').toUpperCase();
const _wroReasonText = String(smReason || '').toLowerCase();
const _wroPrevNeutral = !!(prev && String(prev.signal || prev.execution || '').toUpperCase().includes('NEUTRAL'));
const _wroStaleNeutral = _wroReasonText.includes('stand aside/neutral') || _wroPrevNeutral;
const _wroRawScore = Number(rawScore || d.raw_score || d.score || d.ai_super_score || 0);
const _wroMomentumCandidate = _wroWatchlist.has(_wroTicker) && _wroStaleNeutral && _wroRawScore >= 65;
const _wroMetaComplete = !!(d.daily_trend && d.regime && (d.opt_regime || d.options_regime) && (d.dp_regime || d.dark_pool_regime));
const _wroShadowReason = _wroMomentumCandidate
  ? 'Watchlist stale-neutral momentum candidate detected in shadow only; live route unchanged.'
  : 'No WRO stale-neutral shadow promotion candidate; live route unchanged.';

// ── 15. Return enriched item ──────────────────────────────────
// QTP_H1_CORRELATION_KEY_MINT_20260617
// Mint SSM-local correlation keys in canonical shape {TICKER}_{TF}_{YYYYMMDDHHMMSS}
// (UTC). idempotency_key == signal_id (mirrors strategy_signals convention so H2 can
// re-key on it). NOTE: timestamp is SSM wall-clock, NOT the async_shadow ingest ts, so
// this is a per-execution correlation key within the n8n pipeline, not a JOIN key to
// quantum.strategy_signals. Cross-table JOIN is deferred (see verdict 20260617).
const _smTsUTC = new Date(now);
const _smPad = (x) => String(x).padStart(2, '0');
const _smStamp = `${_smTsUTC.getUTCFullYear()}${_smPad(_smTsUTC.getUTCMonth()+1)}${_smPad(_smTsUTC.getUTCDate())}${_smPad(_smTsUTC.getUTCHours())}${_smPad(_smTsUTC.getUTCMinutes())}${_smPad(_smTsUTC.getUTCSeconds())}`;
const _smTickerKey = (ticker || 'UNK').toString().toUpperCase();
const _smTfKey = (timeframe || 'UNK').toString().toUpperCase();
const _smSignalId = `${_smTickerKey}_${_smTfKey}_${_smStamp}`;
const _smIdempotencyKey = _smSignalId;
// Build gate_lineage[ssm] entry — append-only; absent downstream stages tell us where it died.
_smGateLineage.push({
  stage: 'ssm',
  route: routeAction,
  kill_reasons: _smKillReasonsAll,
  kill_stage_attribution: _smKillStageAttribution,
  ts: _smTsUTC.toISOString()
});

return [{
  json: {
    // ── pass-through all original fields ──────────────────
    ...d,

    // ── state machine outputs ──────────────────────────────
    _sm_version:               'v5.6',
    _sm_action:                'PASS',
    _sm_route:                 routeAction,

    // ── QTP_H1 correlation key + kill attribution (20260617) ──
    _sm_signal_id:             _smSignalId,
    _sm_idempotency_key:       _smIdempotencyKey,
    _sm_kill_stage_attribution: _smKillStageAttribution,
    _sm_gate_lineage:          _smGateLineage,
    _sm_is_heartbeat:          isHeartbeat,
    _sm_heartbeat_promoted:    heartbeatPromoted,
    _sm_promotion_reason:      promotionReason || 'none',
    _sm_raw_score:             rawScore,
    _sm_reason:                smReason,
    _sm_max_confidence:        finalConfidence,
    _sm_quality_gate:          qualityGate,

    // dedup fields
    _sm_prev_execution:        prev ? prev.execution : 'NONE',
    _sm_prev_signal:           prev ? prev.signal : 'NONE',
    _sm_seconds_since_last:    prev ? Math.round((now - prev.timestamp) / 1000) : 0,

    // contradiction output
    _sm_contradiction_count:      allContradictions.length,
    _sm_hard_contradiction_count: totalHard,
    _sm_contradiction_details:    allContradictions.join(' | ') || 'none',
    _sm_hard_contradictions:      hardContradictions.join(' | ') || 'none',
    _sm_soft_contradictions:      softContradictions.join(' | ') || 'none',

    // v3+ fields
    _sm_factor_attribution:    factorAttribution,
    _sm_vix_regime:            vixRegime,
    _sm_market_regime:         marketRegime,
    _sm_trade_regime_tag:      tradeRegimeTag,

    // cap traceability
    _sm_confidence_cap_reason: capReason || 'none',
    _sm_raw_confidence:        Math.round(Math.min(confidence, 9)),

    // ── v5 portfolio risk fields ───────────────────────────
    _sm_active_positions:      activePosCount,
    _sm_active_tickers:        activePosTickers,
    test_mode:                 _isTestSignal,
    _sm_same_direction_count:  sameDirCount,
    _sm_portfolio_heat_pct:    portfolioHeatPct,
    _sm_daily_dd_halt_tickers: ddHaltTickersList.join(',') || 'none',
    _sm_correlation_warning:   correlationWarning,
    _sm_daily_pnl_summary:     dailyPnlSummary,

    // QTP-WRO diagnostic-only fields. No live routing effect.
    _wro_shadow_stale_neutral_refresh_candidate: _wroMomentumCandidate,
    _wro_shadow_stale_neutral_reason: _wroShadowReason,
    _wro_shadow_watchlist_momentum_candidate: _wroMomentumCandidate,
    _wro_shadow_metadata_complete: _wroMetaComplete,
    _wro_shadow_execution_effect: 'NONE_SHADOW_ONLY',
    _wro_active_refresh_patch: 'QTP_WRO_ACTIVE_REFRESH_20260506',
    _wro_active_refresh_effect: 'DEDUP_REFRESH_TO_NORMAL_GATES_ONLY'
  }
}];