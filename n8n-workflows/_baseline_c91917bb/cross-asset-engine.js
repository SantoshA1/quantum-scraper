// ============================================================
// CROSS-ASSET CORRELATION ENGINE v2 — Phase 2.4 (Fix #14 / SE-C4)
// Quantum Engineering Trading Pipeline
//
// v2: Detect upstream Dark Pool Engine failure and fail-closed
//     instead of computing bogus cross-asset metrics on
//     ticker='UNKNOWN'/price=0. Preserves passthrough so
//     downstream (Grok, Format Telegram, APT) still receive
//     ticker, price, execution, etc.
//
// PURPOSE: Enriches every signal with macro context from
// 12 cross-asset instruments. Computes correlation scores,
// risk-on/risk-off regime, sector rotation signals, and
// VIX term structure (contango/backwardation proxy).
//
// DATA SOURCES:
// 1. TradingView webhook (already in payload): SPY, QQQ, VIX, XLY
// 2. Polygon grouped-daily (new): XLK, XLF, XLE, XLV, TLT, UUP,
//    HYG, GLD, IWM, DIA, VIXY, VIXM, IEF
// 3. Polygon grouped-daily (previous day): same tickers for % change
//
// INSERT: After Dark Pool Engine, before Perplexity AI
// READS FROM: $('Dark Pool Engine') for signal data
//             $('Fetch Cross-Asset Today') for today's bars
//             $('Fetch Cross-Asset Previous') for yesterday's bars
// ============================================================

const prev = $('Dark Pool Engine').first().json;
const ticker = prev.ticker || 'UNKNOWN';
const price = prev.price || 0;

// === SE-C4 FAIL-CLOSED: detect upstream Dark Pool Engine failure ===
// If Dark Pool Engine signalled UNAVAILABLE/ERROR or we're missing core
// signal fields, do NOT compute cross-asset metrics on fabricated defaults.
// Preserve passthrough and flag ca_regime='UNAVAILABLE' so downstream knows.
const _dpRegimeUp = (prev.dp_regime || '').toString().toUpperCase();
const _dpUnavailable = _dpRegimeUp === 'UNAVAILABLE' || _dpRegimeUp === 'ERROR' || !!prev.dp_error;
const _tickerMissing = !prev.ticker || prev.ticker === 'UNKNOWN';
if (_dpUnavailable || _tickerMissing) {
  const _reason = _dpUnavailable
    ? ('upstream_dark_pool_' + _dpRegimeUp.toLowerCase() + (prev.dp_error ? ': ' + prev.dp_error : ''))
    : 'missing_ticker_from_upstream';
  console.error('[CA-ENGINE] FAIL-CLOSED: ' + _reason + ' ticker=' + (prev.ticker || 'UNKNOWN'));
  return [{
    json: {
      ...prev,
      ca_error: _reason,
      ca_composite_score: 50,
      ca_regime: 'UNAVAILABLE',
      ca_regime_confidence: 'NONE',
      ca_regime_detail: 'Cross-Asset Engine skipped: ' + _reason,
      ca_signal_alignment: 'NEUTRAL',
      ca_alignment_adjust: 0,
      ca_summary: 'CROSS-ASSET: UNAVAILABLE (' + _reason + ')'
    }
  }];
}

