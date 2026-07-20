// QTP IDEMPOTENCY GATE v4.2.7
// Suppresses duplicate order candidates before Alpaca. Does not place/cancel/modify orders.
const state = $getWorkflowStaticData('global');
if (!state.qtpSignalIdempotency) state.qtpSignalIdempotency = {};
const now = Date.now();
const out = [];
for (const item of items) {
  const d = item.json || {};
  if (d.test_mode === true || d.test_mode === 'true') {
    out.push({ json: { ...d, alpaca_status: 'SKIPPED', alpaca_reason: 'Synthetic test mode — no paper order placed', blocked_stage: d.blocked_stage || 'TEST_MODE', qtp_idempotency_version: 'QTP_IDEMPOTENCY_GATE_v4.2.7' } });
    continue;
  }
  const key = String(d.idempotency_key || `${d.ticker}_${d.execution}_${d.price}`).slice(0, 220);
  const prior = Number(state.qtpSignalIdempotency[key] || 0);
  if (now - prior < 10 * 60 * 1000) {
    console.log(`[QTP IDEMPOTENCY v4.2.7] duplicate suppressed before Alpaca: ${key}`);
    continue;
  }
  state.qtpSignalIdempotency[key] = now;
  out.push({ json: { ...d, qtp_idempotency_status: 'PASS', qtp_idempotency_key: key, qtp_idempotency_version: 'QTP_IDEMPOTENCY_GATE_v4.2.7' } });
}
for (const k of Object.keys(state.qtpSignalIdempotency)) if (now - Number(state.qtpSignalIdempotency[k] || 0) > 60 * 60 * 1000) delete state.qtpSignalIdempotency[k];
return out;