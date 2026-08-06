'use strict';
/**
 * QTP_SAFE_PG_v1_20260806 — canonical SQL-literal helpers for every Prepare-SQL builder.
 *
 * Born from the exec-524111 audit-escaping RCA (gov 187) and the fleet sweep that found the
 * same defect class in 7 more nodes (docs/SQL-BUILDER-SWEEP-20260806.md). One set of rules:
 *
 *  - TEXT literals: double single quotes, strip NUL. NOTHING else — the database runs
 *    standard_conforming_strings=on, where backslash "escaping" corrupts data and, inside
 *    jsonb, kills statements. Bound length BEFORE escaping (slicing after can split a
 *    doubled '' pair and unbalance the literal).
 *  - JSON for jsonb columns: stringify with a deep string-cleaner (NUL and lone surrogates
 *    -> U+FFFD; jsonb rejects both), never throw (circular -> {"__stringify_error"}), then
 *    encode every dollar sign as the JSON escape $ — the SQL text carries no literal
 *    `$`, so the n8n/pg-promise $-param scanner finds nothing, while jsonb decodes it back
 *    to a REAL dollar sign (ends the "USD 3" content corruption). Oversize payloads are
 *    re-wrapped as {"__oversize":true,...} — never sliced mid-JSON.
 *  - Every jsonb literal goes through quantum.safe_jsonb(text) (migration
 *    qtp_safe_jsonb_20260806): a malformed payload degrades to a __jsonb_parse_error row
 *    instead of killing the statement — and with it the batch, the cycle, or the trade.
 *
 * NUL/U+FFFD are built via String.fromCharCode so source stays pure ASCII through every
 * JSON/export layer (standing rule, action log 2026-08-06).
 */

const SAFE_JSONB_FN = 'quantum.safe_jsonb';

/** TEXT literals: quotes doubled, NUL stripped, nothing else touched. */
function escText(v) { return String(v ?? '').replace(new RegExp(String.fromCharCode(0), 'g'), '').replace(/'/g, "''"); }

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

/**
 * jsonb-ready JSON text: never throws, never emits NUL/lone-surrogate escapes, carries no
 * literal `$` (encoded as $ — decodes back to a real dollar sign inside jsonb).
 * maxLen: oversize payloads re-wrap as {"__oversize":true, bytes, head} — never mid-JSON slices.
 */
function jsonText(v, maxLen) {
  let t;
  try {
    t = JSON.stringify(v ?? {}, (k, val) => (typeof val === 'string' ? cleanStr(val) : val));
  } catch (e) {
    try { t = JSON.stringify({ __stringify_error: cleanStr(String((e && e.message) || e)) }); }
    catch (_) { t = '{}'; }
  }
  if (typeof t !== 'string') t = '{}';
  if (maxLen && t.length > maxLen) {
    const head = cleanStr(t).slice(0, Math.max(200, Math.floor(maxLen / 4)));
    t = JSON.stringify({ __oversize: true, bytes: t.length, head });
  }
  return t.replace(/\$/g, '\\u0024');
}

/** The one way to put a payload into a jsonb column: guarded cast over clean JSON text.
 *  (Function name inlined as a literal so node copies are byte-identical to this body.) */
function safeJsonbLit(v, maxLen) { return "quantum.safe_jsonb('" + escText(jsonText(v, maxLen)) + "')"; }

module.exports = { SAFE_JSONB_FN, escText, cleanStr, jsonText, safeJsonbLit };
