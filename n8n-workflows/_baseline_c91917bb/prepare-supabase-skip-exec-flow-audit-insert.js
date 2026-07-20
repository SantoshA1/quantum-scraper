
// QTP Supabase SKIP-Branch Exec Flow Audit Insert prep v1.0 (E2E fc010fe2 Stage 1)
const d = ($input.first() && $input.first().json) || $json || {};
const statement = d._skip_exec_flow_audit_sql;
const sql = statement
  ? `${statement}; SELECT 'INSERTED' AS skip_exec_flow_audit_status;`
  : `SELECT 'SKIPPED_NO_SQL' AS skip_exec_flow_audit_status;`;
return [{ json: { ...d, __supabase_skip_exec_sql: sql, _skip_exec_flow_audit_version: 'QTP-SKIP-AUDIT_SUPABASE_v1.0_20260617' } }];
