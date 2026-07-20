
// QTP-BACKTEST-AUDIT-FIX v4.2.1
// Restore original item after PostgreSQL audit insert. Fail-open semantics are preserved by n8n node success path.
const source = $('VC Gate Audit Emitter').first().json || {};
const out = { ...source, backtest_audit_insert_status: 'SUBMITTED_SUPABASE_POSTGRES' };
delete out.__supabase_backtest_audit_sql;
return [{ json: out }];
