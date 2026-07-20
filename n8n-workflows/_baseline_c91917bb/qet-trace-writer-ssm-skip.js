// W1 (2026-07-11): SKIP-routed candidates diverge at Route Signal out-1 BEFORE the main
// trace writer, so they never get a candidate_path_trace_10fc row. This writes a fresh row
// per SKIP so the console Tier-1 SSM funnel is truthful. Self-guarded, onError=continue.
const d = $input.first().json || {};
const strip = (s) => s == null ? '' : String(s).split('$qet$').join('');
const q = (s) => strip(s).replace(/'/g, "''");
const t = q(String(d.ticker || d.symbol || d.sym || 'UNKNOWN').toUpperCase());
if (!t || t === 'UNKNOWN') { return [{ json: { __skip_trace_sql: 'SELECT 1 AS skip_noop' } }]; }
const dir = q(String(d.execution || d.signal || d.side || '').toUpperCase());
const action = q(String(d._sm_action || d.ssm_action || 'SKIP').toUpperCase());
const route = String(d._sm_route || 'FAST_ONLY').toUpperCase();
const killStage = d._sm_kill_stage_attribution ? String(d._sm_kill_stage_attribution) : '';
const blockedStage = q(killStage ? ('SSM:' + killStage) : ('SSM_' + route));
const reason = strip(String(d._sm_reason || d.reason || '')).slice(0, 400);
const traceId = 'trace10fc_skip_' + Date.now() + '_' + t + '_' + Math.random().toString(36).slice(2, 8);
const sql = "INSERT INTO quantum.candidate_path_trace_10fc (trace_id, observed_at, workflow_execution_id, ticker, signal_direction, ssm_action, ssm_reason, blocked_stage, blocked_reason) VALUES ('" + traceId + "', now(), '" + q(String($execution.id)) + "', '" + t + "', '" + dir + "', '" + action + "', $qet$" + reason + "$qet$, '" + blockedStage + "', $qet$" + reason + "$qet$)";
return [{ json: { __skip_trace_sql: sql, ticker: t, route: route, blocked_stage: blockedStage } }];