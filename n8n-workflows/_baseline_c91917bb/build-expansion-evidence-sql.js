// EXPANSION per-signal evidence builder v1 (2026-07-14). Log-only; never throws.
try {
  const j = $input.first().json || {};
  const sq = (v) => (v === null || v === undefined || v === '') ? 'NULL' : ("'" + String(v).replace(/'/g, "''") + "'");
  const nn = (v) => { const n = Number(v); return (v === null || v === undefined || v === '' || !Number.isFinite(n)) ? 'NULL' : String(n); };
  const bb = (v) => (v === true ? 'true' : (v === false ? 'false' : 'NULL'));
  const active = (j._mtf_shadow_mode === true) || (j._pf_shadow_mode === true);
  const cohort = active ? "'EXPANSION_20260714'" : 'NULL';
  const sid = j.signal_id || j.idempotency_key || null;
  const idem = j.idempotency_key || null;
  const sym = j.ticker || j.symbol || null;
  const side = (j.execution || j.side || '').toString().toUpperCase() || null;
  const sql = 'INSERT INTO quantum.expansion_signal_evidence '
    + '(signal_id, idempotency_key, symbol, side, cohort, expansion_active, mtf_score, mtf_shadow_mode, mtf_final_would_block, mtf_floor_block, final_mtf_decision, pf_shadow_mode, pf_would_block, pf_verdict, pf_value, pf_sample, workflow_version) VALUES ('
    + sq(sid) + ', ' + sq(idem) + ', ' + sq(sym) + ', ' + sq(side) + ', ' + cohort + ', ' + bb(active) + ', '
    + nn(j.mtf_confluence_score) + ', ' + bb(j._mtf_shadow_mode) + ', ' + bb(j._mtf_final_would_block) + ', ' + bb(j._mtf_floor_block) + ', '
    + sq(j.final_mtf_confluence_decision) + ', ' + bb(j._pf_shadow_mode) + ', ' + bb(j._pf_would_block) + ', ' + sq(j._pf_would_block_verdict) + ', '
    + nn(j._pf_value_at_eval) + ', ' + nn(j._pf_sample_at_eval) + ', ' + sq('expansion-attrib-v1') + ')';
  return [{ json: { _ese_sql: sql, _ese_cohort: active ? 'EXPANSION_20260714' : null } }];
} catch (e) {
  return [{ json: { _ese_sql: null, _ese_error: (e.message || String(e)).slice(0, 120) } }];
}