try {
// ---- BEGIN MAIN LOGIC (wrapped in try-catch to preserve passthrough on error) ----

// ============================================================
// PARSE GROUPED DAILY DATA — extract target ETFs from bulk response
// ============================================================
let todayData = {};
let prevData = {};

try {
  const todayRaw = $('Fetch Cross-Asset Today').first().json;
  const todayResults = todayRaw.results || [];
  const TARGETS = ['SPY','QQQ','XLK','XLY','XLF','XLE','XLV','TLT','UUP','HYG','GLD','IWM','DIA','VIXY','VIXM','IEF'];
  for (const bar of todayResults) {
    if (TARGETS.includes(bar.T)) {
      todayData[bar.T] = { o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v, vw: bar.vw };
    }
  }
} catch(e) { /* grouped endpoint may fail — use webhook data as fallback */ }

try {
  const prevRaw = $('Fetch Cross-Asset Previous').first().json;
  const prevResults = prevRaw.results || [];
  const TARGETS = ['SPY','QQQ','XLK','XLY','XLF','XLE','XLV','TLT','UUP','HYG','GLD','IWM','DIA','VIXY','VIXM','IEF'];
  for (const bar of prevResults) {
    if (TARGETS.includes(bar.T)) {
      prevData[bar.T] = { o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v, vw: bar.vw };
    }
  }
} catch(e) { /* use available data */ }

// ============================================================
// HELPER: Calculate % change between two days
// ============================================================
function pctChange(sym) {
  const today = todayData[sym];
  const yesterday = prevData[sym];
  if (!today || !yesterday || !yesterday.c) return null;
  return ((today.c - yesterday.c) / yesterday.c) * 100;
}

function todayClose(sym) {
  return todayData[sym] ? todayData[sym].c : null;
}

function todayOC(sym) {
  // Open-to-close change (intraday direction)
  const d = todayData[sym];
  if (!d || !d.o) return null;
  return ((d.c - d.o) / d.o) * 100;
}

// ============================================================
// METRIC 1: BROAD MARKET HEALTH (SPY + QQQ + DIA + IWM)
// Weight: 25% of correlation score
// ============================================================
const spyChg = pctChange('SPY');
const qqqChg = pctChange('QQQ');
const diaChg = pctChange('DIA');
const iwmChg = pctChange('IWM');

// Use webhook data as primary for SPY/QQQ if Polygon unavailable
const spyFinal = spyChg !== null ? spyChg : parseFloat(prev.spy_change_pct) || 0;
const qqqFinal = qqqChg !== null ? qqqChg : parseFloat(prev.qqq_change_pct) || 0;
const diaFinal = diaChg !== null ? diaChg : 0;
const iwmFinal = iwmChg !== null ? iwmChg : 0;

// Breadth score: average of 4 major indices
const breadthAvg = (spyFinal + qqqFinal + diaFinal + iwmFinal) / 4;
const allUp = spyFinal > 0 && qqqFinal > 0 && diaFinal > 0 && iwmFinal > 0;
const allDown = spyFinal < 0 && qqqFinal < 0 && diaFinal < 0 && iwmFinal < 0;

let broadHealth = 'MIXED';
let broadScore = 50; // neutral
if (allUp && breadthAvg > 0.5) { broadHealth = 'RISK_ON'; broadScore = 80; }
else if (allUp) { broadHealth = 'MILDLY_BULLISH'; broadScore = 65; }
else if (allDown && breadthAvg < -0.5) { broadHealth = 'RISK_OFF'; broadScore = 20; }
else if (allDown) { broadHealth = 'MILDLY_BEARISH'; broadScore = 35; }
else if (Math.abs(spyFinal - iwmFinal) > 1.5) { broadHealth = 'ROTATION'; broadScore = 45; }

// ============================================================
// METRIC 2: VIX TERM STRUCTURE (VIXY vs VIXM proxy)
// Weight: 15%
// Contango (VIXY losing relative to VIXM) = normal/complacent
// Backwardation (VIXY outperforming VIXM) = panic/hedging
// ============================================================
const vixyChg = pctChange('VIXY');
const vixmChg = pctChange('VIXM');
const vixFromWebhook = prev.vix || 0;

let vixTermStructure = 'UNKNOWN';
let vixTermScore = 50;
let vixTermDetail = '';

if (vixyChg !== null && vixmChg !== null) {
  const spread = vixyChg - vixmChg; // positive = backwardation (panic)
  if (spread > 3) {
    vixTermStructure = 'STEEP_BACKWARDATION';
    vixTermScore = 10;
    vixTermDetail = 'Extreme fear — front-month vol surging vs mid-term';
  } else if (spread > 1) {
    vixTermStructure = 'BACKWARDATION';
    vixTermScore = 25;
    vixTermDetail = 'Hedging demand elevated — institutional protection buying';
  } else if (spread > -1) {
    vixTermStructure = 'FLAT';
    vixTermScore = 50;
    vixTermDetail = 'Neutral term structure — no clear vol signal';
  } else if (spread > -3) {
    vixTermStructure = 'CONTANGO';
    vixTermScore = 70;
    vixTermDetail = 'Normal conditions — vol sellers in control';
  } else {
    vixTermStructure = 'STEEP_CONTANGO';
    vixTermScore = 85;
    vixTermDetail = 'Complacent — low near-term fear, potential for vol spike';
  }
} else if (vixFromWebhook > 0) {
  // Fallback: use absolute VIX level
  if (vixFromWebhook > 35) { vixTermStructure = 'EXTREME'; vixTermScore = 5; vixTermDetail = 'Crisis-level VIX'; }
  else if (vixFromWebhook > 25) { vixTermStructure = 'ELEVATED'; vixTermScore = 25; vixTermDetail = 'High VIX — defensive posture'; }
  else if (vixFromWebhook > 18) { vixTermStructure = 'NORMAL'; vixTermScore = 55; vixTermDetail = 'VIX in normal range'; }
  else { vixTermStructure = 'LOW'; vixTermScore = 80; vixTermDetail = 'Low VIX — favorable for risk-on'; }
}

// ============================================================
// METRIC 3: DOLLAR STRENGTH (UUP proxy for DXY)
// Weight: 10%
// Strong dollar = headwind for multinationals (TSLA, AAPL)
// Weak dollar = tailwind for exporters, commodities, EM
// ============================================================
const uupChg = pctChange('UUP');
let dollarTrend = 'NEUTRAL';
let dollarScore = 50;
let dollarImpact = '';

if (uupChg !== null) {
  if (uupChg > 0.5) { dollarTrend = 'STRENGTHENING'; dollarScore = 35; dollarImpact = 'Headwind for exporters/multinationals'; }
  else if (uupChg > 0.15) { dollarTrend = 'MILDLY_STRONG'; dollarScore = 45; dollarImpact = 'Slight headwind'; }
  else if (uupChg < -0.5) { dollarTrend = 'WEAKENING'; dollarScore = 70; dollarImpact = 'Tailwind for exporters/commodities'; }
  else if (uupChg < -0.15) { dollarTrend = 'MILDLY_WEAK'; dollarScore = 60; dollarImpact = 'Slight tailwind'; }
  else { dollarTrend = 'STABLE'; dollarScore = 55; dollarImpact = 'No directional pressure'; }
}

// ============================================================
// METRIC 4: INTEREST RATE SENSITIVITY (TLT + IEF)
// Weight: 10%
// TLT down = yields up = headwind for growth/tech
// TLT up = yields down = tailwind for growth/tech
// ============================================================
const tltChg = pctChange('TLT');
const iefChg = pctChange('IEF');

let yieldTrend = 'NEUTRAL';
let yieldScore = 50;
let yieldImpact = '';

const bondAvg = (tltChg !== null && iefChg !== null) ? (tltChg + iefChg) / 2
  : tltChg !== null ? tltChg : iefChg;

if (bondAvg !== null) {
  if (bondAvg < -1.0) { yieldTrend = 'YIELDS_SURGING'; yieldScore = 20; yieldImpact = 'Strong headwind for growth/tech stocks'; }
  else if (bondAvg < -0.3) { yieldTrend = 'YIELDS_RISING'; yieldScore = 35; yieldImpact = 'Headwind for rate-sensitive stocks'; }
  else if (bondAvg > 1.0) { yieldTrend = 'YIELDS_PLUNGING'; yieldScore = 80; yieldImpact = 'Strong flight-to-safety — bullish for long-duration'; }
  else if (bondAvg > 0.3) { yieldTrend = 'YIELDS_FALLING'; yieldScore = 65; yieldImpact = 'Tailwind for growth/tech stocks'; }
  else { yieldTrend = 'STABLE'; yieldScore = 55; yieldImpact = 'No rate pressure'; }
}

// ============================================================
// METRIC 5: SECTOR ROTATION (XLK, XLY, XLF, XLE, XLV vs SPY)
// Weight: 15%
// Maps ticker to its sector ETF for relative strength
// ============================================================
const sectorMap = {
  'TSLA': 'XLY', 'AMZN': 'XLY', 'MCD': 'XLY', 'NKE': 'XLY', 'HD': 'XLY',
  'NVDA': 'XLK', 'AMD': 'XLK', 'MSFT': 'XLK', 'AAPL': 'XLK', 'CRWV': 'XLK', 'NBIS': 'XLK', 'GOOG': 'XLK', 'META': 'XLK',
  'JPM': 'XLF', 'GS': 'XLF', 'BAC': 'XLF', 'C': 'XLF',
  'XOM': 'XLE', 'CVX': 'XLE', 'SLB': 'XLE',
  'GILD': 'XLV', 'JNJ': 'XLV', 'PFE': 'XLV', 'UNH': 'XLV', 'LLY': 'XLV',
};

const tickerSector = sectorMap[ticker] || 'XLK'; // default to tech
const sectorChg = pctChange(tickerSector);
const sectorVsSPY = (sectorChg !== null && spyFinal !== null) ? sectorChg - spyFinal : null;

let sectorRotation = 'NEUTRAL';
let sectorScore = 50;
let sectorDetail = '';

if (sectorVsSPY !== null) {
  if (sectorVsSPY > 1.0) { sectorRotation = 'SECTOR_LEADING'; sectorScore = 80; sectorDetail = tickerSector + ' outperforming SPY by ' + sectorVsSPY.toFixed(1) + '%'; }
  else if (sectorVsSPY > 0.3) { sectorRotation = 'SECTOR_STRONG'; sectorScore = 65; sectorDetail = tickerSector + ' slightly leading SPY'; }
  else if (sectorVsSPY < -1.0) { sectorRotation = 'SECTOR_LAGGING'; sectorScore = 20; sectorDetail = tickerSector + ' underperforming SPY by ' + Math.abs(sectorVsSPY).toFixed(1) + '%'; }
  else if (sectorVsSPY < -0.3) { sectorRotation = 'SECTOR_WEAK'; sectorScore = 35; sectorDetail = tickerSector + ' slightly lagging SPY'; }
  else { sectorRotation = 'INLINE'; sectorScore = 55; sectorDetail = tickerSector + ' tracking SPY'; }
}

// ============================================================
// METRIC 6: CREDIT / RISK APPETITE (HYG high-yield vs GLD gold)
// Weight: 10%
// HYG up + GLD down = risk-on (credit appetite)
// HYG down + GLD up = risk-off (flight to safety)
// ============================================================
const hygChg = pctChange('HYG');
const gldChg = pctChange('GLD');

let riskAppetite = 'NEUTRAL';
let riskScore = 50;
let riskDetail = '';

if (hygChg !== null && gldChg !== null) {
  const riskSpread = hygChg - gldChg; // positive = risk-on
  if (riskSpread > 1.0) { riskAppetite = 'STRONG_RISK_ON'; riskScore = 85; riskDetail = 'Credit rallying, gold falling — aggressive risk appetite'; }
  else if (riskSpread > 0.3) { riskAppetite = 'MILD_RISK_ON'; riskScore = 65; riskDetail = 'Credit outperforming gold — constructive'; }
  else if (riskSpread < -1.0) { riskAppetite = 'STRONG_RISK_OFF'; riskScore = 15; riskDetail = 'Gold rallying, credit falling — flight to safety'; }
  else if (riskSpread < -0.3) { riskAppetite = 'MILD_RISK_OFF'; riskScore = 35; riskDetail = 'Gold outperforming credit — defensive posture'; }
  else { riskAppetite = 'BALANCED'; riskScore = 55; riskDetail = 'No clear risk appetite signal'; }
} else if (gldChg !== null) {
  if (gldChg > 1.0) { riskAppetite = 'GOLD_BID'; riskScore = 30; riskDetail = 'Gold surging — safe-haven demand'; }
  else if (gldChg < -1.0) { riskAppetite = 'GOLD_SOLD'; riskScore = 70; riskDetail = 'Gold sold off — risk appetite returning'; }
}

// ============================================================
// METRIC 7: SMALL CAP vs LARGE CAP DIVERGENCE (IWM vs SPY)
// Weight: 5%
// IWM leading = broad risk-on, domestic focus
// IWM lagging = narrow leadership, fragile rally
// ============================================================
const iwmVsSpy = (typeof iwmFinal === 'number' && typeof spyFinal === 'number') ? iwmFinal - spyFinal : null;
let capRotation = 'NEUTRAL';
let capScore = 50;

if (iwmVsSpy !== null) {
  if (iwmVsSpy > 1.0) { capRotation = 'SMALLS_LEADING'; capScore = 75; }
  else if (iwmVsSpy > 0.3) { capRotation = 'SMALLS_STRONG'; capScore = 60; }
  else if (iwmVsSpy < -1.0) { capRotation = 'SMALLS_LAGGING'; capScore = 25; }
  else if (iwmVsSpy < -0.3) { capRotation = 'SMALLS_WEAK'; capScore = 40; }
}

// ============================================================
// METRIC 8: NVDA AS AI BELLWETHER (for AI/tech tickers)
// Weight: 10% (only for CRWV, NBIS, AMD, and AI-adjacent)
// ============================================================
const aiTickers = ['CRWV', 'NBIS', 'AMD', 'NVDA', 'MSFT', 'GOOG', 'META', 'SMCI', 'ARM', 'AVGO'];
const isAITicker = aiTickers.includes(ticker);
const nvdaChg = pctChange('NVDA') || null; // NVDA may not be in grouped (only if traded)
let aiBellwether = 'N/A';
let aiScore = 50;

// For NVDA itself, skip self-comparison
if (isAITicker && ticker !== 'NVDA') {
  // Try to get NVDA from today's data (may not be in the grouped ETF response)
  // Fall back to XLK (tech sector) as proxy
  const proxy = nvdaChg !== null ? nvdaChg : (pctChange('XLK') || 0);
  if (proxy > 1.5) { aiBellwether = 'AI_BULL'; aiScore = 80; }
  else if (proxy > 0.3) { aiBellwether = 'AI_CONSTRUCTIVE'; aiScore = 65; }
  else if (proxy < -1.5) { aiBellwether = 'AI_BEAR'; aiScore = 20; }
  else if (proxy < -0.3) { aiBellwether = 'AI_CAUTIOUS'; aiScore = 35; }
  else { aiBellwether = 'AI_NEUTRAL'; aiScore = 50; }
}

// ============================================================
// COMPOSITE CROSS-ASSET SCORE (0-100)
// Weighted average of all metrics
// ============================================================
const weights = {
  broad: 0.25,
  vixTerm: 0.15,
  dollar: 0.10,
  yields: 0.10,
  sector: 0.15,
  risk: 0.10,
  caps: 0.05,
  ai: isAITicker && ticker !== 'NVDA' ? 0.10 : 0
};

// Normalize weights (AI weight only for AI tickers)
const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0);
const normFactor = 1 / totalWeight;

