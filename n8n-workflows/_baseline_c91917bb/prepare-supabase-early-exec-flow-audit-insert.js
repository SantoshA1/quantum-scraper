
// QTP Supabase Early Exec Flow Audit Insert prep v4.2.1
const d = ($input.first() && $input.first().json) || $json || {};
const statement = d._early_exec_flow_audit_sql;
const sql = statement
  ? `${statement}; SELECT 'INSERTED' AS early_exec_flow_audit_status;`
  : `SELECT 'SKIPPED_NO_SQL' AS early_exec_flow_audit_status;`;
return [{ json: { ...d, __supabase_early_exec_sql: sql, _early_exec_flow_audit_version: 'QTP-AUDIT_SUPABASE_v4.2.1_20260515' } }];
