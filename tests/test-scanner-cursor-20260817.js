#!/usr/bin/env node
'use strict';
/**
 * Maya regression guard — the scanner must look at the whole watchlist (gov 224, 2026-08-17).
 *
 * Maya asks: "I gave you 624 tickers. On Monday you looked at 35 of them, and they all began
 * with A. Prove FROM THE DEPLOYED BYTES that (a) the old code really does re-read the same
 * names forever — I want to see it, not be told; (b) the new code reaches every single one of
 * my 624 within a session; (c) you did not raise how many trades it can open per cycle to get
 * there, because that is a risk limit and I did not authorise touching it; (d) it still works
 * when the watchlist changes size or the saved position is garbage; and (e) the huge watchlist
 * case that the batching exists for still behaves exactly as it did."
 *
 * Deterministic + offline. Fixtures are the real `Scan All Tickers` jsCode of workflow
 * 975pZZEtxeUbzI22: `scan-live-20260817.js` is what was live all day (sha 7e453413…, byte-
 * identical to the gov-218 publish 9763ba13) and `scan-cursor-patched.js` is the gov-224
 * candidate. The cursor region and the persist region are sliced out of those exact bytes by
 * literal marker and EXECUTED against a simulated multi-cycle session.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FIX = path.join(__dirname, '..', 'docs', 'scanner-cursor-20260817');
const BEFORE = fs.readFileSync(path.join(FIX, 'scan-live-20260817.js'), 'utf8');
const AFTER = fs.readFileSync(path.join(FIX, 'scan-cursor-patched.js'), 'utf8');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

let passed = 0, failed = 0;
function check(id, name, fn) {
  try { fn(); console.log(`  ✅ ${id}  ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${id}  ${name}\n        ${e.message}`); failed++; }
}

// ── slice the two regions the patch created, out of the REAL body ────────────
function slice(src, startMarker, endMarker) {
  const a = src.indexOf(startMarker);
  assert.ok(a !== -1, `start marker missing: ${startMarker.slice(0, 40)}`);
  const b = src.indexOf(endMarker, a);
  assert.ok(b !== -1, `end marker missing: ${endMarker.slice(0, 40)}`);
  return src.slice(a, b);
}
const BATCH_START = 'const SCANNER_MAX_PER_CYCLE = 1000;';
const BATCH_END = 'state.quantumScanUniverseCount = FULL_WATCHLIST_COUNT;';
const PERSIST_START_A = 'state.quantumScanWalkedThisCycle = _walked;';
const PERSIST_END_A = "console.log('[DONE] v3.2";

/**
 * One scan cycle, running the DEPLOYED batch/cursor bytes for real.
 * `signalEvery` = how many tickers the momentum filter chews through per signal found;
 * the walk stops after MAX_NEW_ENTRIES_PER_CYCLE signals, exactly like the real loop.
 */
function cycle(src, universe, state, { signalEvery = 8, maxEntries = 4 } = {}) {
  const region = slice(src, BATCH_START, BATCH_END);
  const persist = /quantumScanWalkedThisCycle/.test(src)
    ? slice(src, PERSIST_START_A, PERSIST_END_A) : '';
  const body = `
    let tickers = UNIVERSE.slice();
    const FULL_WATCHLIST_COUNT = tickers.length;
    ${region}
    // ---- the evaluate loop, reduced to the two lines gov 224 touches ----
    let _walked = 0, newEntriesThisCycle = 0;
    const visited = [];
    for (const ticker of tickers) {
      if (newEntriesThisCycle >= MAX_ENTRIES) break;
      _walked++;
      visited.push(ticker);
      if (visited.length % SIGNAL_EVERY === 0) newEntriesThisCycle++;
    }
    ${persist}
    return { visited, first: tickers[0], walked: _walked, batchLen: tickers.length };
  `;
  const fn = new Function('UNIVERSE', 'state', 'MAX_ENTRIES', 'SIGNAL_EVERY', body);
  return fn(universe, state, maxEntries, signalEvery);
}

/** Run a whole session and report which of the universe was ever looked at. */
function session(src, universe, cycles, opts) {
  const state = {};
  const seen = new Set();
  const firsts = [];
  for (let i = 0; i < cycles; i++) {
    const r = cycle(src, universe, state, opts);
    r.visited.forEach((t) => seen.add(t));
    firsts.push(r.first);
  }
  return { seen, firsts, state, coverage: seen.size / universe.length };
}

// 624 names, alphabetical — the real shape of quantum.quantum_watchlist_raw on 2026-08-17.
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const UNIVERSE = Array.from({ length: 624 }, (_, i) =>
  LETTERS[Math.floor(i / 24)] + String(i % 24).padStart(2, '0'));
const SESSION_CYCLES = 78;   // 6.5h of 5-minute cycles

