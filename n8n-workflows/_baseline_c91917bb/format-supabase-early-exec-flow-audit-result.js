
// QTP Supabase Early Exec Flow Audit result formatter v4.2.1
const original = $('Prepare Supabase Early Exec Flow Audit Insert').first().json || {};
const row = ($input.first() && $input.first().json) || {};
const { __supabase_early_exec_sql, ...safe } = original;
return [{ json: { ...safe, _early_exec_flow_audit_status: row.early_exec_flow_audit_status || 'INSERTED', _early_exec_flow_audit_sink: 'supabase.exec_flow_audit' } }];
