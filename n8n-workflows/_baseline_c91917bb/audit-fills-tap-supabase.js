
// QTP-SUPABASE-PG-CUTOVER v4.2.1
// Stale REST fills mirror disabled after Supabase PostgreSQL cutover.
// This node is pass-through only. It does not place, cancel, modify, or route orders.
// Order-event persistence is handled by the Supabase/PostgreSQL order-event path.
return items.map(item => {
  const j = item.json || {};
  j.qtp_fill_audit_sink = j.qtp_fill_audit_sink || 'supabase_postgres_order_event_path';
  j.qtp_fill_audit_rest_rpc_disabled = true;
  return { json: j };
});
