// Channel Gate v1.0 — unified subscriber notification gate
// Rules:
//   1. Block empty messages
//   2. Block test_mode signals
//   3. 60-second per-ticker dedup to prevent flood
//   QTP_CHANNEL_GATE_EXEC_META_20260506: recovered execution messages carry ticker metadata and may bypass stale UNKNOWN dedup

const items = $input.all();
const results = [];

for (const item of items) {
  const d = item.json;
  const msg = d.message || d.text || '';
  
  // Gate 1: no empty messages
  if (!msg || msg.trim().length === 0) continue;
  
  // Gate 2: block test mode
  if (d.test_mode === true || d.test_mode === 'true') continue;
  
  // QTP_CHANNEL_GATE_DEDUP_v4.2.5.5
  // 10-minute subscriber dedup for same ticker/action/price. Even recovered broker
  // notifications cannot bypass this if the semantic alert is the same; this stops
  // duplicate VLTO-style messages caused by multi-branch enrichment outputs.
  const ticker = String(d.ticker || d.symbol || 'UNKNOWN').toUpperCase();
  const exec = String(d.execution || d.signal || d.action || 'UNKNOWN').toUpperCase();
  const px = Number(d.price || d.close || d.entry || 0);
  const pxBucket = Number.isFinite(px) ? (Math.round(px * 100) / 100).toFixed(2) : 'NA';
  const now = Date.now();
  const key = `channel_gate_v4255_${ticker}_${exec}_${pxBucket}`;
  const wfStatic = $getWorkflowStaticData('global');
  const lastSent = Number(wfStatic[key] || 0);
  const DEDUP_MS = 10 * 60 * 1000;
  if (now - lastSent < DEDUP_MS) {
    console.log(`[Channel Gate v4.2.5.5] DEDUP ${key}; suppressed duplicate user message`);
    continue;
  }
  wfStatic[key] = now;
  // prune old v4.2.5.5 keys opportunistically
  for (const k of Object.keys(wfStatic)) {
    if (k.startsWith('channel_gate_v4255_') && now - Number(wfStatic[k] || 0) > 30 * 60 * 1000) delete wfStatic[k];
  }
  results.push(item);
}

return results;