// QTP Multi-Timeframe Confluence Engine v5.9
// Scores scalp, swing, and long-term quality horizons before Bias Filter.
// Gate only: no broker/order/Supabase side effects.
const inputItems = (typeof items !== 'undefined') ? items : $input.all();

function num(v, d = 0) {
  if (v === undefined || v === null || String(v).trim() === '') return d;
  const n = Number(String(v).replace('%', '').trim());
  return Number.isFinite(n) ? n : d;
}
function str(v, d = '') { return String(v ?? d).trim(); }
function upper(v) { return str(v).toUpperCase(); }
function clamp(n, lo = 0, hi = 100) { return Math.max(lo, Math.min(hi, n)); }
function isBuy(side) { return ['BUY', 'LONG', 'BULLISH'].includes(upper(side)); }
function isSell(side) { return ['SELL', 'SHORT', 'BEARISH'].includes(upper(side)); }
function alignedDirection(side, signalText) {
  const s = upper(signalText);
  if (isBuy(side)) return s.includes('BUY') || s.includes('LONG') || s.includes('BULLISH') || s.includes('ACCUMULATION') || s.includes('CONTRARIAN_LONG') || s.includes('GAMMA_SQUEEZE_UP') || s.includes('POSITIVE');
  if (isSell(side)) return s.includes('SELL') || s.includes('SHORT') || s.includes('BEARISH') || s.includes('DISTRIBUTION') || s.includes('CONTRARIAN_SHORT') || s.includes('GAMMA_SQUEEZE_DOWN') || s.includes('NEGATIVE');
  return false;
}
function oppositeDirection(side, signalText) {
  const s = upper(signalText);
  if (isBuy(side)) return s.includes('SELL') || s.includes('SHORT') || s.includes('BEARISH') || s.includes('DISTRIBUTION') || s.includes('GAMMA_SQUEEZE_DOWN') || s.includes('PUT_HEAVY');
  if (isSell(side)) return s.includes('BUY') || s.includes('LONG') || s.includes('BULLISH') || s.includes('ACCUMULATION') || s.includes('GAMMA_SQUEEZE_UP') || s.includes('CALL_HEAVY');
  return false;
}

function scoreScalp(j) {
  const side = j.side || j.action || j.signal || j.execution_side || j.execution;
  const bias = num(j.bias_score ?? j.bias ?? j.bias_pct, 0);
  const volumeRatio = num(j.volume_ratio ?? j.vol_ratio, 1);
  const rsi = num(j.rsi, 50);
  const macd = num(j.macd, 0);
  const price = num(j.price ?? j.entry_price ?? j.close, 0);
  const vwap = num(j.vwap, price);
  const aiAction = upper(j.ai_action ?? j.grok_action ?? j.pplx_action);
  const aiVerdict = upper(j.ai_verdict ?? j.grok_verdict ?? j.pplx_verdict);
  const aiConfidence = num(j.ai_confidence ?? j.grok_confidence ?? j.pplx_confidence, 0);
  const optionsRegime = upper(j.options_regime ?? j.options_flow_regime ?? j.options_signal);
  const darkPool = upper(j.dark_pool_regime ?? j.darkpool_regime ?? j.dark_pool);
  const vcScore = num(j.vc_score ?? j.vc_live_v2 ?? j.entry_quality_score, 0);
  let score = 0;
  if (bias >= 70) score += 20; else if (bias >= 60) score += 16; else if (bias >= 55) score += 10;
  if (vcScore >= 10) score += 18; else if (vcScore >= 8.5) score += 12;
  if (volumeRatio >= 1.3) score += 14; else if (volumeRatio >= 1.0) score += 10; else if (volumeRatio >= 0.95) score += 6;
  if (isBuy(side)) { if (price >= vwap) score += 10; if (rsi >= 40 && rsi <= 72) score += 8; if (macd >= -0.05) score += 5; }
  if (isSell(side)) { if (price <= vwap) score += 10; if (rsi >= 28 && rsi <= 65) score += 8; if (macd <= 0.05) score += 5; }
  if (['BUY', 'SELL'].includes(aiAction) && !['WEAK', 'UNCONFIRMED'].includes(aiVerdict) && aiConfidence >= 60) score += 8;
  else if (['PASS'].includes(aiAction) && aiConfidence >= 60) score += 5;
  else if (['MONITOR', 'HOLD', 'PASS'].includes(aiAction) || ['WEAK', 'UNCONFIRMED'].includes(aiVerdict)) score -= 6;
  if (alignedDirection(side, optionsRegime)) score += 7;
  if (alignedDirection(side, darkPool)) score += 7;
  if (oppositeDirection(side, optionsRegime)) score -= 14;
  if (oppositeDirection(side, darkPool)) score -= 14;
  return clamp(score);
}

