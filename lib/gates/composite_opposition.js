'use strict';
/**
 * QTP gate logic — COMPOSITE-OPPOSITION block (entry-quality composite, part 1/2).
 *
 * A2 extraction. Pulled verbatim from the live "QTP Bias Filter" node at baseline
 * versionId c91917bb (n8n-workflows/_baseline_c91917bb/qtp-bias-filter.js, ~L220-256).
 * Pure + dependency-free (vendored-inline; n8n Cloud restricts require).
 *
 * WHAT IT IS: a "second opinion" veto. Independently of the primary bias score,
 * count how many independent data sources OPPOSE the intended entry direction
 * (weak/monitor AI, options regime, dark-pool flow, trend, cross-asset, market
 * tape). If two or more oppose AND we're paper-gated on a real entry, block.
 *
 * PINS (do not regress):
 *  - Threshold is >= 2 oppositions (one dissent is tolerated; two is a veto).
 *  - Block only fires when isPaperGated === true AND isEntry === true.
 *  - aiMissing is DEAD (always false) since FIX1 20260621: a missing-AI field is a
 *    data gap, NOT opposition. Genuine weak/bearish AI still opposes via aiWeakMonitor.
 *  - FIX1 shadow (compositeOppositionShadow) is OBSERVABILITY ONLY — it must never
 *    feed the live block. It records what the count WOULD be if a missing-AI warn
 *    were (wrongly) counted, so we can prove the fix changed nothing live.
 */

// Order fixed to match the live reason-string order (attribution stability).
const OPPOSITION_KEYS = Object.freeze([
  'aiWeakMonitor', // weak/monitor/low-confidence AI against the entry
  'aiMissing',     // DEAD since FIX1 20260621 — always false in live
  'options',       // options regime contrarian to the entry
  'darkPool',      // dark-pool / smart-money flow against the entry
  'trend',         // price/SMA/EMA trend opposes the entry
  'crossAsset',    // cross-asset alignment mixed/lagging/divergent
  'market',        // market tape cautious/risk-off/high-VIX
]);

// Count the active opposition sources, in canonical order, and decide the block.
// flags: { aiWeakMonitor, aiMissing, options, darkPool, trend, crossAsset, market } (booleans)
// ctx:   { isPaperGated, isEntry } (booleans)
function compositeOpposition(flags, ctx) {
  flags = flags || {};
  ctx = ctx || {};
  const active = OPPOSITION_KEYS.filter((k) => flags[k] === true);
  const count = active.length;
  const block = ctx.isPaperGated === true && ctx.isEntry === true && count >= 2;
  return { count, active, block };
}

// FIX1 shadow (log-only). aiMissingWarn = isEntry && !aiFieldsPresent. The shadow
// count strips a would-be missing-AI warn from the live count; the shadow block is
// what a naive "missing = opposition" reading would have produced. NEVER live.
function compositeOppositionShadow(liveCount, ctx) {
  ctx = ctx || {};
  const warn = ctx.isEntry === true && ctx.aiFieldsPresent === false;
  const shadowCount = liveCount - (warn ? 1 : 0);
  const shadowBlock = ctx.isPaperGated === true && ctx.isEntry === true && shadowCount >= 2;
  return { aiMissingWarn: warn, shadowCount, shadowBlock };
}

module.exports = { OPPOSITION_KEYS, compositeOpposition, compositeOppositionShadow };
