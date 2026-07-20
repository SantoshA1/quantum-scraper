// === OPTION_B_v5.14_SHIM_START ===
// Reads optB_flags attached by upstream "Merge Option B Flags" Code node.
// Fail-closed: missing → disabled, V5_13_BASE codepath unchanged.
// Audit fields added per item; behavior gating deferred to v5.15+.
const __optB_readFlags = (it) => {
  const f = (it && it.json && it.json.optB_flags) || null;
  if (!f) {
    return {
      _optB_flags_source: 'missing',
      _optB_profile_aware_engaged: false,
      _optB_ai_advisory_engaged: false,
      _optB_profile_aware_value: null,
      _optB_ai_advisory_value: null
    };
  }
  const pa = f.mtf_profile_aware_composite_v1 || {};
  const ai = f.mtf_ai_advisory_paper_v1 || {};
  return {
    _optB_flags_source: pa.source || ai.source || 'unknown',
    _optB_profile_aware_engaged: pa.enabled === true,
    _optB_ai_advisory_engaged: ai.enabled === true,
    _optB_profile_aware_value: pa.flag_value || null,
    _optB_ai_advisory_value: ai.flag_value || null
  };
};
// === OPTION_B_v5.14_SHIM_END ===

// QTP_BIAS_FILTER_REJECTION_OBSERVABILITY_v5.13_20260601 — Council P0.1: splits MTF_CONFLUENCE into deterministic vs AI-judge veto legs. Adds _mtf_veto_leg attribution emitted alongside existing _composite_opposition_* observability.
// On catch: emits placeholder item with _bias_filter_pass=false, _bias_filter_pass_reason='EXCEPTION',
//   _bias_filter_pass_subreason=err.name, _bias_filter_exception_msg=err.message.slice(0,240).
// Pass Splitter routes the placeholder to FALSE; Drop SQL Builder v1.2 logs it (drop_reason='EXCEPTION',
//   blocked_stage='EXCEPTION', bias_filter_exception_msg=err.message).
// QTP_ENTRY_QUALITY_AI_CONFLICT_GUARD + BACKTEST_ENFORCEMENT v4.2.13 — paper AI soft-allow v5.9 tightened
// Additive hardening: VC >=7 remains locked upstream. Blocks only low-quality new entries before Alpaca.
// Rules: bias >=55 AND secondary confirmation AND required backtest data valid.
// Paper-gated only: HOLD/WEAK/low-confidence AI conflicts are soft-allowed when VC=10, bias>=60, backtest valid, secondary confirmation passes, and SPY/QQQ cross-asset confirmation is strong/aligned.
// Hard AI conflicts remain blocked: opposite action and sentiment conflict.
const scored = items.map(item => {
  try {
  const output = { ...(item.json || {}) };
  // OptB v5.14 audit attach
  Object.assign(output, __optB_readFlags(item));

  function num(v, fallback = 0) {
    if (v === undefined || v === null || String(v).trim() === '') return fallback;
    const n = Number(String(v).replace('%', '').trim());
    return Number.isFinite(n) ? n : fallback;
  }
  function numOrNull(v) {
    if (v === undefined || v === null || String(v).trim() === '') return null;
    const n = Number(String(v).replace('%', '').trim());
    return Number.isFinite(n) ? n : null;
  }
  function txt(...vals) {
    for (const v of vals) {
      if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
    }
    return '';
  }
  // QTP_BACKTEST_RELAXATION_v6.1_20260526
  // Smart backtest thresholds: STRICT 100/1.20, RELAXED 40/1.05, HIGH_VOL_RELAXED 30/0.95.
  // Additive and auditable only. R3.2 KILL and BROAD_SCANNER bias path remain untouched.
  function __qtpBtBool(v) {
    if (v === true) return true;
    if (v === false) return false;
    const s = String(v ?? '').trim().toLowerCase();
    return ['true','1','yes','y','on'].includes(s);
  }
  const __qtpBtRelaxationConfig = {
    strict: { minTrades: 100, minPf: 1.20, action: 'STRICT', relaxed: false },
    relaxed: { minTrades: 40, minPf: 1.05, action: 'RELAXED', relaxed: true },
    highVol: { minTrades: 30, minPf: 0.95, action: 'HIGH_VOL_RELAXED', relaxed: true },
    highVolSymbols: new Set(['VFS','USO'])
  };
  function __qtpSelectBacktestThresholds(j) {
    const ticker = String(j.ticker || j.symbol || '').trim().toUpperCase();
    const marketText = String(j.market_status || j._dq_market_status || j.session || j.session_status || '').toUpperCase();
    const isPreMarket = __qtpBtBool(j.pre_market_mode) || __qtpBtBool(j.preMarketMode) || marketText.includes('PRE') || marketText.includes('PREMARKET');
    const isRelaxed = __qtpBtBool(j.relaxed_mode) || __qtpBtBool(j.relaxedMode) || isPreMarket;
    const isHighVol = __qtpBtRelaxationConfig.highVolSymbols.has(ticker) || __qtpBtBool(j.high_vol) || __qtpBtBool(j.highVol) || __qtpBtBool(j._high_vol);
    const t = isHighVol ? __qtpBtRelaxationConfig.highVol : (isRelaxed ? __qtpBtRelaxationConfig.relaxed : __qtpBtRelaxationConfig.strict);
    return { ...t, ticker, isPreMarket, isHighVol };
  }

  const execution = txt(output.execution, output.side, output.signal).toUpperCase();
  const bias_score = num(output._bias_filter_score ?? output.bias_score ?? output.ai_super_score ?? output.composite_score ?? output.bull_score ?? output.bear_score ?? output.score, 0);
  const volume_ratio = num(output.volume_ratio ?? output.rel_volume ?? output.relative_volume ?? output.vol_ratio, 0);
  const cross_asset = txt(output.cross_asset, output.cross_asset_alignment, output.cross_asset_status, output.ca_signal_alignment, output.ca_regime, output.market_alignment).toUpperCase();
  const spy_alignment = txt(output.spy_alignment, output.spy_confirmation, output.spy_regime, output.spy_trend, output.spy_signal, output.spy_market_alignment, output.spy_state).toUpperCase();
  const qqq_alignment = txt(output.qqq_alignment, output.qqq_confirmation, output.qqq_regime, output.qqq_trend, output.qqq_signal, output.qqq_market_alignment, output.qqq_state).toUpperCase();
  const market_confirmation_text = txt(output.market_confirmation, output.market_context, output.cross_asset_detail, output.cross_asset_reason, output.market_alignment_detail).toUpperCase();
  function strongAligned(v) {
    const s = String(v || '').toUpperCase();
    if (!s || ['N/A','NA','UNKNOWN','NEUTRAL','MIXED','LOW','CAUTIOUS'].includes(s)) return false;
    if (s.includes('MIXED') || s.includes('LAGGING') || s.includes('DIVERGENT') || s.includes('DECOUPLED') || s.includes('CAUTIOUS') || s.includes('LOW')) return false;
    return s.includes('STRONG') || s.includes('ALIGNED') || s.includes('CONFIRMED') || s.includes('BULLISH') || s.includes('BEARISH') || s.includes('RISK_ON') || s.includes('TRENDING');
  }
  const spyStrongAligned = strongAligned(spy_alignment) || market_confirmation_text.includes('SPY ALIGNED') || market_confirmation_text.includes('SPY STRONG') || market_confirmation_text.includes('SPY CONFIRMED');
  const qqqStrongAligned = strongAligned(qqq_alignment) || market_confirmation_text.includes('QQQ ALIGNED') || market_confirmation_text.includes('QQQ STRONG') || market_confirmation_text.includes('QQQ CONFIRMED');
  const crossAssetStrongAligned = strongAligned(cross_asset) || cross_asset.includes('SPY ALIGNED') || cross_asset.includes('QQQ ALIGNED') || cross_asset.includes('SPY STRONG') || cross_asset.includes('QQQ STRONG');
  const paper_ai_soft_allow_cross_asset_confirmed = crossAssetStrongAligned || (spyStrongAligned && qqqStrongAligned);
  const price = num(output.price ?? output.close ?? output.mark_price, NaN);
  const sma50 = num(output.sma50, NaN);
  const ema200 = num(output.ema200, NaN);
  const timeframe = numOrNull(output.timeframe ?? output.tf ?? output.interval);
  const alertType = txt(output.alert_type, output.source, output.strategy_id, output.signal_type).toUpperCase();
  const signalText = txt(output.signal_name, output.strategy, output.setup_type, output.trade_type, output.style, output.intent).toUpperCase();
  const adx = numOrNull(output.adx);
  const vix = numOrNull(output.vix);

  const aiAction = txt(output.ai_action, output.grok_action, output.pplx_action, output.analysis_action, output.model_action, output.action).toUpperCase();
  const aiVerdict = txt(output.ai_verdict, output.grok_verdict, output.pplx_verdict, output.verdict).toUpperCase();
  const aiSentiment = txt(output.ai_sentiment, output.sentiment, output.grok_sentiment, output.pplx_sentiment).toUpperCase();
  const aiConfidence = num(output.ai_confidence ?? output.grok_confidence ?? output.pplx_confidence ?? output.analysis_confidence ?? output.model_confidence ?? output.ai_analysis_confidence, NaN);
  const optionsRegime = txt(output.options_regime, output.options_flow_regime, output.options_signal, output.options_status, output.options_analysis, output.options_verdict).toUpperCase();
  const darkPoolRegime = txt(output.dark_pool_regime, output.darkpool_regime, output.dark_pool_status, output.dark_pool_signal, output.dp_regime, output.smart_money_regime).toUpperCase();
  const darkPoolShortPct = numOrNull(output.dark_pool_short_pct ?? output.darkpool_short_pct ?? output.short_volume_pct ?? output.short_pct ?? output.short_volume_ratio);
  const marketStatus = txt(output.market_status, output.market_regime, output.mkt_status, output.mkt_regime, output.market_risk, output.risk_tape).toUpperCase();

  const bias_threshold = 55;
  const paper_ai_soft_allow_bias_threshold = 60;
  const paper_observation_threshold = 50;
  const qtpMode = String(output.qtp_deployment_mode || '').toUpperCase();
  const qtpTradingEnv = String(output.qtp_trading_env || output.trading_env || '').toUpperCase();
  const alpacaEnv = String(output.alpaca_env || output.alpaca_mode || '').toUpperCase();
  const liveTradingAllowed = output.qtp_live_trading_allowed === true || String(output.qtp_live_trading_allowed || '').toLowerCase() === 'true';
  const isPaperGated =
    (qtpMode === 'PRODUCTION_PAPER_GATED' || qtpTradingEnv === 'PAPER' || alpacaEnv === 'PAPER') &&
    liveTradingAllowed === false;
  const vcScore = num(output.vc_live_v2 ?? output.live_vc_score_v2 ?? output._vc_score, 0);
  const hasAIAction = !!aiAction;
  const explicitHoldConflict = hasAIAction && ['HOLD','STAND ASIDE','NEUTRAL','WAIT','NO TRADE'].includes(aiAction) && ['BUY','SELL'].includes(execution);
  const explicitOppositeConflict = (execution === 'BUY' && ['SELL','BEARISH','SHORT'].includes(aiAction)) || (execution === 'SELL' && ['BUY','BULLISH','LONG'].includes(aiAction));
  const lowAIConfidence = Number.isFinite(aiConfidence) && aiConfidence > 0 && aiConfidence < 60 && ['BUY','SELL'].includes(execution);
  const weakAIVerdict = ['WEAK','INVALID','REJECT','FAIL'].includes(aiVerdict) && ['BUY','SELL'].includes(execution);
  const sentimentConflict = (execution === 'BUY' && ['BEARISH','WEAK'].includes(aiSentiment)) || (execution === 'SELL' && ['BULLISH','WEAK'].includes(aiSentiment));

  const hasTrendRefs = Number.isFinite(price) && Number.isFinite(sma50) && Number.isFinite(ema200) && sma50 > 0 && ema200 > 0;
  const trendConflict = hasTrendRefs && ((execution === 'BUY' && price < sma50 && price < ema200) || (execution === 'SELL' && price > sma50 && price > ema200));

  const hardNonTrendAiConflict =
    explicitOppositeConflict ||
    sentimentConflict;

  const softNonTrendAiConflict =
    explicitHoldConflict ||
    lowAIConfidence ||
    weakAIVerdict;

  const nonTrendAiConflict =
    hardNonTrendAiConflict ||
    softNonTrendAiConflict;

  let aiConflict =
    nonTrendAiConflict ||
    trendConflict;
  const aiConflictReasons = [];
  if (explicitHoldConflict) aiConflictReasons.push(`ai_action=${aiAction}`);
  if (explicitOppositeConflict) aiConflictReasons.push(`opposite_ai_action=${aiAction}`);
  if (lowAIConfidence) aiConflictReasons.push(`ai_confidence=${aiConfidence}<60`);
  if (weakAIVerdict) aiConflictReasons.push(`ai_verdict=${aiVerdict}`);
  if (sentimentConflict) aiConflictReasons.push(`ai_sentiment=${aiSentiment}`);
  if (trendConflict) aiConflictReasons.push(`trend_conflict price=${price} sma50=${sma50} ema200=${ema200}`);

  const isEntry = ['BUY','SELL','LONG','SHORT','BULLISH','BEARISH'].includes(execution);
  const isScalp = signalText.includes('SCALP') || alertType.includes('SCALP') || alertType.includes('BROAD_SCANNER') || (timeframe !== null && timeframe <= 5);


  // QTP v5.9 Multi-Timeframe Confluence hard gate.
  // Real-money-quality selectivity, currently enforced inside the paper-gated production path.
  const mtfEngineSeen = txt(output.mtf_confluence_engine_v, output.mtf_ai_judge_v) !== '';
  const mtfScore = num(output.mtf_confluence_score, 0);
  const aiMtfScore = num(output.ai_mtf_confluence_score, 0);
  const finalMtfDecision = txt(output.final_mtf_confluence_decision, output.mtf_confluence_decision).toUpperCase();
  const finalMtfPass = mtfEngineSeen && finalMtfDecision === 'FINAL_MTF_CONFLUENCE_PASS';
  // ── F1-B EXPANSION_20260714 (Conclave Q1, 2026-07-14): MTF demoted to SHADOW when cohort active ──
  // Config via staticData._gateConfig (synced from quantum.gate_config each batch, ≤1 batch lag).
  // Default (no config / cohort off) = enforce exactly as before (fail-closed to status quo).
  // Hard floor: mtfScore < mtf_hard_floor (default 40) ALWAYS blocks (Guard rail, Conclave amendment).
  // final_mtf_confluence_decision keeps recording the filter verdict = would-block telemetry.
  const _gcfgF1B = ($getWorkflowStaticData('global') || {})._gateConfig || {};
  const _mtfShadowOn = Number(_gcfgF1B.expansion_cohort_active || 0) === 1;
  const _mtfHardFloor = Number.isFinite(Number(_gcfgF1B.mtf_hard_floor)) ? Number(_gcfgF1B.mtf_hard_floor) : 40;
  const _mtfFloorBlock = isEntry && mtfEngineSeen && Number.isFinite(mtfScore) && mtfScore > 0 && mtfScore < _mtfHardFloor;
  const mtfWouldBlock = isEntry && !finalMtfPass;
  output._mtf_shadow_mode = _mtfShadowOn;
  output._mtf_final_would_block = mtfWouldBlock;
  output._mtf_floor_block = _mtfFloorBlock;
  const mtfConfluenceBlock = _mtfShadowOn ? _mtfFloorBlock : mtfWouldBlock;

  // ── v5.13 P0.1: MTF veto-leg attribution ──
  // Decompose the merged MTF veto into independent legs so reject-backtest analysis
  // can distinguish deterministic-confluence drops from AI-judge drops without
  // re-deriving from raw scores. Heuristic: prefer explicit decision text when
  // emitted by the engine/judge; fall back to numeric score thresholds.
  // Deterministic threshold: 65 (MTF Engine v6.2 published threshold).
  // AI judge threshold:      60 (AI MTF Judge v5.10 published threshold).
  const detMtfDecisionText = txt(output.mtf_confluence_decision).toUpperCase();
  const aiMtfDecisionText  = txt(output.ai_mtf_confluence_decision, output.ai_mtf_decision).toUpperCase();
  const detLegExplicitPass = detMtfDecisionText.includes('PASS');
  const detLegExplicitBlock = detMtfDecisionText.includes('BLOCK') || detMtfDecisionText.includes('FAIL') || detMtfDecisionText.includes('REJECT');
  const aiLegExplicitPass  = aiMtfDecisionText.includes('PASS');
  const aiLegExplicitBlock = aiMtfDecisionText.includes('BLOCK') || aiMtfDecisionText.includes('FAIL') || aiMtfDecisionText.includes('REJECT');
  const detLegPass = mtfEngineSeen && (
    detLegExplicitPass ||
    (!detLegExplicitBlock && Number.isFinite(mtfScore) && mtfScore >= 65)
  );
  const aiLegPass = mtfEngineSeen && (
    aiLegExplicitPass ||
    (!aiLegExplicitBlock && Number.isFinite(aiMtfScore) && aiMtfScore >= 60)
  );
  let mtfVetoLeg = null;
  if (mtfConfluenceBlock) {
    if (!detLegPass && !aiLegPass)      mtfVetoLeg = 'MTF_BOTH_VETOED';
    else if (!detLegPass && aiLegPass)  mtfVetoLeg = 'MTF_DETERMINISTIC_VETO';
    else if (detLegPass && !aiLegPass)  mtfVetoLeg = 'MTF_AI_JUDGE_VETO';
    else                                mtfVetoLeg = 'MTF_UNKNOWN_VETO';
  }

  const aiFieldsPresent = !!(aiAction || aiVerdict || aiSentiment || Number.isFinite(aiConfidence));
  const aiWeakMonitorOpposition = isEntry && (
    ['MONITOR','HOLD','PASS','WAIT','STAND ASIDE','NEUTRAL','NO TRADE'].includes(aiAction) ||
    ['WEAK','UNCONFIRMED','LOW CONV','LOW-CONVICTION','INVALID','REJECT','FAIL'].includes(aiVerdict) ||
    (Number.isFinite(aiConfidence) && aiConfidence > 0 && aiConfidence < 60)
  );
  const aiMissingOpposition = false; // FIX1 ENFORCE 20260621: missing-AI is a data gap, not opposition (was: isEntry && !aiFieldsPresent). Genuine weak/bearish AI still blocks via aiWeakMonitorOpposition. PO-authorized; shadow data 4/4 would-pass.
  const optionsOpposition = isEntry && (
    (['BUY','LONG','BULLISH'].includes(execution) && (optionsRegime.includes('CONTRARIAN_SHORT') || optionsRegime.includes('GAMMA_SQUEEZE_DOWN') || optionsRegime.includes('BEARISH') || optionsRegime.includes('PUT_HEAVY'))) ||
    (['SELL','SHORT','BEARISH'].includes(execution) && (optionsRegime.includes('CONTRARIAN_LONG') || optionsRegime.includes('GAMMA_SQUEEZE_UP') || optionsRegime.includes('BULLISH') || optionsRegime.includes('CALL_HEAVY')))
  );
  const darkPoolOpposition = isEntry && (
    (['BUY','LONG','BULLISH'].includes(execution) && (darkPoolRegime.includes('DISTRIBUTION') || darkPoolRegime.includes('BEARISH') || darkPoolRegime.includes('EXTREME_SHORT') || (darkPoolShortPct !== null && darkPoolShortPct >= 60))) ||
    (['SELL','SHORT','BEARISH'].includes(execution) && (darkPoolRegime.includes('ACCUMULATION') || darkPoolRegime.includes('BULLISH') || darkPoolRegime.includes('LOW_SHORT') || (darkPoolShortPct !== null && darkPoolShortPct <= 25)))
  );
  const crossAssetOpposition = isEntry && (
    cross_asset.includes('MIXED') || cross_asset.includes('LOW') || cross_asset.includes('CAUTIOUS') || cross_asset.includes('LAGGING') ||
    cross_asset.includes('DIVERGENT') || cross_asset.includes('DECOUPLED') || cross_asset.includes('SECTOR_LAGGING') || cross_asset.includes('RISK_OFF')
  );
  const marketOpposition = isEntry && ((vix !== null && vix >= 28) || marketStatus.includes('CAUTIOUS') || marketStatus.includes('RISK_OFF') || marketStatus.includes('WEAK'));
  const trendOpposition = isEntry && trendConflict;
  const compositeOppositionReasons = [];
  if (aiWeakMonitorOpposition) compositeOppositionReasons.push(`AI_WEAK_OR_MONITOR action=${aiAction || 'N/A'} verdict=${aiVerdict || 'N/A'} confidence=${Number.isFinite(aiConfidence) ? aiConfidence : 'N/A'}`);
  if (aiMissingOpposition) compositeOppositionReasons.push('AI_FIELDS_MISSING_BEFORE_GATE');
  if (optionsOpposition) compositeOppositionReasons.push(`OPTIONS_OPPOSITION=${optionsRegime || 'UNKNOWN'}`);
  if (darkPoolOpposition) compositeOppositionReasons.push(`DARK_POOL_OPPOSITION=${darkPoolRegime || 'UNKNOWN'} short_pct=${darkPoolShortPct ?? 'N/A'}`);
  if (trendOpposition) compositeOppositionReasons.push(`TREND_OPPOSITION price=${price} sma50=${sma50} ema200=${ema200}`);
  if (crossAssetOpposition) compositeOppositionReasons.push(`CROSS_ASSET_OPPOSITION=${cross_asset || 'UNKNOWN'}`);
  if (marketOpposition) compositeOppositionReasons.push(`MARKET_OPPOSITION vix=${vix ?? 'N/A'} market=${marketStatus || 'UNKNOWN'}`);
  const compositeOppositionCount = compositeOppositionReasons.length;
  const paperCompositeOppositionBlock = isPaperGated && isEntry && compositeOppositionCount >= 2;
  // --- FIX1 SHADOW (log-only; Condition A c7feb6fa). Observability ONLY:
  //     does NOT affect paperCompositeOppositionBlock / backtestValid / live_order_allowed. ---
  const _fix1_ai_missing_warn = isEntry && !aiFieldsPresent;
  const _fix1_shadow_count = compositeOppositionCount - (_fix1_ai_missing_warn ? 1 : 0);
  const _fix1_shadow_block = isPaperGated && isEntry && _fix1_shadow_count >= 2;
  const _fix1_would_pass_if_ai_neutral = (paperCompositeOppositionBlock === true) && (_fix1_shadow_block === false);
  output._fix1_ai_fields_missing_warn = _fix1_ai_missing_warn;
  output._fix1_shadow_composite_count = _fix1_shadow_count;
  output._fix1_would_pass_if_ai_neutral = _fix1_would_pass_if_ai_neutral;

  const highRisk = isEntry && (isScalp || bias_score < 75 || (adx !== null && adx < 20) || (vix !== null && vix >= 24));
  const btSample = numOrNull(output._backtest_sample_size ?? output.backtest_sample_size ?? output.strat_total_trades ?? output.backtest_total_trades ?? output.total_trades);
  const btPf = numOrNull(output._backtest_profit_factor ?? output.backtest_profit_factor ?? output.strat_profit_factor ?? output.profit_factor);
  const backtestDataQuality = txt(output._backtest_data_quality, output.backtest_data_quality, output.strat_backtest_data_quality, output.backtest_quality, output.backtest_status).toUpperCase();
  const btThresholds = __qtpSelectBacktestThresholds(output);
  const minPaperBacktestSample = 30;
  const isNonNeutralRoute = ['BUY','SELL','LONG','SHORT','BULLISH','BEARISH'].includes(execution);
  const weakBacktestQuality =
    backtestDataQuality.includes('WEAK') ||
    backtestDataQuality.includes('MISSING') ||
    backtestDataQuality.includes('NO_BACKTEST') ||
    backtestDataQuality.includes('INSUFFICIENT') ||
    backtestDataQuality.includes('LOW_SAMPLE');
  const paperWeakBacktestSampleBlock = isPaperGated && isNonNeutralRoute && btSample !== null && btSample < minPaperBacktestSample;
  const paperWeakBacktestQualityBlock = isPaperGated && isNonNeutralRoute && weakBacktestQuality;
  const paperWeakBacktestBlock = paperWeakBacktestSampleBlock || paperWeakBacktestQualityBlock;
  const backtestRequired = output._backtest_required === true || String(output._backtest_required ?? '').toLowerCase() === 'true' || highRisk;
  const baseBacktestValid = !backtestRequired || (btSample !== null && btSample >= btThresholds.minTrades && btPf !== null && btPf >= btThresholds.minPf);
  // F2 EXPANSION_20260714 (Conclave Ruling 2, Q2-A): BACKTEST_ENFORCEMENT demoted to SHADOW when cohort active.
  // would_block + PF context stamped on every signal; fail-closed record: missing PF/sample => verdict 'UNKNOWN' (never an implicit pass).
  // Cohort off (default / config missing) = enforce exactly as before.
  const _pfWouldBlockRaw = !(baseBacktestValid && !paperWeakBacktestBlock && !paperCompositeOppositionBlock && !mtfConfluenceBlock);
  const _pfShadowOn = Number(((($getWorkflowStaticData('global') || {})._gateConfig) || {}).expansion_cohort_active || 0) === 1;
  output._pf_shadow_mode = _pfShadowOn;
  output._pf_would_block = _pfWouldBlockRaw;
  output._pf_would_block_verdict = (typeof btPf === 'undefined' || btPf === null || typeof btSample === 'undefined' || btSample === null) ? 'UNKNOWN' : (_pfWouldBlockRaw ? 'WOULD_BLOCK' : 'PASS');
  output._pf_value_at_eval = (typeof btPf === 'undefined') ? null : btPf;
  output._pf_sample_at_eval = (typeof btSample === 'undefined') ? null : btSample;
  const backtestValid = _pfShadowOn ? true : !_pfWouldBlockRaw;

  const strict_secondary_confirmation =
    volume_ratio > 1.25 ||
    cross_asset === 'STRONG' ||
    cross_asset === 'ALIGNED' ||
    cross_asset.includes('STRONG') ||
    cross_asset.includes('ALIGNED') ||
    cross_asset.includes('CONFIRMED');

  const paper_relaxed_secondary_volume =
    Number.isFinite(volume_ratio) &&
    volume_ratio > 0.95;

  const paper_relaxed_secondary_cross_asset =
    cross_asset === '' ||
    cross_asset === 'UNKNOWN' ||
    cross_asset === 'N/A' ||
    cross_asset === 'NEUTRAL' ||
    cross_asset.includes('NEUTRAL') ||
    cross_asset.includes('ALIGNED') ||
    cross_asset.includes('CONFIRMED') ||
    cross_asset.includes('STRONG');

  // reverted to >=10 per Conclave verdict 20260708 — VC9 → shadow (gate_config vc_paper_secondary_bar)
  const paper_secondary_confirmation =
    isPaperGated &&
    vcScore >= 10 &&
    bias_score >= bias_threshold &&
    backtestValid === true &&
    (paper_relaxed_secondary_volume || paper_relaxed_secondary_cross_asset);

  const secondary_confirmation =
    strict_secondary_confirmation ||
    paper_secondary_confirmation;
  const paper_soft_non_trend_ai_conflict_allow =
    isPaperGated &&
    vcScore >= 10 &&
    bias_score >= paper_ai_soft_allow_bias_threshold &&
    backtestValid === true &&
    secondary_confirmation === true &&
    paper_ai_soft_allow_cross_asset_confirmed === true &&
    softNonTrendAiConflict === true &&
    hardNonTrendAiConflict === false;

  const effectiveNonTrendAiConflict =
    hardNonTrendAiConflict ||
    (softNonTrendAiConflict && !paper_soft_non_trend_ai_conflict_allow);

  const paper_soft_trend_conflict_allow =
    isPaperGated &&
    vcScore >= 10 &&
    bias_score >= bias_threshold &&
    backtestValid === true &&
    secondary_confirmation === true &&
    trendConflict === true &&
    effectiveNonTrendAiConflict === false;

  aiConflict =
    effectiveNonTrendAiConflict ||
    (trendConflict && !paper_soft_trend_conflict_allow);
  const backtestReasons = [];
  if (backtestRequired && (btSample === null || btSample < btThresholds.minTrades)) backtestReasons.push(`sample=${btSample ?? 'N/A'}<${btThresholds.minTrades}`);
  if (backtestRequired && (btPf === null || btPf < btThresholds.minPf)) backtestReasons.push(`pf=${btPf ?? 'N/A'}<${btThresholds.minPf}`);
  if (paperWeakBacktestSampleBlock) backtestReasons.push(`paper_min_sample=${btSample ?? 'N/A'}<${minPaperBacktestSample}`);
  if (paperWeakBacktestQualityBlock) backtestReasons.push(`paper_backtest_quality=${backtestDataQuality || 'UNKNOWN'}`);
  if (paperCompositeOppositionBlock) backtestReasons.push(`paper_composite_opposition_count=${compositeOppositionCount}; ${compositeOppositionReasons.join('; ')}`);
  if (mtfConfluenceBlock) backtestReasons.push(`mtf_confluence_block final=${finalMtfDecision || 'UNKNOWN'} deterministic=${mtfScore} ai=${aiMtfScore} summary=${output.final_mtf_confluence_summary || 'N/A'}`);

  output.parser_version = output.parser_version || 'QTP_CYCLE_007_17_NODE_HARDENED_20260511';
  output.qtp_cycle_version = 'QTP_CYCLE_007_17_NODE_HARDENED_20260511';
  output._bias_filter_version = 'QTP_ENTRY_QUALITY_MTF_CONFLUENCE_v5.15_MTF_MISLABEL_FIX_20260615';
  output._bias_filter_threshold = bias_threshold;
  output._bias_filter_paper_ai_soft_allow_bias_threshold = paper_ai_soft_allow_bias_threshold;
  output._bias_filter_score = bias_score;
  output._bias_filter_secondary_pass = secondary_confirmation;
  output._bias_filter_strict_secondary_pass = strict_secondary_confirmation;
  output._bias_filter_paper_secondary_pass = paper_secondary_confirmation;
  output._bias_filter_paper_relaxed_secondary_volume = paper_relaxed_secondary_volume;
  output._bias_filter_paper_relaxed_secondary_cross_asset = paper_relaxed_secondary_cross_asset;
  output._bias_filter_paper_secondary_rule = 'PAPER_RELAXED_SECONDARY_V56: volume_ratio>0.95 OR cross_asset neutral/unknown/aligned/confirmed/strong; requires paper-gated, VC>=9 (v5.16, was 10), bias>=55, backtest valid. AI soft-allow is tightened separately in v5.9 and requires bias>=60 plus strong SPY/QQQ/cross-asset confirmation';
  output._bias_filter_secondary_mode = strict_secondary_confirmation
    ? 'STRICT_SECONDARY'
    : paper_secondary_confirmation
      ? 'PAPER_RELAXED_SECONDARY_V56'
      : 'SECONDARY_FAILED';
  output._bias_filter_volume_ratio = Number.isFinite(volume_ratio) ? volume_ratio : null;
  output._bias_filter_cross_asset = cross_asset || 'UNKNOWN';
  output._bias_filter_spy_alignment = spy_alignment || 'UNKNOWN';
  output._bias_filter_qqq_alignment = qqq_alignment || 'UNKNOWN';
  output._bias_filter_paper_ai_soft_allow_cross_asset_confirmed = paper_ai_soft_allow_cross_asset_confirmed;
  output._bias_filter_paper_ai_soft_allow_cross_asset_rule = 'PAPER_AI_SOFT_ALLOW_V59: requires bias>=60 AND (cross_asset strong/aligned/confirmed OR both SPY and QQQ strong/aligned/confirmed); mixed/lagging/divergent/cautious/low do not qualify';
  output._ai_conflict_guard_action = aiAction || 'N/A';
  output._ai_conflict_guard_confidence = Number.isFinite(aiConfidence) ? aiConfidence : null;
  output._ai_conflict_guard_verdict = aiVerdict || 'N/A';
  output._ai_conflict_guard_sentiment = aiSentiment || 'N/A';
  output._ai_conflict_guard_trend_conflict = trendConflict;
  output._ai_conflict_guard_non_trend_conflict = nonTrendAiConflict;
  output._ai_conflict_guard_hard_non_trend_conflict = hardNonTrendAiConflict;
  output._ai_conflict_guard_soft_non_trend_conflict = softNonTrendAiConflict;
  output._ai_conflict_guard_effective_non_trend_conflict = effectiveNonTrendAiConflict;
  output._ai_conflict_guard_paper_soft_non_trend_allow = paper_soft_non_trend_ai_conflict_allow;
  output._ai_conflict_guard_trend_soft_allow = paper_soft_trend_conflict_allow;
  output._ai_conflict_guard_mode = hardNonTrendAiConflict
    ? 'AI_CONFLICT_HARD_BLOCK'
    : paper_soft_non_trend_ai_conflict_allow && paper_soft_trend_conflict_allow
      ? 'PAPER_SOFT_ALLOW_AI_AND_TREND_CONFLICT'
      : paper_soft_non_trend_ai_conflict_allow
        ? 'PAPER_SOFT_ALLOW_NON_TREND_AI_CONFLICT'
        : paper_soft_trend_conflict_allow
          ? 'PAPER_HARD_ALLOW_TREND_CONFLICT'
          : aiConflict
            ? 'AI_CONFLICT_HARD_BLOCK'
            : 'AI_CONFLICT_CLEAR';
  output._ai_conflict_guard_pass = !aiConflict;
  output._ai_conflict_guard_reason = aiConflictReasons.join('; ') || 'none';
  output._backtest_enforcement_version = output._backtest_enforcement_version || 'QTP_BACKTEST_ENFORCEMENT_v4.2.12_20260513';
  output._backtest_required = backtestRequired;
  output._backtest_valid = backtestValid;
  output._backtest_enforcement_action = backtestRequired ? btThresholds.action : 'BACKTEST_NOT_REQUIRED';
  output._backtest_threshold_action = backtestRequired ? btThresholds.action : 'BACKTEST_NOT_REQUIRED';
  output._backtest_relaxed_thresholds = btThresholds.relaxed;
  output._used_min_trades = btThresholds.minTrades;
  output._used_min_pf = btThresholds.minPf;
  if (btThresholds.relaxed) console.log(`BACKTEST RELAXED for ${output.ticker || output.symbol || 'UNKNOWN'} → trades=${btSample ?? 'N/A'} pf=${btPf ?? 'N/A'} (${btThresholds.isHighVol ? 'high-vol' : 'pre-market'})`);
  output._backtest_base_valid = baseBacktestValid;
  output._backtest_sample_size = btSample;
  output._backtest_profit_factor = btPf;
  output._backtest_data_quality = backtestDataQuality || output._backtest_data_quality || output.backtest_data_quality || 'UNKNOWN';
  output._backtest_min_paper_sample = minPaperBacktestSample;
  output._backtest_paper_weak_sample_block = paperWeakBacktestSampleBlock;
  output._backtest_paper_weak_quality_block = paperWeakBacktestQualityBlock;
  output._backtest_paper_weak_block = paperWeakBacktestBlock;
  output._composite_opposition_gate_v = 'QTP_PAPER_COMPOSITE_OPPOSITION_BLOCK_v6.0_20260519';
  output._composite_opposition_count = compositeOppositionCount;
  output._composite_opposition_reasons = compositeOppositionReasons.join('; ') || 'none';
  output._composite_opposition_ai_fields_present = aiFieldsPresent;
  output._composite_opposition_ai_weak_monitor = aiWeakMonitorOpposition;
  output._composite_opposition_options = optionsOpposition;
  output._composite_opposition_dark_pool = darkPoolOpposition;
  output._composite_opposition_trend = trendOpposition;
  output._composite_opposition_cross_asset = crossAssetOpposition;
  output._composite_opposition_market = marketOpposition;
  output._composite_opposition_block = paperCompositeOppositionBlock;
  output._mtf_veto_leg = mtfVetoLeg;
  output._mtf_det_leg_pass = detLegPass;
  output._mtf_ai_leg_pass = aiLegPass;
  output._options_regime_seen_by_gate = optionsRegime || 'UNKNOWN';
  output._dark_pool_regime_seen_by_gate = darkPoolRegime || 'UNKNOWN';
  output._dark_pool_short_pct_seen_by_gate = darkPoolShortPct;
  output._market_status_seen_by_gate = marketStatus || 'UNKNOWN';
  output._backtest_enforcement_result = backtestValid ? (backtestRequired ? 'BACKTEST_VALID_ALLOW_CONTINUE' : 'BACKTEST_NOT_REQUIRED') : (mtfConfluenceBlock ? 'PAPER_BLOCK_MTF_CONFLUENCE' : (paperCompositeOppositionBlock ? 'PAPER_BLOCK_COMPOSITE_OPPOSITION' : (paperWeakBacktestBlock ? 'PAPER_BLOCK_WEAK_BACKTEST_QUALITY' : 'BIAS_FILTER_BLOCK_BACKTEST_INVALID')));
  output._backtest_enforcement_action = backtestRequired ? btThresholds.action : 'BACKTEST_NOT_REQUIRED';
  output._backtest_enforcement_reason = (backtestReasons.join('; ') || 'OK')
    + `; FIX1_SHADOW ai_missing_warn=${_fix1_ai_missing_warn} shadow_count=${_fix1_shadow_count} would_pass_if_ai_neutral=${_fix1_would_pass_if_ai_neutral}`;
  output._backtest_status = backtestValid ? 'BACKTEST_DATA_OK' : 'NO_BACKTEST_DATA';
  output._backtest_available = btSample !== null && btSample > 0 && btPf !== null;
  output._backtest_failure_reason = backtestValid ? '' : `BACKTEST_ENFORCEMENT_FAILED: ${output._backtest_enforcement_reason}`;

  if (bias_score < bias_threshold || !secondary_confirmation || aiConflict || !backtestValid) {
    output.gate_decision = 'BLOCKED_BY_ENTRY_QUALITY';
    // QTP_BIAS_FILTER_v5.15_MTF_MISLABEL_FIX_20260615 — Council δ directive #1.
    // Honest blocked_stage / _bias_filter_pass_reason: distinguish genuine MTF block (engine ran,
    // decision present, score>0) from MTF data-missing (engine never produced an evaluation —
    // decision is N/A/UNKNOWN/empty/NONE or score ≤ 0). Behavior unchanged — only the labels.
    const _mtfStageDecPresent = (function(){
      const d = String(finalMtfDecision || '').trim().toUpperCase();
      return d !== '' && d !== 'N/A' && d !== 'UNKNOWN' && d !== 'NONE';
    })();
    const _mtfStageScoreValid = Number.isFinite(mtfScore) && mtfScore > 0;
    const _mtfStageGenuineBlock = mtfConfluenceBlock && mtfEngineSeen && _mtfStageDecPresent && _mtfStageScoreValid;
    const _mtfStageDataMissing  = mtfConfluenceBlock && !(mtfEngineSeen && _mtfStageDecPresent && _mtfStageScoreValid);
    output.blocked_stage = _mtfStageGenuineBlock
      ? 'MTF_CONFLUENCE'
      : (_mtfStageDataMissing
          ? 'MTF_DATA_MISSING'
          : (!backtestValid ? 'BACKTEST_ENFORCEMENT' : 'BIAS_FILTER'));
    output._mtf_stage_attribution = _mtfStageGenuineBlock
      ? 'GENUINE_MTF_BLOCK'
      : (_mtfStageDataMissing ? 'MTF_DATA_MISSING' : 'NOT_MTF');
    output._mtf_stage_mislabel_fix_version = 'QTP_BIAS_FILTER_v5.15_MTF_MISLABEL_FIX_20260615';
    output._bias_filter_pass = false;
    // ── BIAS-FILTER REJECTION OBSERVABILITY v5.10 — single canonical reason + detail ──
    // Priority order: MTF > BACKTEST > AI > PAPER_SECONDARY > COMPOSITE > BIAS_THRESHOLD > UNKNOWN.
    // v5.15: MTF leg now splits into MTF_CONFLUENCE (genuine) vs MTF_DATA_MISSING (engine N/A).
    let _bf_reason = "UNKNOWN";
    if (_mtfStageGenuineBlock) _bf_reason = "MTF_CONFLUENCE";
    else if (_mtfStageDataMissing) _bf_reason = "MTF_DATA_MISSING";
    else if (!backtestValid) _bf_reason = "BACKTEST_ENFORCEMENT";
    else if (aiConflict) _bf_reason = "AI_CONFLICT";
    else if (!secondary_confirmation) _bf_reason = "PAPER_SECONDARY";
    else if (paperCompositeOppositionBlock) _bf_reason = "COMPOSITE_OPPOSITION";
    else if (bias_score < bias_threshold) _bf_reason = "BIAS_THRESHOLD";
    output._bias_filter_pass_reason = _bf_reason;
    const _bf_detail_bits = [
      `bias=${bias_score}/${bias_threshold}`,
      `vol_ratio=${Number.isFinite(volume_ratio) ? volume_ratio : "NA"}`,
      `mtf=${mtfScore}/${typeof mtf_threshold!=="undefined"?mtf_threshold:"NA"}`,
      `mtf_block=${mtfConfluenceBlock}`,
      `bt_valid=${backtestValid}`,
      `bt_sample=${btSample ?? "NA"}`,
      `bt_pf=${btPf ?? "NA"}`,
      `ai_conflict=${aiConflict}`,
      `ai_verdict=${aiVerdict || "NA"}`,
      `sec_conf=${secondary_confirmation}`,
      `composite_opp=${paperCompositeOppositionBlock}`,
      `composite_n=${compositeOppositionCount}`,
      `mtf_veto_leg=${mtfVetoLeg || "N/A"}`,
      `det_pass=${detLegPass}`,
      `ai_pass=${aiLegPass}`,
    ];
    output._bias_filter_pass_reason_detail = _bf_detail_bits.join("; ");
    output._bias_filter_pass_reason_version = "BIAS_FILTER_REJECTION_OBSERVABILITY_v5.13_20260601";
    // ── v5.11: MTF sub-reason classifier ──
    // MTF_BLOCKED      = MTF engine produced a real decision AND a numeric score > 0
    // MTF_DATA_MISSING = MTF engine returned no decision (N/A/UNKNOWN/empty) or score 0/NULL
    let _bf_subreason = null;
    if (_bf_reason === "MTF_CONFLUENCE") {
      // v5.15: reaching here means genuine MTF block (data present, score>0) — subreason = MTF_BLOCKED.
      _bf_subreason = "MTF_BLOCKED";
    } else if (_bf_reason === "MTF_DATA_MISSING") {
      // v5.15: new explicit reason — subreason mirrors for backward-compat with v5.11 readers.
      _bf_subreason = "MTF_DATA_MISSING";
    }
    output._bias_filter_pass_subreason = _bf_subreason;
    const paperBiasObservationOnly = isPaperGated && vcScore >= 10 && backtestValid === true && aiConflict === false && bias_score >= paper_observation_threshold && bias_score < bias_threshold;
    output._bias_filter_paper_observation_only = paperBiasObservationOnly;
    output._bias_filter_paper_observation_threshold = paper_observation_threshold;
    output._bias_filter_paper_observation_reason = paperBiasObservationOnly
      ? 'PAPER_OBSERVATION_ONLY: VC/backtest/AI guard passed, but production bias threshold or secondary confirmation failed. No live routing.'
      : 'NOT_ELIGIBLE_FOR_PAPER_OBSERVATION';
    output.paper_observation_only = paperBiasObservationOnly;
    output.live_order_allowed = false;
    output.order_intent = output.order_intent || 'NONE';
    output.blocked_reason = `Cycle 007/4.2.13 entry quality block: bias=${bias_score} threshold=${bias_threshold}, volume_ratio=${Number.isFinite(volume_ratio) ? volume_ratio : 'N/A'}, cross_asset=${cross_asset || 'UNKNOWN'}, secondary=${secondary_confirmation}, strict_secondary=${strict_secondary_confirmation}, paper_secondary=${paper_secondary_confirmation}, ai_guard=${!aiConflict}, ai_reason=${output._ai_conflict_guard_reason}, hard_ai_conflict=${hardNonTrendAiConflict}, soft_ai_conflict=${softNonTrendAiConflict}, paper_ai_soft_allow=${paper_soft_non_trend_ai_conflict_allow}, trend_soft_allow=${paper_soft_trend_conflict_allow}, backtest_required=${backtestRequired}, backtest_valid=${backtestValid}, backtest_base_valid=${baseBacktestValid}, backtest_sample=${btSample ?? 'N/A'}, backtest_quality=${backtestDataQuality || 'UNKNOWN'}, paper_weak_backtest_block=${paperWeakBacktestBlock}, mtf_confluence_block=${mtfConfluenceBlock}, mtf_score=${mtfScore}, ai_mtf_score=${aiMtfScore}, mtf_decision=${finalMtfDecision || 'UNKNOWN'}, composite_opposition_block=${paperCompositeOppositionBlock}, composite_opposition_count=${compositeOppositionCount}, composite_opposition_reasons=${compositeOppositionReasons.join('; ') || 'none'}, backtest_reason=${output._backtest_enforcement_reason}, paper_observation_only=${paperBiasObservationOnly}`;
  } else {
    output._bias_filter_pass = true;
    output._bias_filter_paper_observation_only = false;
    output._bias_filter_paper_observation_threshold = paper_observation_threshold;
    output.paper_observation_only = false;
    output.gate_decision = output.gate_decision || 'PASS';
    output.blocked_stage = output.blocked_stage || 'NONE';
  }
  return { json: output };
  } catch (err) {
    // v5.12 EXCEPTION-path observability — never fail-open, never crash the whole batch.
    // Build placeholder from the raw input so Pass Splitter still has a routable item.
    const safeJson = (item && item.json) ? item.json : {};
    const errName = (err && err.name) ? String(err.name) : 'Error';
    const errMsg  = String((err && err.message) || err || 'unknown').slice(0, 240);
    const output = {
      ...safeJson,
      _bias_filter_pass: false,
      _bias_filter_pass_reason: 'EXCEPTION',
      _bias_filter_pass_subreason: errName,
      _bias_filter_exception_msg: errMsg,
      _bias_filter_pass_reason_version: 'BIAS_FILTER_REJECTION_OBSERVABILITY_v5.12_20260601',
      _bias_filter_pass_reason_detail: `exception=${errName}; msg=${errMsg}`,
      gate_decision: 'BLOCKED_BY_ENTRY_QUALITY',
      blocked_stage: 'EXCEPTION',
      live_order_allowed: false,
      order_intent: 'NONE',
      paper_observation_only: false,
      blocked_reason: `Bias Filter caught ${errName}: ${errMsg}`
    };
    return { json: output };
  }
});

// QTP-SUPABASE-PG-CUTOVER v4.2.1
// Stale REST rejection mirror disabled after Supabase PostgreSQL cutover.
// Trading behavior is unchanged: failed items are still filtered exactly as before.
// The removed mirror was audit-only and fail-open.
return scored;  // v5.10: emit all items; downstream IF splits pass/drop. PASS branch payload byte-equal to pre-patch.