#!/usr/bin/env node
// gov 241 Patch C — EX-C3 fill-anchored stop vs the ratified 2.5% policy (2026-08-26)
// INCIDENT THIS SUITE EXISTS FOR: first probation session (08-26), all three entries
// placed the ratified 2.5% stop; EX-C3 (private constants 0.0115/0.0119 — the retired
// 1.2% regime under DIFFERENT literals) then re-anchored every stop to ~1.145% of fill.
// CHTR −1.03R and EQT −1.18R stopped out at prices above their untouched policy stops.
// FIELD LESSON (ratchet): a policy constant is not changed until every consumer of its
// VALUE is found — grep for the semantics (stop/bar/target words + any percent literal),
// not for the literal you happen to know; and the executed region must extend to every
// block that can rewrite the value after placement (EX-C3 sits BELOW the EX-C1 marker
// where the entry-math region ends).
// EXD-01/02  defs region REAL: constants + _exFillStop geometry = 2.5% of fill
// EXD-03     REGRESSION STAR: normal fill -> EX-C3 must NOT fire (today it fired)
// EXD-04     pathological fill -> fires, re-anchors to 2.5% of FILL, PATCHes once
// EXD-05     incident witness: OLD constants under EXD-03's inputs reproduce ~1.145%
// EXD-06     short-side mirror of EXD-04
// Sabotage: revert either constant -> EXD-01/03 bite.
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'docs/policy-20260825/alpaca-paper-trade-patched2.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, name, extra) => { if (c) { pass++; console.log('  PASS ' + name); } else { fail++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')); } };
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// ---- region A: r2v49 + constants + _exFillStop (REAL bytes) ----
const a0 = SRC.indexOf('const r2v49 = n =>');
const a1 = SRC.indexOf('// PATCH = atomic replace.');
if (a0 < 0 || a1 <= a0) { console.error('region A anchors missing'); process.exit(2); }
let regionA = SRC.slice(a0, a1);
// keep only what region A needs: strip the _exGetOrder/_exCancel helpers (network) by
// executing with stubs for this.helpers — simpler: they are declared but never CALLED
// during definition, so the region can execute as-is with a dummy `this`.
const defs = new Function('BASE', 'HDR', '_aptHarness', regionA + '\nreturn { r2v49, _exStopTargetPct, _exStopTsmBar, _exFillStop };');
const D = defs.call({ helpers: { httpRequest: () => { throw new Error('no net in defs'); } } }, 'http://x', {}, true);

// ---- region B: the EX-C3 decision block (REAL bytes) ----
const b0 = SRC.indexOf('let _exStopFinal = stopPrice, _exReanchor = null;');
const b1 = SRC.indexOf("const state = $getWorkflowStaticData('global');", b0);
if (b0 < 0 || b1 <= b0) { console.error('region B anchors missing'); process.exit(2); }
const regionB = SRC.slice(b0, b1);
async function runC3({ stopPrice, fill, isLong, bar, fillStop, capActive = true }) {
  const patches = [];
  const logs = [];
  const fakeConsole = { log: (...x) => logs.push(x.join(' ')), error: (...x) => logs.push('ERR ' + x.join(' ')) };
  const _exPatchStop = async (legId, newStop) => { patches.push({ legId, newStop }); return { ok: true, id: 'sl_new' }; };
  const fn = new AsyncFunction(
    'stopPrice', '_exFillPx', 'isLong', '_exCapActive', '_aptHarness', 'ticker', 'prev',
    '_exStopTsmBar', '_exFillStop', '_exPatchStop', 'console',
    'let slId = "sl_orig";\n' + regionB + '\nreturn { _exStopFinal, _exReanchor, slId };');
  const out = await fn(stopPrice, fill, isLong, capActive, false, 'TEST', {},
    bar !== undefined ? bar : D._exStopTsmBar,
    fillStop || D._exFillStop, _exPatchStop, fakeConsole);
  return { out, patches, logs };
}

