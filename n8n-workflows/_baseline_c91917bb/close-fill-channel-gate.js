
// QTP close/recovery fill Telegram dedup gate.
// Dedups by order ID for 24h so repeated normalized rows do not spam users.
const state = $getWorkflowStaticData('global');
if (!state.qtpCloseFillTelegramDedup) state.qtpCloseFillTelegramDedup = {};
const dedup = state.qtpCloseFillTelegramDedup;
const now = Date.now();
const out = [];
for (const item of $input.all()) {
  const d = item.json || {};
  if (!d.message || d.test_mode === true || d.test_mode === 'true') continue;
  const key = String(d.close_fill_order_id || `${d.ticker}_${d.close_fill_status}_${d.close_fill_qty}_${d.close_fill_price}`);
  const prior = dedup[key] || 0;
  if (now - prior < 24 * 60 * 60 * 1000) continue;
  dedup[key] = now;
  out.push(item);
}
for (const k of Object.keys(dedup)) {
  if (now - dedup[k] > 48 * 60 * 60 * 1000) delete dedup[k];
}
return out;
