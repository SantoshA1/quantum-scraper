#!/usr/bin/env node
'use strict';
/**
 * Institutional review (2026-08-12): how much evidence does QTP's track record actually carry?
 * Deterministic (seeded LCG). Run from repo root: node analysis/sample-adequacy-20260812.js
 * Input = the 20 certified long trades, corrected r_multiple field (gov 208).
 */
const PNL = [-82.73,-453.81,-35.52,-99.94,540.80,564.74,-108.50,-104.34,-119.84,-36.04,
             555.08,-107.36,484.65,-112.98,-157.66,-45.15,-107.94,-96.86,-132.40,-168.97];
let seed = 20260812;
const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
const pf = (a) => { const w = a.filter(x=>x>0).reduce((s,x)=>s+x,0), l = Math.abs(a.filter(x=>x<=0).reduce((s,x)=>s+x,0)); return l>0 ? w/l : (w>0?Infinity:NaN); };
const mean = (a) => a.reduce((s,x)=>s+x,0)/a.length;
const q = (a,p) => a.slice().sort((x,y)=>x-y)[Math.floor(p*a.length)];

const n = PNL.length, B = 50000;
const pfs = [], means = [];
for (let b=0;b<B;b++){ const s=[]; for(let i=0;i<n;i++) s.push(PNL[Math.floor(rnd()*n)]); pfs.push(pf(s)); means.push(mean(s)); }
const finite = pfs.filter(Number.isFinite);
console.log('OBSERVED   n =', n, ' PF =', pf(PNL).toFixed(4), ' mean $/trade =', mean(PNL).toFixed(2));
console.log('BOOTSTRAP  PF 95% CI = [' + q(finite,0.025).toFixed(3) + ', ' + q(finite,0.975).toFixed(3) + ']',
            ' P(PF<1 i.e. no edge) =', (finite.filter(x=>x<1).length/finite.length).toFixed(3));
console.log('BOOTSTRAP  mean$ 95% CI = [' + q(means,0.025).toFixed(2) + ', ' + q(means,0.975).toFixed(2) + ']',
            ' P(mean<0) =', (means.filter(x=>x<0).length/means.length).toFixed(3));

// concentration: how dependent is the whole result on the few winners?
const sorted = PNL.slice().sort((a,b)=>b-a);
console.log('\nCONCENTRATION  top-1 winner =', sorted[0].toFixed(2), ' | all 4 winners =', sorted.slice(0,4).reduce((s,x)=>s+x,0).toFixed(2));
console.log('  drop the single best trade -> PF =', pf(PNL.filter(x=>x!==sorted[0])).toFixed(4));
console.log('  drop the two best          -> PF =', pf(PNL.filter(x=>x!==sorted[0]&&x!==sorted[1])).toFixed(4));

// SAMPLE ADEQUACY: trades needed to distinguish the observed edge from zero at 95%/80% power.
// two-sided, per-trade dollar mean vs 0: n = ((z_a/2 + z_b) * sd / effect)^2
const sd = Math.sqrt(PNL.reduce((s,x)=>s+(x-mean(PNL))**2,0)/(n-1));
console.log('\nSAMPLE ADEQUACY  per-trade sd = $' + sd.toFixed(2));
for (const eff of [50, 100, 150]) {
  const need = Math.ceil(((1.96+0.84)*sd/eff)**2);
  console.log(`  to prove a +$${eff}/trade edge at 95% conf / 80% power: n = ${need} trades`);
}
// and the accumulation rate reality check
const perDay = 0.52;   // measured: 46 closed trades over the live span, per TRADING day
for (const need of [385, 96, 43]) {
  console.log(`  n=${need} at ${perDay} trades/trading-day = ${Math.round(need/perDay)} trading days ≈ ${(need/perDay/21).toFixed(1)} months`);
}

// ── appended: the decidability calculation (per-trade Sharpe → trades to t=2) ──
{
  const m = mean(PNL), sd2 = Math.sqrt(PNL.reduce((s,x)=>s+(x-m)**2,0)/(PNL.length-1));
  const spt = m/sd2, need = Math.ceil((2/spt)**2);
  console.log('\nDECIDABILITY');
  console.log(`  per-trade Sharpe = ${spt.toFixed(4)} | observed t at n=${PNL.length} = ${(spt*Math.sqrt(PNL.length)).toFixed(2)}`);
  console.log(`  trades to t=2 = ${need} | at 0.52/day = ${(need/0.52/252).toFixed(1)} yr | at 5/day = ${(need/5/252).toFixed(1)} yr | at 20/day = ${(need/20/252).toFixed(1)} yr`);
  console.log(`  annualised Sharpe if edge real: ${(spt*Math.sqrt(0.52*252)).toFixed(2)} @0.52/day, ${(spt*Math.sqrt(5*252)).toFixed(2)} @5/day, ${(spt*Math.sqrt(20*252)).toFixed(2)} @20/day`);
}
