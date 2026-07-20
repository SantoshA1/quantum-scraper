const p = $('QET Gate-K Prep').first().json;
const v = $input.first().json.verdict || {};
const esc = (s) => s == null ? '' : String(s).replace(/'/g, "''");
const raw = JSON.stringify({ ticker: p.__qet_symbol, side: p.__qet_side, entry: p.__qet_entry, stop_est: p.__qet_stop, signal: p.signal || p.execution || null, verdict: v }).split('$qet$').join('');
const reason = esc(v.reason || 'gate_k_reject');
const t = esc(String(p.__qet_symbol || '').toUpperCase());
const sql = "INSERT INTO public.audit_log (user_id, workflow_name, execution_id, mode, decision, reason, raw) VALUES ('04a6a5d7-ddc0-437f-b95b-5340941c0742'::uuid, 'qtp-main-pipeline-gate-k', '" + esc($execution.id) + "', 'paper', 'rejected', '" + reason + "', $qet$" + raw + "$qet$::jsonb)";
const __trace_stamp_sql = t ? ("UPDATE quantum.candidate_path_trace_10fc SET blocked_stage='GATE_K', blocked_reason='" + reason + "', risk_gate_status='REJECTED' WHERE ctid IN (SELECT ctid FROM quantum.candidate_path_trace_10fc WHERE ticker='" + t + "' AND observed_at >= now() - interval '20 minutes' AND (blocked_stage IS NULL OR blocked_stage='') ORDER BY observed_at DESC LIMIT 1)") : 'SELECT 1 AS stamp_noop';
return [{ json: { sql: sql, __trace_stamp_sql: __trace_stamp_sql, reason: v.reason || 'gate_k_reject', ticker: p.__qet_symbol } }];