function scoreSwing(j) {
  const side = j.side || j.action || j.signal || j.execution_side || j.execution;
  const bias = num(j.bias_score ?? j.bias ?? j.bias_pct, 0);
  const price = num(j.price ?? j.entry_price ?? j.close, 0);
  const sma50 = num(j.sma50, price);
  const ema200 = num(j.ema200, price);
  const weeklyRegime = upper(j.weekly_regime ?? j.market_regime ?? j.regime);
  const crossAsset = upper(j.cross_asset ?? j.cross_asset_regime);
  const sector = upper(j.sector_regime ?? j.sector_status ?? j.cross_asset);
  const vixRegime = upper(j.vix_regime ?? j.vix_status ?? j.market_status);
  const backtestTrades = num(j.strat_total_trades ?? j.backtest_sample ?? j.backtest_trades, 0);
  const pf = num(j.strat_profit_factor ?? j.backtest_pf ?? j.profit_factor, 0);
  const wr = num(j.strat_win_rate ?? j.win_rate, 0);
  let score = 0;
  if (bias >= 70) score += 16; else if (bias >= 60) score += 12; else if (bias >= 55) score += 8;
  if (backtestTrades >= 150) score += 15; else if (backtestTrades >= 100) score += 10; else if (backtestTrades >= 30) score += 4;
  if (pf >= 1.5) score += 15; else if (pf >= 1.35) score += 10; else if (pf >= 1.2) score += 5;
  if (wr >= 55) score += 8; else if (wr >= 50) score += 5;
  if (isBuy(side)) { if (price >= sma50) score += 10; else score -= 8; if (price >= ema200) score += 10; else score -= 8; }
  if (isSell(side)) { if (price <= sma50) score += 10; else score -= 8; if (price <= ema200) score += 10; else score -= 8; }
  if (weeklyRegime.includes('TREND') || weeklyRegime.includes('PASS')) score += 8;
  if (crossAsset.includes('STRONG') || crossAsset.includes('ALIGNED')) score += 8;
  else if (crossAsset.includes('MIXED') || crossAsset.includes('CAUTIOUS') || crossAsset.includes('LAGGING') || crossAsset.includes('DIVERGENT') || crossAsset.includes('DECOUPLED')) score -= 10;
  if (sector.includes('LAGGING')) score -= 8;
  if (vixRegime.includes('HIGH') || vixRegime.includes('CAUTIOUS') || vixRegime.includes('VIX 24')) score -= 5;
  return clamp(score);
}

function scoreLongTerm(j) {
  const side = j.side || j.action || j.signal || j.execution_side || j.execution;
  const price = num(j.price ?? j.entry_price ?? j.close, 0);
  const sma50 = num(j.sma50, price);
  const ema200 = num(j.ema200, price);
  const qualityScore = num(j.quality_score ?? j.long_term_quality_score, 50);
  const valueScore = num(j.value_score ?? j.long_term_value_score, 50);
  const earningsTrend = upper(j.earnings_trend ?? j.fundamental_trend);
  const debtRisk = upper(j.debt_risk ?? j.balance_sheet_risk);
  const institutional = upper(j.institutional_flow ?? j.dark_pool_regime ?? j.dark_pool);
  let score = 0;
  if (qualityScore >= 75) score += 22; else if (qualityScore >= 60) score += 16; else if (qualityScore >= 50) score += 8;
  if (valueScore >= 70) score += 18; else if (valueScore >= 55) score += 12; else if (valueScore >= 45) score += 5;
  if (isBuy(side)) { if (price >= ema200) score += 14; else if (price >= sma50) score += 8; else score -= 8; }
  if (isSell(side)) { if (price <= ema200) score += 14; else if (price <= sma50) score += 8; else score -= 8; }
  if (earningsTrend.includes('POSITIVE') || earningsTrend.includes('IMPROVING')) score += 12;
  if (earningsTrend.includes('NEGATIVE') || earningsTrend.includes('DETERIORATING')) score -= 12;
  if (debtRisk.includes('HIGH') || debtRisk.includes('ELEVATED')) score -= 10;
  if (alignedDirection(side, institutional)) score += 10;
  if (oppositeDirection(side, institutional)) score -= 12;
  return clamp(score);
}

function selectTargetProfile(j) {
  const strategy = upper(j.strategy ?? j.signal_type ?? j.module ?? j.timeframe_profile ?? j.alert_type);
  if (strategy.includes('SCALP')) return 'SCALP';
  if (strategy.includes('SWING')) return 'SWING';
  if (strategy.includes('LONG') || strategy.includes('VALUE') || strategy.includes('QUALITY')) return 'LONG_TERM';
  return 'SCALP';
}
function weightedConfluence(profile, scalp, swing, longTerm) {
  // QTP_MTF_SCALP_REWEIGHT_v6.2_20260521: long_term tier has no weight for SCALP
  // because its inputs (quality_score, value_score, earnings_trend, etc.) are
  // fundamentals that intraday signals never carry. See audit history pre-2026-05-21:
  // 0/5969 signals ever cleared mtf_confluence_score >= 65 because long_term
  // defaulted to ~27 and consumed 15% weight.
  if (profile === 'SCALP') return clamp((scalp * 0.65) + (swing * 0.35) + (longTerm * 0.00));
  if (profile === 'SWING') return clamp((scalp * 0.20) + (swing * 0.55) + (longTerm * 0.25));
  return clamp((scalp * 0.10) + (swing * 0.30) + (longTerm * 0.60));
}

