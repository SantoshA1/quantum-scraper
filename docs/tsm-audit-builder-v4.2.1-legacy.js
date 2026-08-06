
// QTP Supabase Trailing Stop Manager audit insert v4.2.1
const rows = $input.all().map(i => i.json || {});
function esc(v) { return String(v ?? '').replace(/\\/g, '\\\\').replace(/'/g, "''").replace(/\r/g, '\\r').replace(/\n/g, '\\n'); }
function s(v) { return `'${esc(v)}'`; }
function safeJson(v) { try { return JSON.stringify(v ?? {}); } catch (_) { return '{}'; } }
function hash32(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16).padStart(8, '0');
}
if (!rows.length) {
  return [{ json: { __supabase_tsm_audit_sql: "SELECT 'NO_ROWS' AS audit_status;", migration_version: 'QTP_SUPABASE_TRAILING_STOP_MANAGER_v4.2.1' } }];
}
const values = rows.map((r, idx) => {
  const sym = String(r.sym || r.symbol || r.ticker || r.asset || 'SYSTEM').toUpperCase();
  const status = r.error ? 'ERROR' : 'OK';
  const severity = r.error ? 'WARNING' : 'INFO';
  const eventType = r.type || r.action || r.message || 'TRAILING_STOP_MANAGER_RUN';
  const idem = `tsm:${$execution.id || 'manual'}:${idx}:${sym}:${eventType}`;
  const auditId = `tsm_${hash32(idem)}_${idx}`;
  const msg = `Trailing Stop Manager ${eventType} ${sym}`;
  return `(${s(auditId)},NULL,CURRENT_TIMESTAMP,CURRENT_DATE,'system','trailing_stop_manager',${s($workflow.id || 'vFnPjyx8srnzcYgV')},${s($workflow.name || 'Trailing Stop Manager v1.5')},${s(String($execution.id || ''))},NULL,'trailing_stop_manager','TRAILING_STOP_MANAGER',${s(severity)},${s(status)},'position',${s(sym)},${s(msg)},NULL,NULL,${s(safeJson({ ...r, migration_version: 'QTP_SUPABASE_TRAILING_STOP_MANAGER_v4.2.1' }))}::jsonb,NULL,NULL,${s(sym)},${s(idem)},CURRENT_TIMESTAMP)`;
}).join(',\n');
return [{
  json: {
    __supabase_tsm_audit_sql: `
      INSERT INTO quantum.audit_trail (
        audit_id, source_row_id, event_ts, event_date, actor_type, actor_id, workflow_id, workflow_name, run_id, account_id,
        strategy_id, event_type, event_severity, event_status, entity_type, entity_id, message, before_state, after_state,
        raw_payload, ip_address, user_agent, correlation_id, idempotency_key, ingested_at
      ) VALUES ${values};
      SELECT COUNT(*)::int AS audit_rows_attempted, 'QTP_SUPABASE_TRAILING_STOP_MANAGER_v4.2.1' AS migration_version;
    `,
    migration_version: 'QTP_SUPABASE_TRAILING_STOP_MANAGER_v4.2.1'
  }
}];
