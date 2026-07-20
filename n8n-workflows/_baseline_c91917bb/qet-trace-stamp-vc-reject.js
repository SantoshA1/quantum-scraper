// Terminal-stage stamp (side branch, never in execution path). Self-guarded:
// only stamps when the verdict actually indicates a terminal VC outcome.
const j = $input.first().json;
const esc = (s) => s == null ? '' : String(s).replace(/'/g, "''");
const t = esc(String(j.ticker || j.symbol || '').toUpperCase());
const verdict = String(j.vc_verdict || '');
if (!t || !/REJECT|KILL|WEAK|SUPPRESS/i.test(verdict)) { return [{ json: { __trace_stamp_sql: 'SELECT 1 AS stamp_noop' } }]; }
const reason = esc(('vc_verdict=' + verdict + ' live_v2=' + (j.live_vc_score_v2 ?? '')).slice(0, 180));
const sql = "UPDATE quantum.candidate_path_trace_10fc SET blocked_stage='VC_GATE', blocked_reason='" + reason + "' WHERE ctid IN (SELECT ctid FROM quantum.candidate_path_trace_10fc WHERE ticker='" + t + "' AND observed_at >= now() - interval '20 minutes' AND (blocked_stage IS NULL OR blocked_stage='') ORDER BY observed_at DESC LIMIT 1)";
return [{ json: { __trace_stamp_sql: sql } }];