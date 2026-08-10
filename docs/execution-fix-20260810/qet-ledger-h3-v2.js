// QET H3-legacy (Phase 2, 2026-07-10): stage a trade_ledger row for every SUBMITTED
// pipeline entry. Entry fill price/time left NULL — H4 exit-sync backfills from the broker.
// Arms the stop-out cooldown + edge measurement for qtp-main-pipeline flow.
const j = $input.first().json;
// QET_H3_STATUS_FAMILY_v2_20260810 (with APT v4.9): the exact-match list below was written
// when there were exactly four non-executing statuses. v4.9 introduces four more —
// SKIPPED_NO_FILL_WITHIN_CAP, SKIPPED_NO_FILL_CANCEL_FAILED, ERROR_FILL_STATE_UNKNOWN and
// BLOCKED_EXEC_CAP — and an exact-match list silently fails OPEN on every one of them.
// Three of the four happen to be caught downstream by the qty/entry guards, but by accident,
// not by design; ERROR_FILL_STATE_UNKNOWN carries a full qty and would have staged a
// trade_ledger row for a trade whose fill we explicitly said we could not determine.
// A phantom open row is the worse failure: it feeds H4, the divergence detector and Gate-K's
// edge sample, which is exactly the contamination R3 exists to prevent. A real position with
// no ledger row is loud and already has a detector. So: match on FAMILY, and fail closed.
const bad = ['SKIPPED', 'REJECTED', 'BLOCKED_RISK_GATE', 'ERROR'];
const st = String(j.alpaca_status || '');
const stBlocked = bad.includes(st) ||
  st.startsWith('SKIPPED') || st.startsWith('REJECTED') || st.startsWith('BLOCKED') || st.startsWith('ERROR');
if (!j.alpaca_entry_id || stBlocked) {
  return [{ json: { sql: 'SELECT 1 AS h3_noop', h3: 'skipped', alpaca_status: st } }];
}
const esc = (s) => s == null ? '' : String(s).replace(/'/g, "''");
const num = (v) => (v === null || v === undefined || v === '' || isNaN(Number(v))) ? null : Number(v);
const sym = String(j.ticker || '').toUpperCase();
const side = String(j.alpaca_side || '') === 'sell' ? 'sell' : 'buy';
const qty = num(j.alpaca_qty);
const entry = num(j.alpaca_signal_price) || num(j.alpaca_fresh_price);
const stopN = num(j.alpaca_stop_price); // numeric for bracket path; null for 'trail:x%'
const isVol = j.alpaca_is_volatile === true;
const target = num(j.alpaca_tp_price);
if (!sym || !qty || !entry) { return [{ json: { sql: 'SELECT 1 AS h3_noop', h3: 'skipped_missing_fields' } }]; }
let risk = null;
if (stopN) risk = Math.abs(entry - stopN) * qty;
else if (isVol) risk = entry * 0.03 * qty; // trailing 3% risk basis
if (!risk || risk <= 0) { return [{ json: { sql: 'SELECT 1 AS h3_noop', h3: 'skipped_no_risk_basis' } }]; }
const g = j.__qet_gate || {};
// QET_H3_EXEC_REGIME_v2_20260810 (E3): without these keys the execution regime exists only
// in the n8n execution payload, and the pre- vs post-fix comparison the Conclave asked for
// could not be run from trade_ledger at all. fill_price and risk_amount_at_fill are recorded
// but NOT used: risk_amount below still uses intended_entry, deliberately, because changing
// the risk basis mid-rebuild would mix two bases inside one Gate-K sample. Both numbers are
// here so the Conclave can rule on that rather than discover it.
const _fillPx = num(j.alpaca_fill_price);
const meta = JSON.stringify({ gate: g, volatile: isVol, trail_sl_id: j.alpaca_sl_id || null, tp_id: j.alpaca_tp_id || null, bracket_v: j.alpaca_bracket_v || null, anchor: j.alpaca_anchor_used || null, source: 'qtp-main-pipeline',
  exec_regime: j.alpaca_exec_regime || null,
  exec_cap_pct: j.alpaca_exec_cap_pct === undefined ? null : j.alpaca_exec_cap_pct,
  limit_price: j.alpaca_limit_price === undefined ? null : j.alpaca_limit_price,
  fill_price: _fillPx,
  poll_outcome: j.alpaca_poll_outcome || null,
  partial_fill: j.alpaca_partial_fill === true,
  stop_reanchored: !!(j.alpaca_stop_reanchor && j.alpaca_stop_reanchor.ok),
  stop_price_initial: j.alpaca_stop_price_initial === undefined ? null : j.alpaca_stop_price_initial,
  risk_amount_at_fill: (_fillPx && stopN) ? Math.round(Math.abs(_fillPx - stopN) * qty * 100) / 100 : null
}).split('$qet$').join('');
const extraCol = (isVol && j.alpaca_sl_id) ? ', exit_order_id' : '';
const extraVal = (isVol && j.alpaca_sl_id) ? ", '" + esc(j.alpaca_sl_id) + "'" : '';
const sql = 'INSERT INTO public.trade_ledger (user_id, portfolio_id, strategy, mode, symbol, side, qty, confidence, signal_time, intended_entry, intended_stop, intended_target, risk_amount, risk_pct_applied, sizing_meta, entry_order_id' + extraCol + ") VALUES ('04a6a5d7-ddc0-437f-b95b-5340941c0742'::uuid, '38aa32eb-4269-4f13-bb36-f0a538db8ab7'::uuid, 'qtp-main-pipeline', 'paper', '" + esc(sym) + "', '" + side + "', " + qty + ', ' + (num(j.__qet_conf) === null ? 'NULL' : num(j.__qet_conf)) + ', now(), ' + entry + ', ' + (stopN === null ? 'NULL' : stopN) + ', ' + (target === null ? 'NULL' : target) + ', ' + Math.round(risk * 100) / 100 + ', ' + (g.risk_pct == null ? 'NULL' : g.risk_pct) + ', $qet$' + meta + "$qet$::jsonb, '" + esc(j.alpaca_entry_id) + "'" + extraVal + ') RETURNING id';
return [{ json: { sql: sql, h3: 'staged', symbol: sym, qty: qty } }];