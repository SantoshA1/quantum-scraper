#!/usr/bin/env python3
# gov 241 patches part 2: Gate-K Prep parity + TSM (width tolerance + ladder freeze).
import hashlib
def sha(s): return hashlib.sha256(s.encode()).hexdigest()

# ══ 2. GATE-K PREP ══════════════════════════════════════════════════════════
srcp = open('gatek-prep-deployed.js').read()
assert sha(srcp) == 'aff5743c7d8182baaf2e61e2c35ed0821bb3f6d0cf373c166e8d26bbd8268d72'
P_OLD = """  // exact mirror of Alpaca Paper Trade: SL_MULT, the missing-ATR fallback, then the 1.2% clamp
  const _slMult = isVol ? 1.0 : 1.5;
  const _atrEff = atr > 0 ? atr : price * 0.015;
  const _rawStopDist = _atrEff * _slMult;
  const _stopDist = Math.min(_rawStopDist, price * MAX_ENTRY_STOP_PCT);
  _clamped = _stopDist < _rawStopDist;
  _rawPct = Math.round((_rawStopDist / price) * 10000) / 100;
  if (_clamped) console.log('[GATE-K STOP-PARITY v1] ' + String(j.ticker || '') + ': gate was judging a ' + _rawPct + '% stop; now judging the 1.2% stop the order will carry');
  stopEst = side === 'sell' ? r2(price + _stopDist) : r2(price - _stopDist);"""
P_NEW = """  // QTP_EXIT_POLICY_v1_gov241_20260825: exact mirror of Alpaca Paper Trade post-gov241 —
  // the executor places a FIXED 2.5% stop (Conclave Decision 1), so the gate judges the
  // 2.5% stop the order will carry. Raw ATR distance retained for telemetry parity.
  const POLICY_STOP_PCT = 0.025;
  const _slMult = isVol ? 1.0 : 1.5;
  const _atrEff = atr > 0 ? atr : price * 0.015;
  const _rawStopDist = _atrEff * _slMult;
  const _stopDist = price * POLICY_STOP_PCT;
  _clamped = false; // fixed policy width: nothing is clamped any more
  _rawPct = Math.round((_rawStopDist / price) * 10000) / 100;
  stopEst = side === 'sell' ? r2(price + _stopDist) : r2(price - _stopDist);"""
n = srcp.count(P_OLD); assert n == 1, f"prep: expected 1, found {n}"
outp = srcp.replace(P_OLD, P_NEW, 1)
assert srcp.replace(P_OLD,'\x00',1) == outp.replace(P_NEW,'\x00',1)
assert outp.count('POLICY_STOP_PCT = 0.025') == 1
open('gatek-prep-patched.js','w').write(outp)
print('PREP OK      new sha:', sha(outp), len(outp))

# ══ 3. TSM: width tolerance 1.2% -> 2.6%; tier ladder frozen ═══════════════
srct = open('tsm-node-trail-stops.js').read()
assert sha(srct) == '5f22eddd175bfdc3aab57a645bcd17b6cf828bae6fbb91eb0b96672795df207d'
T1_OLD = "      const MAX_PROTECTIVE_STOP_PCT = 0.012; // 1.2%"
T1_NEW = "      const MAX_PROTECTIVE_STOP_PCT = 0.026; // QTP_EXIT_POLICY_v1_gov241_20260825: was 0.012; the Conclave-ratified entry stop is a FIXED 2.5%, so a held 2.5% leg is PROTECTION, not a defect. 0.026 leaves rounding headroom. Legacy narrow stops still pass (<=)."
T2_OLD = """  let newTier = ts.tier;
  let newStop = null;
  if (isLong) {
    if (_evalFav >= t3_trigger && ts.tier < 3) { newTier = 3; newStop = t3_stop; }
    else if (_evalFav >= t2_trigger && ts.tier < 2) { newTier = 2; newStop = t2_stop; }
    else if (_evalFav >= t1_trigger && ts.tier < 1) { newTier = 1; newStop = t1_stop; }
  } else {
    if (_evalFav <= t3_trigger && ts.tier < 3) { newTier = 3; newStop = t3_stop; }
    else if (_evalFav <= t2_trigger && ts.tier < 2) { newTier = 2; newStop = t2_stop; }
    else if (_evalFav <= t1_trigger && ts.tier < 1) { newTier = 1; newStop = t1_stop; }
  }"""
T2_NEW = """  // QTP_EXIT_POLICY_v1_gov241_20260825 (Conclave Decision 1): the probation cohort runs the
  // MEASURED policy — fixed 2.5% stop, exit at the 2nd close. The TSM monitors but does not
  // tighten: tier advancement (and with it breakeven moves, stop raises, and the tier-gated
  // scale-outs) is FROZEN. Existing tier states are preserved; positions already scaled/
  // tiered keep their stops. Would-have-fired advancements are logged for the fidelity
  // ledger so the deviation cost of trailing can be measured before any re-enable.
  const QTP_TIER_TRAIL_ENABLED = false;
  let newTier = ts.tier;
  let newStop = null;
  if (isLong) {
    if (_evalFav >= t3_trigger && ts.tier < 3) { newTier = 3; newStop = t3_stop; }
    else if (_evalFav >= t2_trigger && ts.tier < 2) { newTier = 2; newStop = t2_stop; }
    else if (_evalFav >= t1_trigger && ts.tier < 1) { newTier = 1; newStop = t1_stop; }
  } else {
    if (_evalFav <= t3_trigger && ts.tier < 3) { newTier = 3; newStop = t3_stop; }
    else if (_evalFav <= t2_trigger && ts.tier < 2) { newTier = 2; newStop = t2_stop; }
    else if (_evalFav <= t1_trigger && ts.tier < 1) { newTier = 1; newStop = t1_stop; }
  }
  if (!QTP_TIER_TRAIL_ENABLED && newTier !== ts.tier) {
    console.log('[TSM gov241] ' + sym + ': tier advance ' + ts.tier + '->' + newTier + ' SUPPRESSED (policy: no tightening); would-be stop $' + newStop);
    newTier = ts.tier;
    newStop = null;
  }"""
outt = srct
for old, new, label in [(T1_OLD, T1_NEW, 'width'), (T2_OLD, T2_NEW, 'ladder')]:
    n = outt.count(old); assert n == 1, f"tsm {label}: expected 1, found {n}"
    outt = outt.replace(old, new, 1)
assert srct.replace(T1_OLD,'\x00',1).replace(T2_OLD,'\x00',1) == outt.replace(T1_NEW,'\x00',1).replace(T2_NEW,'\x00',1)
assert outt.count('QTP_TIER_TRAIL_ENABLED = false') == 1
assert outt.count('MAX_PROTECTIVE_STOP_PCT = 0.026') == 1
open('tsm-node-trail-stops-patched.js','w').write(outt)
print('TSM OK       new sha:', sha(outt), len(outt))
print('ALL PATCHES OK')
