
// QTP Supabase Trailing Stop Manager audit insert v4.2.2
// FIX 2026-08-06 (exec 524111): v4.2.1's esc() doubled backslashes — correct only under
// standard_conforming_strings=OFF, but qtp_prod runs ON. Any payload string containing a
// double quote (JSON.stringify emits \") became \\" inside the jsonb literal -> jsonb's
// string terminated early -> `invalid input syntax for type json` -> the ENTIRE cycle's
// audit batch was lost (WRB's embedded Alpaca 422 body killed XPEV's tier-1 event).
// v4.2.2: (1) esc doubles ONLY single quotes (+ strips NUL) — standard-conforming;
// (2) safeJson deep-cleans strings (NUL / lone surrogates -> U+FFFD) so jsonb always
// accepts the text; (3) every payload goes through quantum.safe_jsonb(text), an
// exception-guarded cast — a malformed payload degrades to {"__jsonb_parse_error":...}
// instead of killing the batch. Mirror: lib/tsm/audit_sql.js · suite: tests/test-tsm-audit-sql.js
const rows = $input.all().map(i => i.json || {});
function esc(v) { return String(v ?? '').replace(new RegExp(String.fromCharCode(0), 'g'), '').replace(/'/g, "''"); }
function s(v) { return "'" + esc(v) + "'"; }
function cleanStr(x) {
  const RC = String.fromCharCode(0xFFFD);
  let out = '';
  for (let i = 0; i < x.length; i++) {
    const c = x.charCodeAt(i);
    if (c === 0) { out += RC; continue; }
    if (c >= 0xD800 && c <= 0xDBFF) {
      const d = x.charCodeAt(i + 1);
      if (d >= 0xDC00 && d <= 0xDFFF) { out += x[i] + x[i + 1]; i++; }
      else out += RC;
    } else if (c >= 0xDC00 && c <= 0xDFFF) { out += RC; }
    else out += x[i];
  }
  return out;
}
function safeJson(v) {
  let t;
  try {
    t = JSON.stringify(v ?? {}, (k, val) => (typeof val === 'string' ? cleanStr(val) : val));
  } catch (e) {
    try { t = JSON.stringify({ __stringify_error: cleanStr(String((e && e.message) || e)) }); }
    catch (_) { t = '{}'; }
  }
  return typeof t === 'string' ? t : '{}';
}
function hash32(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16).padStart(8, '0');
}
if (!rows.length) {
  return [{ json: { __supabase_tsm_audit_sql: "SELECT 'NO_ROWS' AS audit_status;", migration_version: 'QTP_SUPABASE_TRAILING_STOP_MANAGER_v4.2.2' } }];
}
const values = rows.map((r, idx) => {
  const sym = String(r.sym || r.symbol || r.ticker || r.asset || 'SYSTEM').toUpperCase().slice(0, 32);
  const status = r.error ? 'ERROR' : 'OK';
  const severity = r.error ? 'WARNING' : 'INFO';
  const eventType = String(r.type || r.action || r.message || 'TRAILING_STOP_MANAGER_RUN').slice(0, 80);
  const idem = `tsm:${$execution.id || 'manual'}:${idx}:${sym}:${eventType}`;
  const auditId = `tsm_${hash32(idem)}_${idx}`;
  const msg = `Trailing Stop Manager ${eventType} ${sym}`;
  return `(${s(auditId)},NULL,CURRENT_TIMESTAMP,CURRENT_DATE,'system','trailing_stop_manager',${s($workflow.id || 'vFnPjyx8srnzcYgV')},${s($workflow.name || 'Trailing Stop Manager v1.5')},${s(String($execution.id || ''))},NULL,'trailing_stop_manager','TRAILING_STOP_MANAGER',${s(severity)},${s(status)},'position',${s(sym)},${s(msg)},NULL,NULL,quantum.safe_jsonb(${s(safeJson({ ...r, migration_version: 'QTP_SUPABASE_TRAILING_STOP_MANAGER_v4.2.2' }))}),NULL,NULL,${s(sym)},${s(idem)},CURRENT_TIMESTAMP)`;
}).join(',\n');
return [{
  json: {
    __supabase_tsm_audit_sql: `
      INSERT INTO quantum.audit_trail (
        audit_id, source_row_id, event_ts, event_date, actor_type, actor_id, workflow_id, workflow_name, run_id, account_id,
        strategy_id, event_type, event_severity, event_status, entity_type, entity_id, message, before_state, after_state,
        raw_payload, ip_address, user_agent, correlation_id, idempotency_key, ingested_at
      ) VALUES ${values};
      SELECT COUNT(*)::int AS audit_rows_attempted, 'QTP_SUPABASE_TRAILING_STOP_MANAGER_v4.2.2' AS migration_version;
    `,
    migration_version: 'QTP_SUPABASE_TRAILING_STOP_MANAGER_v4.2.2'
  }
}];
