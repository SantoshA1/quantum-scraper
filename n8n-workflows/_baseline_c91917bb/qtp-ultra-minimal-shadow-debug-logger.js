
// QTP-WRO v4.2.13 — Ultra-Minimal Shadow Debug Logger + Backtest Recommendation Builder
// Place directly after VC Score Parser.
// Shadow-only. Pass-through unchanged. No trading logic impact.

const d = $json || {};

function esc(v) {
  if (v === undefined || v === null) return 'NULL';
  return "'" + String(v).replace(/'/g, "''").slice(0, 5000) + "'";
}

function num(v) {
  const n = Number(String(v ?? '').replace('%', '').trim());
  return Number.isFinite(n) ? String(n) : 'NULL';
}

function nval(v) {
  const n = Number(String(v ?? '').replace('%', '').trim());
  return Number.isFinite(n) ? n : null;
}

function bool(v) {
  return v ? 'true' : 'false';
}

function rawJson(obj) {
  return esc(JSON.stringify(obj).slice(0, 5000));
}

const symbol = String(d.ticker || d.symbol || 'UNKNOWN').toUpperCase();
const side = String(d.execution || d.signal || d.side || 'UNKNOWN').toUpperCase();
const vc = Number(d.live_vc_score_v2 ?? d.vc_live_v2 ?? d.live_vc_score ?? d._vc_score ?? 0);
const bias = Number(String(d.bias_score ?? d.ai_super_score ?? d.composite_score ?? d.score ?? 0).replace('%', '').trim());
const vol = Number(String(d.volume_ratio ?? d.relative_volume ?? 0).replace('%', '').trim());
const cross = String(d.cross_asset || d.cross_asset_status || d.cross_asset_alignment || 'N/A').toUpperCase();

const sample = nval(d._backtest_sample_size ?? d.backtest_sample_size ?? d.backtest_sample ?? d.strat_total_trades ?? d.total_trades);
const pf = nval(d._backtest_profit_factor ?? d.backtest_profit_factor ?? d.backtest_pf ?? d.strat_profit_factor ?? d.profit_factor);
const btValid = sample !== null && pf !== null && sample >= 100 && pf >= 1.2;
const btStatus = btValid ? 'BACKTEST_DATA_OK' : (sample === null || pf === null ? 'NO_BACKTEST_DATA' : 'WEAK_BACKTEST_DATA');

const bias68 = Number.isFinite(bias) && bias >= 68;
const bias70 = Number.isFinite(bias) && bias >= 70;
const secondary = (Number.isFinite(vol) && vol > 1.25) || cross.includes('STRONG') || cross.includes('ALIGNED') || cross.includes('CONFIRMED');

const pass68 = bias68 && secondary;
const pass70 = bias70 && secondary;

const recommendation = pass70 ? 'PASS_70_SHADOW' : pass68 ? 'PASS_68_SHADOW' : 'WOULD_BLOCK_SHADOW';
const reason = `bias=${Number.isFinite(bias) ? bias : 'N/A'}; volume_ratio=${Number.isFinite(vol) ? vol : 'N/A'}; cross=${cross}; secondary=${secondary}; backtest_status=${btStatus}; sample=${sample ?? 'N/A'}; pf=${pf ?? 'N/A'}`;

d._wro_shadow_debug_version = 'QTP_WRO_BACKTEST_RECOMMENDER_v4.2.13_20260513';

d._wro_shadow_debug_sql = `INSERT INTO quantum.wro_shadow_entry_quality_421
(observed_at, symbol, side, vc_live_v2, bias_score, volume_ratio, cross_asset,
 shadow_bias68_pass, shadow_bias70_pass, secondary_confirm_pass,
 shadow_entry_quality_pass_68, shadow_entry_quality_pass_70,
 shadow_recommendation, shadow_reason, gate_decision, raw_payload)
SELECT
 CURRENT_TIMESTAMP,
 ${esc(symbol)},
 ${esc(side)},
 ${num(vc)},
 ${num(bias)},
 ${num(vol)},
 ${esc(cross)},
 ${bool(bias68)},
 ${bool(bias70)},
 ${bool(secondary)},
 ${bool(pass68)},
 ${bool(pass70)},
 ${esc(recommendation)},
 ${esc(reason)},
 ${esc('ultra_minimal_debug_after_vc_parser | audit_v=4.2.13 | backtest_status=' + btStatus)},
 ${rawJson({
   ticker: symbol,
   side,
   vc,
   bias,
   vol,
   cross,
   backtest_status: btStatus,
   backtest_sample: sample,
   backtest_pf: pf,
   version: d._wro_shadow_debug_version
 })}`;

if (!btValid && ['BUY','SELL','LONG','SHORT','BULLISH','BEARISH'].includes(side)) {
  const recType = btStatus === 'NO_BACKTEST_DATA' ? 'BACKTEST_COVERAGE_MISSING' : 'BACKTEST_COVERAGE_WEAK';
  const recId = `qtp_backtest_${symbol}_${side}_${recType}_${new Date().toISOString().slice(0,10)}`;
  const idem = `qtp:backtest:${symbol}:${side}:${recType}:${new Date().toISOString().slice(0,10)}`;
  const metrics = {
    symbol,
    side,
    sample,
    profit_factor: pf,
    backtest_status: btStatus,
    vc_live_v2: vc,
    bias_score: Number.isFinite(bias) ? bias : null,
    source: 'QTP_WRO_BACKTEST_RECOMMENDER_v4.2.13'
  };
  d._optimization_recommendation_sql = `INSERT INTO quantum.optimization_recommendations
  (recommendation_id, generated_at, generated_date, strategy_id, strategy_name, symbol, timeframe, model_version,
   recommendation_type, current_value, recommended_value, confidence, severity, risk_level, reason,
   supporting_metrics, supporting_window, expected_impact, status, source_workflow, source_run_id,
   idempotency_key, raw_payload, ingested_at, updated_at)
SELECT
  ${esc(recId)},
  CURRENT_TIMESTAMP,
  CURRENT_DATE,
  ${esc(String(d.strategy_id || d.strategy || d.alert_type || 'quantum_pipeline'))},
  ${esc(String(d.strategy_name || d.momentum_type || d.alert_type || 'quantum_pipeline'))},
  ${esc(symbol)},
  ${esc(String(d.timeframe || d.tf || '5'))},
  ${esc(String(d.parser_version || d._vc_score_parser_version || d._wro_shadow_debug_version))},
  ${esc(recType)},
  ${esc(`sample=${sample ?? 'NULL'};pf=${pf ?? 'NULL'}`)},
  ${esc('Require sample >=100 and profit factor >=1.2 before allowing high-risk/scalp promotion')},
  CAST(0.90000000 AS DECIMAL(18,8)),
  ${esc(btStatus === 'NO_BACKTEST_DATA' ? 'HIGH' : 'MEDIUM')},
  ${esc('LOW')},
  ${esc(btStatus === 'NO_BACKTEST_DATA'
    ? 'Signal reached VC path without usable backtest sample/profit-factor metadata. Upstream backtest coverage must be populated before strategy promotion.'
    : 'Signal reached VC path with weak backtest evidence below sample/PF threshold. Tune or suppress until evidence improves.')},
  (${rawJson(metrics)})::jsonb,
  ${esc('current_session')},
  ${esc('Improves auditability and prevents weak/missing backtest candidates from silently passing future promotion gates.')},
  ${esc('OPEN_SHADOW')},
  ${esc('Main Trading')},
  ${esc(String($execution?.id || 'no-exec-id'))},
  ${esc(idem)},
  (${rawJson({ ...metrics, raw_keys: Object.keys(d).slice(0, 40) })})::jsonb,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
WHERE NOT EXISTS (
  SELECT 1 FROM quantum.optimization_recommendations
  WHERE idempotency_key = ${esc(idem)}
)`;
}

return [{ json: d }];
