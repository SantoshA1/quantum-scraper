// PF_MARGIN Bypass Gate v1.0 - Option 2 PF_MARGIN paper bypass
// Reads upstream item.json (from QTP Bias Filter output) + flag row (from Flag Reader)
// Evaluates 13 conditions in EXACT brief order, fail-closed at first failure.
// Tightening 1: is_test_injection===true OR harness===true (legacy) marks signal as TEST.
// Tightening 2: ANY routed test signal MUST have is_dummy=true at insert time.
// C3 explicit: per architect d224664c, _bias_filter_pass must be true (NOT redundant — Splitter routes downstream of tap).
// LIVE path FAIL-CLOSED PANIC: not wired yet.

// Wiring (PATH C, Option α): QTP Bias Filter -> PF_MARGIN Flag Reader -> PF_MARGIN Bypass Gate (this node) -> Executor -> Trade Insert -> Telegram
// $input.first().json == flag row (from Flag Reader, the direct upstream postgres node).
// $('QTP Bias Filter') exposes the original signal item that originated this branch.
let flagRow = null;
try { flagRow = $input.first()?.json || null; } catch (_) {}

let j = {};
try { j = $('QTP Bias Filter').first()?.json || {}; } catch (_) { j = {}; }
if (!flagRow || !flagRow.flag_name) {
  return [{ json: {
    ...j,
    _pfm_routed: false,
    _pfm_route_mode: 'skip',
    _pfm_reason: 'flag_row_missing_fail_closed',
    _pfm_version: 'v1.0',
    _pfm_skip_at_condition: 0
  }}];
}

// ---------- helpers ----------
function num(v, d=0) { const n = Number(String(v ?? '').replace('%','').trim()); return Number.isFinite(n) ? n : d; }
function strU(v) { return String(v ?? '').trim().toUpperCase(); }
function boolish(v) {
  if (v === true) return true;
  if (v === false) return false;
  const s = String(v ?? '').trim().toLowerCase();
  return ['true','1','yes','y','on','pass','passed','allow'].includes(s);
}

const raw = (j.raw_payload && typeof j.raw_payload === 'object') ? j.raw_payload : {};

// ---------- test marker (Tightening 1) ----------
const is_test_injection = (raw.is_test_injection === true) || (raw.harness === true);
const has_legacy_harness_only = (raw.harness === true) && (raw.is_test_injection !== true);

