// QTP_EXT_HOURS_RISK_PROFILE_v2_20260527
// Paper-only extended-hours risk profile. Adds caps/context before Supabase Risk
// Gate and Alpaca. Does not bypass Supabase Risk Gate.

const item = $input.first().json || {};
const session = String(item.market_session || 'REGULAR').toUpperCase();
const isExt = item.is_extended_hours === true || String(item.is_extended_hours || '').toLowerCase() === 'true';

const profiles = {
  PRE_MARKET: { max_notional: 10000, max_session_exposure_pct: 20, max_spread_bps: 80, stop_atr_mult: 2.25 },
  REGULAR: { max_notional: 10000, max_session_exposure_pct: 65, max_spread_bps: 25, stop_atr_mult: 1.50 },
  POST_MARKET: { max_notional: 10000, max_session_exposure_pct: 15, max_spread_bps: 100, stop_atr_mult: 2.75 }
};
const p = profiles[session] || profiles.REGULAR;

const spread = Number(item.spread_bps ?? item._spread_bps ?? NaN);
let extRiskBlock = false;
let extRiskReason = 'PASS';
if (isExt && Number.isFinite(spread) && spread > p.max_spread_bps) {
  extRiskBlock = true;
  extRiskReason = `EXT_HOURS_SPREAD_TOO_WIDE:${spread}>${p.max_spread_bps}`;
}

return [{
  json: {
    ...item,
    extended_hours_risk_profile: session,
    extended_hours_max_notional: p.max_notional,
    extended_hours_max_session_exposure_pct: p.max_session_exposure_pct,
    extended_hours_max_spread_bps: p.max_spread_bps,
    extended_hours_stop_atr_mult: p.stop_atr_mult,
    order_type: isExt ? 'limit' : (item.order_type || 'market'),
    time_in_force: isExt ? 'day' : (item.time_in_force || 'gtc'),
    alpaca_extended_hours: isExt,
    extended_hours_risk_block: extRiskBlock,
    extended_hours_risk_reason: extRiskReason,
    extended_hours_risk_v: 'QTP_EXT_HOURS_RISK_PROFILE_v2_20260527'
  }
}];