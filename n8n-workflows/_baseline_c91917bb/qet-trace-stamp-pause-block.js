const j = $input.first().json;
const esc = (s) => s == null ? '' : String(s).replace(/'/g, "''");
const t = esc(String(j.ticker || j.symbol || '').toUpperCase());
if (!t) { return [{ json: { __trace_stamp_sql: 'SELECT 1 AS stamp_noop' } }]; }
const score = Number(j.bias_score ?? j.ai_super_score ?? j.composite_score ?? j.bull_score ?? j.bear_score ?? j.score ?? 0);
const reason = esc(('pause_guard_block score=' + score + (j.pause_new_entries ? ' pause_active' : '')).slice(0, 180));
const sql = "UPDATE quantum.candidate_path_trace_10fc SET blocked_stage='PAUSE_GUARD', blocked_reason='" + reason + "', pause_guard_action='BLOCKED' WHERE ctid IN (SELECT ctid FROM quantum.candidate_path_trace_10fc WHERE ticker='" + t + "' AND observed_at >= now() - interval '20 minutes' AND (blocked_stage IS NULL OR blocked_stage='') ORDER BY observed_at DESC LIMIT 1)";
return [{ json: { __trace_stamp_sql: sql } }];