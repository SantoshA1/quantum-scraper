const raw = $input.all();
let posArr = [];
for (const it of raw) {
  const j = it && it.json;
  if (Array.isArray(j)) posArr = posArr.concat(j);
  else if (j && j.symbol) posArr.push(j);
  else if (j && Array.isArray(j.data)) posArr = posArr.concat(j.data);
}
const SQ = String.fromCharCode(39);
const q = (s) => SQ + String(s == null ? '' : s).split(SQ).join(SQ + SQ) + SQ;
const syms = posArr.map(function (p) { return String((p && p.symbol) || '').toUpperCase(); }).filter(Boolean);
const inList = syms.length ? syms.map(q).join(',') : q('__NO_BROKER_POSITIONS__');
const runTag = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
const prefix = 'possync_' + runTag + '_flat_';
const cols = 'risk_state_id, run_id, account_id, broker, environment, observed_at, observed_date, symbol, quantity, position_qty_abs, protected_qty, unprotected_qty, protection_status, severity, risk_reason, recommended_action, blocks_phase_2, blocks_new_entries, blocks_new_shorts, manual_review_required, source_workflow_name, source_node_name, idempotency_key, ingested_at, updated_at';
const sql =
  'WITH open_before AS (' +
  'SELECT symbol, account_id FROM (' +
  'SELECT DISTINCT ON (symbol) symbol, account_id, quantity FROM quantum.position_risk_state ORDER BY symbol, observed_at DESC' +
  ') s WHERE abs(coalesce(quantity,0)) > 0' +
  ') ' +
  'INSERT INTO quantum.position_risk_state (' + cols + ') ' +
  'SELECT ' +
  q(prefix) + ' || symbol, ' +
  q('position_reconcile') + ', account_id, ' + q('alpaca') + ', ' + q('paper') + ', ' +
  'now(), current_date, symbol, 0, 0, 0, 0, ' +
  q('CLOSED_NO_POSITION') + ', ' + q('INFO') + ', ' +
  q('position_reconcile: symbol absent from live Alpaca /v2/positions; flattened to broker truth') + ', ' + q('none') + ', ' +
  'false, false, false, false, ' +
  q('QTP Position Reconcile - Broker Truth Sync') + ', ' + q('flatten_phantoms') + ', ' +
  q(prefix) + ' || symbol, now(), now() ' +
  'FROM open_before WHERE symbol NOT IN (' + inList + ')';
return [{ json: { __sql: sql, __note: 'ok_' + syms.length + '_broker_positions', __flatten_ok: true, __broker_syms: syms.join(',') } }];