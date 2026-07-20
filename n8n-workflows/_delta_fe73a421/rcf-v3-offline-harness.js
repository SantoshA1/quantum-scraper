// Offline harness: exact decision core of published RCF v3 + drop-router semantics.
function detectRegimeConflict(side, optionsRegime, darkPoolRegime) {
  const opt = String(optionsRegime || '').toUpperCase();
  const dp = String(darkPoolRegime || '').toUpperCase();
  const sideU = String(side || '').toUpperCase();
  const buyOptConflict = sideU === 'BUY' && /CONTRARIAN_SHORT|GAMMA_SQUEEZE_DOWN|DISTRIBUTION/.test(opt);
  const buyDpConflict = sideU === 'BUY' && /CONTRARIAN_SHORT|DISTRIBUTION/.test(dp);
  const sellOptConflict = sideU === 'SELL' && /CONTRARIAN_LONG|GAMMA_SQUEEZE_UP|ACCUMULATION/.test(opt);
  const sellDpConflict = sideU === 'SELL' && /CONTRARIAN_LONG|ACCUMULATION/.test(dp);
  const optConflict = buyOptConflict || sellOptConflict;
  const dpConflict = buyDpConflict || sellDpConflict;
  if (optConflict && dpConflict) return 'CONTRA_BOTH';
  if (optConflict) return 'CONTRA_OPT';
  if (dpConflict) return 'CONTRA_DP';
  return null;
}
// v3 emit semantics
function rcfV3(items) {
  const out = [];
  for (const item of items) {
    const j = { ...item.json };
    const conflict = detectRegimeConflict(j.execution || j.side, j.opt_regime || j.options_regime, j.dp_regime);
    if (conflict) { j._rcf_dropped = true; j._rcf_drop_reason = 'REGIME_CONFLICT_' + conflict; }
    else { j._rcf_dropped = false; }
    out.push({ json: j });
  }
  return out;
}
// router semantics: true(out0)=drop-audit, false(out1)=VC Gatekeeper
const route = (j) => (j._rcf_dropped === true ? 'AUDIT_BRANCH' : 'VC_GATEKEEPER');

let pass = 0, fail = 0;
function chk(name, cond) { console.log((cond ? '  ✅ ' : '  ❌ ') + name); cond ? pass++ : fail++; }

// EG incident replica: BUY + CONTRA_OPT
const eg = rcfV3([{ json: { ticker: 'EG', execution: 'BUY', opt_regime: 'CONTRARIAN_SHORT', dp_regime: 'NEUTRAL' } }])[0].json;
chk('EG replica: dropped=true, reason=REGIME_CONFLICT_CONTRA_OPT', eg._rcf_dropped === true && eg._rcf_drop_reason === 'REGIME_CONFLICT_CONTRA_OPT');
chk('EG replica routes to AUDIT branch, never VC', route(eg) === 'AUDIT_BRANCH');

// Clean survivor: byte-equivalent pass path
const ok = rcfV3([{ json: { ticker: 'AAPL', execution: 'BUY', opt_regime: 'BULLISH', dp_regime: 'ACCUMULATION' } }])[0].json;
chk('clean BUY survivor: dropped=false, routes to VC Gatekeeper', ok._rcf_dropped === false && route(ok) === 'VC_GATEKEEPER');

// SELL conflict + CONTRA_BOTH
const s = rcfV3([{ json: { ticker: 'X', execution: 'SELL', opt_regime: 'GAMMA_SQUEEZE_UP', dp_regime: 'ACCUMULATION' } }])[0].json;
chk('SELL CONTRA_BOTH detected + dropped', s._rcf_drop_reason === 'REGIME_CONFLICT_CONTRA_BOTH' && route(s) === 'AUDIT_BRANCH');

// decision parity: v3 drops exactly what v2 dropped (same detect fn, no behavior change)
const cases = [['BUY','CONTRARIAN_SHORT',''],['BUY','','DISTRIBUTION'],['SELL','CONTRARIAN_LONG',''],['BUY','BULLISH','ACCUMULATION'],['SELL','','ACCUMULATION'],['STAND ASIDE','CONTRARIAN_SHORT','DISTRIBUTION']];
let parity = true;
for (const [sd, o, d] of cases) {
  const v2drop = detectRegimeConflict(sd, o, d) !== null; // v2: continue (swallow)
  const v3item = rcfV3([{ json: { execution: sd, opt_regime: o, dp_regime: d } }])[0].json;
  const v3blockedFromTrading = route(v3item) === 'AUDIT_BRANCH';
  if (v2drop !== v3blockedFromTrading) { parity = false; console.log('   parity break:', sd, o, d); }
}
chk('v2/v3 trading-path parity across 6 cases (incl. STAND ASIDE untouched)', parity);

console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
