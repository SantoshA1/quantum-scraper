// PF_MARGIN Trade SQL Builder v1.0 - Option 2 PF_MARGIN paper bypass
// Builds the INSERT + flag-counter UPDATE SQL string for the postgres node next.
// Tightening 2: is_dummy is constructed as a SQL CASE — true for any flag_value != 'LIVE'.
//                Bypass code cannot set is_dummy=false unless flag_value='LIVE'. Hard at INSERT site.
// Skip/no-op cases produce a benign SELECT that returns no insert.

const j = $input.first()?.json || {};
const res = j._pfm_executor_result || {};
const execStatus = j._pfm_executor_status || 'noop';
const routeMode  = j._pfm_route_mode || 'skip';
const flagValue  = j._pfm_flag_value || '';
const symbol     = j._pfm_symbol || '';
const side       = j._pfm_side || '';
const isTest     = j._pfm_is_test_injection === true;
const gateReason = j._pfm_reason || '';
const executorReason = j._pfm_executor_reason || '';
const detScore   = (j._pfm_det_score != null && Number.isFinite(j._pfm_det_score)) ? j._pfm_det_score : null;
const backtestPf = (j._pfm_backtest_pf != null && Number.isFinite(j._pfm_backtest_pf)) ? j._pfm_backtest_pf : null;
const entryPrice = (routeMode === 'dry_run')
  ? null
  : ((res.filled_avg_price != null) ? Number(res.filled_avg_price) : (res.submission_intended_price != null ? Number(res.submission_intended_price) : null));
const exitReason = res.exit_reason || null;
const notional   = (res.notional_filled != null) ? Number(res.notional_filled) : null;
const alpacaOrderId = res.alpaca_order_id || null;

const wouldInsert = (execStatus === 'ok' || execStatus === 'warn') && (routeMode === 'dry_run' || routeMode === 'test_cancel' || routeMode === 'paper_fill');

function sqlNum(v) { return (v != null && Number.isFinite(Number(v))) ? Number(v).toString() : 'NULL'; }
function sqlText(v) { return (v == null || v === '') ? 'NULL' : ("'" + String(v).replace(/'/g, "''") + "'"); }

if (!wouldInsert) {
  // No-insert path: emit a benign SELECT so the postgres node returns a row but inserts nothing.
  const sql = "SELECT NULL::uuid AS trade_id, " + sqlText(routeMode) + "::text AS route_mode, NULL::boolean AS is_dummy, NULL::text AS alpaca_order_id, NULL::int AS new_daily_trade_count, 'no_insert_skip'::text AS insert_status;";
  return [{ json: { ...j, _pfm_sql: sql, _pfm_insert_planned: false } }];
}

// Audit JSON: pack additional fields not in the table into raw_alpaca_response
const audit = {
  flag_value_at_decision: flagValue,
  route_mode: routeMode,
  gate_reason: gateReason,
  executor_status: execStatus,
  executor_reason: executorReason,
  is_test_injection: isTest,
  alpaca_order_id: alpacaOrderId,
  submission_intended_price: res.submission_intended_price ?? null,
  submission_ts: res.submission_ts ?? null,
  cancel_status: res.cancel_status ?? null,
  cancel_requested_at: res.cancel_requested_at ?? null,
  alpaca_status: res.alpaca_status ?? null,
  baseline_buying_power: res.baseline_buying_power ?? null,
  post_buying_power: res.post_buying_power ?? null,
  buying_power_delta: res.buying_power_delta ?? null,
  intended_payload: res.intended_payload ?? null,
  raw_submit_response: res.raw_submit_response ?? null,
  raw_final_order: res.raw_final_order ?? null,
  bypass_version: 'v1.0'
};
const auditJson = JSON.stringify(audit).replace(/'/g, "''");

const sql =
  "WITH ins AS (\n" +
  "  INSERT INTO quantum.experiment_paper_trades (\n" +
  "    exp_name, signal_ts, audit_row_ts, symbol, side, is_dummy,\n" +
  "    det_score, backtest_pf, entry_price, entry_ts,\n" +
  "    notional_dollars, exit_reason, raw_alpaca_response\n" +
  "  ) VALUES (\n" +
  "    'pf_margin_paper_bypass', now(), now(),\n" +
  "    " + sqlText(symbol) + ", " + sqlText(side) + ",\n" +
  "    CASE WHEN " + sqlText(flagValue) + " = 'LIVE' THEN false ELSE true END,\n" +
  "    " + sqlNum(detScore) + ", " + sqlNum(backtestPf) + ", " + sqlNum(entryPrice) + ", " + ((routeMode === 'dry_run') ? 'NULL' : 'now()') + ",\n" +
  "    " + sqlNum(notional) + ", " + sqlText(exitReason) + ", '" + auditJson + "'::jsonb\n" +
  "  ) RETURNING trade_id, is_dummy\n" +
  "),\n" +
  "upd AS (\n" +
  "  UPDATE quantum.experiment_flags\n" +
  "  SET daily_trade_count = daily_trade_count + 1, updated_at = now()\n" +
  "  WHERE flag_name = 'pf_margin_paper_bypass' AND EXISTS (SELECT 1 FROM ins)\n" +
  "  RETURNING daily_trade_count\n" +
  ")\n" +
  "SELECT (SELECT trade_id FROM ins LIMIT 1) AS trade_id, " +
  sqlText(routeMode) + "::text AS route_mode, " +
  "(SELECT is_dummy FROM ins LIMIT 1) AS is_dummy, " +
  sqlText(alpacaOrderId) + "::text AS alpaca_order_id, " +
  "(SELECT daily_trade_count FROM upd LIMIT 1) AS new_daily_trade_count, " +
  "'inserted'::text AS insert_status;";

return [{ json: { ...j, _pfm_sql: sql, _pfm_insert_planned: true } }];
