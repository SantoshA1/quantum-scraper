const j = $input.first().json;
const esc = (s) => s == null ? '' : String(s).replace(/'/g, "''");
const t = esc(String(j.ticker || j.symbol || '').toUpperCase());
// Guard: never stamp an item that carries explicit pass markers
if (!t || j.qtp_bias_filter_pass === true || j.bias_filter_pass === true) { return [{ json: { __trace_stamp_sql: 'SELECT 1 AS stamp_noop' } }]; }
const reason = esc((String(j.bias_filter_drop_reason || j.bias_drop_reason || 'bias_filter_drop') + ' score=' + (j.bias_score ?? j.ai_super_score ?? '')).slice(0, 180));
const sql = "UPDATE quantum.candidate_path_trace_10fc SET blocked_stage='BIAS_FILTER', blocked_reason='" + reason + "' WHERE ctid IN (SELECT ctid FROM quantum.candidate_path_trace_10fc WHERE ticker='" + t + "' AND observed_at >= now() - interval '20 minutes' AND (blocked_stage IS NULL OR blocked_stage='') ORDER BY observed_at DESC LIMIT 1)";
return [{ json: { __trace_stamp_sql: sql } }];