'use strict';
/**
 * Pure spec-mirror of QTP_RCF_MODERATE_DP_EXEMPT_v1_20260727 (live on main SM
 * vaqfCaELhOEWnkdo, version 51c179ad). PO-authorized evidence-based exemption:
 * a BUY whose CONTRA_BOTH is driven by dp=MODERATE_DISTRIBUTION recovers at the
 * +2d swing horizon (rcf_shadow n=15: +1.34% mean / 67% win), so it is exempt
 * from the RCF hard veto AND from the VC R3.2 deterministic kill. Reversible via
 * n8n var QTP_RCF_MODERATE_DP_EXEMPT=off. Genuine both-leg CONTRA_BOTH (STRONG/
 * STEALTH dp) STILL kills. Mirrors three live edits: RCF classifier, VC prompt,
 * VC Score Parser _raw_is_kill.
 */
function detectRegimeConflict(side, opt, dp) {
  opt = String(opt || '').toUpperCase();
  dp = String(dp || '').toUpperCase();
  const s = String(side || '').toUpperCase();
  const bO = s === 'BUY' && /CONTRARIAN_SHORT|GAMMA_SQUEEZE_DOWN|DISTRIBUTION/.test(opt);
  const bD = s === 'BUY' && /CONTRARIAN_SHORT|DISTRIBUTION/.test(dp);
  const sO = s === 'SELL' && /CONTRARIAN_LONG|GAMMA_SQUEEZE_UP|ACCUMULATION/.test(opt);
  const sD = s === 'SELL' && /CONTRARIAN_LONG|ACCUMULATION/.test(dp);
  const o = bO || sO, d = bD || sD;
  if (o && d) return 'CONTRA_BOTH';
  if (o) return 'CONTRA_OPT';
  if (d) return 'CONTRA_DP';
  return null;
}

/** RCF branch outcome: 'DROP' | 'EXEMPT_PASS' | 'SINGLE_PASS' | 'PASS' */
function rcfDecision(side, opt, dp, flagOn) {
  const c = detectRegimeConflict(side, opt, dp);
  const sd = String(side || '').toUpperCase();
  const dpU = String(dp || '').toUpperCase();
  if (c) {
    if (c === 'CONTRA_BOTH') {
      if (flagOn && sd === 'BUY' && dpU === 'MODERATE_DISTRIBUTION') return 'EXEMPT_PASS';
      return 'DROP';
    }
    return 'SINGLE_PASS';
  }
  return 'PASS';
}

/** VC Score Parser _raw_is_kill mirror. exempt = prev._rcf_moderate_dp_exempt && flag. */
function parserKill(exempt, verdict, score, rules) {
  const rt = (rules || []).map((x) => String(x).toUpperCase()).join('|');
  const any = rt.includes('R3.2');
  const both = /BOTH/.test(rt);
  const V = String(verdict || '').toUpperCase();
  const S = Number(score);
  return exempt
    ? (both || (V === 'KILL' && !any) || (S === 0 && !any))
    : ((V === 'KILL') || (S === 0) || any);
}

module.exports = { detectRegimeConflict, rcfDecision, parserKill };