const compositeScore = Math.round(
  (broadScore * weights.broad +
   vixTermScore * weights.vixTerm +
   dollarScore * weights.dollar +
   yieldScore * weights.yields +
   sectorScore * weights.sector +
   riskScore * weights.risk +
   capScore * weights.caps +
   aiScore * weights.ai) * normFactor
);

// ============================================================
// CROSS-ASSET REGIME CLASSIFICATION
// ============================================================
let caRegime = 'NEUTRAL';
let caRegimeConfidence = 'LOW';
let caRegimeDetail = '';

if (compositeScore >= 75) {
  caRegime = 'STRONG_RISK_ON';
  caRegimeConfidence = 'HIGH';
  caRegimeDetail = 'Broad market, sector, credit, and vol all supportive';
} else if (compositeScore >= 60) {
  caRegime = 'MILD_RISK_ON';
  caRegimeConfidence = 'MODERATE';
  caRegimeDetail = 'Generally constructive macro backdrop';
} else if (compositeScore <= 25) {
  caRegime = 'CRISIS';
  caRegimeConfidence = 'HIGH';
  caRegimeDetail = 'Multiple macro headwinds — capital preservation mode';
} else if (compositeScore <= 40) {
  caRegime = 'RISK_OFF';
  caRegimeConfidence = 'MODERATE';
  caRegimeDetail = 'Defensive conditions — reduce exposure';
} else {
  caRegime = 'MIXED';
  caRegimeConfidence = 'LOW';
  caRegimeDetail = 'Conflicting cross-asset signals — selective positioning';
}