// ---------- gate inputs: raw_payload.force_* overrides upstream ----------
function take(forceKey, ...upstreamFallbacks) {
  if (raw[forceKey] !== undefined && raw[forceKey] !== null) return raw[forceKey];
  for (const v of upstreamFallbacks) {
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return undefined;
}

const det_score        = num(take('force_det_score', j.det_score, j.deterministic_score, j._mtf_deterministic_score, j.mtf_confluence_score), NaN);
const backtest_pf      = num(take('force_backtest_pf', j.backtest_pf, j._backtest_profit_factor), NaN);
const bias_pass        = (raw.force_bias !== undefined && raw.force_bias !== null)
                          ? (strU(raw.force_bias) === 'BIAS_PASS' || boolish(raw.force_bias))
                          : (j._bias_filter_pass === true);
const vc_in            = take('force_vc', j.vc_gate_decision, j._vc_decision, j.gate_decision);
const vc_pass          = strU(vc_in) === 'VC_PASS' || strU(vc_in) === 'PASS' || boolish(vc_in);
const risk_gate_in     = take('force_risk_gate_decision', j.risk_gate_decision);
const risk_gate_pass   = strU(risk_gate_in) === 'RISK_PASS';
const pause_guard_in   = take('force_pause_guard', j.pause_guard_pass, j.pause_status);
const pause_guard_pass = boolish(pause_guard_in) || strU(pause_guard_in) === 'PASS' || strU(pause_guard_in) === 'OK';
const spread_pct       = num(take('force_spread_pct', j.spread_pct, (j.spread_bps != null ? j.spread_bps/100 : null)), NaN);
const symbol           = strU(j.symbol || j.ticker || raw.ticker);
const side             = strU(j.side || raw.side);

// ---------- emit shape: defaults ----------
const out = {
  ...j,
  _pfm_routed: false,
  _pfm_route_mode: 'skip',
  _pfm_reason: '',
  _pfm_skip_at_condition: 0,
  _pfm_is_test_injection: is_test_injection,
  _pfm_has_legacy_harness_only: has_legacy_harness_only,
  _pfm_flag_value: flagRow.flag_value,
  _pfm_flag_enabled: flagRow.enabled === true,
  _pfm_symbol: symbol,
  _pfm_side: side,
  _pfm_det_score: det_score,
  _pfm_backtest_pf: backtest_pf,
  _pfm_bias_pass: bias_pass,
  _pfm_vc_pass: vc_pass,
  _pfm_risk_gate_pass: risk_gate_pass,
  _pfm_pause_guard_pass: pause_guard_pass,
  _pfm_spread_pct: spread_pct,
  _pfm_version: 'v1.0',
  _pfm_decided_at: new Date().toISOString()
};

function skip(condN, reason) {
  return [{ json: { ...out, _pfm_routed: false, _pfm_route_mode: 'skip', _pfm_reason: reason, _pfm_skip_at_condition: condN } }];
}

// ---------- 13 conditions (brief order) ----------

// C0: flag.enabled must be true (kill switch)
if (flagRow.enabled !== true) return skip(0, 'disabled_flag');

// C0a: halted_until in future ⇒ skip
if (flagRow.halted_until && new Date(flagRow.halted_until).getTime() > Date.now()) {
  return skip(0, 'halted:' + (flagRow.halt_reason || 'unknown'));
}

// C1: DET score in [65, 100)
if (!(det_score >= 65 && det_score < 100)) return skip(1, `det_score_out_of_range:${det_score}`);

// C2: backtest_pf in [1.00, 1.20)
if (!(backtest_pf >= 1.00 && backtest_pf < 1.20)) return skip(2, `pf_out_of_window:${backtest_pf}`);

// C3: bias_filter_pass === true (EXPLICIT — architect d224664c)
if (bias_pass !== true) return skip(3, 'bias_filter_not_pass');

// C4: VC pass
if (vc_pass !== true) return skip(4, 'vc_not_pass');

// C5: risk_gate_decision === 'RISK_PASS'
if (risk_gate_pass !== true) return skip(5, 'risk_gate_unavailable');

// C6: pause_guard pass
if (pause_guard_pass !== true) return skip(6, 'pause_guard_block');

// C7: spread_pct must be present and < 0.5%
if (!Number.isFinite(spread_pct) || !(spread_pct < 0.5)) return skip(7, `spread_too_wide:${spread_pct}`);

// C8: symbol present
if (!symbol) return skip(8, 'no_symbol');

// C9: side ∈ {BUY, SELL, LONG, SHORT}
if (!['BUY','SELL','LONG','SHORT'].includes(side)) return skip(9, `invalid_side:${side}`);

// C10: daily_trade_count < 2 (max 2/day)
if (Number(flagRow.daily_trade_count || 0) >= 2) return skip(10, 'daily_trade_cap_reached');

// C11: consecutive_losses < 2
if (Number(flagRow.consecutive_losses || 0) >= 2) return skip(11, 'consecutive_loss_halt');

// C12: daily_pnl_dollars > -5 (architect amendment: was -200)
if (Number(flagRow.daily_pnl_dollars || 0) <= -5) return skip(12, 'daily_dd_halt');

// C13: notional cap; raised $50 -> $1000 on 2026-06-29 (PO) for paper-canary fills. Executor sizes whole-share floor(cap/price). Still bounded: daily_trade_count<2, paper-only, T+60m sweep.
const NOTIONAL_CAP = 1000.0;

// ---------- ROUTING DECISION ----------
const fv = strU(flagRow.flag_value);
let route_mode = 'skip';
let mode_reason = '';

if (fv === 'OFF_AWAITING_DUMMY_QA' || fv === 'TESTS_PASSED_AWAITING_GO_LIVE') {
  // QA states — bypass enabled=true here is unusual but possible during Step C tests
  // Still treat as skip (these are NOT live values)
  route_mode = 'skip';
  mode_reason = `flag_value_not_live:${fv}`;
} else if (fv === 'QA_PASSED_AWAITING_GO_LIVE') {
  // Steps A, D, E (dry-run): write audit row, NO Alpaca call
  route_mode = 'dry_run';
} else if (fv === 'TEST_E2E_CANCEL_ONLY') {
  // Step F: submit-then-cancel real Alpaca paper order
  route_mode = 'test_cancel';
} else if (fv === 'PAPER_FILL_V1') {
  route_mode = 'paper_fill';
  mode_reason = 'routed_paper_fill_v1';
} else if (fv === 'LIVE') {
  // FAIL-CLOSED PANIC: LIVE path not wired (no exit handler). Route to Executor's panic branch so it logs + refuses, then skip.
  // We still set routed=true so the Executor sees it (and refuses). Trade Insert will NOT fire because Executor returns no executor_result on panic.
  route_mode = 'panic_live_not_wired';
  mode_reason = 'LIVE_branch_reached_but_exit_handler_unwired_failclosed';
} else {
  // Unknown flag_value → fail closed
  route_mode = 'skip';
  mode_reason = `unknown_flag_value:${fv}`;
}

// Tightening 1 audit: harness-only without is_test_injection is allowed but flagged
if (route_mode !== 'skip' && has_legacy_harness_only) {
  out._pfm_legacy_harness_warning = 'harness=true without is_test_injection=true — accepted as legacy alias';
}

// Build Alpaca payload skeleton (used by Executor for test_cancel only; dry_run ignores)
const alpaca_payload = {
  symbol: symbol,
  notional: String(NOTIONAL_CAP.toFixed(2)),
  side: (side === 'BUY' || side === 'LONG') ? 'buy' : 'sell',
  type: 'market',
  time_in_force: 'day',
  client_order_id: `EXP-PFM-${Date.now()}-${Math.random().toString(36).slice(2,8)}`
};

if (route_mode === 'skip') {
  return skip(13, mode_reason || 'flag_state_not_routable');
}

return [{ json: {
  ...out,
  _pfm_routed: true,
  _pfm_route_mode: route_mode,
  _pfm_reason: mode_reason || `routed_${route_mode}`,
  _pfm_alpaca_payload: alpaca_payload,
  _pfm_notional_cap: NOTIONAL_CAP
}}];
