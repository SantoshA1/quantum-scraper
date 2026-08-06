
// QTP-BACKTEST-AUDIT-FIX v4.2.2
// FIX 2026-08-06 (gov 188, exec-524111 class): v4.2.1 sliced AFTER quote-doubling (could
// split a doubled quote -> unbalanced literal) and cast free LLM text into jsonb bare —
// this node sits INLINE in the signal path with onError=stop, so one hostile payload killed
// the trade cycle. v4.2.2: slice-before-escape; raw_payload_json via quantum.safe_jsonb.
// Build PostgreSQL audit insert using Supabase PostgreSQL.
// Non-blocking: insert is performed by the next Postgres node; downstream gets original signal back.
const crypto = require('crypto');
function uuidv4() { return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex').replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5'); }
function hash(v) { return crypto.createHash('sha256').update(String(v || '')).digest('hex'); }
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
function esc(v) { if (v === undefined || v === null) return 'NULL'; return "'" + escText(String(v).slice(0, 20000)) + "'"; }
function num(v) { const n = Number(String(v ?? '').replace('%','').trim()); return Number.isFinite(n) ? String(n) : 'NULL'; }
const out = [];
for (const item of items) {
  const j = item.json || {};
  const signal_id = j.signal_id || uuidv4();
  const strategy_config_hash = j.strategy_config_hash || hash(JSON.stringify(j.strategy_params || {}));
  const forensic_id = `bt_audit_${signal_id}`;
  const idem = `bt_audit:${signal_id}`;
  const sql = `
INSERT INTO quantum.vc_gate_forensics_shadow (
  forensic_id, observed_at, source_table, ticker, timeframe, execution, signal, price,
  vc_score, vc_verdict, vc_feedback, vc_red_flags, ssm_action, ssm_route, ssm_reason,
  regime, daily_trend, spy_status, qqq_status, rsi, bull_score, bear_score,
  idempotency_key, raw_payload_json, created_at
) VALUES (
  ${esc(forensic_id)}, CURRENT_TIMESTAMP, 'main_trading_backtest_audit_supabase',
  ${esc(j.ticker || j.symbol)}, ${esc(j.timeframe || j.tf)}, ${esc(j.execution || j.side)}, ${esc(j.signal)},
  ${num(j.price || j.entry_ref_price)}, ${num(j._vc_score || j.vc_score || j.live_vc_score_v2)}, ${esc(j._vc_verdict || j.vc_verdict)},
  ${esc(j._vc_feedback || j.vc_feedback || j.feedback)}, ${esc(Array.isArray(j._vc_red_flags) ? j._vc_red_flags.join('; ') : j._vc_red_flags)},
  ${esc(j._sm_action || j.ssm_action)}, ${esc(j._sm_route || j.ssm_route)}, ${esc(j._sm_reason || j.ssm_reason)},
  ${esc(j.regime)}, ${esc(j.daily_trend)}, ${esc(j.spy_status)}, ${esc(j.qqq_status)},
  ${num(j.rsi)}, ${num(j.bull_score)}, ${num(j.bear_score)},
  ${esc(idem)}, ${safeJsonbLit({ ...j, signal_id, strategy_config_hash, backtest_audit_v: 'QTP_BACKTEST_AUDIT_SUPABASE_PG_v4.2.2' }, 20000)}, CURRENT_TIMESTAMP
)
ON CONFLICT (idempotency_key) DO NOTHING
RETURNING forensic_id;`;
  out.push({ json: { ...j, signal_id, strategy_config_hash, __supabase_backtest_audit_sql: sql, backtest_audit_sink: 'supabase_postgres.quantum.vc_gate_forensics_shadow' } });
}
return out;
