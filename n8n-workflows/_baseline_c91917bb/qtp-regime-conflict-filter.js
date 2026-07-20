// ============================================================
// QTP_SCANNER_REGIME_CONFLICT_FILTER_v1_20260526
// Block signals where options/dark-pool regime opposes execution direction.
// Mode: LOG_ONLY (no blocks yet — observe for 2 hours, then promote to HARD_VETO).
// Inserted between Grok AI Analysis and VC Agent Gatekeeper.
// Constraint: stamp-only in LOG_ONLY; never drop items.
// ============================================================
// QTP_REGIME_FILTER_PROMOTE_HARD_VETO_v1_20260527: promoting after 2 days
// of LOG_ONLY observation confirmed 100% of flagged signals correctly identified
// as R3.2 conflicts. HARD_VETO blocks at filter, saves LLM tokens and audit noise.
const REGIME_FILTER_MODE   = 'HARD_VETO';
const REGIME_FILTER_MARKER = 'QTP_SCANNER_REGIME_CONFLICT_FILTER_v1_20260526';
// QTP_RCF_OBS_v1_20260706: observability only — record dropped items (console + _rcf_drop_log on survivors). NO pass/drop behavior change.
const RCF_OBS_MARKER = 'QTP_RCF_OBS_SHADOW_v2_20260706';
// QTP_RCF_SHADOW_V1_20260706: shadow-policy evaluation (log-only, zero behavior change):
// shadow_both_required_pass = would this dropped item PASS if HARD_VETO required CONTRA_BOTH
// (options AND dark-pool both opposed) instead of any single-leg conflict?
const RCF_SHADOW_POLICY = 'QTP_RCF_SHADOW_V1_20260706';
const rcfDrops = [];

function detectRegimeConflict(side, optionsRegime, darkPoolRegime) {
  const opt   = String(optionsRegime  || '').toUpperCase();
  const dp    = String(darkPoolRegime || '').toUpperCase();
  const sideU = String(side           || '').toUpperCase();

  // QTP_SCANNER_REGIME_CONFLICT_FILTER_v1_20260526: BUY conflicts with bearish regimes
  const buyOptConflict  = sideU === 'BUY'  && /CONTRARIAN_SHORT|GAMMA_SQUEEZE_DOWN|DISTRIBUTION/.test(opt);
  const buyDpConflict   = sideU === 'BUY'  && /CONTRARIAN_SHORT|DISTRIBUTION/.test(dp);
  // QTP_SCANNER_REGIME_CONFLICT_FILTER_v1_20260526: SELL conflicts with bullish regimes
  const sellOptConflict = sideU === 'SELL' && /CONTRARIAN_LONG|GAMMA_SQUEEZE_UP|ACCUMULATION/.test(opt);
  const sellDpConflict  = sideU === 'SELL' && /CONTRARIAN_LONG|ACCUMULATION/.test(dp);

  const optConflict = buyOptConflict  || sellOptConflict;
  const dpConflict  = buyDpConflict   || sellDpConflict;

  if (optConflict && dpConflict) return 'CONTRA_BOTH';
  if (optConflict) return 'CONTRA_OPT';
  if (dpConflict)  return 'CONTRA_DP';
  return null;
}

const out = [];
for (const item of $input.all()) {
  const j = item.json || {};
  const side = j.execution || j.side;
  const optRegime = j.opt_regime || j.options_regime;
  const dpRegime  = j.dp_regime;

  const conflict = detectRegimeConflict(side, optRegime, dpRegime);

  // Stamp every item for audit visibility
  j._regime_filter_marker  = REGIME_FILTER_MARKER;
  j._regime_filter_mode    = REGIME_FILTER_MODE;
  j._regime_filter_checked = true;
  j._regime_filter_side    = String(side || '').toUpperCase();
  j._regime_filter_opt     = String(optRegime || '').toUpperCase();
  j._regime_filter_dp      = String(dpRegime  || '').toUpperCase();

  if (conflict) {
    j._regime_conflict = conflict;
    j._regime_filter_verdict = 'CONFLICT_DETECTED';
    console.log('[REGIME_FILTER] ' + (j.ticker || j.symbol || '?') + ' ' + (side || '?') + ' conflict=' + conflict +
                ' opt=' + (optRegime || 'N/A') + ' dp=' + (dpRegime || 'N/A') + ' mode=' + REGIME_FILTER_MODE);

    if (REGIME_FILTER_MODE === 'HARD_VETO') {
      // QTP_SCANNER_REGIME_CONFLICT_FILTER_v1_20260526: drop the item — fail closed, no downstream VC call
      j._regime_filter_action = 'BLOCKED';
      // QTP_RCF_OBS_v1_20260706: record the drop before discarding (dropped item is still NOT returned — no behavior change)
      rcfDrops.push({
        ticker: j.ticker || j.symbol || '?',
        side: String(side || '').toUpperCase(),
        reason: 'REGIME_CONFLICT_' + conflict,
        composite_opposition_count: (j.composite_opposition_count !== undefined ? j.composite_opposition_count : null),
        legs: 'conflict=' + conflict + ' opt=' + (optRegime || 'N/A') + ' dp=' + (dpRegime || 'N/A') + ' mode=' + REGIME_FILTER_MODE,
        shadow_both_required_pass: conflict !== 'CONTRA_BOTH',
        shadow_policy_version: RCF_SHADOW_POLICY
      });
      continue;
    }
    // LOG_ONLY: pass through with stamp
    j._regime_filter_action = 'LOGGED_ONLY';
  } else {
    j._regime_filter_verdict = 'NO_CONFLICT';
    j._regime_filter_action  = 'PASS';
  }

  out.push({ json: j });
}

// QTP_RCF_OBS_v1_20260706: attach drop log to SURVIVING items only. Downstream of this node is
// 'VC Agent Gatekeeper' (a Code node) — there is NO IF/filter/switch that would route flagged items
// away from the trading path, so returning dropped items would change behavior. Therefore:
// drops are console-logged always, and piggybacked on survivors as _rcf_drop_log when any survive.
if (rcfDrops.length > 0) {
  const _rcfDropLog = JSON.stringify(rcfDrops);
  console.log('[RCF_OBS] ' + RCF_OBS_MARKER + ' dropped=' + rcfDrops.length + ' survivors=' + out.length + ' drops=' + _rcfDropLog);
  for (const it of out) {
    it.json._rcf_obs_marker = RCF_OBS_MARKER;
    it.json._rcf_drop_log = _rcfDropLog;
  }
  if (out.length === 0) {
    console.log('[RCF_OBS] ' + RCF_OBS_MARKER + ' ALL_ITEMS_DROPPED — node emits nothing; drop records exist only in this log line');
  }
}

return out;