// ============================================================
// SIGNAL ALIGNMENT CHECK
// Does cross-asset environment support the signal direction?
// ============================================================
const signalDir = (prev.signal || '').toUpperCase();
const isBullish = signalDir === 'BULLISH' || (prev.execution || '').toUpperCase() === 'BUY' || (prev.execution || '').toUpperCase() === 'SCALE IN';
const isBearish = signalDir === 'BEARISH' || (prev.execution || '').toUpperCase() === 'SELL';

let signalAlignment = 'NEUTRAL';
let alignmentAdjust = 0;

if (isBullish) {
  if (compositeScore >= 65) { signalAlignment = 'CONFIRMED'; alignmentAdjust = +1; }
  else if (compositeScore >= 50) { signalAlignment = 'CAUTIOUS'; alignmentAdjust = 0; }
  else if (compositeScore >= 35) { signalAlignment = 'DIVERGENT'; alignmentAdjust = -1; }
  else { signalAlignment = 'HOSTILE'; alignmentAdjust = -2; }
} else if (isBearish) {
  // For bearish signals, low composite = confirming
  if (compositeScore <= 35) { signalAlignment = 'CONFIRMED'; alignmentAdjust = +1; }
  else if (compositeScore <= 50) { signalAlignment = 'CAUTIOUS'; alignmentAdjust = 0; }
  else if (compositeScore <= 65) { signalAlignment = 'DIVERGENT'; alignmentAdjust = -1; }
  else { signalAlignment = 'HOSTILE'; alignmentAdjust = -2; }
}

