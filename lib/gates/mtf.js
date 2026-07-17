'use strict';
/**
 * QTP gate logic — MTF confluence decision + F1-B shadow.
 *
 * A2 extraction. Pulled verbatim from the live node "QTP Bias Filter" at baseline
 * versionId c91917bb (n8n-workflows/_baseline_c91917bb/qtp-bias-filter.js, ~L165-213).
 * Pure + dependency-free (vendored-inline; n8n Cloud restricts require).
 *
 * PINS (do not regress):
 *  - The PASS gate is the ENGINE verdict ALONE (finalMtfDecision === FINAL_MTF_CONFLUENCE_PASS).
 *  - G22: the redundant `mtfScore>=65 && aiMtfScore>=65` double-check was removed
 *    2026-05-29 and MUST stay gone. finalMtfPass must NOT depend on scores.
 *  - F1-B shadow: cohort active => only a sub-floor score (default 40) blocks
 *    (Guard rail); cohort off => the engine "would block" stands (byte-equivalent to
 *    pre-F1-B). Floor only fires for a real positive score (score>0).
 *  - Per-leg attribution thresholds: deterministic leg >= 65, AI leg >= 60.
 */

const MTF = Object.freeze({ DEFAULT_HARD_FLOOR: 40, DET_LEG_MIN: 65, AI_LEG_MIN: 60 });
const ENTRY = new Set(['BUY', 'SELL', 'LONG', 'SHORT', 'BULLISH', 'BEARISH']);

function isEntry(execution) { return ENTRY.has(String(execution || '').toUpperCase()); }

// Trade gate. PASS iff the MTF engine ran AND emitted FINAL_MTF_CONFLUENCE_PASS.
// G22: depends ONLY on the engine decision, never on mtfScore/aiMtfScore.
function finalMtfPass(mtfEngineSeen, finalMtfDecision) {
  return !!mtfEngineSeen &&
    String(finalMtfDecision || '').toUpperCase() === 'FINAL_MTF_CONFLUENCE_PASS';
}

// F1-B shadow block decision.
// p = { execution, mtfEngineSeen, finalMtfDecision, mtfScore, cohortActive, hardFloor }
function mtfConfluenceBlock(p) {
  const entry = isEntry(p.execution);
  const seen = !!p.mtfEngineSeen;
  const pass = finalMtfPass(seen, p.finalMtfDecision);
  const floor = Number.isFinite(Number(p.hardFloor)) ? Number(p.hardFloor) : MTF.DEFAULT_HARD_FLOOR;
  const score = Number(p.mtfScore);
  const floorBlock = entry && seen && Number.isFinite(score) && score > 0 && score < floor;
  const wouldBlock = entry && !pass;
  const shadowOn = Number(p.cohortActive || 0) === 1;
  return { block: shadowOn ? floorBlock : wouldBlock, wouldBlock, floorBlock, shadowOn, pass };
}

// Per-leg attribution (which leg vetoed). Text matched as-is (live upstream is upper-cased).
function detLegPass(mtfEngineSeen, detDecisionText, mtfScore) {
  const t = String(detDecisionText || '');
  const explicitPass = t.includes('PASS');
  const explicitBlock = t.includes('BLOCK') || t.includes('FAIL') || t.includes('REJECT');
  return !!mtfEngineSeen &&
    (explicitPass || (!explicitBlock && Number.isFinite(Number(mtfScore)) && Number(mtfScore) >= MTF.DET_LEG_MIN));
}
function aiLegPass(mtfEngineSeen, aiDecisionText, aiMtfScore) {
  const t = String(aiDecisionText || '');
  const explicitPass = t.includes('PASS');
  const explicitBlock = t.includes('BLOCK') || t.includes('FAIL') || t.includes('REJECT');
  return !!mtfEngineSeen &&
    (explicitPass || (!explicitBlock && Number.isFinite(Number(aiMtfScore)) && Number(aiMtfScore) >= MTF.AI_LEG_MIN));
}

module.exports = { MTF, isEntry, finalMtfPass, mtfConfluenceBlock, detLegPass, aiLegPass };
