
// QTP-BACKTEST-AUDIT-FIX v4.2.1
// Supabase PostgreSQL migration: use Supabase PostgreSQL-compatible shadow fields.
// Shadow-only. No blocking. No order placement impact.
function n(v) { const x = Number(String(v ?? '').replace('%','').trim()); return Number.isFinite(x) ? x : null; }
const out = [];
for (const item of items) {
  const j = item.json || {};
  const sample = n(j.backtest_sample_size ?? j.strat_total_trades ?? j.backtest_sample);
  const pf = n(j.backtest_profit_factor ?? j.strat_profit_factor ?? j.backtest_pf);
  let decision = 'no_backtest_available';
  if (sample !== null || pf !== null) decision = (sample >= 100 && pf >= 1.2) ? 'would_pass' : 'would_block';
  out.push({ json: {
    ...j,
    shadow_gate: {
      decision,
      backtest_score: pf,
      backtest_sample: sample,
      backtest_profit_factor: pf,
      backtest_run_id: null,
      audit_source: 'supabase_postgres_payload_metrics',
      audit_v: 'QTP_BACKTEST_AUDIT_SUPABASE_PG_v4.2.1'
    }
  }});
}
return out;
