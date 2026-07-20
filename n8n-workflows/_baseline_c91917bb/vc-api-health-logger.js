
// QTP Supabase VC API health logger v4.2.1. Non-blocking; never affects trading path.
function esc(v) { return String(v ?? '').replace(/\\/g, '\\\\').replace(/'/g, "''").replace(/\r/g, '\\r').replace(/\n/g, '\\n').slice(0, 4000); }
function s(v) { return `'${esc(v)}'`; }
function n(v) { const x = Number(v); return Number.isFinite(x) ? String(Math.trunc(x)) : '0'; }
const out = [];
for (const item of $input.all()) {
  const d = item.json || {};
  if (!d._vc_api_health_event) {
    out.push({ json: { ...d, __supabase_vc_health_sql: `SELECT 'SKIPPED_NO_EVENT' AS vc_health_status;` } });
    continue;
  }
  const statement = `
    INSERT INTO quantum.vc_api_health_events_10o (
      event_id, observed_at, ticker, execution, alert_type, provider, model, attempts, latency_ms,
      circuit_state, reason, error_message, telegram_alert_sent, safety_action
    ) VALUES (
      ${s(d._vc_health_event_id)}, CURRENT_TIMESTAMP, ${s(d.ticker)}, ${s(d.execution)}, ${s(d.alert_type)},
      ${s(d._vc_provider || 'xai_grok_native')}, ${s(d._vc_model)}, ${n(d._vc_api_attempts || 0)}, ${s(String(d._vc_api_latency_ms || 0))},
      ${s(d._vc_circuit_state || 'CLOSED')}, ${s(d._vc_health_reason || '')}, ${s(d._vc_grok_error || '')},
      ${d._vc_api_health_alert ? 'true' : 'false'}, 'FAIL_CLOSED_SE_C7'
    );
    SELECT 'INSERTED' AS vc_health_status;
  `;
  out.push({ json: { ...d, __supabase_vc_health_sql: statement, _vc_api_health_sink: 'supabase.vc_api_health_events_10o' } });
}
return out;
