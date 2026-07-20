// QTP ticker blocklist v1 20260522
// Drops signals for tickers with proven anti-edge PF over 7-day audit window.
// Source: Q04 strategy curation audit, 2026-05-22.
// Additive: when ticker is NOT on the list, item passes through unchanged.

const BLOCKLIST_VERSION = 'QTP_TICKER_BLOCKLIST_v1_20260522';
const TICKER_BLOCKLIST = new Set([
  'COP','ADM','DRI','BYND','CBOE','ALL','DLR','IEX','IQV','IBKR',
  'HCA','XYZ','KR','ADBE','EXE','EOG','PSKY','DHI','PSA','LYB',
  'MOH','EW','ABNB','CAG'
]);

const item = $input.first().json || {};
const body = item.body && typeof item.body === 'object' ? item.body : {};
const symbol = String(item.ticker || item.symbol || body.ticker || body.symbol || '').toUpperCase().trim();

if (TICKER_BLOCKLIST.has(symbol)) {
  const patchedBody = {
    ...body,
    blocked_stage: 'TICKER_BLOCKLIST',
    _ticker_blocklist_version: BLOCKLIST_VERSION,
    _ticker_blocklist_reason: `ticker ${symbol} disabled per Q04 audit (anti-edge PF)`,
    _vc_pass: false,
    _vc_verdict: 'BLOCKED_BY_TICKER',
    execution: 'STAND ASIDE',
    signal: 'STAND ASIDE',
    final_outcome: 'TICKER_BLOCKLISTED'
  };
  return [{
    json: {
      ...item,
      body: Object.keys(body).length ? patchedBody : item.body,
      blocked_stage: 'TICKER_BLOCKLIST',
      _ticker_blocklist_version: BLOCKLIST_VERSION,
      _ticker_blocklist_reason: `ticker ${symbol} disabled per Q04 audit (anti-edge PF)`,
      _vc_pass: false,
      _vc_verdict: 'BLOCKED_BY_TICKER',
      execution: 'STAND ASIDE',
      signal: 'STAND ASIDE',
      final_outcome: 'TICKER_BLOCKLISTED'
    }
  }];
}

return [{ json: { ...item, _ticker_blocklist_checked: true } }];