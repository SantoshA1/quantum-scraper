
// QTP-BACKTEST-AUDIT-FIX v4.2.1
// Merge Supabase strat cache lookup result back into the original signal.
const source = $('Prepare Supabase Strat Cache Lookup').first().json || {};
const row = $input.first().json || {};
const out = { ...source };
delete out.__supabase_strat_cache_sql;
let payload = {};
try { payload = row.raw_payload_json ? JSON.parse(row.raw_payload_json) : {}; } catch (_) { payload = {}; }
function first(...vals) { for (const v of vals) if (v !== undefined && v !== null && String(v).trim() !== '' && String(v).toUpperCase() !== 'N/A') return v; return ''; }
const totalTrades = first(payload.strat_total_trades, payload.backtest_sample_size, payload.total_trades);
const pf = first(payload.strat_profit_factor, payload.backtest_profit_factor, payload.profit_factor);
// QTP_BACKTEST_RELAXATION_v6.1_20260526
// Smart backtest thresholds: STRICT 100/1.20, RELAXED 40/1.05, HIGH_VOL_RELAXED 30/0.95.
// Additive and auditable only. R3.2 KILL and BROAD_SCANNER bias path remain untouched.
function __qtpBtBool(v) {
  if (v === true) return true;
  if (v === false) return false;
  const s = String(v ?? '').trim().toLowerCase();
  return ['true','1','yes','y','on'].includes(s);
}
const __qtpBtRelaxationConfig = {
  strict: { minTrades: 100, minPf: 1.20, action: 'STRICT', relaxed: false },
  relaxed: { minTrades: 40, minPf: 1.05, action: 'RELAXED', relaxed: true },
  highVol: { minTrades: 30, minPf: 0.95, action: 'HIGH_VOL_RELAXED', relaxed: true },
  highVolSymbols: new Set(['VFS','USO'])
};
function __qtpSelectBacktestThresholds(j) {
  const ticker = String(j.ticker || j.symbol || '').trim().toUpperCase();
  const marketText = String(j.market_status || j._dq_market_status || j.session || j.session_status || '').toUpperCase();
  const isPreMarket = __qtpBtBool(j.pre_market_mode) || __qtpBtBool(j.preMarketMode) || marketText.includes('PRE') || marketText.includes('PREMARKET');
  const isRelaxed = __qtpBtBool(j.relaxed_mode) || __qtpBtBool(j.relaxedMode) || isPreMarket;
  const isHighVol = __qtpBtRelaxationConfig.highVolSymbols.has(ticker) || __qtpBtBool(j.high_vol) || __qtpBtBool(j.highVol) || __qtpBtBool(j._high_vol);
  const t = isHighVol ? __qtpBtRelaxationConfig.highVol : (isRelaxed ? __qtpBtRelaxationConfig.relaxed : __qtpBtRelaxationConfig.strict);
  return { ...t, ticker, isPreMarket, isHighVol };
}
const __btThresholds = __qtpSelectBacktestThresholds({ ...out, ...payload });
if (row && row.ticker && Number(totalTrades || 0) > 0) {
  out.strat_total_trades = String(totalTrades);
  out.strat_profit_factor = String(pf || 0);
  out.strat_win_rate = String(first(payload.strat_win_rate, payload.backtest_win_rate, payload.win_rate));
  out.strat_net_pct = String(first(payload.strat_net_pct, payload.net_pct));
  out.strat_max_dd = String(first(payload.strat_max_dd, payload.max_dd));
  out.backtest_sample_size = String(totalTrades);
  out.backtest_profit_factor = String(pf || 0);
  out.backtest_win_rate = String(first(payload.strat_win_rate, payload.backtest_win_rate, payload.win_rate));
  out.backtest_data_source = 'supabase_postgres.quantum_strat_cache_raw';
  out._backtest_enforcement_action = __btThresholds.action;
  out._backtest_relaxed_thresholds = __btThresholds.relaxed;
  out._used_min_trades = __btThresholds.minTrades;
  out._used_min_pf = __btThresholds.minPf;
  out.backtest_data_quality = (Number(totalTrades) >= __btThresholds.minTrades && Number(pf || 0) >= __btThresholds.minPf) ? 'BACKTEST_DATA_OK' : 'BACKTEST_DATA_WEAK';
  out._strat_cache_hit = true;
  out._strat_cache_asof = row.asof_utc || null;
} else {
  out._strat_cache_hit = false;
  out.backtest_data_source = out.backtest_data_source || 'supabase_postgres.quantum_strat_cache_raw:MISS';
}
return [{ json: out }];
