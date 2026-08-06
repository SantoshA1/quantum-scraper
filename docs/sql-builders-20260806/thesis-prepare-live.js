const judgeOut = $input.first().json;
const meta = $('Build Crew Prompts').first().json;
const crew = $('Assemble Judge Request').first().json;
const rawJudge = judgeOut && typeof judgeOut.text === 'string' && judgeOut.text.trim() ? judgeOut.text.trim() : null;
if (!rawJudge) { throw new Error('QTP_DRT FAIL LOUD: Judge returned no text. Raw output head: ' + JSON.stringify(judgeOut).slice(0, 500)); }
let jsonText = String(rawJudge).trim();
const FENCE = String.fromCharCode(96, 96, 96);
if (jsonText.indexOf(FENCE) !== -1) {
  const firstFence = jsonText.indexOf(FENCE);
  let start = jsonText.indexOf('\n', firstFence);
  if (start === -1) start = firstFence + 3; else start = start + 1;
  const end = jsonText.lastIndexOf(FENCE);
  if (end > start) jsonText = jsonText.slice(start, end);
  jsonText = jsonText.trim();
}
let verdict;
try { verdict = JSON.parse(jsonText); } catch (e) {
  throw new Error('QTP_DRT FAIL LOUD: Judge output is not valid strict JSON after fence-stripping. Parse error: ' + e.message + '. Output head: ' + jsonText.slice(0, 400));
}
const missing = [];
if (typeof verdict.market_regime !== 'string' || !verdict.market_regime) missing.push('market_regime');
if (typeof verdict.regime_rationale !== 'string') missing.push('regime_rationale');
if (typeof verdict.spy_view !== 'string') missing.push('spy_view');
if (!Array.isArray(verdict.sector_tilts)) missing.push('sector_tilts');
if (!Array.isArray(verdict.names)) missing.push('names');
if (missing.length) { throw new Error('QTP_DRT FAIL LOUD: Judge JSON missing/invalid required fields: ' + missing.join(', ') + '. Output head: ' + jsonText.slice(0, 400)); }
const degradations = (meta.degradations || []).slice();
degradations.push('vix_level_not_sourced_in_v1');
function sanDollar(s) { return String(s).replace(/\$(?=\d)/g, 'USD '); }
function sqlText(v) { return "'" + sanDollar(v == null ? '' : v).replace(/'/g, "''") + "'"; }
function deepSan(o) { if (typeof o === 'string') return sanDollar(o); if (Array.isArray(o)) return o.map(deepSan); if (o && typeof o === 'object') { const r = {}; for (const k of Object.keys(o)) { r[k] = deepSan(o[k]); } return r; } return o; }
function jsonbLit(o) { return "'" + JSON.stringify(deepSan(o)).replace(/'/g, "''") + "'::jsonb"; }
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
  "'QTP_DRT_CREW_v1.0_20260706', " +
  ttlSql + ', ' +
  jsonbLit(rawPayload) + ', ' +
  sqlText(notes) +
  ') RETURNING thesis_id, thesis_date, market_regime, regime_confidence;';
if (/\$\d/.test(insertSql)) { throw new Error('QTP_DRT FAIL LOUD: insert_sql still contains a $<digit> sequence after sanitization - refusing to send (pg-param bug guard).'); }
return [{ json: { insert_sql: insertSql, thesis_id: thesisId } }];
