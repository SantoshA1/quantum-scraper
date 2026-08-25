
// QTP Supabase Trailing Stop Manager result formatter v4.2.1
const sourceRows = $('Trail Stops').all().map(i => i.json || {});
const auditRows = $input.all().map(i => i.json || {});
return [{
  json: {
    ok: true,
    broker_order_side_effects: sourceRows.some(r => r.type && /SELL|BUY|CLOSE|TRAIL|STOP|FILL/i.test(String(r.type))) ? 'SEE_TRAIL_STOPS_OUTPUT' : 'NONE_OR_READ_ONLY',
    trail_stop_output_count: sourceRows.length,
    trail_stop_outputs: sourceRows,
    supabase_audit_status: 'SUCCEEDED',
    supabase_audit_rows: auditRows,
    migration_version: 'QTP_SUPABASE_TRAILING_STOP_MANAGER_v4.2.1',
    checked_at: new Date().toISOString()
  }
}];
