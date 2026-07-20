// QTP SKIP-Branch Exec Flow Audit Builder v1.0 (E2E sprint fc010fe2 Stage 1)
// Purpose: SSM-killed / FAST_ONLY-routed entries reach Route Fast Only out0 -> Alpaca
//   Position Closer WITHOUT ever writing quantum.exec_flow_audit. The FULL branch
//   writes audit via "QTP Early Exec Flow Audit Builder"; the SKIP branch was blind.
//   This node taps Route Fast Only out0 and writes an exec_flow_audit row that
//   ALWAYS carries kill_stage_attribution (+ signal_id / idempotency_key / gate_lineage)
//   so v_qtp_e2e_live can surface which kill switch bound each killed organic signal.
// Pattern parity: mirrors the Early Audit Builder esc()/num()/bool() helpers and the
//   d._skip_exec_flow_audit_sql -> Prepare -> Postgres chain (INSERT ... SELECT, no
//   trailing semicolon; the Prepare node appends "; SELECT 'INSERTED' ...").
// Column list is the SAME 27-column tuple the Early Audit Builder writes, so both
//   branches produce schema-compatible exec_flow_audit rows.

const d = $json || {};

function esc(v) {
  if (v === undefined || v === null) return 'NULL';
  return "'" + String(v).replace(/'/g, "''").slice(0, 20000) + "'";
}
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : 'NULL';
}
function bool(v) {
  if (v === true) return 'TRUE';
  if (v === false) return 'FALSE';
  return 'NULL';
}
function clean(v, fallback = 'N/A') {
  if (v === undefined || v === null || v === '') return fallback;
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, 240) : fallback;
}
function upper(v, fallback = 'N/A') {
  return clean(v, fallback).toUpperCase();
}
function score(v) {
  const n = Number(String(v ?? '').replace('%', '').trim());
  return Number.isFinite(n) ? n : null;
}
function jsonClean(v, fallback = {}) {
  try {
    if (v === undefined || v === null || v === '') return fallback;
    if (typeof v === 'object') return v;
    return JSON.parse(String(v));
  } catch (e) {
    return fallback;
  }
}
function pickFirst(...vals) {
  for (const v of vals) {
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return '';
}

const symbol = String(d.symbol || d.ticker || d.sym || d.asset || 'UNKNOWN').toUpperCase();
const side = String(d.side || d.execution || d.signal || d.action || d.direction || 'UNKNOWN').toUpperCase();

// VC scores (carried on the killed item if present; else NULL)
const vcLiveLegacy = d.vc_live_legacy ?? d.live_vc_score ?? d._vc_score_legacy ?? d._vc_score ?? null;
const vcLiveV2 = d.vc_live_v2 ?? d.live_vc_score_v2 ?? d._vc_score ?? null;
const vcShadow = d.vc_shadow ?? d._vc_shadow_scanner_score ?? d.shadow_vc_score ?? null;
const vcDelta = d.vc_delta ?? d._vc_parity_delta ?? d._vc_shadow_scanner_delta ?? null;

// SSM attribution (H1/H3). These are the values the SKIP branch exists to capture.
const ssmAction = upper(d._sm_action || d.ssm_action || d.signal_state_action || 'SKIP', 'SKIP');
const ssmReason = clean(d._sm_reason || d.ssm_reason || d.signal_state_reason || d.reason || 'N/A', 'N/A');
const ssmRoute = upper(d._sm_route || 'FAST_ONLY', 'FAST_ONLY');

// kill_stage_attribution: SSM stamps _sm_kill_stage_attribution when a kill switch
//   binds. On the SKIP branch a bound kill switch is the EXPECTED cause, so if SSM
//   left it null we fall back to a deterministic SSM_<route> marker rather than NULL,
//   guaranteeing v_qtp_e2e_live always shows a kill switch for killed entries.
const killStage = clean(
  pickFirst(
    d._sm_kill_stage_attribution,
    d.kill_stage_attribution,
    d._kill_stage_attribution,
    d.blocked_stage,
    d._blocked_stage
  ),
  `SSM_${ssmRoute}`
);

// H1 correlation keys (same source fields the Early Audit Builder reads)
const _h1SignalId = d._sm_signal_id || d.signal_id || null;
const _h1IdempotencyKey = d._sm_idempotency_key || d._sm_signal_id || d.idempotency_key || null;
const _h1GateLineage = (() => {
  const gl = d._sm_gate_lineage;
  if (gl === undefined || gl === null) return null;
  try { return (typeof gl === 'string') ? gl : JSON.stringify(gl); } catch (e) { return null; }
})();

// MTF context if carried (usually present from the confluence engine before SSM)
const mtfScore = score(pickFirst(d.mtf_confluence_score, d.ai_mtf_confluence_score));
const mtfDecision = clean(pickFirst(d.final_mtf_confluence_decision, d.mtf_confluence_decision), 'N/A');
const mtfTiers = jsonClean(pickFirst(d.mtf_tiers), {});
const timeframeHorizon = clean(pickFirst(d.timeframe_horizon, d.timeframe_profile), 'N/A');

// Shadow context if carried
const shadowScore = pickFirst(d.shadow_mtf_score);
const shadowDecision = pickFirst(d.shadow_mtf_decision);
const shadowSizeMult = pickFirst(d.shadow_size_multiplier);
const shadowLtVeto = (d.shadow_lt_veto ?? null);
const shadowEngineV = pickFirst(d.shadow_engine_v);
const shadowLtValue = pickFirst(d.shadow_lt_value);

const execId = ($execution && $execution.id) ? String($execution.id).slice(0, 12) : 'no-exec-id';
const inputKeys = Object.keys(d).slice(0, 18).join(',');

const auditBuilderVersion = 'QTP_SKIP_BRANCH_AUDIT_BUILDER_v1.0_E2E_fc010fe2_20260617';
const parserVersion = d.parser_version || d.vc_score_parser_version || d._vc_score_parser_version || auditBuilderVersion;

// On the SKIP branch the killed entry is, by definition, not allowed through:
//   gate_decision summarises why; risk/pause stay NULL (never evaluated on SKIP).
const gateDecisionParts = [
  `branch=SKIP_FAST_ONLY`,
  `sm_route=${ssmRoute}`, `sm_action=${ssmAction}`, `sm_reason=${ssmReason}`,
  `kill_stage_attribution=${killStage}`,
  `vc_v2=${vcLiveV2 ?? 'N/A'}`, `vc_legacy=${vcLiveLegacy ?? 'N/A'}`,
  `vc_shadow=${vcShadow ?? 'N/A'}`, `vc_delta=${vcDelta ?? 'N/A'}`,
  `mtf_confluence_score=${mtfScore ?? 'N/A'}`, `final_mtf_confluence_decision=${mtfDecision}`,
  `timeframe_horizon=${timeframeHorizon}`,
  `audit_builder_v=${auditBuilderVersion}`,
  `exec_id=${execId}`, `keys=${inputKeys}`
];
const gateDecision = gateDecisionParts.filter(Boolean).join(' | ').slice(0, 20000);

// risk_gate_decision / risk_status NULL on SKIP (Late Patcher leaves them; no risk eval).
const risk_gate_decision = null;
const risk_status_struct = null;
const pause_guard_decision = clean(d._pause_guard_decision, 'PAUSE_N/A');
const pause_status = clean(d._pause_status_struct, 'N/A');

d._skip_exec_flow_audit_sql = `INSERT INTO quantum.exec_flow_audit
(ts, symbol, side, vc_live_legacy, vc_live_v2, vc_shadow, vc_delta, gate_decision, parser_version,
 risk_gate_decision, risk_status, pause_guard_decision, pause_status,
 timeframe_horizon, mtf_tiers, mtf_confluence_score, final_mtf_confluence_decision,
 shadow_mtf_score, shadow_mtf_decision, shadow_size_multiplier, shadow_lt_veto, shadow_engine_v, shadow_lt_value,
 signal_id, idempotency_key, gate_lineage, kill_stage_attribution)
SELECT
  CURRENT_TIMESTAMP,
  ${esc(symbol)},
  ${esc(side)},
  ${num(vcLiveLegacy)},
  ${num(vcLiveV2)},
  ${num(vcShadow)},
  ${num(vcDelta)},
  ${esc(gateDecision)},
  ${esc(parserVersion)},
  ${esc(risk_gate_decision)},
  ${esc(risk_status_struct)},
  ${esc(pause_guard_decision)},
  ${esc(pause_status)},
  ${esc(timeframeHorizon)},
  ${esc(JSON.stringify(mtfTiers))}::jsonb,
  ${num(mtfScore)},
  ${esc(mtfDecision)},
  ${shadowScore === '' || shadowScore == null ? 'NULL' : num(shadowScore)},
  ${esc(shadowDecision || 'SHADOW_NA')},
  ${shadowSizeMult === '' || shadowSizeMult == null ? 'NULL' : num(shadowSizeMult)},
  ${bool(shadowLtVeto === '' ? null : shadowLtVeto)},
  ${esc(shadowEngineV || null)},
  ${shadowLtValue === '' || shadowLtValue == null ? 'NULL' : num(shadowLtValue)},
  ${esc(_h1SignalId)},
  ${esc(_h1IdempotencyKey)},
  ${_h1GateLineage == null ? 'NULL' : esc(_h1GateLineage) + '::jsonb'},
  ${esc(killStage)}`;

d._skip_exec_flow_audit_gate_decision_preview = gateDecision;
d._skip_exec_flow_audit_builder_version = auditBuilderVersion;
d._skip_exec_flow_audit_kill_stage_attribution = killStage;
return [{ json: d }];
