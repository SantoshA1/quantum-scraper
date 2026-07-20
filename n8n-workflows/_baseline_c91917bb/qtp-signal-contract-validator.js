// QTP SIGNAL CONTRACT VALIDATOR v4.2.7
// Safety: fail-closed before VC/Gate logic if input is malformed.
function upper(v, fallback = '') { return String(v ?? fallback).trim().toUpperCase(); }
function num(v, fallback = null) { const n = Number(v); return Number.isFinite(n) ? n : fallback; }
return items.map(item => {
  const d = item.json || {};
  const auth = String(d._auth_status || d.auth_status || '').toUpperCase();
  if (auth && auth !== 'AUTH_OK') {
    return { json: { ...d, _sm_route: 'SKIP', blocked_stage: 'WEBHOOK_AUTH', vc_verdict: 'AUTH_FAILED', qtp_live_trading_allowed: false, qtp_trading_env: 'paper', alpaca_env: 'paper' } };
  }
  const ticker = upper(d.ticker || d.symbol || d.Ticker || d.Symbol);
  const execution = upper(d.execution || d.signal || d.side || d.action || d.Execution || d.Signal);
  const price = num(d.price || d.close || d.entry || d.mark_price || d.Price || d.Close);
  const allowed = ['BUY', 'SELL', 'LONG', 'SHORT', 'STAND ASIDE', 'NEUTRAL', 'BULLISH', 'BEARISH'];
  if (!ticker || ticker === 'UNKNOWN') return { json: { ...d, _sm_route: 'SKIP', blocked_stage: 'SCHEMA_VALIDATION', vc_verdict: 'KILL', feedback: 'Missing ticker/symbol.', qtp_live_trading_allowed: false, qtp_trading_env: 'paper', alpaca_env: 'paper' } };
  if (!allowed.includes(execution)) return { json: { ...d, ticker, symbol: ticker, _sm_route: 'SKIP', blocked_stage: 'SCHEMA_VALIDATION', vc_verdict: 'KILL', feedback: `Unsupported execution=${execution}.`, qtp_live_trading_allowed: false, qtp_trading_env: 'paper', alpaca_env: 'paper' } };
  if (!['STAND ASIDE','NEUTRAL'].includes(execution) && !Number.isFinite(price)) return { json: { ...d, ticker, symbol: ticker, execution, signal: execution, _sm_route: 'SKIP', blocked_stage: 'SCHEMA_VALIDATION', vc_verdict: 'KILL', feedback: 'Missing numeric price for actionable signal.', qtp_live_trading_allowed: false, qtp_trading_env: 'paper', alpaca_env: 'paper' } };
  const sourceId = d.source_id || d.alert_id || d.id || d.qtp_source_execution_id || d.timestamp || d.Timestamp || new Date().toISOString();
  const idempotencyKey = String(d.idempotency_key || `qtp_source_${ticker}_${execution}_${sourceId}`).replace(/[^A-Z0-9_:-]/gi, '_').slice(0, 220);
  return { json: { ...d, ticker, symbol: ticker, execution, signal: execution, side: execution, price, close: price, idempotency_key: idempotencyKey, qtp_schema_valid: true, qtp_trading_env: 'paper', alpaca_env: 'paper', qtp_live_trading_allowed: false, parser_version: d.parser_version || 'QTP_CYCLE_007_17_NODE_HARDENED_20260511', qtp_ingress_version: 'QTP_SIGNAL_CONTRACT_VALIDATOR_v4.2.7' } };
});