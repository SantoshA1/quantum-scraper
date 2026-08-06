'use strict';
/**
 * QTP_TSM_AUDIT_SQL_v4_2_2_20260806 — spec-mirror of the TSM audit-INSERT builder
 * (workflow vFnPjyx8srnzcYgV, "Prepare Supabase TSM Audit SQL" Code node).
 *
 * WHY (2026-08-06 RCA, exec 524111): the v4.2.1 escaper did
 *     .replace(/\\/g, '\\\\')            // double every backslash
 * which is only correct when Postgres interprets backslash escapes in '...' literals
 * (standard_conforming_strings = OFF / E'...'). qtp_prod runs the modern default — ON —
 * where '...' literals are verbatim. So JSON.stringify's \" (any payload string that
 * CONTAINS a double quote) became \\" inside the jsonb literal: jsonb reads \\ as one
 * escaped backslash, then the " TERMINATES the JSON string early -> `Token "code" is
 * invalid` -> the WHOLE multi-row INSERT died. Exec 524111 lost all 6 rows because WRB's
 * UNPROTECTED_STOP_TOO_WIDE payload embedded Alpaca's 422 error body (raw JSON, full of
 * quotes) — taking XPEV's tier-1 TRAILING_STOP_MANAGER_RUN down with it. Any cycle where
 * ANY symbol produced an error payload with an embedded quote lost its ENTIRE audit batch
 * — precisely the interesting cycles (recoveries, 422s, protections).
 *
 * v4.2.2 CONTRACT (mirrored verbatim by the live node):
 *   - esc(): standard-conforming — doubles ONLY single quotes, strips NUL (Postgres text
 *     cannot store NUL). No backslash mangling: JSON text passes through byte-correct.
 *   - safeJson(): deep-cleans every string value BEFORE stringify — NUL and lone
 *     surrogates -> U+FFFD — because jsonb REJECTS \u0000 and unpaired surrogate escapes
 *     even in valid JSON. Circular/unserializable payloads degrade to {"__stringify_error"}.
 *   - every payload literal is wrapped in quantum.safe_jsonb(text) — a plpgsql
 *     exception-guarded cast that turns a malformed payload into
 *     {"__jsonb_parse_error":true,"__error":...,"__raw":left(p,8000)} instead of raising.
 *     ONE bad row can NEVER take out the batch again, even if a future edit
 *     reintroduces a corruption class this file doesn't know about.
 *   - hostile eventType (r.message can be an arbitrary error string) truncated to 80
 *     chars before entering idempotency keys / messages.
 *   - byte-identical output to v4.2.1 for payloads with no specials (zero-diff for the
 *     common case; same column list, same idempotency scheme, same hash32 ids).
 */

const MIGRATION_VERSION = 'QTP_SUPABASE_TRAILING_STOP_MANAGER_v4.2.2';
const LEGACY_VERSION = 'QTP_SUPABASE_TRAILING_STOP_MANAGER_v4.2.1';
const SAFE_JSONB_FN = 'quantum.safe_jsonb';
const EVENT_TYPE_MAX = 80;

