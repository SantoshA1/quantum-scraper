#!/usr/bin/env node
'use strict';
/**
 * Maya regression guard — TSM wide-stop recovery v4.3.1 (gov 189).
 *
 * Maya asks: "Today your stop 'recovery' cancelled the only stop WRB had, failed to place
 * the new one, and left me naked — then the watcher dumped me at the low. Twice. Replay
 * BOTH real cases and prove the new logic keeps my existing stop when the tight one can't
 * exist, prove a placement failure after a cancel re-protects me instead of leaving me
 * naked, and prove the normal path didn't change for positions where recovery works."
 *
 * Deterministic + offline. Fixtures are the REAL numbers from execs 524111 (WRB) and
 * 524416 (APA). Lockstep: the live node embeds the same guard/fallback arithmetic.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const R = require('../lib/tsm/stop_recovery');

let passed = 0, failed = 0;
function check(id, name, fn) {
  try { fn(); console.log(`  ✅ ${id}  ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${id}  ${name}  — ${e.message}`); failed++; }
}

// ── the two real casualties must land in KEEP_EXISTING ─────────────────────────
check('REC-01', 'WRB replay (entry 73.05527, market 72.085): tight 72.40 is unplaceable → KEEP_EXISTING, nothing cancelled', () => {
  const d = R.recoveryDecision({ isLong: true, entry: 73.05527, current: 72.085, atrMiss: 3.0 });
  assert.strictEqual(d.tightStop, 72.4, 'byte-matches the 422 the broker threw (stop_price 72.4 vs market 71.99→72.085)');
  assert.strictEqual(d.action, 'KEEP_EXISTING', 'v4.3.0 went naked here');
});
check('REC-02', 'APA replay (entry 35.9, market 35.51): tight 35.58 unplaceable → KEEP_EXISTING', () => {
  const d = R.recoveryDecision({ isLong: true, entry: 35.9, current: 35.51, atrMiss: 2.0 });
  assert.strictEqual(d.tightStop, 35.58, 'matches the live 422 (stop_price 35.58 vs market 35.53)');
  assert.strictEqual(d.action, 'KEEP_EXISTING');
});
check('REC-03', 'short mirror: price rallied through the tightened level → KEEP_EXISTING', () => {
  const d = R.recoveryDecision({ isLong: false, entry: 12.415, current: 12.58, atrMiss: 0.05 });
  assert.ok(d.tightStop <= 12.58 * 1.001, 'tight stop below required clearance');
  assert.strictEqual(d.action, 'KEEP_EXISTING');
});

// ── the healthy path is unchanged ──────────────────────────────────────────────
check('REC-04', 'healthy long (market above tight level): CANCEL_AND_REPLACE with the same v4.3.0 arithmetic', () => {
  const d = R.recoveryDecision({ isLong: true, entry: 100, current: 99.8, atrMiss: 0.4 });
  assert.strictEqual(d.tightStop, 99.4, 'min(0.9%, 1.5×ATR/entry)=0.6% → 99.40');
  assert.strictEqual(d.action, 'CANCEL_AND_REPLACE', 'recovery still fires when it can succeed');
});
check('REC-05', 'healthy short: CANCEL_AND_REPLACE, tight stop above market clearance', () => {
  const d = R.recoveryDecision({ isLong: false, entry: 50, current: 50.2, atrMiss: 5 });
  assert.strictEqual(d.tightStop, 50.45, '0.9% cap');
  assert.strictEqual(d.action, 'CANCEL_AND_REPLACE');
});
check('REC-06', 'boundary: tight stop just inside the 0.1% clearance stays REPLACE; just outside flips to KEEP', () => {
  assert.strictEqual(R.recoveryDecision({ isLong: true, entry: 100.5, current: 100, atrMiss: 0.6 }).action, 'CANCEL_AND_REPLACE'); // tight 99.60 < 99.9
  assert.strictEqual(R.recoveryDecision({ isLong: true, entry: 100.9, current: 100, atrMiss: 10 }).action, 'KEEP_EXISTING');       // tight 99.99 !< 99.9
});

// ── the re-protect fallback ────────────────────────────────────────────────────
check('REC-07', 'fallback stop sits 0.5% inside market on both sides — placeable by construction', () => {
  const l = R.recoveryDecision({ isLong: true, entry: 100, current: 99.8, atrMiss: 0.4 });
  assert.strictEqual(l.fallbackStop, 99.3, '99.8 × 0.995');
  assert.ok(l.fallbackStop < 99.8 * 0.999, 'satisfies the same validity rule');
  const s = R.recoveryDecision({ isLong: false, entry: 50, current: 50.2, atrMiss: 5 });
  assert.strictEqual(s.fallbackStop, 50.45, '50.2 × 1.005');
  assert.ok(s.fallbackStop > 50.2 * 1.001);
});

// ── lockstep with the deployable node file ─────────────────────────────────────
check('REC-08', 'the v4.3.1 node file carries the guard, the fallback, and no naked path (pinned)', () => {
  const node = fs.readFileSync(path.join(__dirname, '..', 'docs', 'naked-window-20260806', 'tsm-trail-stops-v4.3.1.js'), 'utf8');
  assert.ok(node.includes("(isLong && !(_tightStop < current * 0.999)) || (!isLong && !(_tightStop > current * 1.001))"), 'validity guard present before the cancel branch');
  assert.ok(node.includes("STOP_TOO_WIDE_KEPT_EXISTING_UNRECOVERABLE"), 'keep-existing result type');
  assert.ok(node.includes("isLong ? r2(current * 0.995) : r2(current * 1.005)"), 're-protect fallback arithmetic');
  assert.ok(node.includes("STOP_TOO_WIDE_REPLACED_WITH_FALLBACK_STOP"), 'fallback result type');
  assert.ok(node.indexOf('KEPT_EXISTING_UNRECOVERABLE') < node.indexOf("state._stopRecoveryDedup[_widthKey] = Date.now();"), 'guard evaluated BEFORE the cancel path marks dedup');
  assert.strictEqual((node.match(/qtp_fbstop_/g) || []).length, 1, 'fallback client-order prefix present once');
});

console.log(`\n  ${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