(async () => {
  console.log('== EXD region A: defs (REAL bytes) ==');
  ok(D._exStopTargetPct === 0.025 && D._exStopTsmBar === 0.0259, 'EXD-01 constants are policy 2.5% target < 2.59% bar', D._exStopTargetPct + '/' + D._exStopTsmBar);
  ok(D._exFillStop(100, true) === 97.5 && D._exFillStop(100, false) === 102.5, 'EXD-02a _exFillStop = 2.5% of fill, both sides', D._exFillStop(100, true) + '/' + D._exFillStop(100, false));
  { const s = D._exFillStop(3.33, true);
    ok(Math.abs(s - 3.33) / 3.33 <= D._exStopTsmBar && s < 3.33, 'EXD-02b cent-walk stays inside bar, never crosses fill (penny stock)', String(s)); }

  console.log('== EXD region B: EX-C3 decision (REAL bytes) ==');
  { // EXD-03 THE regression: policy stop, clean fill -> must NOT fire
    const r = await runC3({ stopPrice: 97.5, fill: 100.0, isLong: true });
    ok(r.out._exReanchor === null && r.patches.length === 0 && r.out._exStopFinal === 97.5 && r.out.slId === 'sl_orig',
      'EXD-03 clean fill: EX-C3 does NOT fire; placed 2.5% policy stop stands', JSON.stringify(r.out._exReanchor));
  }
  { // EXD-03b modest slip (0.2%) still inside bar
    const r = await runC3({ stopPrice: 97.5, fill: 100.2, isLong: true });
    const realised = Math.abs(97.5 - 100.2) / 100.2; // 2.694% > 2.59% -> actually fires; compute expectation honestly:
    if (realised > D._exStopTsmBar) {
      ok(r.patches.length === 1 && Math.abs(r.out._exStopFinal - D._exFillStop(100.2, true)) < 1e-9,
        'EXD-03b 0.2% adverse slip: realised ' + (realised * 100).toFixed(2) + '% > bar -> re-anchor to 2.5% of fill', String(r.out._exStopFinal));
    } else {
      ok(r.patches.length === 0, 'EXD-03b 0.2% adverse slip inside bar: no fire');
    }
  }
  { // EXD-04 pathological adverse fill
    const r = await runC3({ stopPrice: 97.5, fill: 95.0, isLong: true });
    ok(r.patches.length === 1 && r.out._exStopFinal === D._exFillStop(95, true) && r.out._exReanchor && r.out._exReanchor.ok && r.out.slId === 'sl_new',
      'EXD-04 bad fill (realised 2.63%): fires once, re-anchors to 2.5% of FILL, adopts new leg id', String(r.out._exStopFinal));
    ok(r.out._exStopFinal === 92.63, 'EXD-04b re-anchored stop is 92.63 (2.5% under 95 fill)', String(r.out._exStopFinal));
  }
  { // EXD-05 incident witness: OLD constants reproduce the 08-26 bug under EXD-03 inputs
    const oldBar = 0.0119;
    const oldFillStop = (fill, long) => { // old geometry, target 1.15%
      let s = D.r2v49(long ? fill * (1 - 0.0115) : fill * (1 + 0.0115));
      for (let i = 0; i < 60; i++) { if (!(Math.abs(s - fill) / fill > oldBar)) break; const n = D.r2v49(long ? s + 0.01 : s - 0.01); if ((long && n >= fill) || (!long && n <= fill)) break; s = n; }
      return s;
    };
    const r = await runC3({ stopPrice: 97.5, fill: 100.0, isLong: true, bar: oldBar, fillStop: oldFillStop });
    const pct = r.out._exReanchor ? Math.abs(r.out._exStopFinal - 100) / 100 * 100 : null;
    ok(r.patches.length === 1 && pct !== null && pct >= 1.10 && pct <= 1.16,
      'EXD-05 WITNESS: old constants fire on a CLEAN fill and force ~1.15% (the CHTR/EQT/FLEX incident)', pct + '%');
  }
  { // EXD-06 short mirror
    const r = await runC3({ stopPrice: 102.5, fill: 105.5, isLong: false }); // realised 2.844% > bar
    ok(r.patches.length === 1 && r.out._exStopFinal === D._exFillStop(105.5, false),
      'EXD-06 short-side bad fill mirrors: re-anchor to 2.5% ABOVE fill', String(r.out._exStopFinal));
  }
  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
