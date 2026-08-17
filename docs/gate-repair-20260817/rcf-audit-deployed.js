// RCF Drop Audit SQL Builder v1.1 (QTP_RCF_AUDIT_EMIT_v3_20260720)
// Builds an exec_flow_audit INSERT for a HARD_VETO regime-conflict drop so the kill
// is attributable (2026-07-20 EG incident: drops previously left ZERO db trace).
// v1.1: num(null/undefined/'') -> NULL (v1.0 coerced null->0; RCF drops pre-date VC,
// so every row would have carried a fake vc score of 0 instead of NULL).
// Dedupes duplicate enrichment legs via WHERE NOT EXISTS on (idempotency_key, kill_stage).
// HARD RULE: never throws — on any error emits a harmless SELECT so this side
// branch can never take down the execution.
try {
  const d = ($input.first() && $input.first().json) || $json || {};

  function esc(v) {
    if (v === undefined || v === null) return 'NULL';
    return "'" + String(v).replace(/'/g, "''").slice(0, 20000) + "'";
  }
  function num(v) {
    if (v === undefined || v === null || v === '') return 'NULL';
    const n = Number(v);
    return Number.isFinite(n) ? String(n) : 'NULL';
  }
  function clean(v, fallback) {
    if (v === undefined || v === null || v === '') return fallback;
    const s = String(v).replace(/\s+/g, ' ').trim();
    return s ? s.slice(0, 240) : fallback;
  }

  const symbol = String(d.ticker || d.symbol || d.sym || 'UNKNOWN').toUpperCase();
  const side = String(d.execution || d.side || d.signal || 'UNKNOWN').toUpperCase();
  const conflict = clean(d._regime_conflict, 'UNSPECIFIED');
  const dropReason = clean(d._rcf_drop_reason, 'REGIME_CONFLICT_' + conflict);
  const killStage = 'REGIME_CONFLICT_' + conflict;

  const vcLiveLegacy = d.vc_live_legacy ?? d.live_vc_score ?? d._vc_score_legacy ?? null;
  const vcLiveV2 = d.vc_live_v2 ?? d.live_vc_score_v2 ?? d._vc_score ?? null;

  const signalId = d._sm_signal_id || d.signal_id || null;
  const idemKey = d._sm_idempotency_key || d._sm_signal_id || d.idempotency_key || null;
  const gateLineage = (() => {
    const gl = d._sm_gate_lineage;
    if (gl === undefined || gl === null) return null;
    try { return (typeof gl === 'string') ? gl : JSON.stringify(gl); } catch (e) { return null; }
  })();

  const execId = ($execution && $execution.id) ? String($execution.id).slice(0, 12) : 'no-exec-id';
  const gateDecision = [
    'branch=RCF_HARD_VETO_DROP',
    'conflict=' + conflict,
    'side=' + side,
    'opt=' + clean(d._regime_filter_opt, 'N/A'),
    'dp=' + clean(d._regime_filter_dp, 'N/A'),
    'shadow_both_required_pass=' + String(d._rcf_drop_shadow_both_required_pass ?? 'N/A'),
    'sm_action=' + clean(d._sm_action, 'N/A'),
    'sm_route=' + clean(d._sm_route, 'N/A'),
    'audit_builder_v=RCF_DROP_AUDIT_BUILDER_v1.1_20260720',
    'exec_id=' + execId
  ].join(' | ').slice(0, 20000);

  const dedupe = idemKey
    ? `WHERE NOT EXISTS (SELECT 1 FROM quantum.exec_flow_audit a WHERE a.idempotency_key = ${esc(idemKey)} AND a.kill_stage_attribution = ${esc(killStage)})`
    : '';

  const insert = `INSERT INTO quantum.exec_flow_audit
(ts, symbol, side, vc_live_legacy, vc_live_v2, gate_decision, parser_version,
 blocked_stage, bias_filter_drop_reason, bias_filter_drop_at, bias_filter_drop_subreason,
 audit_status, signal_id, idempotency_key, gate_lineage, kill_stage_attribution)
SELECT
  CURRENT_TIMESTAMP,
  ${esc(symbol)},
  ${esc(side)},
  ${num(vcLiveLegacy)},
  ${num(vcLiveV2)},
  ${esc(gateDecision)},
  ${esc(d.parser_version || 'RCF_DROP_AUDIT_BUILDER_v1.1_20260720')},
  'REGIME_CONFLICT',
  ${esc(dropReason)},
  CURRENT_TIMESTAMP,
  ${esc(conflict)},
  'REJECTED',
  ${esc(signalId)},
  ${esc(idemKey)},
  ${gateLineage === null ? 'NULL' : esc(gateLineage) + '::jsonb'},
  ${esc(killStage)}
${dedupe}`;

  const sql = insert + "; SELECT 'INSERTED' AS rcf_drop_audit_status;";
  return [{ json: { ...d, __rcf_drop_audit_sql: sql, _rcf_drop_audit_builder_v: 'RCF_DROP_AUDIT_BUILDER_v1.1_20260720' } }];
} catch (e) {
  console.log('[RCF_DROP_AUDIT_BUILDER_ERROR] ' + (e && e.message ? e.message : String(e)));
  return [{ json: { __rcf_drop_audit_sql: "SELECT 'BUILDER_ERROR' AS rcf_drop_audit_status;", _rcf_drop_audit_builder_error: String(e && e.message ? e.message : e) } }];
}