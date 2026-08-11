#!/usr/bin/env node
'use strict';
/**
 * Maya regression guard — the entry-cap ↔ TSM-classifier coupling (Conclave S2, 2026-08-11).
 *
 * Maya asks: "Two different files each have a number that has to be the same number. Last time
 * they disagreed, my stop got cancelled and replaced with one 0.25% under the market, and noise
 * took me out of a trade whose exit price was ABOVE where I bought it. So: fail loudly the
 * moment somebody moves one and forgets the other. I don't care that it's 'obvious' — WST was
 * obvious afterwards too."
 *
 * THE INVARIANT (ratified 2026-08-11, S2):
 *   The entry-stop clamp (Alpaca Paper Trade, MAX_ENTRY_STOP_PCT) and the TSM's
 *   UNPROTECTED_STOP_TOO_WIDE classifier (Trail Stops, MAX_PROTECTIVE_STOP_PCT) are ONE
 *   parameter. Neither may move without the other, in the same atomic commit.
 *
 * Why it is load-bearing: if the entry cap is widened past the classifier bar, the TSM
 * classifies EVERY new position as too-wide, cancels its bracket stop, and forces a 0.9%
 * replacement — handing the whole book to the recovery path. That is the gov 202/203 WST
 * failure chain, reproduced by config drift rather than by a bug.
 *
 * Deterministic and offline. Reads the DEPLOYED bytes of both nodes.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function check(id, name, fn) {
  try { fn(); console.log(`  ✅ ${id}  ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${id}  ${name}\n        ${e.message}`); failed++; }
}
const DIR = path.join(__dirname, '..', 'docs', 'execution-fix-20260810');
const APT = fs.readFileSync(path.join(DIR, 'alpaca-paper-trade-v4.9.1.js'), 'utf8');
const TSM = fs.readFileSync(path.join(DIR, 'tsm-trail-stops-LIVE.js'), 'utf8');

const strip = (s) => s.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
const grabNum = (src, re, what) => {
  const m = strip(src).match(re);
  assert.ok(m, `could not find ${what} — the constant was renamed or removed, which is itself the failure this suite exists to catch`);
  return Number(m[1]);
};

console.log('\n═══ S2 — the entry cap and the TSM classifier are ONE parameter ═══\n');

check('CPL-01', 'both constants are still findable by name — a rename silently unpins the invariant', () => {
  assert.ok(/MAX_ENTRY_STOP_PCT\s*=/.test(strip(APT)), 'entry clamp constant missing from the Alpaca node');
  assert.ok(/MAX_PROTECTIVE_STOP_PCT\s*=/.test(strip(TSM)), 'classifier constant missing from Trail Stops');
});
check('CPL-02', 'THE INVARIANT: entry clamp === TSM classifier bar, to the last decimal', () => {
  const entry = grabNum(APT, /MAX_ENTRY_STOP_PCT\s*=\s*([0-9.]+)/, 'MAX_ENTRY_STOP_PCT');
  const tsm   = grabNum(TSM, /MAX_PROTECTIVE_STOP_PCT\s*=\s*([0-9.]+)/, 'MAX_PROTECTIVE_STOP_PCT');
  assert.strictEqual(entry, tsm,
    `entry clamp ${entry} vs TSM classifier ${tsm} — MOVED APART. Every new position will be ` +
    `classified UNPROTECTED_STOP_TOO_WIDE and handed to the 0.9% forced-stop recovery path. ` +
    `This is the WST failure chain. Move both or neither.`);
});
check('CPL-03', 'the bar is still where gov 190 and gov 202/203 left it (1.2%) — a silent drift is a finding', () => {
  assert.strictEqual(grabNum(APT, /MAX_ENTRY_STOP_PCT\s*=\s*([0-9.]+)/, 'entry'), 0.012,
    'if this changed deliberately, the Conclave must have ruled S1 and this pin must be updated in the same commit');
});
check('CPL-04', 'the fill-anchored stop target sits INSIDE the classifier bar, with margin for cent rounding', () => {
  const target = grabNum(APT, /_exStopTargetPct\s*=\s*([0-9.]+)/, '_exStopTargetPct');
  const guard  = grabNum(APT, /_exStopTsmBar\s*=\s*([0-9.]+)/, '_exStopTsmBar');
  const bar    = grabNum(TSM, /MAX_PROTECTIVE_STOP_PCT\s*=\s*([0-9.]+)/, 'classifier');
  assert.ok(target < guard, `re-anchor target ${target} must be inside its own guard ${guard}`);
  assert.ok(guard < bar, `guard ${guard} must be inside the TSM bar ${bar} — this is the rounding margin`);
  assert.ok(bar - target >= 0.0004, `only ${bar - target} of margin: one cent of rounding can cross the bar`);
});
check('CPL-05', 'the forced-recovery stop is still TIGHTER than the classifier bar it replaces', () => {
  // TSM: _tightPct = min(0.009, 1.5 x atr/entry). If this ever exceeded the bar, the recovery
  // would place a stop that immediately re-triggers its own classifier — an infinite churn.
  const tight = grabNum(TSM, /_tightPct\s*=\s*Math\.min\(([0-9.]+)/, '_tightPct');
  const bar   = grabNum(TSM, /MAX_PROTECTIVE_STOP_PCT\s*=\s*([0-9.]+)/, 'classifier');
  assert.ok(tight < bar, `recovery stop ${tight} must be tighter than the bar ${bar}, or recovery re-arms itself`);
});
check('CPL-06', 'the coupling is documented in the deployed bytes, not only in a doc nobody opens', () => {
  assert.ok(/1\.2%|MAX_PROTECTIVE_STOP_PCT|TSM/.test(APT),
    'the Alpaca node must reference the TSM constraint so the next editor sees the coupling in situ');
});

console.log(`\n  ${passed}/${passed + failed} checks passed\n`);
process.exit(failed === 0 ? 0 : 1);
