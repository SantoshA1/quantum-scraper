// QET Gate-K Filter shim v1.0 (2026-07-10) — Phase 1: FILTER ONLY, sizing untouched.
// Derives gate inputs from pipeline fields; unmappable signals FAIL OPEN (skip flag).
// Evidence: week 2026-07-06 counter-regime shorts -485 USD; WDAY/F/ASML protection defects.
const j = $input.first().json;
const price = parseFloat(j.price || 0);
const atr = parseFloat(j.atr || 0);
const sigTxt = String(j.signal || j.execution || j._sm_route || '').toUpperCase();
let side = '';
if (/SELL|SHORT|BEAR/.test(sigTxt)) side = 'sell';
else if (/BUY|LONG|BULL/.test(sigTxt)) side = 'buy';
const VOL = ['SQQQ','TQQQ','SPXS','SPXL','SOXS','SOXL','UVXY','SVXY','SMCI'];
const isVol = VOL.includes(String(j.ticker || '').toUpperCase());
let stopEst = 0;
if (price > 0 && side) {
  if (isVol) stopEst = side === 'sell' ? price * 1.03 : price * 0.97;
  else if (atr > 0) stopEst = side === 'sell' ? price + 1.5 * atr : price - 1.5 * atr;
}
const confRaw = parseFloat(j.ai_confidence || j.confidence || j.bias_score || 50);
const conf = Math.min(1, Math.max(0, confRaw > 1 ? confRaw / 100 : confRaw));
return [{ json: { ...j, __qet_symbol: String(j.ticker || '').toUpperCase(), __qet_side: side, __qet_entry: price, __qet_stop: Math.round(stopEst * 100) / 100, __qet_conf: conf } }];