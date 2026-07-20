
// QTP-BACKTEST-AUDIT-FIX v4.2.1
// Prepare PostgreSQL lookup for quantum.quantum_strat_cache_raw.
// Uses Supabase PostgreSQL lookup. Read-only and fail-open.
function esc(v) { return String(v ?? '').replace(/'/g, "''").slice(0, 120); }
const d = $json || {};
const ticker = String(d.ticker || d.symbol || '').toUpperCase().trim();
const hasPayloadStats = String(d.strat_total_trades ?? '').trim() !== '' && Number(d.strat_total_trades) > 0;
if (!ticker || hasPayloadStats) {
  return [{ json: { ...d, _strat_cache_lookup_skipped: true, _strat_cache_source: hasPayloadStats ? 'tradingview_payload' : 'missing_ticker', __supabase_strat_cache_sql: "SELECT NULL::text AS raw_payload_json, NULL::text AS ticker, NULL::text AS status, NULL::text AS asof_utc;" } }];
}
const sql = `
SELECT
  raw_payload_json,
  UPPER(TRIM(COALESCE(symbol, ticker))) AS ticker,
  COALESCE(status, 'OK') AS status,
  COALESCE(asof_utc::text, migrated_at::text, analyzed_at::text, scraped_at::text) AS asof_utc
FROM quantum.quantum_strat_cache_raw
WHERE UPPER(TRIM(COALESCE(symbol, ticker))) = '${esc(ticker)}'
ORDER BY COALESCE(asof_utc, migrated_at, analyzed_at, scraped_at) DESC NULLS LAST
LIMIT 1;`;
return [{ json: { ...d, __supabase_strat_cache_sql: sql, _strat_cache_lookup_ticker: ticker, _strat_cache_source: 'supabase.quantum_strat_cache_raw' } }];
