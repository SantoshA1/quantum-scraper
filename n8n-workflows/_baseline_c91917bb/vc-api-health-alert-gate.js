
// VC API health alert gate. Sends Telegram only for repeated SE-C7/circuit events.
const out = [];
for (const item of $input.all()) {
  const d = item.json || {};
  if (!d._vc_api_health_alert) continue;
  const msg = [
    '<b>VC API RESILIENCE ALERT</b>',
    `Ticker: ${d.ticker || '?' } ${d.execution || ''} @ ${d.price || '?'}`,
    `Reason: ${d._vc_health_reason || 'vc_api_down_or_timeout'}`,
    `Attempts: ${d._vc_api_attempts || 0} | Circuit: ${d._vc_circuit_state || 'UNKNOWN'}`,
    `Action: fail-closed SE-C7 preserved. VC score forced to 0; no order can pass.`,
    `Shadow scanner score: ${d._vc_shadow_scanner_score || d.shadow_vc_score || 'N/A'}`
  ].join('\n');
  out.push({json:{...d, message: msg}});
}
return out;
