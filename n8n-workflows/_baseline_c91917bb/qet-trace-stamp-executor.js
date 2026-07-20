const j = $input.first().json;
const esc = (s) => s == null ? '' : String(s).replace(/'/g, "''");
const t = esc(String(j.ticker || j.symbol || '').toUpperCase());
if (!t || !j.alpaca_status) { return [{ json: { __trace_stamp_sql: 'SELECT 1 AS stamp_noop' } }]; }
const st = String(j.alpaca_status);
const bad = ['SKIPPED', 'REJECTED', 'BLOCKED_RISK_GATE', 'ERROR'];
let sql;
if (bad.includes(st)) {
  const reason = esc((st + ': ' + (j.alpaca_reason || j.alpaca_error || '')).slice(0, 180));
  sql = "UPDATE quantum.candidate_path_trace_10fc SET blocked_stage='ALPACA_EXECUTOR', blocked_reason='" + reason + "', alpaca_route='" + esc(st) + "' WHERE ctid IN (SELECT ctid FROM quantum.candidate_path_trace_10fc WHERE ticker='" + t + "' AND observed_at >= now() - interval '20 minutes' AND (blocked_stage IS NULL OR blocked_stage='') ORDER BY observed_at DESC LIMIT 1)";
} else {
  const route = esc(('EXECUTED:' + st + ' qty=' + (j.alpaca_qty ?? '') + ' entry_id=' + (j.alpaca_entry_id || '')).slice(0, 120));
  sql = "UPDATE quantum.candidate_path_trace_10fc SET alpaca_route='" + route + "', risk_gate_status='PASS' WHERE ctid IN (SELECT ctid FROM quantum.candidate_path_trace_10fc WHERE ticker='" + t + "' AND observed_at >= now() - interval '20 minutes' AND (alpaca_route IS NULL OR alpaca_route='') ORDER BY observed_at DESC LIMIT 1)";
}
return [{ json: { __trace_stamp_sql: sql } }];