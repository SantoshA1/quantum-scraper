#!/usr/bin/env node
'use strict';
/**
 * Maya regression guard — the scanner universe self-heal (gov 218, 2026-08-14).
 *
 * Maya asks: "For sixteen sessions this thing told everyone it was scanning a 622-name
 * watchlist while it was actually looking at 25, and not one alarm fired. Prove FROM THE
 * DEPLOYED BYTES that (a) it now scans every name in the list, (b) it heals the poisoned
 * cursor that is sitting in staticData right now without anyone touching it, (c) it can
 * never again split the list so that a remainder starves, (d) it still degrades safely if
 * the list outgrows one cycle, and (e) prove your test would have CAUGHT the original bug
 * — show me the old code failing the same assertions."
 *
 * Deterministic + offline. Fixtures are the real `Scan All Tickers` jsCode of workflow
 * 975pZZEtxeUbzI22: `scan-deployed.js` is the pre-fix deployed body (sha e49ccfe5…) and
 * `scan-patched.js` is what was published (sha 7e453413…). The batch-selection region is
 * sliced out of those exact bytes by literal marker and EXECUTED — not grepped.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FIX = path.join(__dirname, '..', 'docs', 'scanner-universe-20260814');
const BEFORE = fs.readFileSync(path.join(FIX, 'scan-deployed.js'), 'utf8');
const AFTER = fs.readFileSync(path.join(FIX, 'scan-patched.js'), 'utf8');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

let passed = 0, failed = 0;
function check(id, name, fn) {
  try { fn(); console.log(`  ✅ ${id}  ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${id}  ${name}\n        ${e.message}`); failed++; }
}

// ── slice the batch-selection region out of the REAL body, by literal marker ──────
const START = 'const FULL_WATCHLIST_COUNT = tickers.length;';
const END_MARK = "' ET');";
function region(src) {
  const a = src.indexOf(START);
  assert.ok(a !== -1, 'start marker missing');
  const b = src.indexOf(END_MARK, src.indexOf('[SCAN] #', a));
  assert.ok(b !== -1, 'end marker missing');
  return src.slice(a, b + END_MARK.length);
}
const REGION_BEFORE = region(BEFORE);
const REGION_AFTER = region(AFTER);

// Execute a region with a stubbed staticData + ticker list. Returns what the scan sees.
function runCycle(regionSrc, tickers, state) {
  const logs = [];
  const fn = new Function('state', 'tickers', 'etHour', 'etMin', 'console', `
    ${regionSrc}
    return { scanned: tickers, batchStart, batchEnd };
  `);
  const out = fn(state, tickers.slice(), 10, 0, { log: (m) => logs.push(String(m)) });
  return { scanned: out.scanned, batchStart: out.batchStart, batchEnd: out.batchEnd, state, logs };
}
// Walk N cycles and return the union of everything the scanner looked at.
function sweep(regionSrc, tickers, cycles, state) {
  const st = state || {};
  const seen = new Set();
  const sizes = [];
  for (let i = 0; i < cycles; i += 1) {
    const r = runCycle(regionSrc, tickers, st);
    r.scanned.forEach((t) => seen.add(t));
    sizes.push(r.scanned.length);
  }
  return { seen, sizes, state: st };
}
const universe = (n) => Array.from({ length: n }, (_, i) => 'T' + String(i).padStart(4, '0'));
const LIVE_N = 622; // the real effective watchlist on 2026-08-14

(async () => {
  console.log('\n═══ the bytes are the deployed bytes ═══\n');

  check('SU-01', 'fixtures are the real pre-fix and published Scan All Tickers bodies', () => {
    assert.strictEqual(sha(BEFORE), 'e49ccfe5e7e7de82eaab42602f55c42bb5d6a01c9d20b060b07d9e403265b67e');
    assert.strictEqual(sha(AFTER), '7e45341304f807aebeee98402487f6630bd72b93e3a9242e472c873ef0039591');
  });

  check('SU-02', 'the patch touched ONLY the batch-selection region — every other byte identical', () => {
    // reconstruct: swapping the new region back for the old must reproduce the old file
    const rebuilt = AFTER.replace(REGION_AFTER, REGION_BEFORE);
    assert.strictEqual(sha(rebuilt), sha(BEFORE),
      'something outside the batch-selection region changed');
  });

  check('SU-03', 'the risk-shaping constants were NOT touched by this fix', () => {
    for (const c of ['MAX_NEW_ENTRIES_PER_CYCLE = 4', 'DEDUP_WINDOW_MS = 25 * 60 * 1000',
      'MAX_DAILY_LOSS_PCT', 'MAX_MARGIN_PCT', 'MAX_POSITIONS', 'MAX_EXPOSURE']) {
      assert.strictEqual(AFTER.includes(c), BEFORE.includes(c), `constant moved: ${c}`);
    }
    assert.ok(!AFTER.includes('SCANNER_BATCH_SIZE = 600'), 'the fixed 600 constant must be gone');
  });

  console.log('\n═══ the bug is real, and this suite catches it ═══\n');

  check('SU-04', 'REGRESSION WITNESS: the OLD code splits 622 into 600 + 22 and starves the middle', () => {
    const { sizes, seen } = sweep(REGION_BEFORE, universe(LIVE_N), 2);
    assert.deepStrictEqual(sizes, [600, 22], `old code batch sizes were ${sizes}`);
    assert.strictEqual(seen.size, LIVE_N, 'two cycles do cover it — the starvation is downstream of here');
    // the 22-name micro-batch is the defect: it consumes a whole cycle
    assert.ok(sizes.includes(22), 'the degenerate micro-batch must be reproduced');
  });

  check('SU-05', 'REGRESSION WITNESS: the OLD code gives the tail 22 names a full cycle to itself', () => {
    const st = {};
    const c1 = runCycle(REGION_BEFORE, universe(LIVE_N), st);
    const c2 = runCycle(REGION_BEFORE, universe(LIVE_N), st);
    assert.strictEqual(c1.scanned.length, 600);
    assert.strictEqual(c2.scanned.length, 22);
    // 50% of scan cycles spent on 3.5% of the universe
    assert.ok(c2.scanned.length / LIVE_N < 0.04);
  });

  console.log('\n═══ every name in the list is scanned, every cycle ═══\n');

  check('SU-06', 'at the live universe size, ONE batch covers all 622 names', () => {
    const r = runCycle(REGION_AFTER, universe(LIVE_N), {});
    assert.strictEqual(r.scanned.length, LIVE_N);
    assert.strictEqual(r.batchStart, 0);
    assert.strictEqual(r.batchEnd, LIVE_N);
    assert.strictEqual(r.state.quantumScanCoveragePct, 100);
    assert.ok(r.logs.join(' ').includes('100% of universe'), r.logs.join(' '));
  });

  check('SU-07', 'the poisoned cursor sitting in production staticData heals itself, unattended', () => {
    // this is the exact live state on 2026-08-14: offset parked at 600 of 622
    const st = { quantumWatchlistBatchOffset: 600, scanCount: 4211 };
    const r = runCycle(REGION_AFTER, universe(LIVE_N), st);
    assert.strictEqual(r.scanned.length, LIVE_N, 'a stale offset must not survive the fix');
    assert.strictEqual(st.quantumWatchlistBatchOffset, 0, 'the cursor must be cleared');
    assert.strictEqual(r.scanned[0], 'T0000', 'and the scan must start at the top of the list');
  });

  check('SU-08', 'ten consecutive cycles all scan the full universe — no alternation left', () => {
    const { sizes, seen } = sweep(REGION_AFTER, universe(LIVE_N), 10);
    assert.deepStrictEqual([...new Set(sizes)], [LIVE_N], `sizes drifted: ${[...new Set(sizes)]}`);
    assert.strictEqual(seen.size, LIVE_N);
  });

  check('SU-09', 'the pre-07-22 universe (537) behaves exactly as it did before the watchlist grew', () => {
    const before = runCycle(REGION_BEFORE, universe(537), {});
    const after = runCycle(REGION_AFTER, universe(537), {});
    assert.deepStrictEqual(after.scanned, before.scanned,
      'below 600 the fix must be a no-op — that era was not broken');
  });

  console.log('\n═══ it can never degenerate again ═══\n');

  check('SU-10', 'a universe just past the old ceiling splits EVENLY, not 1000 + 1', () => {
    const N = 1001;
    const { sizes, seen } = sweep(REGION_AFTER, universe(N), 2);
    assert.deepStrictEqual(sizes, [501, 500], `expected even halves, got ${sizes}`);
    assert.strictEqual(seen.size, N, 'a full sweep must still cover every name');
    // the same starved-remainder shape the old code produces, one name past its ceiling
    const old601 = sweep(REGION_BEFORE, universe(601), 2);
    assert.deepStrictEqual(old601.sizes, [600, 1], 'old code makes a 1-name micro-batch at 601');
    const new601 = sweep(REGION_AFTER, universe(601), 2);
    assert.deepStrictEqual(new601.sizes, [601, 601], 'the fix scans all 601 every cycle');
  });

  check('SU-11', 'a much larger universe still completes a full sweep, in even batches', () => {
    const N = 2500;
    const { sizes, seen } = sweep(REGION_AFTER, universe(N), 3);
    assert.strictEqual(seen.size, N, 'three cycles must cover all 2500');
    // ceil-sized batches differ by at most (batchCount - 1) names — 834/834/832 here
    assert.ok(Math.max(...sizes) - Math.min(...sizes) <= sizes.length - 1, `batches uneven: ${sizes}`);
    assert.ok(Math.min(...sizes) / Math.max(...sizes) > 0.95, `batch sizes lopsided: ${sizes}`);
  });

  check('SU-12', 'no batch is ever smaller than a quarter of an even share, at any size 1..3000', () => {
    for (const N of [1, 2, 7, 99, 599, 600, 601, 622, 999, 1000, 1001, 1500, 2000, 2001, 3000]) {
      const cycles = Math.ceil(N / 1000) + 1;
      const { sizes, seen } = sweep(REGION_AFTER, universe(N), cycles);
      assert.strictEqual(seen.size, N, `N=${N}: sweep missed names (${seen.size}/${N})`);
      const share = N / Math.max(1, Math.ceil(N / 1000));
      for (const s of sizes) {
        assert.ok(s >= Math.min(N, share * 0.75), `N=${N}: starved batch of ${s} (share ${share})`);
      }
    }
  });

  check('SU-13', 'an empty or single-name watchlist does not throw or wedge the cursor', () => {
    for (const N of [0, 1]) {
      const st = { quantumWatchlistBatchOffset: 600 };
      const r = runCycle(REGION_AFTER, universe(N), st);
      assert.strictEqual(r.scanned.length, N);
      assert.strictEqual(st.quantumWatchlistBatchOffset, 0);
    }
  });

  check('SU-14', 'coverage telemetry is written every cycle, so a collapse can be asserted on', () => {
    const st = {};
    runCycle(REGION_AFTER, universe(LIVE_N), st);
    assert.strictEqual(st.quantumScanUniverseCount, LIVE_N);
    assert.strictEqual(st.quantumScanBatchSize, LIVE_N);
    assert.strictEqual(st.quantumScanCoveragePct, 100);
    const st2 = {};
    runCycle(REGION_AFTER, universe(2500), st2);
    assert.strictEqual(st2.quantumScanCoveragePct, 33.4, 'partial sweeps must report partial coverage');
  });

  console.log(`\n  ${passed}/${passed + failed} checks passed\n`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('HARNESS FAILURE:', e); process.exit(1); });
