// QTP_DRT v1.1 FIX 2026-08-06 (gov 188, exec-524111 class): v1.0 jsonbLit died on
// NUL/lone-surrogate escapes in LLM prose, and deepSan's $-defang corrupted stored content
// (USD 3 instead of $3). v1.1: canonical jsonText — real dollars preserved as \\u0024 (no
// literal $ reaches the SQL text, so the workflow's own /\\$\\d/ refusal guard still passes),
// payloads through quantum.safe_jsonb. deepSan/sanDollar retained for plain-text columns.
const judgeOut = $input.first().json;
const meta = $('Build Crew Prompts').first().json;
const crew = $('Assemble Judge Request').first().json;
const rawJudge = judgeOut && typeof judgeOut.text === 'string' && judgeOut.text.trim() ? judgeOut.text.trim() : null;
if (!rawJudge) { throw new Error('QTP_DRT FAIL LOUD: Judge returned no text. Raw output head: ' + JSON.stringify(judgeOut).slice(0, 500)); }
let judgeText = String(rawJudge).trim();
const FENCE = String.fromCharCode(96, 96, 96);
if (judgeText.indexOf(FENCE) !== -1) {
  const firstFence = judgeText.indexOf(FENCE);
  let start = judgeText.indexOf('\n', firstFence);
  if (start === -1) start = firstFence + 3; else start = start + 1;
  const end = judgeText.lastIndexOf(FENCE);
  if (end > start) judgeText = judgeText.slice(start, end);
  judgeText = judgeText.trim();
}
let verdict;
try { verdict = JSON.parse(judgeText); } catch (e) {
  throw new Error('QTP_DRT FAIL LOUD: Judge output is not valid strict JSON after fence-stripping. Parse error: ' + e.message + '. Output head: ' + judgeText.slice(0, 400));
}
const missing = [];
if (typeof verdict.market_regime !== 'string' || !verdict.market_regime) missing.push('market_regime');
if (typeof verdict.regime_rationale !== 'string') missing.push('regime_rationale');
if (typeof verdict.spy_view !== 'string') missing.push('spy_view');
if (!Array.isArray(verdict.sector_tilts)) missing.push('sector_tilts');
if (!Array.isArray(verdict.names)) missing.push('names');
if (missing.length) { throw new Error('QTP_DRT FAIL LOUD: Judge JSON missing/invalid required fields: ' + missing.join(', ') + '. Output head: ' + judgeText.slice(0, 400)); }
const degradations = (meta.degradations || []).slice();
degradations.push('vix_level_not_sourced_in_v1');
function sanDollar(s) { return String(s).replace(/\$(?=\d)/g, 'USD '); }
function sqlText(v) { return "'" + sanDollar(v == null ? '' : v).replace(/'/g, "''") + "'"; }
function deepSan(o) { if (typeof o === 'string') return sanDollar(o); if (Array.isArray(o)) return o.map(deepSan); if (o && typeof o === 'object') { const r = {}; for (const k of Object.keys(o)) { r[k] = deepSan(o[k]); } return r; } return o; }
// === QTP_SAFE_PG_v1_20260806 canonical helpers (lib/sql/safe_pg.js — lockstep, do not hand-edit) ===
function escText(v) { return String(v ?? '').replace(new RegExp(String.fromCharCode(0), 'g'), '').replace(/'/g, "''"); }
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
function safeJsonbLit(v, maxLen) { return "quantum.safe_jsonb('" + escText(jsonText(v, maxLen)) + "')"; }
// === end canonical helpers ===
function jsonbLit(o) { return safeJsonbLit(o); }
let rc = Number(verdict.regime_confidence);
let rcSql;
if (Number.isFinite(rc)) { rcSql = String(Math.max(0, Math.min(1, rc))); } else { rcSql = 'NULL'; degradations.push('regime_confidence_not_numeric'); }
const et = $now.setZone('America/New_York');
const thesisId = 'drt_' + et.toFormat('yyyyMMdd_HHmm');
const ttlSql = "('" + meta.trading_date + " 16:30:00'::timestamp AT TIME ZONE 'America/New_York')";
const rawPayload = { bull: crew.bull_text, bear: crew.bear_text, judge_raw: rawJudge };
const notes = 'QTP_DRT v1: ' + (degradations.length ? 'degradations: ' + degradations.join('; ') : 'clean run');
const insertSql = 'INSERT INTO quantum.daily_research_thesis (thesis_id, thesis_date, market_regime, regime_confidence, regime_rationale, vix_level, spy_view, sector_tilts, names, bull_model, bear_model, judge_model, crew_version, ttl_expires_at, raw_payload, notes) VALUES (' +
  sqlText(thesisId) + ', ' +
  "'" + meta.trading_date + "'::date, " +
  sqlText(verdict.market_regime) + ', ' +
  rcSql + ', ' +
  sqlText(verdict.regime_rationale) + ', ' +
  'NULL, ' +
  sqlText(verdict.spy_view) + ', ' +
  jsonbLit(verdict.sector_tilts) + ', ' +
  jsonbLit(verdict.names) + ', ' +
  "'grok-3-mini', 'grok-3-mini', 'grok-3', " +
  "'QTP_DRT_CREW_v1.1_20260806', " +
  ttlSql + ', ' +
  jsonbLit(rawPayload) + ', ' +
  sqlText(notes) +
  ') RETURNING thesis_id, thesis_date, market_regime, regime_confidence;';
if (/\$\d/.test(insertSql)) { throw new Error('QTP_DRT FAIL LOUD: insert_sql still contains a $<digit> sequence after sanitization - refusing to send (pg-param bug guard).'); }
return [{ json: { insert_sql: insertSql, thesis_id: thesisId } }];
