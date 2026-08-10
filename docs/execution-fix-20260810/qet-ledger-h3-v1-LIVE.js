// QET H3-legacy (Phase 2, 2026-07-10): stage a trade_ledger row for every SUBMITTED
// pipeline entry. Entry fill price/time left NULL — H4 exit-sync backfills from the broker.
// Arms the stop-out cooldown + edge measurement for qtp-main-pipeline flow.
const j = $input.first().json;
const bad = ['SKIPPED', 'REJECTED', 'BLOCKED_RISK_GATE', 'ERROR'];
const st = String(j.alpaca_status || '');
if (!j.alpaca_entry_id || bad.includes(st)) {
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
const meta = JSON.stringify({ gate: g, volatile: isVol, trail_sl_id: j.alpaca_sl_id || null, tp_id: j.alpaca_tp_id || null, bracket_v: j.alpaca_bracket_v || null, anchor: j.alpaca_anchor_used || null, source: 'qtp-main-pipeline' }).split('$qet$').join('');
const extraCol = (isVol && j.alpaca_sl_id) ? ', exit_order_id' : '';
const extraVal = (isVol && j.alpaca_sl_id) ? ", '" + esc(j.alpaca_sl_id) + "'" : '';
const sql = 'INSERT INTO public.trade_ledger (user_id, portfolio_id, strategy, mode, symbol, side, qty, confidence, signal_time, intended_entry, intended_stop, intended_target, risk_amount, risk_pct_applied, sizing_meta, entry_order_id' + extraCol + ") VALUES ('04a6a5d7-ddc0-437f-b95b-5340941c0742'::uuid, '38aa32eb-4269-4f13-bb36-f0a538db8ab7'::uuid, 'qtp-main-pipeline', 'paper', '" + esc(sym) + "', '" + side + "', " + qty + ', ' + (num(j.__qet_conf) === null ? 'NULL' : num(j.__qet_conf)) + ', now(), ' + entry + ', ' + (stopN === null ? 'NULL' : stopN) + ', ' + (target === null ? 'NULL' : target) + ', ' + Math.round(risk * 100) / 100 + ', ' + (g.risk_pct == null ? 'NULL' : g.risk_pct) + ', $qet$' + meta + "$qet$::jsonb, '" + esc(j.alpaca_entry_id) + "'" + extraVal + ') RETURNING id';
return [{ json: { sql: sql, h3: 'staged', symbol: sym, qty: qty } }];