// ============================================================
// BUILD SUMMARY STRING (for Telegram display)
// ============================================================
const NL = String.fromCharCode(10);
let summary = 'CROSS-ASSET: ' + caRegime + ' (Score: ' + compositeScore + '/100, ' + caRegimeConfidence + ')' + NL;
summary += 'Market: ' + broadHealth + ' (SPY ' + (typeof spyFinal === 'number' ? spyFinal.toFixed(1) : spyFinal) + '%, QQQ ' + (typeof qqqFinal === 'number' ? qqqFinal.toFixed(1) : qqqFinal) + '%, IWM ' + (iwmFinal ? iwmFinal.toFixed(1) : '?') + '%, DIA ' + (diaFinal ? diaFinal.toFixed(1) : '?') + '%)' + NL;
summary += 'VIX Term: ' + vixTermStructure + (vixFromWebhook ? ' (VIX ' + vixFromWebhook + ')' : '') + NL;
summary += 'Dollar: ' + dollarTrend + (uupChg !== null ? ' (UUP ' + uupChg.toFixed(2) + '%)' : '') + NL;
summary += 'Yields: ' + yieldTrend + (tltChg !== null ? ' (TLT ' + tltChg.toFixed(2) + '%)' : '') + NL;
summary += 'Sector: ' + sectorRotation + ' (' + sectorDetail + ')' + NL;
summary += 'Credit/Gold: ' + riskAppetite + NL;
if (isAITicker && ticker !== 'NVDA') {
  summary += 'AI Bellwether: ' + aiBellwether + NL;
}
summary += 'Signal Align: ' + signalAlignment + ' (adjust ' + (alignmentAdjust >= 0 ? '+' : '') + alignmentAdjust + ')';

