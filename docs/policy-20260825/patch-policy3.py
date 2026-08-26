#!/usr/bin/env python3
# gov 241 Patch C (2026-08-26) — EX-C3 held a private copy of the retired 1.2% stop regime.
# Incident: first probation session 08-26, all three entries (CHTR/EQT/FLEX) placed the
# ratified 2.5% stop, then EX-C3 fired (realised 2.5% > _exStopTsmBar 0.0119) and
# re-anchored every stop to ~1.145% of fill (_exStopTargetPct 0.0115). CHTR −1.03R and
# EQT −1.18R stopped out at prices ABOVE their untouched policy stops.
# Root cause of the miss: EX-C3 encodes the old policy as 0.0115/0.0119 literals — recon
# greps for 0.012 / MAX_ENTRY_STOP_PCT / MAX_PROTECTIVE_STOP_PCT could not surface it, and
# the suite's executed region ended at the EX-C1 marker, above this block.
# New chain, coherent by construction: target 2.5% (of fill, = policy) < bar 2.59% < TSM
# tolerance 2.6% (gov241 T1). Normal fills: realised ≈ 2.5%±slip ≤ 2.59% → EX-C3 never
# fires and the placed policy stop stands. Pathological fills: re-anchored to 2.5% of
# fill — exactly the E1-measured geometry — with the cent-walk keeping it inside the bar.
import hashlib, sys

SRC = '/home/claude/qs/docs/policy-20260825/alpaca-paper-trade-patched.js'
DST = '/home/claude/qs/docs/policy-20260825/alpaca-paper-trade-patched2.js'

s = open(SRC, encoding='utf-8').read()
print('before sha256:', hashlib.sha256(s.encode()).hexdigest()[:16], 'len', len(s))

OLD_BLOCK = """// E2 target 1.15%, NOT 1.20%. The Trailing Stop Manager classifies a held bracket stop leg
// as UNPROTECTED_STOP_TOO_WIDE at |stop-entry|/entry > 1.20% and responds by cancelling it
// and forcing a 0.9% stop — which is what noise-killed WST on 08-10. Cent-rounding puts a
// 1.20% target on both sides of that line (ALGN 08-07 landed at 1.2003% against its signal
// and escaped only because its fill happened to be favourable). 1.15% sits provably inside.
const _exStopTargetPct = 0.0115;
const _exStopTsmBar    = 0.0119;"""

NEW_BLOCK = """// gov241 Patch C (2026-08-26): EX-C3 geometry now follows the ratified 2.5% policy stop.
// HISTORY: these constants were a PRIVATE COPY of the pre-gov241 1.2% stop regime
// (target 1.15% / bar 1.19%, matched to the TSM's old UNPROTECTED_STOP_TOO_WIDE line).
// On 2026-08-26, the first session after gov241 moved entry stops to POLICY_STOP_PCT
// (2.5%), this block re-tightened all three probation entries back to ~1.145% of fill;
// CHTR (−1.03R) and EQT (−1.18R) then stopped out at prices above their untouched policy
// stops. COUPLING CONTRACT — keep this chain ordered or the policy silently repeals:
//   _exStopTargetPct (2.5%, = POLICY_STOP_PCT geometry, of FILL)
//   < _exStopTsmBar (2.59%, EX-C3 fire threshold; cent-rounding sits inside)
//   < TSM MAX_PROTECTIVE_STOP_PCT (2.6%, gov241 T1).
// Normal fills realise ≈2.5%±slip ≤ 2.59% → EX-C3 does not fire; the placed policy stop
// stands. Pathological fills → re-anchor to 2.5% of the price actually paid (the
// E1-measured cell), never to a tighter family.
const _exStopTargetPct = 0.025;
const _exStopTsmBar    = 0.0259;"""

assert s.count(OLD_BLOCK) == 1, 'anchor block not unique/found'
# occurrence census (def + consumers): target 1+2 (both branches of _exFillStop line),
# bar 1+2 (_exFillStop walk guard + EX-C3 fire threshold). Any new consumer -> abort.
assert s.count('_exStopTargetPct') == 3, 'unexpected extra _exStopTargetPct consumers'
assert s.count('_exStopTsmBar') == 3, 'unexpected extra _exStopTsmBar consumers'
s2 = s.replace(OLD_BLOCK, NEW_BLOCK, 1)

# no-collateral proof: outside the replaced block, bytes identical
i = s.index(OLD_BLOCK); j = i + len(OLD_BLOCK)
i2 = s2.index(NEW_BLOCK); j2 = i2 + len(NEW_BLOCK)
assert s[:i] == s2[:i2] and s[j:] == s2[j2:], 'collateral change outside block'
assert s2.count('0.0115') == 0 and s2.count('0.0119') == 0, 'old literals survive'

open(DST, 'w', encoding='utf-8').write(s2)
print('after  sha256:', hashlib.sha256(s2.encode()).hexdigest()[:16], 'len', len(s2))
print('PATCH C OK ->', DST)
