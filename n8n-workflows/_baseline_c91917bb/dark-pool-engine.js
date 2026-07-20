// ============================================================
// DARK POOL & INSTITUTIONAL FLOW ENGINE v2 (Fix #14 / SE-C4)
// Phase 2.3 of Quantum Engineering Trading Pipeline
//
// v2: Fail-closed with full passthrough when upstream Options Flow Engine
//     is unavailable. Previously returned a stripped {dp_error:...} object
//     that caused Cross-Asset Engine to compute bogus metrics on
//     ticker='UNKNOWN'/price=0. Now preserves ticker/price/signal fields
//     via Webhook Trigger fallback and flags dp_regime='UNAVAILABLE'.
//
// PHILOSOPHY (Citadel/RenTech-inspired):
// Retail volume does not move markets. Institutional positioning
// reveals where the real money is committed. This engine combines
// multiple free data sources to approximate dark pool intelligence:
//
// DATA SOURCES:
//   A) FINRA Short Volume (daily) — short ratio as pressure proxy
//   B) Polygon 10-day OHLCV+VWAP — accumulation/distribution patterns
//   C) TradingView signal data — volume, VWAP, relative volume
//   D) Options Flow Engine data (upstream) — OI/volume patterns
//
// INSERT: After Options Flow Engine, before Perplexity AI Analysis
// ============================================================

// ============================================================
// DATA INPUTS
// ============================================================

// Signal + Options data from upstream (Options Flow Engine)
const ofeItem = $('Options Flow Engine').first();

// === SE-C4 FAIL-CLOSED: preserve passthrough when OFE is unavailable ===
// Previous behavior: return {dp_error: '...'} with NO passthrough, which
// caused Cross-Asset Engine to run on ticker='UNKNOWN', price=0.
// New behavior: pull passthrough from Webhook Trigger (original signal)
// so ticker/price/signal fields survive for downstream consumers.
if (!ofeItem || !ofeItem.json) {
  let _passthrough = {};
  try {
    const wh = $('Webhook Trigger').first();
    if (wh && wh.json) {
      _passthrough = wh.json.body || wh.json || {};
    }
  } catch (_whErr) { /* passthrough best-effort */ }
  console.error('[DP-ENGINE] FAIL-CLOSED: no input from Options Flow Engine; passthrough ticker=' + (_passthrough.ticker || 'UNKNOWN'));
  return [{
    json: {
      ..._passthrough,
      dp_error: 'No input from Options Flow Engine',
      dp_regime: 'UNAVAILABLE',
      dp_regime_confidence: 'NONE',
      dp_institutional_score: 0,
      dp_summary: 'Dark Pool Engine unavailable: upstream Options Flow Engine returned no input'
    }
  }];
}
const prev = ofeItem.json;
const ticker = prev.ticker || 'UNKNOWN';

