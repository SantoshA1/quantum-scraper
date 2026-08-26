#!/usr/bin/env node
// gov 242 — H4c: the exit classifier learns the qtp_timeexit_ prefix (2026-08-26)
// Executes classifyExitReason from the REAL deployed and REAL patched node bytes.
// Gap closed: the gov-241 time-exit runner's market closes carried no classification
// path and fell through to 'manual', corrupting exit_reason analytics for the exact
// policy the cohort exists to measure. Witness: old bytes classify a timeexit order
// 'manual'; patched bytes -> 'time'. All pre-existing classifications regression-pinned.
// Sabotage: strip the prefix line -> H4C-01 bites.
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const OLD = fs.readFileSync(path.join(ROOT, 'docs/h4c-20260826/h4-build-exit-updates-deployed.js'), 'utf8');
const NEW = fs.readFileSync(path.join(ROOT, 'docs/h4c-20260826/h4-build-exit-updates-patched.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, name, extra) => { if (c) { pass++; console.log('  PASS ' + name); } else { fail++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')); } };

// extract + execute the real classifyExitReason (needs normSide from the same bytes)
function loadClassifier(src) {
  const a = src.indexOf('function normSide(side)');
  const b = src.indexOf('function intendedExitFor');
  if (a < 0 || b <= a) throw new Error('anchors missing');
  const region = src.slice(a, b);
  return new Function(region + '\nreturn classifyExitReason;')();
}
const cOld = loadClassifier(OLD);
const cNew = loadClassifier(NEW);

const LONG = { side: 'buy', intended_stop: 108.91, intended_target: 139.63 };
const timeExitOrd = { type: 'market', side: 'sell', client_order_id: 'qtp_timeexit_FLEX_20260828', filled_avg_price: 112.4 };
const stopOrd = { type: 'stop', side: 'sell', stop_price: 108.91, filled_avg_price: 108.85 };
const trailOrd = { type: 'stop', side: 'sell', stop_price: 110.5, filled_avg_price: 110.4 };   // ratcheted above intended
const targetOrd = { type: 'limit', side: 'sell', limit_price: 139.63, filled_avg_price: 139.6 };
const manualOrd = { type: 'market', side: 'sell', client_order_id: 'someone_clicked_close', filled_avg_price: 112.4 };

ok(cNew(LONG, timeExitOrd) === 'time', 'H4C-01 patched: qtp_timeexit_ market close -> time');
ok(cOld(LONG, timeExitOrd) === 'manual', 'H4C-02 WITNESS: deployed bytes classify the same order manual');
ok(cNew(LONG, stopOrd) === 'stop' && cOld(LONG, stopOrd) === 'stop', 'H4C-03 stop unchanged both');
ok(cNew(LONG, trailOrd) === 'trail' && cOld(LONG, trailOrd) === 'trail', 'H4C-04 ratcheted stop -> trail unchanged');
ok(cNew(LONG, targetOrd) === 'target' && cOld(LONG, targetOrd) === 'target', 'H4C-05 target unchanged');
ok(cNew(LONG, manualOrd) === 'manual', 'H4C-06 unprefixed market close still manual');
ok(cNew(LONG, { ...timeExitOrd, client_order_id: 'xqtp_timeexit_A_1' }) === 'manual', 'H4C-07 prefix must anchor at position 0');
{ // byte discipline: diff is exactly the one insertion
  const marker = 'QTP_H4c_TIMEEXIT_20260826';
  ok(NEW.indexOf(marker) > 0 && OLD.indexOf(marker) < 0 && (NEW.length - OLD.length) === 428, 'H4C-08 single-insertion diff (428 bytes)', String(NEW.length - OLD.length));
}
console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
