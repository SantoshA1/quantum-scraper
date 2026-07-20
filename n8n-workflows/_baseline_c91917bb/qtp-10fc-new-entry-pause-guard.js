
// QTP-10FC New Entry Pause Guard — Supabase context v4.2.1
// Blocks ONLY new opening entries. Never blocks exits, stops, trailing stops, or closing orders.
// QTP_PAUSE_GUARD_INTENT_PARSE_FIX_v1_20260526
//   Fix: substring-match on 'CLOSE'/'STOP'/'EXIT' was flagging descriptive OR-clause intents
//   like "sell_short_or_close_per_downstream_state" as closing actions, mis-routing every
//   Broad Scanner new-entry signal to Alpaca Position Closer (→ STAND ASIDE / no fill).
//   Now: exact set match OR end-anchored token match, with explicit OR-clause exclusion.
const closingActions = new Set([
  'SELL_TO_CLOSE', 'BUY_TO_COVER', 'CLOSE', 'EXIT', 'STOP', 'TRAILING_STOP',
  'PROTECTIVE_STOP', 'PROTECTION', 'SCALE_OUT', 'REDUCE_ONLY'
]);
// QTP_PAUSE_GUARD_INTENT_PARSE_FIX_v1_20260526 — descriptive OR-clause exclusion
const _PG_OR_CLAUSE_RE = /_OR_(CLOSE|STOP|EXIT)(_|$)/;
// QTP_PAUSE_GUARD_INTENT_PARSE_FIX_v1_20260526 — end-anchored closing token (suffix or exact)
const _PG_CLOSING_TOKEN_RE = /(^|_)(CLOSE|STOP|EXIT)$/;
function isClosingOrProtective(j) {
  const fields = [j.action, j.order_action, j._order_action, j.intent, j.order_intent, j._intent, j.route, j.order_class]
    .map(v => String(v || '').toUpperCase());
  const hit = fields.some(v => {
    if (!v) return false;
    if (_PG_OR_CLAUSE_RE.test(v)) return false;       // explicit allow for descriptive OR-clauses
    if (closingActions.has(v)) return true;            // exact set membership
    if (_PG_CLOSING_TOKEN_RE.test(v)) return true;     // end-anchored token (..._CLOSE / ..._STOP / ..._EXIT)
    return false;
  });
  if (hit) return true;
  if (j.reduce_only === true || j._reduce_only === true) return true;
  if (j.is_protective === true || j._is_protective === true) return true;
  return false;
}
// Supabase pause control is attached by Format Supabase Pause Guard Context.

return items.map(item => {
  const j = item.json || {};
  const pause = j._supabase_pause_control || {};
  const pauseActive = String(pause.pause_new_entries).toLowerCase() === 'true';

  // QTP_EXEC_FLOW_V2_RISK_OBSERVABILITY_20260506 — observability only, no logic/routing change.
  j._risk_gate_observability = {
    version: 'QTP_EXEC_FLOW_V2_20260506',
    observed_at: new Date().toISOString(),
    ticker: j.ticker || j.symbol || j.Ticker || j.Symbol || null,
    execution: j.execution || j.side || j.direction || j.signal_direction || null,
    legacy_live_vc_score: Number(j.live_vc_score ?? 0),
    live_vc_score_v2: Number(j.live_vc_score_v2 ?? 0),
    vc_threshold_locked: 7,
    vc_v2_passed: Number(j.live_vc_score_v2 ?? 0) >= 7,
    vc_legacy_passed: Number(j.live_vc_score ?? 0) >= 7,
    parity_delta: Number(j._vc_parity_delta ?? 0),
    risk_gate_logic_changed: false,
    alpaca_routing_changed: false,
    protective_exit_logic_changed: false,
    pause_guard_intent_parse_fix_v: 'QTP_PAUSE_GUARD_INTENT_PARSE_FIX_v1_20260526'
  };

  if (isClosingOrProtective(j)) {
    return { json: { ...j, _pause_guard_checked: true, _pause_guard_action: 'BYPASS_PROTECTIVE_OR_CLOSING', _pause_guard_live_order_allowed: true, _pause_guard_fix_v: 'QTP_PAUSE_GUARD_INTENT_PARSE_FIX_v1_20260526' } };
  }
  if (pauseActive) {
    return { json: { ...j, _pause_guard_checked: true, _pause_guard_action: 'BLOCK_NEW_ENTRY_ONLY', _pause_guard_live_order_allowed: false, _pause_guard_reason: pause.reason || 'pause_new_entries=true', _sm_action: 'KILLED', _sm_route: 'SKIP', _sm_reason: `New entry paused by QTP-10FC: ${pause.reason || 'pause_new_entries=true'}`, _pause_guard_fix_v: 'QTP_PAUSE_GUARD_INTENT_PARSE_FIX_v1_20260526' } };
  }
  return { json: { ...j, _pause_guard_checked: true, _pause_guard_action: 'ALLOW_NEW_ENTRY', _pause_guard_live_order_allowed: true, _pause_guard_fix_v: 'QTP_PAUSE_GUARD_INTENT_PARSE_FIX_v1_20260526' } };
});
