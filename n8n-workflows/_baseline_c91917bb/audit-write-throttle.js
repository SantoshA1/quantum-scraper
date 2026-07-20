// Rate Limit Throttle v3 — Per-ticker rate limiting for Supabase audit writer
// Limits: max 1 write per ticker per 60 seconds
//
// v3 (Fix SE-C6): When ALL items are rate-limited, return an empty array
// instead of the previous v2 behavior (3s delay + return $input.all()) which
// defeated the throttle exactly during bursts — the scenario it was built for.
//
// n8n Code nodes DO support empty array returns. Downstream nodes simply
// receive zero items and skip execution. This is the correct, non-ambiguous
// fail-closed behavior for a rate limiter.
const state = $getWorkflowStaticData('global');
if (!state._sheetThrottle) state._sheetThrottle = {};

const items = $input.all();
const results = [];
const now = Date.now();
const MIN_INTERVAL_MS = 60000; // 1 write per ticker per 60 seconds

let suppressed = 0;
for (const item of items) {
  const ticker = item.json.ticker || item.json._shadow_ticker || 'UNKNOWN';
  const lastWrite = state._sheetThrottle[ticker] || 0;

  if (now - lastWrite >= MIN_INTERVAL_MS) {
    state._sheetThrottle[ticker] = now;
    results.push(item);
  } else {
    suppressed++;
    console.log('[THROTTLE] Skipped ' + ticker + ' — last write ' + Math.round((now - lastWrite) / 1000) + 's ago');
  }
}

// Prune throttle state for tickers not seen in 24h (bounded memory)
const PRUNE_MS = 24 * 60 * 60 * 1000;
for (const key of Object.keys(state._sheetThrottle)) {
  if (now - state._sheetThrottle[key] > PRUNE_MS) {
    delete state._sheetThrottle[key];
  }
}

// Fix SE-C6: if ALL items were suppressed, return empty — do NOT forward
// unthrottled traffic. Emit a single telemetry log line for observability.
if (results.length === 0 && items.length > 0) {
  console.log('[THROTTLE] All ' + items.length + ' items suppressed — returning empty to protect downstream.');
}

return results;
