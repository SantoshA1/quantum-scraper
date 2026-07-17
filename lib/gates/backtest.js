'use strict';
/**
 * QTP gate logic — BACKTEST_ENFORCEMENT + F2 PF shadow.
 *
 * A2 extraction. Pulled verbatim from the live "QTP Bias Filter" node at baseline
 * versionId c91917bb (n8n-workflows/_baseline_c91917bb/qtp-bias-filter.js, ~L49-289).
 * Pure + dependency-free (vendored-inline; n8n Cloud restricts require).
 *
 * PINS (do not regress):
 *  - Tier thresholds: strict 100/1.20, relaxed 40/1.05, highVol 30/0.95; highVol
 *    symbols {VFS, USO}. Selection: highVol > relaxed(pre-market included) > strict.
 *  - F2 shadow (Ruling 2 Q2-A): cohort ON => backtestValid ALWAYS true (PF blocks
 *    nothing); cohort OFF => enforce !pfWouldBlock (byte-equivalent to pre-F2).
 *  - FAIL-CLOSED verdict: missing PF OR sample => 'UNKNOWN' — NEVER an implicit pass.
 */

const BT = Object.freeze({
  strict:  { minTrades: 100, minPf: 1.20, action: 'STRICT', relaxed: false },
  relaxed: { minTrades: 40,  minPf: 1.05, action: 'RELAXED', relaxed: true },
  highVol: { minTrades: 30,  minPf: 0.95, action: 'HIGH_VOL_RELAXED', relaxed: true },
  highVolSymbols: new Set(['VFS', 'USO']),
});

function btBool(v) {
  return ['true', '1', 'yes', 'y', 'on'].includes(String(v == null ? '' : v).trim().toLowerCase());
}

function selectBacktestThresholds(j) {
  j = j || {};
  const ticker = String(j.ticker || j.symbol || '').trim().toUpperCase();
  const marketText = String(j.market_status || j._dq_market_status || j.session || j.session_status || '').toUpperCase();
  const isPreMarket = btBool(j.pre_market_mode) || btBool(j.preMarketMode) || marketText.includes('PRE') || marketText.includes('PREMARKET');
  const isRelaxed = btBool(j.relaxed_mode) || btBool(j.relaxedMode) || isPreMarket;
  const isHighVol = BT.highVolSymbols.has(ticker) || btBool(j.high_vol) || btBool(j.highVol) || btBool(j._high_vol);
  const t = isHighVol ? BT.highVol : (isRelaxed ? BT.relaxed : BT.strict);
  return { minTrades: t.minTrades, minPf: t.minPf, action: t.action, relaxed: t.relaxed, ticker, isPreMarket, isHighVol };
}

// !required => valid; else require sample>=minTrades AND pf>=minPf (both present).
function baseBacktestValid(backtestRequired, btSample, btPf, thresholds) {
  if (!backtestRequired) return true;
  return btSample != null && btSample >= thresholds.minTrades && btPf != null && btPf >= thresholds.minPf;
}

// PF "would block" if base is invalid OR any paired paper block is set.
function pfWouldBlockRaw(base, paperWeakBacktestBlock, paperCompositeOppositionBlock, mtfConfluenceBlock) {
  return !(base && !paperWeakBacktestBlock && !paperCompositeOppositionBlock && !mtfConfluenceBlock);
}

// FAIL-CLOSED: missing PF or sample => UNKNOWN, never an implicit pass.
function pfVerdict(btSample, btPf, wouldBlock) {
  if (btPf == null || btSample == null) return 'UNKNOWN';
  return wouldBlock ? 'WOULD_BLOCK' : 'PASS';
}

// F2 shadow: cohort on => PF blocks nothing; off => enforce.
function backtestValid(pfShadowOn, wouldBlock) {
  return pfShadowOn ? true : !wouldBlock;
}

module.exports = { BT, btBool, selectBacktestThresholds, baseBacktestValid, pfWouldBlockRaw, pfVerdict, backtestValid };