try {

const price = parseFloat(prev.price) || 0;
const signalVol = parseFloat(prev.volume) || 0;
const signalAvgVol = parseFloat(prev.avg_volume) || 0;
const signalVWAP = parseFloat(prev.vwap) || 0;
const relativeVolume = parseFloat(prev.relative_volume) || 0;
const dailyHigh = parseFloat(prev.daily_high) || 0;
const dailyLow = parseFloat(prev.daily_low) || 0;

// FINRA Short Volume data (from Fetch FINRA Short Volume HTTP node)
let finraData = null;
try {
  const finraItems = $('Fetch FINRA Short Volume').all();
  if (finraItems && finraItems.length > 0) {
    const finraRaw = finraItems[0].json;
    // FINRA returns pipe-delimited text as response body
    // HTTP Request node may put it in 'data' or directly in json
    if (typeof finraRaw === 'string') {
      finraData = finraRaw;
    } else if (finraRaw && finraRaw.data) {
      finraData = finraRaw.data;
    } else if (finraRaw && finraRaw.body) {
      finraData = finraRaw.body;  
    } else {
      finraData = finraRaw;
    }
  }
} catch (e) {
  finraData = null;
}

// Polygon 10-day price history (from Fetch Price History HTTP node)
let priceHistory = [];
try {
  const polyItems = $('Fetch Price History').all();
  if (polyItems && polyItems.length > 0) {
    const polyData = polyItems[0].json;
    priceHistory = polyData.results || [];
  }
} catch (e) {
  priceHistory = [];
}

const NL = String.fromCharCode(10);

// ============================================================
// SKIP if no valid price
// ============================================================
if (price <= 0) {
  return [{
    json: {
      ...prev,
      dp_regime: 'NO_PRICE',
      dp_regime_confidence: 'NONE',
      dp_summary: 'No valid price for dark pool analysis',
      dp_short_ratio: 0,
      dp_institutional_score: 0
    }
  }];
}

// ============================================================
// 1. SHORT VOLUME RATIO + TREND
// ============================================================
// FINRA short volume as % of total = institutional pressure proxy
// >45% = heavy shorting (bearish pressure or hedging)
// <35% = light shorting (bullish, institutions not hedging)
// Normal range: 35-45%

let shortRatio = 0;
let shortVolume = 0;
let totalVolume = 0;
let shortSignal = 'UNAVAILABLE';
let shortTrend = 'FLAT';

if (finraData) {
  // Parse FINRA pipe-delimited data
  // Format: Date|Symbol|ShortVolume|ShortExemptVolume|TotalVolume|Market
  let lines = '';
  if (typeof finraData === 'string') {
    lines = finraData;
  } else if (finraData.data && typeof finraData.data === 'string') {
    lines = finraData.data;
  } else if (finraData.body && typeof finraData.body === 'string') {
    lines = finraData.body;
  }

  if (lines) {
    const rows = lines.split(String.fromCharCode(10));
    for (const row of rows) {
      const parts = row.replace(String.fromCharCode(13), '').split('|');
      if (parts.length >= 5 && parts[1] === ticker) {
        shortVolume = parseFloat(parts[2]) || 0;
        totalVolume = parseFloat(parts[4]) || 0;
        if (totalVolume > 0) {
          shortRatio = (shortVolume / totalVolume) * 100;
        }
        break;
      }
    }
  }

  if (shortRatio > 0) {
    if (shortRatio > 50) shortSignal = 'EXTREME_SHORT_PRESSURE';
    else if (shortRatio > 45) shortSignal = 'HIGH_SHORT_PRESSURE';
    else if (shortRatio > 40) shortSignal = 'ELEVATED_SHORTS';
    else if (shortRatio > 35) shortSignal = 'NORMAL';
    else if (shortRatio > 30) shortSignal = 'LOW_SHORTS_BULLISH';
    else shortSignal = 'VERY_LOW_SHORTS_BULLISH';
  }
}

// ============================================================
// 2. VWAP PROXIMITY SCORE
// ============================================================
// Institutional traders benchmark to VWAP
// Price near VWAP = institutional accumulation zone
// Price far above VWAP = retail FOMO (distribution risk)
// Price far below VWAP = capitulation (accumulation opportunity)

let vwapDist = 0;
let vwapSignal = 'UNAVAILABLE';

if (signalVWAP > 0 && price > 0) {
  vwapDist = ((price - signalVWAP) / signalVWAP) * 100;

  if (Math.abs(vwapDist) < 0.3) {
    vwapSignal = 'AT_VWAP';  // Institutional benchmark zone
  } else if (vwapDist > 1.5) {
    vwapSignal = 'EXTENDED_ABOVE';  // Retail FOMO, distribution risk
  } else if (vwapDist > 0.5) {
    vwapSignal = 'ABOVE_VWAP';  // Slight bullish, watching for distribution
  } else if (vwapDist < -1.5) {
    vwapSignal = 'EXTENDED_BELOW';  // Capitulation, accumulation opportunity
  } else if (vwapDist < -0.5) {
    vwapSignal = 'BELOW_VWAP';  // Slight bearish, watching for accumulation
  } else {
    vwapSignal = 'NEAR_VWAP';  // Close to institutional benchmark
  }
}

// ============================================================
// 3. ACCUMULATION / DISTRIBUTION PATTERN (Multi-Day)
// ============================================================
// Analyze 10-day price history for institutional patterns:
// - Accumulation: price flat/down but volume increasing (stealth buying)
// - Distribution: price up but volume declining (institutions selling into strength)
// - Climax: extreme volume + reversal = capitulation/euphoria

let adPattern = 'UNAVAILABLE';
let adScore = 0;  // -100 (heavy distribution) to +100 (heavy accumulation)
let avgHistVol = 0;
let volTrend = 'FLAT';
let priceTrend = 'FLAT';
let closingStrength = 0;  // Where price closes within daily range (0-1)

if (priceHistory.length >= 5) {
  const recent = priceHistory.slice(-5);  // Last 5 days
  const older = priceHistory.slice(0, Math.min(5, priceHistory.length - 5));

  // Volume trend
  const recentAvgVol = recent.reduce((s, r) => s + (r.v || 0), 0) / recent.length;
  const olderAvgVol = older.length > 0
    ? older.reduce((s, r) => s + (r.v || 0), 0) / older.length
    : recentAvgVol;
  avgHistVol = priceHistory.reduce((s, r) => s + (r.v || 0), 0) / priceHistory.length;

  const volChange = olderAvgVol > 0 ? ((recentAvgVol - olderAvgVol) / olderAvgVol) * 100 : 0;
  if (volChange > 20) volTrend = 'INCREASING';
  else if (volChange > 5) volTrend = 'SLIGHTLY_UP';
  else if (volChange < -20) volTrend = 'DECREASING';
  else if (volChange < -5) volTrend = 'SLIGHTLY_DOWN';

  // Price trend (close-to-close over 5 days)
  const firstClose = recent[0].c || 0;
  const lastClose = recent[recent.length - 1].c || 0;
  const priceChange = firstClose > 0 ? ((lastClose - firstClose) / firstClose) * 100 : 0;
  if (priceChange > 2) priceTrend = 'UP';
  else if (priceChange > 0.5) priceTrend = 'SLIGHT_UP';
  else if (priceChange < -2) priceTrend = 'DOWN';
  else if (priceChange < -0.5) priceTrend = 'SLIGHT_DOWN';

  // Closing strength: where today closes within its range
  // High closing strength + high volume = accumulation
  // Low closing strength + high volume = distribution
  const todayBar = recent[recent.length - 1];
  if (todayBar && todayBar.h > todayBar.l) {
    closingStrength = (todayBar.c - todayBar.l) / (todayBar.h - todayBar.l);
  }

  // VWAP deviation trend (are closes converging or diverging from VWAP?)
  let vwapDeviations = recent.filter(r => r.vw > 0).map(r => ((r.c - r.vw) / r.vw) * 100);
  let avgVwapDev = vwapDeviations.length > 0
    ? vwapDeviations.reduce((s, v) => s + v, 0) / vwapDeviations.length
    : 0;

  // Composite accumulation/distribution score
  // Accumulation signals: volume up + price flat/down + high closing strength + close near VWAP
  // Distribution signals: volume down + price up + low closing strength + close far from VWAP

  adScore = 0;

  // Volume increasing while price down = stealth accumulation (+30)
  if (volTrend === 'INCREASING' && (priceTrend === 'DOWN' || priceTrend === 'SLIGHT_DOWN')) {
    adScore += 30;
  }
  // Volume decreasing while price up = distribution (-30)
  else if ((volTrend === 'DECREASING' || volTrend === 'SLIGHTLY_DOWN') && (priceTrend === 'UP' || priceTrend === 'SLIGHT_UP')) {
    adScore -= 30;
  }
  // Volume increasing + price up = confirmed rally (+15)
  else if (volTrend === 'INCREASING' && (priceTrend === 'UP' || priceTrend === 'SLIGHT_UP')) {
    adScore += 15;
  }
  // Volume decreasing + price down = selling exhaustion (+10)
  else if ((volTrend === 'DECREASING' || volTrend === 'SLIGHTLY_DOWN') && (priceTrend === 'DOWN' || priceTrend === 'SLIGHT_DOWN')) {
    adScore += 10;
  }

  // High closing strength = buyers in control (+20)
  if (closingStrength > 0.7) adScore += 20;
  else if (closingStrength < 0.3) adScore -= 20;

  // VWAP proximity = institutional activity (+15)
  if (Math.abs(avgVwapDev) < 0.5) adScore += 15;

  // Short ratio signal
  if (shortRatio > 0) {
    if (shortRatio > 45 && priceTrend !== 'DOWN') adScore -= 15;  // Heavy shorting during rally = distribution
    if (shortRatio < 35) adScore += 10;  // Low shorts = bullish institutional positioning
  }

  // Classify
  if (adScore >= 30) adPattern = 'HEAVY_ACCUMULATION';
  else if (adScore >= 15) adPattern = 'ACCUMULATION';
  else if (adScore >= 5) adPattern = 'SLIGHT_ACCUMULATION';
  else if (adScore <= -30) adPattern = 'HEAVY_DISTRIBUTION';
  else if (adScore <= -15) adPattern = 'DISTRIBUTION';
  else if (adScore <= -5) adPattern = 'SLIGHT_DISTRIBUTION';
  else adPattern = 'NEUTRAL';
}

// ============================================================
// 4. VOLUME PROFILE ANALYSIS
// ============================================================
// Relative volume detects unusual activity
// Volume climax at extremes = reversal signal

let volProfile = 'NORMAL';
let volRatio = 0;

if (signalVol > 0 && signalAvgVol > 0) {
  volRatio = signalVol / signalAvgVol;
} else if (signalVol > 0 && avgHistVol > 0) {
  volRatio = signalVol / avgHistVol;
} else if (relativeVolume > 0) {
  volRatio = relativeVolume;
}

if (volRatio > 3.0) volProfile = 'CLIMAX';        // Extreme volume = potential reversal
else if (volRatio > 2.0) volProfile = 'SURGE';      // Very high = institutional activity
else if (volRatio > 1.5) volProfile = 'ELEVATED';   // Above average = increased interest
else if (volRatio > 0.8) volProfile = 'NORMAL';      // Average range
else if (volRatio > 0) volProfile = 'LOW';          // Below average = quiet accumulation possible

// ============================================================
// 5. PRICE-VOLUME DIVERGENCE
// ============================================================
// Smart money often acts opposite to price:
// Price down + volume surge = capitulation buy opportunity
// Price up + volume dry up = retail-driven, potential trap

let pvDivergence = 'NONE';
if (priceHistory.length >= 3) {
  const last3 = priceHistory.slice(-3);
  const priceDir = last3[last3.length - 1].c > last3[0].c ? 'UP' : 'DOWN';
  const volDir = last3[last3.length - 1].v > last3[0].v ? 'UP' : 'DOWN';

  if (priceDir === 'DOWN' && volDir === 'UP') {
    pvDivergence = 'BULLISH_DIVERGENCE';  // Selling climax, smart money buying
  } else if (priceDir === 'UP' && volDir === 'DOWN') {
    pvDivergence = 'BEARISH_DIVERGENCE';  // Rally on declining volume, distribution
  } else if (priceDir === 'UP' && volDir === 'UP') {
    pvDivergence = 'CONFIRMED_RALLY';     // Volume confirms uptrend
  } else if (priceDir === 'DOWN' && volDir === 'DOWN') {
    pvDivergence = 'SELLING_EXHAUSTION';  // Declining volume on selloff = near bottom
  }
}

// ============================================================
// 6. INSTITUTIONAL MOMENTUM SCORE
// ============================================================
// Composite score: -100 (strong distribution) to +100 (strong accumulation)
// Combines all signals into a single directional bias

let instScore = 0;

// Short volume component (weight: 25%)
if (shortRatio > 0) {
  if (shortRatio > 50) instScore -= 25;
  else if (shortRatio > 45) instScore -= 15;
  else if (shortRatio > 40) instScore -= 5;
  else if (shortRatio < 30) instScore += 25;
  else if (shortRatio < 35) instScore += 15;
  else instScore += 5;  // Normal range, slight positive
}

// A/D pattern component (weight: 25%)
instScore += Math.round(adScore * 0.5);  // Scale adScore (max ~65) to ~25 range

// Volume profile component (weight: 15%)
if (volProfile === 'SURGE' || volProfile === 'CLIMAX') {
  // High volume — direction depends on closing strength
  instScore += closingStrength > 0.5 ? 15 : -15;
} else if (volProfile === 'LOW') {
  instScore -= 5;  // Quiet = slightly negative (no conviction)
}

// VWAP component (weight: 15%)
if (vwapSignal === 'AT_VWAP' || vwapSignal === 'NEAR_VWAP') {
  instScore += 10;  // Near VWAP = institutional zone
} else if (vwapSignal === 'EXTENDED_ABOVE') {
  instScore -= 10;  // Extended above = distribution risk
} else if (vwapSignal === 'EXTENDED_BELOW') {
  instScore += 10;  // Extended below = accumulation opportunity
}

// Price-volume divergence component (weight: 20%)
if (pvDivergence === 'BULLISH_DIVERGENCE') instScore += 20;
else if (pvDivergence === 'BEARISH_DIVERGENCE') instScore -= 20;
else if (pvDivergence === 'CONFIRMED_RALLY') instScore += 10;
else if (pvDivergence === 'SELLING_EXHAUSTION') instScore += 5;

// Clamp to -100..+100
instScore = Math.max(-100, Math.min(100, instScore));

// ============================================================
// 7. BLOCK TRADE PROXY
// ============================================================
// Without direct block trade data, use volume clustering analysis
// Large volume bars that are 2x+ average and close near VWAP = block activity

let blockProxy = 'NONE';
let blockCount = 0;
let blockBias = 'NEUTRAL';

if (priceHistory.length >= 5) {
  const histAvgVol = priceHistory.reduce((s, r) => s + (r.v || 0), 0) / priceHistory.length;
  
  for (const bar of priceHistory.slice(-5)) {
    if (bar.v > histAvgVol * 2 && bar.vw > 0) {
      const vwapProximity = Math.abs(bar.c - bar.vw) / bar.vw * 100;
      if (vwapProximity < 1.0) {
        blockCount++;
        // Close above VWAP = bullish block, below = bearish
        if (bar.c >= bar.vw) blockBias = 'BULLISH';
        else blockBias = 'BEARISH';
      }
    }
  }

  if (blockCount >= 3) blockProxy = 'HEAVY_BLOCK_ACTIVITY';
  else if (blockCount >= 2) blockProxy = 'MODERATE_BLOCKS';
  else if (blockCount >= 1) blockProxy = 'LIGHT_BLOCKS';
}

// ============================================================
// 8. DARK POOL REGIME — Institutional Decision Tree
// ============================================================
let dpRegime = 'NEUTRAL';
let dpConf = 'LOW';
let dpDetail = '';

// Decision tree combining all signals
if (instScore >= 40) {
  dpRegime = 'STRONG_ACCUMULATION';
  dpConf = 'HIGH';
  dpDetail = 'Multiple signals confirm institutional buying. Smart money is positioning long.';
} else if (instScore >= 20) {
  if (adPattern.includes('ACCUMULATION') && (shortSignal === 'LOW_SHORTS_BULLISH' || shortSignal === 'VERY_LOW_SHORTS_BULLISH')) {
    dpRegime = 'STEALTH_ACCUMULATION';
    dpConf = 'HIGH';
    dpDetail = 'Low short interest + accumulation pattern = institutions quietly building positions.';
  } else {
    dpRegime = 'MODERATE_ACCUMULATION';
    dpConf = 'MODERATE';
    dpDetail = 'Positive institutional flow indicators. Bias toward accumulation.';
  }
} else if (instScore <= -40) {
  dpRegime = 'STRONG_DISTRIBUTION';
  dpConf = 'HIGH';
  dpDetail = 'Multiple signals confirm institutional selling. Smart money is exiting or shorting.';
} else if (instScore <= -20) {
  if (adPattern.includes('DISTRIBUTION') && shortSignal.includes('SHORT_PRESSURE')) {
    dpRegime = 'ACTIVE_DISTRIBUTION';
    dpConf = 'HIGH';
    dpDetail = 'High short pressure + distribution pattern = institutions actively selling.';
  } else {
    dpRegime = 'MODERATE_DISTRIBUTION';
    dpConf = 'MODERATE';
    dpDetail = 'Negative institutional flow indicators. Bias toward distribution.';
  }
} else {
  // Mixed or neutral
  if (pvDivergence === 'BULLISH_DIVERGENCE') {
    dpRegime = 'CONTRARIAN_ACCUMULATION';
    dpConf = 'MODERATE';
    dpDetail = 'Price-volume divergence suggests smart money buying into weakness.';
  } else if (pvDivergence === 'BEARISH_DIVERGENCE') {
    dpRegime = 'STEALTH_DISTRIBUTION';
    dpConf = 'MODERATE';
    dpDetail = 'Price-volume divergence suggests smart money selling into strength.';
  } else {
    dpRegime = 'NEUTRAL';
    dpConf = 'LOW';
    dpDetail = 'No clear institutional directional bias detected.';
  }
}

// Cross-reference with options flow regime
const optRegime = prev.opt_regime || '';
if (optRegime === 'CONTRARIAN_LONG' && dpRegime.includes('ACCUMULATION')) {
  dpConf = 'VERY_HIGH';
  dpDetail += ' OPTIONS CONFIRM: Contrarian long + accumulation = strong institutional conviction.';
} else if (optRegime === 'GAMMA_SQUEEZE_DOWN' && dpRegime.includes('DISTRIBUTION')) {
  dpConf = 'VERY_HIGH';
  dpDetail += ' OPTIONS CONFIRM: Gamma squeeze down + distribution = cascading institutional exit.';
} else if (optRegime.includes('UP') && dpRegime.includes('DISTRIBUTION')) {
  dpDetail += ' CAUTION: Options bullish but institutional flow shows distribution. Watch for trap.';
} else if (optRegime.includes('DOWN') && dpRegime.includes('ACCUMULATION')) {
  dpDetail += ' CAUTION: Options bearish but institutional flow shows accumulation. Potential reversal.';
}

// Block trade overlay
if (blockProxy === 'HEAVY_BLOCK_ACTIVITY') {
  dpDetail += ' Block activity detected (' + blockCount + ' sessions with 2x+ volume at VWAP).';
  if (dpConf === 'MODERATE') dpConf = 'HIGH';
}

// ============================================================
// BUILD SUMMARY TEXT for Telegram
// ============================================================
let sum = '';
sum += 'Short Ratio: ' + (shortRatio > 0 ? shortRatio.toFixed(1) + '% | ' + shortSignal : 'Unavailable');
sum += NL + 'VWAP Proximity: ' + (vwapDist !== 0 ? vwapDist.toFixed(2) + '% | ' + vwapSignal : 'Unavailable');
sum += NL + 'A/D Pattern: ' + adPattern + ' (score: ' + adScore + ')';
sum += NL + 'Volume: ' + volProfile + (volRatio > 0 ? ' (' + (volRatio * 100).toFixed(0) + '% of avg)' : '');
sum += NL + 'P/V Divergence: ' + pvDivergence;
if (blockProxy !== 'NONE') {
  sum += NL + 'Block Proxy: ' + blockProxy + ' (' + blockCount + ' sessions, ' + blockBias + ')';
}
sum += NL + 'Inst. Score: ' + instScore + '/100';
sum += NL + 'REGIME: ' + dpRegime + ' (' + dpConf + ')';
sum += NL + dpDetail;

// ============================================================
// OUTPUT
// ============================================================
return [{
  json: {
    ...prev,

    // Flat fields for Perplexity prompt expressions
    dp_short_ratio: shortRatio > 0 ? shortRatio.toFixed(1) + '%' : 'N/A',
    dp_short_signal: shortSignal,
    dp_short_volume: shortVolume > 0 ? Math.round(shortVolume).toLocaleString() : 'N/A',
    dp_vwap_dist: vwapDist !== 0 ? vwapDist.toFixed(2) + '%' : 'N/A',
    dp_vwap_signal: vwapSignal,
    dp_ad_pattern: adPattern,
    dp_ad_score: adScore,
    dp_vol_profile: volProfile,
    dp_vol_ratio: volRatio > 0 ? (volRatio * 100).toFixed(0) + '%' : 'N/A',
    dp_pv_divergence: pvDivergence,
    dp_closing_strength: closingStrength > 0 ? (closingStrength * 100).toFixed(0) + '%' : 'N/A',
    dp_block_proxy: blockProxy,
    dp_block_count: blockCount,
    dp_block_bias: blockBias,
    dp_institutional_score: instScore,
    dp_regime: dpRegime,
    dp_regime_confidence: dpConf,
    dp_regime_detail: dpDetail,
    dp_price_trend: priceTrend,
    dp_vol_trend: volTrend,

    // Full summary for Telegram format node
    dp_summary: sum
  }
}];


} catch (engineError) {
  return [{
    json: {
      ...prev,
      dp_regime: 'ERROR',
      dp_regime_confidence: 'NONE',
      dp_summary: 'Dark pool engine error: ' + (engineError.message || 'unknown'),
      dp_error: engineError.message || 'Dark Pool Engine failed',
      dp_institutional_score: 0,
    }
  }];
}
