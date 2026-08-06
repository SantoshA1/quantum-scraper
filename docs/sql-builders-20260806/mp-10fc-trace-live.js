
// QTP Supabase Candidate Trace Builder v4.2.2
// Fail-open diagnostic logger. No VC, Bias, Risk, Pause, Alpaca, or protective-exit logic changes.
function esc(v) { return String(v ?? '').replace(/\\/g, '\\\\').replace(/'/g, "''").replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\$(\d)/g, 'USD $1').replace(/\$\{/g, 'USD{'); }
function s(v) { return `'${esc(v)}'`; }
function n(v) { const x = Number(v); return Number.isFinite(x) ? String(x) : 'NULL'; }
function b(v) {
  if (v === true) return 'true';
  if (v === false) return 'false';
  const t = String(v ?? '').toLowerCase();
  if (t === 'true') return 'true';
  if (t === 'false') return 'false';
  return 'NULL';
}
const out = [];
for (const item of items) {
  const j = item.json || {};
  const ticker = String(j.ticker || j.symbol || '').toUpperCase();
  const direction = String(j.execution || j.signal || j.side || j.trade_action || '').toUpperCase();
  const legacyLive = Number(j.live_vc_score ?? j._vc_score_legacy ?? j.vc_score);
  const liveV2 = Number(j.live_vc_score_v2 ?? j._vc_score ?? j.vc_score);
  const shadow = Number(j._vc_shadow_scanner_score);
  const parityDelta = Number(j._vc_parity_delta ?? (Number.isFinite(liveV2) && Number.isFinite(legacyLive) ? Math.round((liveV2 - legacyLive) * 10) / 10 : NaN));
  const traceId = `trace10fc_${Date.now()}_${ticker || 'NA'}_${Math.random().toString(36).slice(2, 8)}`;
  const trace = {
    trace_id: traceId,
    observed_at: new Date().toISOString(),
    ticker,
    signal_direction: direction,
    scanner_score: Number(j.score ?? j.raw_score ?? j.composite_score ?? j.ai_super_score ?? 0),
    ssm_action: j._sm_action || '',
    ssm_reason: j._sm_reason || '',
    live_vc_score: Number.isFinite(legacyLive) ? legacyLive : null,
    shadow_vc_score: Number.isFinite(shadow) ? shadow : null,
    vc_delta: Number.isFinite(legacyLive) && Number.isFinite(shadow) ? Math.round((shadow - legacyLive) * 10) / 10 : null,
    vc_verdict: j._vc_verdict || j._vc_shadow_scanner_verdict || '',
    pause_guard_action: j._pause_guard_action || '',
    live_vc_score_v2: Number.isFinite(liveV2) ? liveV2 : null,
    vc_score_legacy: Number.isFinite(legacyLive) ? legacyLive : null,
    vc_parity_delta: Number.isFinite(parityDelta) ? parityDelta : null,
    vc_gate_candidate_v2_pass: j._vc_gate_candidate_v2_pass,
    vc_gate_candidate_legacy_pass: j._vc_gate_candidate_legacy_pass,
    vc_score_parser_version: j._vc_score_parser_version || ''
  };
  const stmt = `
    INSERT INTO quantum.candidate_path_trace_10fc (
      trace_id, observed_at, workflow_execution_id, ticker, signal_direction,
      scanner_score, ssm_action, ssm_reason, live_vc_score, shadow_vc_score,
      vc_delta, vc_verdict, risk_gate_status, pause_guard_action, alpaca_route,
      blocked_stage, blocked_reason, raw_payload,
      live_vc_score_v2, vc_score_legacy, vc_parity_delta,
      vc_gate_candidate_v2_pass, vc_gate_candidate_legacy_pass, vc_score_parser_version
    ) VALUES (
      ${s(trace.trace_id)}, CURRENT_TIMESTAMP, ${s(String($execution.id || ''))}, ${s(trace.ticker)}, ${s(trace.signal_direction)},
      ${n(trace.scanner_score)}, ${s(trace.ssm_action)}, ${s(trace.ssm_reason)}, ${n(trace.live_vc_score)}, ${n(trace.shadow_vc_score)},
      ${n(trace.vc_delta)}, ${s(trace.vc_verdict)}, ${s(j._risk_gate_status || '')}, ${s(j._pause_guard_action || '')}, ${s(j._alpaca_route || '')},
      ${s(j._blocked_stage || '')}, ${s(j._blocked_reason || '')}, ${s(JSON.stringify(j).slice(0, 12000))},
      ${n(trace.live_vc_score_v2)}, ${n(trace.vc_score_legacy)}, ${n(trace.vc_parity_delta)},
      ${b(trace.vc_gate_candidate_v2_pass)}, ${b(trace.vc_gate_candidate_legacy_pass)}, ${s(trace.vc_score_parser_version)}
    );
    SELECT 'INSERTED' AS candidate_trace_status, ${s(trace.trace_id)} AS trace_id;
  `;
  out.push({ json: { ...j, _10fc_trace: trace, _10fc_trace_logged: true, _candidate_trace_sql: stmt, _candidate_trace_source: 'supabase.candidate_path_trace_10fc' } });
}
return out;
// QTP_TRACE_SQL_DOLLAR_SANITIZE_v1_20260703
