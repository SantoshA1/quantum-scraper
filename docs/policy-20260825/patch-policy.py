#!/usr/bin/env python3
# gov 241 Decision 1 mechanics — count-asserted patches, 3 nodes.
import hashlib
def sha(s): return hashlib.sha256(s.encode()).hexdigest()

# ══ 1. EXECUTOR: fixed 2.5% stop + far take-profit ══════════════════════════
src = open('alpaca-paper-trade-deployed.js').read()
assert sha(src) == 'df7d8036b2fbbd995d66b6372979bc36127f59c3ac6d833a5dc589c69667031e'

A_OLD = """const MAX_ENTRY_STOP_PCT = 0.012;
const _rawStopDist = atr * SL_MULT;
const _stopDist = Math.min(_rawStopDist, price * MAX_ENTRY_STOP_PCT);
if (_stopDist < _rawStopDist) console.log('[APT STOP-CLAMP v1] ' + ticker + ': ATR stop ' + r2(_rawStopDist) + ' (' + (Math.round(_rawStopDist / price * 10000) / 100) + '%) clamped to 1.2% = ' + r2(_stopDist));"""
A_NEW = """// QTP_EXIT_POLICY_v1_gov241_20260825 (Conclave 2026-08-25, Decision 1): FIXED 2.5% stop.
// E1 measured the pct_2.5 x time_2d cell across three OOS passes (A 1.60 / B 1.35, n=490);
// the probation cohort runs the MEASURED policy — fixed width, not min(ATR, cap). The raw
// ATR distance is still computed and logged for stop_regime telemetry separability (S3).
const MAX_ENTRY_STOP_PCT = 0.012; // retained for telemetry comparison only (pre-gov241 regime)
const POLICY_STOP_PCT = 0.025;
const _rawStopDist = atr * SL_MULT;
const _stopDist = price * POLICY_STOP_PCT;
console.log('[APT POLICY-STOP gov241] ' + ticker + ': fixed 2.5% stop = ' + r2(_stopDist) + ' (raw ATR would be ' + r2(_rawStopDist) + ' = ' + (Math.round(_rawStopDist / price * 10000) / 100) + '%)');"""

B_OLD = """const tpPrice = isLong
  ? r2(price + atr * (vol ? 2.0 : 3.0))
  : r2(price - atr * (vol ? 2.0 : 3.0));"""
B_NEW = """// QTP_EXIT_POLICY_v1_gov241_20260825: the measured policy has NO profit target — winners
// exit at the 2nd close (time-exit workflow). The bracket's TP leg is kept for OCO
// mechanics but placed FAR (25%) so it cannot bind inside the 2-day hold.
const tpPrice = isLong
  ? r2(price * 1.25)
  : r2(price * 0.75);"""

out = src
for old, new, label in [(A_OLD, A_NEW, 'stop'), (B_OLD, B_NEW, 'target')]:
    n = out.count(old); assert n == 1, f"executor {label}: expected 1, found {n}"
    out = out.replace(old, new, 1)
assert out.count('POLICY_STOP_PCT = 0.025') == 1 and out.count('price * 1.25') == 1
probe = src.replace(A_OLD,'\x00',1).replace(B_OLD,'\x00',1)
assert probe == out.replace(A_NEW,'\x00',1).replace(B_NEW,'\x00',1), 'executor leak'
open('alpaca-paper-trade-patched.js','w').write(out)
print('EXECUTOR OK  new sha:', sha(out), len(out))

# ══ 2. GATE-K PREP: judge the fixed 2.5% the order will carry ═══════════════
srcp = open('gatek-prep-deployed.js').read()
assert sha(srcp) == 'aff5743c7d8182baaf2e61e2c35ed0821bb3f6d0cf373c166e8d26bbd8268d72'
import re
m = re.search(r'\n(let stopEst[^\n]*\n(?:.*\n)*?)\nconst confRaw', srcp)
assert m, 'prep stop region not found'
region = m.group(1)
print('--- prep stop region (verbatim) ---'); print(region); print('---')