(async () => {
  console.log('\n═══ the bytes are the deployed bytes ═══\n');

  check('SC-01', 'fixtures are the live gov-218 body and the gov-224 candidate', () => {
    assert.strictEqual(sha(BEFORE), '7e45341304f807aebeee98402487f6630bd72b93e3a9242e472c873ef0039591');
    assert.strictEqual(sha(AFTER), 'a0e261379fcae67ed29176e1df9f8942a34ff11937c09e65ea830a8f4cb54000');
  });

  check('SC-02', 'the patch only ADDS cursor lines — it deletes nothing and rewrites one log line', () => {
    const a = BEFORE.split('\n'), b = AFTER.split('\n');
    const setA = new Set(a);
    const added = b.filter((l) => !setA.has(l));
    const removed = a.filter((l) => !new Set(b).has(l));
    // exactly one pre-existing line is rewritten: the [DONE] log, which gained the cursor readout
    assert.strictEqual(removed.length, 1, `the patch DELETED ${removed.length} lines:\n${removed.join('\n')}`);
    assert.ok(removed[0].includes("'[DONE] v3.2"), `unexpected deletion: ${removed[0]}`);
    // every added line must belong to the cursor feature — nothing may sneak in
    const OWNED = /gov 224|_entryCursor|_cursorActive|_walked|quantumScanEntryCursor|quantumScanWalkedThisCycle|\[DONE\] v3\.2|^\s*\?|^\s*:|^\/\/|^$/;
    const strays = added.filter((l) => !OWNED.test(l.trim()) && !OWNED.test(l));
    assert.deepStrictEqual(strays, [], `lines added that are not part of the cursor:\n${strays.join('\n')}`);
    // and every risk/batching line is byte-identical in both — the [DONE] log is excluded
    // because it is the one rewritten line, already accounted for above.
    const riskLines = a.filter((l) =>
      /MAX_NEW_ENTRIES_PER_CYCLE|SCANNER_MAX_PER_CYCLE|SCANNER_BATCH_/.test(l) && !l.includes("'[DONE] v3.2"));
    assert.ok(riskLines.length >= 6, `only found ${riskLines.length} risk/batching lines to compare`);
    for (const line of riskLines) {
      assert.ok(b.includes(line), `a batching/risk line was altered: ${line}`);
    }
  });

  console.log('\n═══ the bug is real: I want to see it re-read the A\'s ═══\n');

  check('SC-03', 'REGRESSION WITNESS: the LIVE code reads the same names every cycle, all session', () => {
    const r = session(BEFORE, UNIVERSE, SESSION_CYCLES);
    assert.ok(r.firsts.every((f) => f === UNIVERSE[0]),
      'every cycle must restart at index 0 — that is the whole bug');
    assert.ok(r.seen.size <= 40, `saw ${r.seen.size} names; the bug is that it is a tiny fixed set`);
    const letters = new Set([...r.seen].map((s) => s[0]));
    assert.ok(letters.size <= 2 && letters.has('A'),
      `78 cycles and it never gets past the head — expected <=2 letters starting at A, got ${[...letters].join('')}`);
    // the same names, cycle after cycle: the union over 78 cycles equals the FIRST cycle's names
    const one = cycle(BEFORE, UNIVERSE, {});
    assert.deepStrictEqual([...r.seen].sort(), [...one.visited].sort(),
      '78 cycles must reveal not one name that cycle 1 did not already see');
  });

  check('SC-04', 'and that matches what actually happened on 2026-08-17: 35 names, letters {A,B}', () => {
    const r = session(BEFORE, UNIVERSE, SESSION_CYCLES);
    // production measured 35 distinct symbols of 624; the model must land in that ballpark,
    // not merely "fewer than all".
    assert.ok(r.seen.size >= 20 && r.seen.size <= 45,
      `model says ${r.seen.size}, production measured 35 — the model does not reproduce the field`);
    assert.ok(r.coverage < 0.08, `coverage ${(r.coverage * 100).toFixed(1)}% — production was 5.6%`);
  });

  console.log('\n═══ after the fix, every name gets looked at ═══\n');

  check('SC-05', 'the patched code sweeps ALL 624 within a session', () => {
    const r = session(AFTER, UNIVERSE, SESSION_CYCLES);
    const missed = UNIVERSE.filter((t) => !r.seen.has(t));
    assert.strictEqual(missed.length, 0,
      `${missed.length} of 624 never looked at, e.g. ${missed.slice(0, 6).join(',')}`);
    assert.strictEqual(r.coverage, 1);
  });

  check('SC-06', 'it reaches the far end of the alphabet, not just further into A', () => {
    const r = session(AFTER, UNIVERSE, SESSION_CYCLES);
    for (const l of LETTERS) {
      assert.ok([...r.seen].some((s) => s[0] === l), `never reached any ticker starting with ${l}`);
    }
    assert.ok(new Set(r.firsts).size > 10, 'the starting point must actually move between cycles');
  });

  check('SC-07', 'a full sweep completes in a reasonable number of cycles, not once a week', () => {
    const state = {};
    const seen = new Set();
    let cycles = 0;
    while (seen.size < UNIVERSE.length && cycles < 500) {
      cycle(AFTER, UNIVERSE, state).visited.forEach((t) => seen.add(t));
      cycles++;
    }
    assert.ok(seen.size === UNIVERSE.length, 'never completed a sweep');
    assert.ok(cycles <= 78, `took ${cycles} cycles (${cycles * 5} min) — must complete within a session`);
  });

  console.log('\n═══ the risk limit was NOT touched ═══\n');

  check('SC-08', 'MAX_NEW_ENTRIES_PER_CYCLE is still 4, and still breaks the loop', () => {
    for (const src of [BEFORE, AFTER]) {
      assert.ok(/const MAX_NEW_ENTRIES_PER_CYCLE = 4;/.test(src), 'the per-cycle entry cap moved');
      assert.ok(src.includes('if (newEntriesThisCycle >= MAX_NEW_ENTRIES_PER_CYCLE) {'),
        'the break that enforces it must be untouched');
    }
  });

  check('SC-09', 'the patched code opens no more per cycle than the live code did', () => {
    const st = {};
    for (let i = 0; i < 20; i++) {
      const a = cycle(AFTER, UNIVERSE, st);
      const b = cycle(BEFORE, UNIVERSE, {});
      const entriesA = Math.floor(a.visited.length / 8);
      const entriesB = Math.floor(b.visited.length / 8);
      assert.ok(entriesA <= 4 && entriesB <= 4, 'cap breached');
      assert.strictEqual(entriesA, entriesB, 'the fix must change WHICH names, never HOW MANY');
    }
  });

  console.log('\n═══ it survives a changing watchlist and a corrupt saved position ═══\n');

  check('SC-10', 'garbage in the saved cursor resets to 0 instead of skipping the universe', () => {
    for (const bad of [undefined, null, NaN, -5, 'banana', 1e9, 623.7, Infinity]) {
      const state = { quantumScanEntryCursor: bad };
      const r = cycle(AFTER, UNIVERSE, state);
      assert.ok(r.visited.length > 0, `dead cycle on cursor=${String(bad)}`);
      assert.ok(UNIVERSE.includes(r.first), `walked off the list on cursor=${String(bad)}`);
      assert.ok(Number.isInteger(state.quantumScanEntryCursor) && state.quantumScanEntryCursor >= 0
        && state.quantumScanEntryCursor < UNIVERSE.length,
        `left cursor=${state.quantumScanEntryCursor} behind after input ${String(bad)} — a non-integer compounds every cycle`);
    }
  });

  check('SC-11', 'the watchlist shrinking under a large cursor does not strand the scanner', () => {
    const state = {};
    for (let i = 0; i < 30; i++) cycle(AFTER, UNIVERSE, state);   // push the cursor out
    const small = UNIVERSE.slice(0, 12);
    const r = cycle(AFTER, small, state);
    assert.ok(r.visited.length > 0, 'a shrunk watchlist must still be scanned');
    assert.ok(small.includes(r.first));
    assert.ok(state.quantumScanEntryCursor < small.length, 'cursor must be re-clamped to the new size');
  });

  check('SC-12', 'a universe smaller than the entry cap is swept, not looped on forever', () => {
    const tiny = ['AAA', 'BBB', 'CCC'];
    const r = session(AFTER, tiny, 5, { signalEvery: 1, maxEntries: 4 });
    assert.strictEqual(r.seen.size, 3);
  });

  console.log('\n═══ the >1000-name case the batching exists for is unchanged ═══\n');

  check('SC-13', 'above SCANNER_MAX_PER_CYCLE the cursor stands down and batching still rotates', () => {
    const big = Array.from({ length: 2500 }, (_, i) => 'T' + String(i).padStart(4, '0'));
    const stA = {}, stB = {};
    for (let i = 0; i < 6; i++) {
      const a = cycle(AFTER, big, stA);
      const b = cycle(BEFORE, big, stB);
      assert.strictEqual(a.batchLen, b.batchLen, 'batch size diverged from the live code');
      assert.strictEqual(a.first, b.first, 'batch start diverged from the live code');
    }
    assert.strictEqual(stA.quantumScanEntryCursorActive, false, 'the cursor must disarm above one batch');
    assert.strictEqual(stA.quantumScanEntryCursor, 0);
    assert.strictEqual(stA.quantumWatchlistBatchOffset, stB.quantumWatchlistBatchOffset,
      'the batch offset must advance exactly as it does today');
  });

  check('SC-14', 'NEGATIVE CONTROL: run the patched cursor region against the LIVE walk and coverage dies', () => {
    // Sabotage: keep the patch but never persist the walk (the pre-gov-224 behaviour).
    const noPersist = AFTER.replace(slice(AFTER, PERSIST_START_A, PERSIST_END_A), '');
    const r = session(noPersist, UNIVERSE, SESSION_CYCLES);
    assert.ok(r.coverage < 0.08,
      `sabotage still covered ${(r.coverage * 100).toFixed(1)}% — SC-05 is not testing the cursor`);
  });

  console.log(`\n  ${passed}/${passed + failed} checks passed\n`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('HARNESS FAILURE:', e); process.exit(1); });