// ============================================================
// OUTPUT — pass everything downstream
// ============================================================
return [{
  json: {
    ...prev,

    // Cross-Asset Correlation Engine outputs
    ca_composite_score: compositeScore,
    ca_regime: caRegime,
    ca_regime_confidence: caRegimeConfidence,
    ca_regime_detail: caRegimeDetail,
    ca_signal_alignment: signalAlignment,
    ca_alignment_adjust: alignmentAdjust,
    ca_summary: summary,

    // Individual metrics (for Perplexity analysis)
    ca_broad_health: broadHealth,
    ca_broad_score: broadScore,
    ca_spy_chg: spyFinal ? +spyFinal.toFixed(2) : 0,
    ca_qqq_chg: qqqFinal ? +qqqFinal.toFixed(2) : 0,
    ca_iwm_chg: iwmFinal ? +iwmFinal.toFixed(2) : 0,
    ca_dia_chg: diaFinal ? +diaFinal.toFixed(2) : 0,
    ca_vix_term: vixTermStructure,
    ca_vix_term_detail: vixTermDetail,
    ca_dollar_trend: dollarTrend,
    ca_dollar_impact: dollarImpact,
    ca_yield_trend: yieldTrend,
    ca_yield_impact: yieldImpact,
    ca_sector_rotation: sectorRotation,
    ca_sector_detail: sectorDetail,
    ca_sector_etf: tickerSector,
    ca_risk_appetite: riskAppetite,
    ca_risk_detail: riskDetail,
    ca_cap_rotation: capRotation,
    ca_ai_bellwether: isAITicker ? aiBellwether : 'N/A',

    // Raw changes (for Perplexity to reference)
    ca_tlt_chg: tltChg !== null ? +tltChg.toFixed(2) : null,
    ca_uup_chg: uupChg !== null ? +uupChg.toFixed(2) : null,
    ca_hyg_chg: hygChg !== null ? +hygChg.toFixed(2) : null,
    ca_gld_chg: gldChg !== null ? +gldChg.toFixed(2) : null,
    ca_xlk_chg: pctChange('XLK') !== null ? +pctChange('XLK').toFixed(2) : null,
    ca_xly_chg: pctChange('XLY') !== null ? +pctChange('XLY').toFixed(2) : null,
    ca_xlf_chg: pctChange('XLF') !== null ? +pctChange('XLF').toFixed(2) : null,
    ca_xle_chg: pctChange('XLE') !== null ? +pctChange('XLE').toFixed(2) : null,
    ca_xlv_chg: pctChange('XLV') !== null ? +pctChange('XLV').toFixed(2) : null,
  }
}];

} catch (engineError) {
  // FALLBACK: If Cross-Asset Engine crashes, preserve ALL passthrough fields
  // so Format Telegram Message still gets ticker, price, timeframe etc.
  return [{
    json: {
      ...prev,
      ca_error: engineError.message || 'Cross-Asset Engine failed',
      ca_composite_score: 50,
      ca_regime: 'UNAVAILABLE',
      ca_regime_confidence: 'LOW',
      ca_signal_alignment: 'NEUTRAL',
      ca_alignment_adjust: 0,
      ca_summary: 'CROSS-ASSET: UNAVAILABLE (engine error: ' + (engineError.message || 'unknown') + ')',
    }
  }];
}