return inputItems.map((item) => {
  const j = { ...(item.json || {}) };
  const side = j.side || j.action || j.signal || j.execution_side || j.execution;
  const profile = selectTargetProfile(j);
  const scalpScore = scoreScalp(j);
  const swingScore = scoreSwing(j);
  const longTermScore = scoreLongTerm(j);
  const confluenceScore = weightedConfluence(profile, scalpScore, swingScore, longTermScore);
  const reasons = [];
  if (!['BUY', 'SELL', 'LONG', 'SHORT', 'BULLISH', 'BEARISH'].includes(upper(side))) reasons.push('NO_ACTIONABLE_SIDE');
  if (num(j.strat_total_trades ?? j.backtest_sample ?? j.backtest_trades, 0) < 30) reasons.push('BACKTEST_SAMPLE_TOO_SMALL');
  if (num(j.strat_profit_factor ?? j.backtest_pf ?? j.profit_factor, 0) < 1.20) reasons.push('BACKTEST_PF_TOO_LOW');
  if (upper(j.ai_action ?? j.grok_action).includes('SELL') && isBuy(side)) reasons.push('HARD_AI_OPPOSITE_ACTION');
  if (upper(j.ai_action ?? j.grok_action).includes('BUY') && isSell(side)) reasons.push('HARD_AI_OPPOSITE_ACTION');
  // QTP_MTF_REJECTBACKTEST_RETUNE_v7_20260702 (PO-auth): profile-aware gates from a 28-day reject-backtest.
  // SCALP shorts behave as mean-reversion: the scalp tier is the ONLY correctly-signed predictor of forward
  // profit (IC +0.075); swing & long_term are flat/wrong-signed intraday, so they no longer gate SCALP.
  // Gate = scalp>=50 plus existing hard-veto reasons. Backtest: 145/199 pass, +0.103%/day mean short return,
  // 58% win, rejected set net-negative. Prior gate passed only 25/199. SWING/LONG stay trend-following
  // (retuned) but the scanner emits only SCALP today, so those branches are shadow (no live traffic).
  const SCALP_MIN = 50;
  const profilePass =
    profile === 'SCALP' ? (scalpScore >= SCALP_MIN) :
    profile === 'SWING' ? (confluenceScore >= 55 && swingScore >= 55 && scalpScore >= 45) :
    (confluenceScore >= 55 && longTermScore >= 55 && swingScore >= 50);
  const pass = reasons.length === 0 && profilePass;
  j.mtf_confluence_engine_v = 'QTP_MTF_CONFLUENCE_v6.2_20260521';
  j.timeframe_profile = profile;
  // QTP_MTF_STRUCTURAL_FIELDS_v5.9.1_20260520
  // Required downstream/audit structure: explicit horizon plus structured per-tier object.
  j.timeframe_horizon =
    profile === 'SCALP'
      ? 'SCALP_5_15M'
      : profile === 'SWING'
        ? 'SWING_DAILY_WEEKLY'
        : 'LONG_TERM_MONTHLY_QUARTERLY';
  j.mtf_tiers = {
    scalp: {
      horizon: '5_15M',
      score: Math.round(scalpScore * 100) / 100,
      decision: scalpScore >= 60 ? 'PASS' : 'BLOCK'
    },
    swing: {
      horizon: 'DAILY_WEEKLY',
      score: Math.round(swingScore * 100) / 100,
      decision: swingScore >= 60 ? 'PASS' : 'BLOCK'
    },
    long_term: {
      horizon: 'MONTHLY_QUARTERLY',
      score: Math.round(longTermScore * 100) / 100,
      decision: longTermScore >= 60 ? 'PASS' : 'BLOCK'
    },
    target_profile: profile,
    threshold: 65
  };
  j.scalp_confluence_score = Math.round(scalpScore * 100) / 100;
  j.swing_confluence_score = Math.round(swingScore * 100) / 100;
  j.long_term_confluence_score = Math.round(longTermScore * 100) / 100;
  j.mtf_confluence_score = Math.round(confluenceScore * 100) / 100;
  j.mtf_confluence_threshold = 65;
  j.mtf_confluence_decision = pass ? 'MTF_CONFLUENCE_PASS' : 'MTF_CONFLUENCE_BLOCK';
  j.mtf_confluence_block_reasons = reasons;
  j.mtf_confluence_summary = `${profile} | scalp=${j.scalp_confluence_score} swing=${j.swing_confluence_score} long_term=${j.long_term_confluence_score} final=${j.mtf_confluence_score} decision=${j.mtf_confluence_decision}`;
  return { json: j };
});