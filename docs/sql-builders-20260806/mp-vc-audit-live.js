
// QTP-BACKTEST-AUDIT-FIX v4.2.1
// Build PostgreSQL audit insert using Supabase PostgreSQL.
// Non-blocking: insert is performed by the next Postgres node; downstream gets original signal back.
const crypto = require('crypto');
function uuidv4() { return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex').replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5'); }
function hash(v) { return crypto.createHash('sha256').update(String(v || '')).digest('hex'); }
function esc(v) { if (v === undefined || v === null) return 'NULL'; return "'" + String(v).replace(/'/g, "''").slice(0, 20000) + "'"; }
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
  ${esc(idem)}, ${esc(JSON.stringify({ ...j, signal_id, strategy_config_hash, backtest_audit_v: 'QTP_BACKTEST_AUDIT_SUPABASE_PG_v4.2.1' }))}, CURRENT_TIMESTAMP
)
ON CONFLICT (idempotency_key) DO NOTHING
RETURNING forensic_id;`;
  out.push({ json: { ...j, signal_id, strategy_config_hash, __supabase_backtest_audit_sql: sql, backtest_audit_sink: 'supabase_postgres.quantum.vc_gate_forensics_shadow' } });
}
return out;
