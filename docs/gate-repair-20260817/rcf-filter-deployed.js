// ============================================================
// QTP_SCANNER_REGIME_CONFLICT_FILTER_v1_20260526
// Block signals where options/dark-pool regime opposes execution direction.
// ============================================================
// QTP_REGIME_FILTER_PROMOTE_HARD_VETO_v1_20260527: promoted to HARD_VETO.
const REGIME_FILTER_MODE   = 'HARD_VETO';
const REGIME_FILTER_MARKER = 'QTP_SCANNER_REGIME_CONFLICT_FILTER_v1_20260526';
const RCF_OBS_MARKER = 'QTP_RCF_OBS_SHADOW_v2_20260706';
const RCF_SHADOW_POLICY = 'QTP_RCF_SHADOW_V1_20260706';
// QTP_RCF_AUDIT_EMIT_v3_20260720: drops emitted with _rcf_dropped=true -> RCF Drop Router -> audit.
const RCF_AUDIT_EMIT_VERSION = 'QTP_RCF_AUDIT_EMIT_v3_20260720';
// QTP_RCF_CONTRA_BOTH_v4_20260721 (PO-authorized, evidence-based side-balance fix):
// HARD_VETO now fires ONLY on CONTRA_BOTH (options AND dark-pool both opposed).
// WHY: 7d evidence — RCF killed 55% of BUY signals (56/101) vs 2.2% of SELLs (9/406).
// Root cause: options-regime classifier is a FADE thesis (+GEX + call-heavy OI ->
// CONTRARIAN_SHORT), which opposes momentum BUY entries BY CONSTRUCTION, while
// momentum SELLs escape (dump names still show neutral/bullish P/C OI). The
// purpose-built RCF_SHADOW_V1 telemetry (collecting since 07-06) shows ALL 30
// single-leg kills (21 BUY + 9 SELL) would-pass under CONTRA_BOTH; the 35
// conviction (both-leg) kills remain killed. Phase-0: rejects were NOT losers
// (+15bp/1h) and BUY alpha ~6x SELL — the single-leg veto was executing the weak
// side and killing the strong one. Single-leg conflicts are now STAMPED
// (_rcf_single_leg_conflict) as caution, pass through, and stay measurable.
const RCF_POLICY_VERSION = 'QTP_RCF_CONTRA_BOTH_v4_20260721';
const rcfDrops = [];
const RCF_MOD_DP_EXEMPT_ON = String(((typeof $vars!=='undefined') && $vars.QTP_RCF_MODERATE_DP_EXEMPT) || 'on').toLowerCase() !== 'off';

function detectRegimeConflict(side, optionsRegime, darkPoolRegime) {
  const opt   = String(optionsRegime  || '').toUpperCase();
  const dp    = String(darkPoolRegime || '').toUpperCase();
  const sideU = String(side           || '').toUpperCase();

  const buyOptConflict  = sideU === 'BUY'  && /CONTRARIAN_SHORT|GAMMA_SQUEEZE_DOWN|DISTRIBUTION/.test(opt);
  const buyDpConflict   = sideU === 'BUY'  && /CONTRARIAN_SHORT|DISTRIBUTION/.test(dp);
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

  j._regime_filter_marker  = REGIME_FILTER_MARKER;
  j._regime_filter_mode    = REGIME_FILTER_MODE;
  j._regime_filter_checked = true;
  j._regime_filter_side    = String(side || '').toUpperCase();
  j._regime_filter_opt     = String(optRegime || '').toUpperCase();
  j._regime_filter_dp      = String(dpRegime  || '').toUpperCase();
  j._rcf_audit_emit_version = RCF_AUDIT_EMIT_VERSION;
  j._rcf_policy_version = RCF_POLICY_VERSION;

  if (conflict) {
    j._regime_conflict = conflict;
    j._regime_filter_verdict = 'CONFLICT_DETECTED';
    console.log('[REGIME_FILTER] ' + (j.ticker || j.symbol || '?') + ' ' + (side || '?') + ' conflict=' + conflict +
                ' opt=' + (optRegime || 'N/A') + ' dp=' + (dpRegime || 'N/A') + ' mode=' + REGIME_FILTER_MODE + ' policy=CONTRA_BOTH_ONLY');

    // v4: HARD kill ONLY when BOTH legs oppose. Single-leg = stamped caution, passes.
    if (REGIME_FILTER_MODE === 'HARD_VETO' && conflict === 'CONTRA_BOTH') {
      // QTP_RCF_MODERATE_DP_EXEMPT_v1_20260727 (PO-authorized; rcf_shadow n=15 +1.34%/67% @+2d).
      if (RCF_MOD_DP_EXEMPT_ON && j._regime_filter_side === 'BUY' && j._regime_filter_dp === 'MODERATE_DISTRIBUTION') {
        j._regime_filter_action = 'MODERATE_DP_EXEMPT_PASS';
        j._rcf_moderate_dp_exempt = true;
        j._rcf_moderate_dp_exempt_v = 'QTP_RCF_MODERATE_DP_EXEMPT_v1_20260727';
        j._rcf_single_leg_conflict = conflict;
        j._rcf_dropped = false;
        out.push({ json: j });
        continue;
      }
      j._regime_filter_action = 'BLOCKED';
      j._rcf_dropped = true;
      j._rcf_drop_reason = 'REGIME_CONFLICT_' + conflict;
      j._rcf_drop_shadow_both_required_pass = false;
      j._rcf_drop_shadow_policy_version = RCF_SHADOW_POLICY;
      rcfDrops.push({
        ticker: j.ticker || j.symbol || '?',
        side: String(side || '').toUpperCase(),
        reason: 'REGIME_CONFLICT_' + conflict,
        composite_opposition_count: (j.composite_opposition_count !== undefined ? j.composite_opposition_count : null),
        legs: 'conflict=' + conflict + ' opt=' + (optRegime || 'N/A') + ' dp=' + (dpRegime || 'N/A') + ' mode=' + REGIME_FILTER_MODE,
        shadow_both_required_pass: false,
        shadow_policy_version: RCF_SHADOW_POLICY
      });
      out.push({ json: j });
      continue;
    }
    // v4: single-leg conflict — pass with caution stamps (measurable, reversible).
    j._regime_filter_action = 'SINGLE_LEG_PASS_V4';
    j._rcf_single_leg_conflict = conflict;
    j._rcf_dropped = false;
    out.push({ json: j });
    continue;
  }

  j._regime_filter_verdict = 'NO_CONFLICT';
  j._regime_filter_action  = 'PASS';
  j._rcf_dropped = false;
  out.push({ json: j });
}

// Console summary (retained observability)
if (rcfDrops.length > 0) {
  const _rcfDropLog = JSON.stringify(rcfDrops);
  const survivors = out.filter(it => it.json._rcf_dropped !== true);
  console.log('[RCF_OBS] ' + RCF_OBS_MARKER + ' dropped=' + rcfDrops.length + ' survivors=' + survivors.length + ' drops=' + _rcfDropLog);
  for (const it of survivors) {
    it.json._rcf_obs_marker = RCF_OBS_MARKER;
    it.json._rcf_drop_log = _rcfDropLog;
  }
}

return out;