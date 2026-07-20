// ============================================================
// OPTIONS FLOW ENGINE v1 — Institutional-Grade GEX + Flow
// Phase 2.2 of Quantum Engineering Trading Pipeline
//
// PHILOSOPHY (Citadel/RenTech-inspired):
// Dealers must delta-hedge. +GEX = mean-reversion. -GEX = breakout.
// This node fetches the options chain AND computes 10 metrics.
//
// COMPUTES: GEX, GEX Flip, P/C Ratio, Max Pain, Dealer Walls,
//   Unusual Activity, 0DTE Skew, IV Skew, Gamma Wall, Options Regime
//
// INSERT: After Backtest Engine, before Perplexity AI Analysis
// ============================================================

// Signal data from Backtest Engine (upstream), options from HTTP input
const beItem = $('Backtest Engine').first();
if (!beItem || !beItem.json) {
  return [{ json: { opt_error: 'No input from Backtest Engine' } }];
}
const prev = beItem.json;
const ticker = prev.ticker || 'UNKNOWN';
const price = parseFloat(prev.price) || 0;

try {
const now = Date.now();

// API key is in the 'Fetch Options Chain' HTTP Request node

// ============================================================
// CONFIG
// ============================================================
// Strike range configured in HTTP node
// Max contracts configured in HTTP node
const UNUSUAL_VOL_OI_RATIO = 3.0;
const UNUSUAL_MIN_VOLUME = 500;
const UNUSUAL_MIN_PREMIUM = 50000;
const DEALER_WALL_OI_MULTIPLIER = 3.0;
const PC_EXTREME_HIGH = 1.2;
const PC_EXTREME_LOW = 0.6;

// ============================================================
// SKIP if no valid price or API key not set
// ============================================================
if (price <= 0) {
  return [{
    json: {
      ...prev,
      options_regime: 'NO_PRICE',
      options_regime_confidence: 'NONE',
      options_summary: 'No valid price for options analysis',
      opt_regime: 'UNAVAILABLE',
      opt_regime_confidence: 'NONE',
      opt_regime_detail: ''
    }
  }];
}

// Options chain data comes from "Fetch Options Chain" HTTP Request node
const todayObj = new Date();
const todayStr = todayObj.toISOString().split('T')[0];

// Get options chain from HTTP Request node (direct input)
let allContracts = [];
try {
  const optData = $('Fetch Options Chain').first().json;
  allContracts = optData.results || [];
} catch (err) {
  allContracts = [];
}

if (allContracts.length === 0) {
  return [{
    json: {
      ...prev,
      options_regime: 'NO_DATA',
      options_regime_confidence: 'NONE',
      options_summary: 'No options contracts returned for ' + ticker,
      opt_regime: 'NO_DATA',
      opt_regime_confidence: 'NONE',
      opt_regime_detail: ''
    }
  }];
}

// ============================================================
// PARSE CONTRACTS
// ============================================================
const calls = [];
const puts = [];
const expirations = new Set();
let spotPrice = price;

for (const c of allContracts) {
  const d = c.details || {};
  const g = c.greeks || {};
  const day = c.day || {};

  if (c.underlying_asset && c.underlying_asset.price > 0) {
    spotPrice = c.underlying_asset.price;
  }

  const ct = {
    strike: d.strike_price || 0,
    expiration: d.expiration_date || '',
    type: d.contract_type || '',
    oi: c.open_interest || 0,
    volume: day.volume || 0,
    delta: g.delta || 0,
    gamma: g.gamma || 0,
    iv: c.implied_volatility || 0,
    dayClose: day.close || 0
  };

  expirations.add(ct.expiration);
  if (ct.type === 'call') calls.push(ct);
  else if (ct.type === 'put') puts.push(ct);
}

const sortedExps = Array.from(expirations).sort();
const nearestExp = sortedExps[0] || todayStr;
const is0DTE = nearestExp === todayStr;

// ============================================================
// 1. NET GEX — Dealer gamma exposure
// ============================================================
let callGEX = 0;
let putGEX = 0;
const gexByStrike = {};

for (const c of calls) {
  const gex = c.gamma * c.oi * 100 * spotPrice;
  callGEX += gex;
  if (!gexByStrike[c.strike]) gexByStrike[c.strike] = 0;
  gexByStrike[c.strike] += gex;
}
for (const p of puts) {
  const gex = p.gamma * p.oi * 100 * spotPrice;
  putGEX += gex;
  if (!gexByStrike[p.strike]) gexByStrike[p.strike] = 0;
  gexByStrike[p.strike] -= gex;
}

const netGEX = callGEX - putGEX;

function fmtDollar(v) {
  const a = Math.abs(v);
  const s = v >= 0 ? '+' : '-';
  if (a >= 1e9) return s + '$' + (a / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return s + '$' + (a / 1e6).toFixed(1) + 'M';
  if (a >= 1e3) return s + '$' + (a / 1e3).toFixed(0) + 'K';
  return s + '$' + a.toFixed(0);
}

// ============================================================
// 2. GEX FLIP LEVEL
// ============================================================
let gexFlip = 0;
const strikes = Object.keys(gexByStrike).map(Number).sort((a, b) => a - b);

for (let i = 0; i < strikes.length - 1; i++) {
  const g1 = gexByStrike[strikes[i]];
  const g2 = gexByStrike[strikes[i + 1]];
  if ((g1 > 0 && g2 < 0) || (g1 < 0 && g2 > 0)) {
    gexFlip = strikes[i] + (strikes[i + 1] - strikes[i]) * Math.abs(g1) / (Math.abs(g1) + Math.abs(g2));
    break;
  }
}

// ============================================================
// 3. PUT/CALL RATIO
// ============================================================
let tCallOI = 0, tPutOI = 0, tCallVol = 0, tPutVol = 0;
for (const c of calls) { tCallOI += c.oi; tCallVol += c.volume; }
for (const p of puts) { tPutOI += p.oi; tPutVol += p.volume; }

const pcOI = tCallOI > 0 ? tPutOI / tCallOI : 0;
const pcVol = tCallVol > 0 ? tPutVol / tCallVol : 0;

let pcSent = 'NEUTRAL';
if (pcOI > PC_EXTREME_HIGH) pcSent = 'EXTREME_FEAR';
else if (pcOI > 1.0) pcSent = 'BEARISH';
else if (pcOI < PC_EXTREME_LOW) pcSent = 'EXTREME_GREED';
else if (pcOI < 0.8) pcSent = 'BULLISH';

// ============================================================
// 4. MAX PAIN
// ============================================================
let maxPainStrike = 0;
let minPain = Infinity;

for (const sk of strikes) {
  let tp = 0;
  for (const c of calls) { if (sk > c.strike) tp += (sk - c.strike) * c.oi * 100; }
  for (const p of puts) { if (sk < p.strike) tp += (p.strike - sk) * p.oi * 100; }
  if (tp < minPain) { minPain = tp; maxPainStrike = sk; }
}

const mpDist = spotPrice > 0 ? ((maxPainStrike - spotPrice) / spotPrice * 100).toFixed(2) : '0';

// ============================================================
// 5. DEALER WALLS
// ============================================================
const allOIs = [...calls, ...puts].map(c => c.oi).filter(v => v > 0);
const avgOI = allOIs.length > 0 ? allOIs.reduce((a, b) => a + b, 0) / allOIs.length : 0;
const wallThr = avgOI * DEALER_WALL_OI_MULTIPLIER;

const cWalls = calls.filter(c => c.oi > wallThr && c.oi > 500).sort((a, b) => b.oi - a.oi).slice(0, 3);
const pWalls = puts.filter(p => p.oi > wallThr && p.oi > 500).sort((a, b) => b.oi - a.oi).slice(0, 3);

// ============================================================
// 6. UNUSUAL ACTIVITY
// ============================================================
const unusual = [];
for (const c of [...calls, ...puts]) {
  if (c.volume < UNUSUAL_MIN_VOLUME) continue;
  const ratio = c.oi > 0 ? c.volume / c.oi : c.volume;
  const prem = c.volume * c.dayClose * 100;
  if (ratio >= UNUSUAL_VOL_OI_RATIO && prem >= UNUSUAL_MIN_PREMIUM) {
    unusual.push({
      strike: c.strike, type: c.type.toUpperCase(), volume: c.volume,
      oi: c.oi, ratio: ratio.toFixed(1), prem: Math.round(prem), exp: c.expiration
    });
  }
}
unusual.sort((a, b) => b.prem - a.prem);
const topUnu = unusual.slice(0, 5);

// ============================================================
// 7. 0DTE SKEW
// ============================================================
let odteC = 0, odteP = 0;
if (is0DTE) {
  for (const c of calls) { if (c.expiration === todayStr) odteC += c.volume; }
  for (const p of puts) { if (p.expiration === todayStr) odteP += p.volume; }
}
const odteT = odteC + odteP;

// ============================================================
// 8. IV SKEW
// ============================================================
const atmR = spotPrice * 0.02;
const atmCalls = calls.filter(c => Math.abs(c.strike - spotPrice) <= atmR && c.iv > 0 && c.expiration === nearestExp);
const atmPuts = puts.filter(p => Math.abs(p.strike - spotPrice) <= atmR && p.iv > 0 && p.expiration === nearestExp);

const avgCIV = atmCalls.length > 0 ? atmCalls.reduce((s, c) => s + c.iv, 0) / atmCalls.length : 0;
const avgPIV = atmPuts.length > 0 ? atmPuts.reduce((s, p) => s + p.iv, 0) / atmPuts.length : 0;
const ivSkew = avgPIV - avgCIV;

let ivSig = 'NEUTRAL';
if (ivSkew > 0.05) ivSig = 'FEAR_PREMIUM';
else if (ivSkew > 0.02) ivSig = 'MILD_FEAR';
else if (ivSkew < -0.02) ivSig = 'CALL_PREMIUM';

// ============================================================
// 9. GAMMA WALL
// ============================================================
let gWallStrike = 0, gWallVal = 0;
for (const c of [...calls, ...puts]) {
  const gxoi = Math.abs(c.gamma) * c.oi;
  if (gxoi > gWallVal) { gWallVal = gxoi; gWallStrike = c.strike; }
}

// ============================================================
// 10. OPTIONS REGIME — Institutional decision tree
// ============================================================
let optRegime = 'NEUTRAL';
let regConf = 'LOW';
let regDetail = '';

if (netGEX > 0) {
  if (pcSent === 'EXTREME_FEAR') {
    optRegime = 'CONTRARIAN_LONG'; regConf = 'HIGH';
    regDetail = '+GEX + extreme fear = dealers buy dips aggressively. Mean-reversion long.';
  } else if (pcSent === 'EXTREME_GREED') {
    optRegime = 'CONTRARIAN_SHORT'; regConf = 'MODERATE';
    regDetail = '+GEX + extreme greed = dealers cap upside. Expect fade.';
  } else {
    optRegime = 'MEAN_REVERSION'; regConf = 'MODERATE';
    regDetail = '+GEX: dealers sell rallies, buy dips. Range-bound. Fade extremes.';
  }
} else {
  if (pcSent === 'EXTREME_FEAR' || pcSent === 'BEARISH') {
    optRegime = 'GAMMA_SQUEEZE_DOWN'; regConf = 'HIGH';
    regDetail = '-GEX + bearish flow = downside amplification. Danger zone for longs.';
  } else if (pcSent === 'EXTREME_GREED' || pcSent === 'BULLISH') {
    optRegime = 'GAMMA_SQUEEZE_UP'; regConf = 'HIGH';
    regDetail = '-GEX + bullish flow = upside amplification. Momentum favored.';
  } else {
    optRegime = 'BREAKOUT'; regConf = 'MODERATE';
    regDetail = '-GEX: dealers amplify direction. Breakout imminent.';
  }
}

// IV skew overlay
if (ivSig === 'FEAR_PREMIUM' && optRegime.includes('UP')) {
  regDetail += ' CAUTION: IV skew shows put premium despite bullish flow.';
}
if (ivSig === 'CALL_PREMIUM' && optRegime.includes('DOWN')) {
  regDetail += ' CAUTION: IV skew shows call premium despite bearish flow.';
}

// Unusual activity overlay
const unuC = topUnu.filter(u => u.type === 'CALL').length;
const unuP = topUnu.filter(u => u.type === 'PUT').length;
const unuBias = unuC > unuP ? 'CALL_HEAVY' : unuP > unuC ? 'PUT_HEAVY' : 'BALANCED';

if (topUnu.length >= 3) {
  if (unuBias === 'CALL_HEAVY' && (optRegime.includes('UP') || optRegime === 'CONTRARIAN_LONG')) {
    regConf = 'VERY_HIGH';
    regDetail += ' Institutional sweeps confirm bullish conviction.';
  } else if (unuBias === 'PUT_HEAVY' && (optRegime.includes('DOWN') || optRegime === 'CONTRARIAN_SHORT')) {
    regConf = 'VERY_HIGH';
    regDetail += ' Institutional sweeps confirm bearish conviction.';
  }
}

// ============================================================
// BUILD SUMMARY TEXT for Telegram
// ============================================================
const NL = String.fromCharCode(10);
let sum = '';
sum += 'GEX: ' + fmtDollar(netGEX) + ' (' + (netGEX >= 0 ? 'Positive: dealers stabilize' : 'Negative: dealers amplify') + ')';
sum += NL + 'GEX Flip: $' + (gexFlip > 0 ? gexFlip.toFixed(2) : 'N/A') + ' | Gamma Wall: $' + gWallStrike;
sum += NL + 'P/C Ratio: ' + pcOI.toFixed(2) + ' OI / ' + pcVol.toFixed(2) + ' Vol | ' + pcSent;
sum += NL + 'Max Pain: $' + maxPainStrike + ' (' + mpDist + '% from spot)';
sum += NL + 'IV Skew: ' + (ivSkew * 100).toFixed(1) + '% | ' + ivSig;

if (is0DTE && odteT > 0) {
  const odteCPct = (odteC / odteT * 100).toFixed(0);
  const odtePPct = (odteP / odteT * 100).toFixed(0);
  sum += NL + '0DTE: ' + odteCPct + '% calls / ' + odtePPct + '% puts (' + odteT.toLocaleString() + ' contracts)';
}

if (cWalls.length > 0) sum += NL + 'Call Walls: ' + cWalls.map(w => '$' + w.strike + '(' + w.oi.toLocaleString() + ')').join(', ');
if (pWalls.length > 0) sum += NL + 'Put Walls: ' + pWalls.map(w => '$' + w.strike + '(' + w.oi.toLocaleString() + ')').join(', ');

if (topUnu.length > 0) {
  sum += NL + 'Unusual: ' + topUnu.length + ' sweeps (' + unuBias + ')';
  for (const u of topUnu.slice(0, 3)) {
    sum += NL + '  ' + u.type + ' $' + u.strike + ' exp ' + u.exp + ' | Vol ' + u.volume.toLocaleString() + ' vs OI ' + u.oi.toLocaleString() + ' (' + u.ratio + 'x) | ~$' + (u.prem / 1000).toFixed(0) + 'K';
  }
} else {
  sum += NL + 'Unusual: None detected';
}

sum += NL + 'REGIME: ' + optRegime + ' (' + regConf + ')';
sum += NL + regDetail;

// ============================================================
// OUTPUT
// ============================================================
return [{
  json: {
    ...prev,

    // Flat fields for Perplexity prompt expressions
    opt_net_gex: fmtDollar(netGEX),
    opt_gex_sign: netGEX >= 0 ? 'POSITIVE' : 'NEGATIVE',
    opt_gex_flip: gexFlip > 0 ? '$' + gexFlip.toFixed(2) : 'N/A',
    opt_gamma_wall: '$' + gWallStrike,
    opt_pc_ratio_oi: pcOI.toFixed(2),
    opt_pc_ratio_vol: pcVol.toFixed(2),
    opt_pc_sentiment: pcSent,
    opt_max_pain: '$' + maxPainStrike,
    opt_max_pain_dist: mpDist + '%',
    opt_iv_skew: (ivSkew * 100).toFixed(1) + '%',
    opt_iv_skew_signal: ivSig,
    opt_call_walls: cWalls.map(w => '$' + w.strike + '(' + w.oi.toLocaleString() + ')').join(', ') || 'None',
    opt_put_walls: pWalls.map(w => '$' + w.strike + '(' + w.oi.toLocaleString() + ')').join(', ') || 'None',
    opt_unusual_count: topUnu.length,
    opt_unusual_bias: unuBias,
    opt_unusual_detail: topUnu.slice(0, 3).map(u =>
      u.type + ' $' + u.strike + ' ' + u.exp + ' vol=' + u.volume + ' ~$' + (u.prem / 1000).toFixed(0) + 'K'
    ).join('; ') || 'None',
    opt_0dte: is0DTE && odteT > 0
      ? (odteC / odteT * 100).toFixed(0) + '% calls / ' + (odteP / odteT * 100).toFixed(0) + '% puts'
      : 'N/A',
    opt_regime: optRegime,
    opt_regime_confidence: regConf,
    opt_regime_detail: regDetail,
    opt_contracts: allContracts.length,
    opt_nearest_exp: nearestExp,

    // Full summary for Telegram format node
    options_summary: sum,
    options_regime: optRegime,
    options_regime_confidence: regConf
  }
}];

} catch (engineError) {
  return [{
    json: {
      ...prev,
      opt_regime: 'ERROR',
      opt_regime_confidence: 'NONE',
      options_summary: 'Options engine error: ' + (engineError.message || 'unknown'),
      opt_error: engineError.message || 'Options Flow Engine failed',
    }
  }];
}