/** THE BUG, preserved for the regression suite: v4.2.1's escaper. */
function escLegacy(v) {
  return String(v ?? '').replace(/\\/g, '\\\\').replace(/'/g, "''").replace(/\r/g, '\\r').replace(/\n/g, '\\n');
}

/** v4.2.2: correct for standard_conforming_strings=on. Quotes doubled, NUL stripped, nothing else touched. */
function esc(v) { return String(v ?? '').replace(new RegExp(String.fromCharCode(0), 'g'), '').replace(/'/g, "''"); }
function s(v) { return "'" + esc(v) + "'"; }

/** Make a JS string storable by jsonb: NUL and lone surrogates -> U+FFFD. Valid pairs untouched. */
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

/** jsonb-compatible stringify: never throws, never emits a \u0000 escape or a lone-surrogate escape. */
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

/** FNV-1a 32-bit — unchanged from v4.2.1 (audit_id continuity). */
function hash32(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

const COLUMNS = 'audit_id, source_row_id, event_ts, event_date, actor_type, actor_id, workflow_id, workflow_name, run_id, account_id,\n        strategy_id, event_type, event_severity, event_status, entity_type, entity_id, message, before_state, after_state,\n        raw_payload, ip_address, user_agent, correlation_id, idempotency_key, ingested_at';

/**
 * Build the full audit SQL for one cycle.
 * rows: audit event objects from Trail Stops · ctx: {executionId, workflowId, workflowName}
 * opts.legacyEsc: rebuild with the v4.2.1 escaper + naked ::jsonb (regression suite only).
 */
function buildAuditSql(rows, ctx, opts) {
  const legacy = !!(opts && opts.legacyEsc);
  const version = legacy ? LEGACY_VERSION : MIGRATION_VERSION;
  const E = legacy ? escLegacy : esc;
  const S = (v) => "'" + E(v) + "'";
  if (!rows || !rows.length) {
    return { sql: "SELECT 'NO_ROWS' AS audit_status;", migration_version: version, count: 0 };
  }
  const execId = (ctx && ctx.executionId) || 'manual';
  const values = rows.map((r, idx) => {
    r = r || {};
    const sym = String(r.sym || r.symbol || r.ticker || r.asset || 'SYSTEM').toUpperCase().slice(0, 32);
    const status = r.error ? 'ERROR' : 'OK';
    const severity = r.error ? 'WARNING' : 'INFO';
    const eventType = legacy
      ? (r.type || r.action || r.message || 'TRAILING_STOP_MANAGER_RUN')
      : String(r.type || r.action || r.message || 'TRAILING_STOP_MANAGER_RUN').slice(0, EVENT_TYPE_MAX);
    const idem = 'tsm:' + execId + ':' + idx + ':' + sym + ':' + eventType;
    const auditId = 'tsm_' + hash32(idem) + '_' + idx;
    const msg = 'Trailing Stop Manager ' + eventType + ' ' + sym;
    const payloadText = legacy
      ? (() => { try { return JSON.stringify({ ...r, migration_version: version }); } catch (_) { return '{}'; } })()
      : safeJson({ ...r, migration_version: version });
    const payloadSql = legacy ? S(payloadText) + '::jsonb' : SAFE_JSONB_FN + '(' + S(payloadText) + ')';
    return '(' + S(auditId) + ',NULL,CURRENT_TIMESTAMP,CURRENT_DATE,\'system\',\'trailing_stop_manager\',' +
      S((ctx && ctx.workflowId) || 'vFnPjyx8srnzcYgV') + ',' + S((ctx && ctx.workflowName) || 'Trailing Stop Manager v1.5') + ',' +
      S(String(execId === 'manual' ? '' : execId)) + ',NULL,\'trailing_stop_manager\',\'TRAILING_STOP_MANAGER\',' +
      S(severity) + ',' + S(status) + ',\'position\',' + S(sym) + ',' + S(msg) + ',NULL,NULL,' +
      payloadSql + ',NULL,NULL,' + S(sym) + ',' + S(idem) + ',CURRENT_TIMESTAMP)';
  }).join(',\n');
  const sql = '\n      INSERT INTO quantum.audit_trail (\n        ' + COLUMNS + '\n      ) VALUES ' + values + ';\n' +
    '      SELECT COUNT(*)::int AS audit_rows_attempted, \'' + version + '\' AS migration_version;\n    ';
  return { sql, migration_version: version, count: rows.length };
}

/**
 * Decode a standard-conforming Postgres '...' literal — what the server actually hands to
 * the jsonb parser. Used by the suite to reproduce the failure without a database.
 */
function pgUnquoteStandard(literal) {
  if (literal.length < 2 || literal[0] !== "'" || literal[literal.length - 1] !== "'") {
    throw new Error('not a quoted literal');
  }
  return literal.slice(1, -1).replace(/''/g, "'");
}

/** Pull the Nth row's raw_payload literal out of a generated batch (suite helper). */
function extractPayloadLiteral(sql, rowIdx) {
  const naked = /,NULL,NULL,'((?:[^']|'')*)'::jsonb,NULL,NULL,/g;
  const wrapped = new RegExp(',NULL,NULL,' + SAFE_JSONB_FN.replace('.', '\\.') + "\\('((?:[^']|'')*)'\\),NULL,NULL,", 'g');
  const re = sql.indexOf(SAFE_JSONB_FN + "('") >= 0 ? wrapped : naked;
  let m, i = 0;
  while ((m = re.exec(sql)) !== null) {
    if (i === rowIdx) return "'" + m[1] + "'";
    i++;
  }
  throw new Error('payload literal ' + rowIdx + ' not found');
}

module.exports = {
  MIGRATION_VERSION, LEGACY_VERSION, SAFE_JSONB_FN, EVENT_TYPE_MAX, COLUMNS,
  escLegacy, esc, s, cleanStr, safeJson, hash32, buildAuditSql, pgUnquoteStandard, extractPayloadLiteral,
};
