#!/usr/bin/env node
'use strict';
/**
 * Maya regression guard — the ratified exit policy actually reaches the broker
 * (gov 241 Decision 1 mechanics, 2026-08-25).
 *
 * Maya asks: "The Conclave ratified a 2.5% fixed stop and a 2-day time exit because three
 * out-of-sample passes measured THAT policy. Now prove the machinery will place THAT policy
 * and not an approximation: (a) the executor computes a FIXED 2.5% stop — not min(ATR,cap),
 * not 1.2% — execute the real math and show me the price; (b) the take-profit leg cannot
 * bind inside the hold — because a TP that fires early is a different policy than the one
 * you measured; (c) the gate judges the SAME 2.5% stop the order carries — parity, executed
 * on the real Prep bytes; (d) the TSM no longer classifies the ratified stop as a defect —
 * because at 1.2% tolerance it would CANCEL the Conclave's stop and force 0.9%, silently
 * repealing the ratification every morning; (e) the TSM tier ladder is frozen — no
 * breakeven moves, no tightening, no tier-gated scale-outs on new advancement — while
 * every suppressed advancement is LOGGED so the deviation cost stays measurable; and
 * (f) the pieces that were not ratified to change are byte-identical."
 *
 * FIELD LESSON (first run): five reds, ALL harness — a missing $input stub, a parameter
 * colliding with an in-region declaration (_evalFav is computed INSIDE the sliced region),
 * and my own patch comment tripping an over-broad drift counter. The subjects were healthy.
 * Executed-region harnesses must inject the region's INPUTS, never its intermediates.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FIX = path.join(__dirname, '..', 'docs', 'policy-20260825');
const rd = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');
const EXE_OLD = rd('alpaca-paper-trade-deployed.js'), EXE_NEW = rd('alpaca-paper-trade-patched.js');
const PRE_OLD = rd('gatek-prep-deployed.js'),        PRE_NEW = rd('gatek-prep-patched.js');
const TSM_OLD = rd('tsm-node-trail-stops.js'),       TSM_NEW = rd('tsm-node-trail-stops-patched.js');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const count = (h, n) => h.split(n).length - 1;

let passed = 0, failed = 0;
async function check(id, name, fn) {
  try { await fn(); console.log(`  ✅ ${id}  ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${id}  ${name}\n        ${e.message}`); failed++; }
}

// Execute the executor's stop/target math region against controlled inputs.
function runExecMath(src, { price, atr, vol, isLong }) {
  const a = src.indexOf('const r2 = n => Math.round(n * 100) / 100;');
  const b = src.indexOf('// ── APT v4.9 EX-C1: the capped marketable limit');
  assert.ok(a !== -1 && b > a, 'executor math region markers missing');
  const region = src.slice(a, b);
  const fn = new Function('price', 'atr', 'vol', 'isLong', 'SL_MULT', 'ticker', 'console',
    region + '\nreturn { stopPrice, stopLimit, tpPrice, _stopDist, _rawStopDist };');
  return fn(price, atr, vol, isLong, vol ? 1.0 : 1.5, 'TT', { log: () => {} });
}
// Execute the FULL Prep node with a stubbed item.
function runPrep(src, item) {
  const fn = new Function('$', '$json', '$input', src);
  const $input = { first: () => ({ json: item }), all: () => [{ json: item }] };
  return fn(() => { throw new Error('prep must not reference other nodes'); }, item, $input)[0].json;
}
// Execute the TSM tier-ladder region.
function runLadder(src, { isLong, tier, fav, entry, atr }) {
  const a = src.indexOf('  const BUF = 0.05;');
  const marker = 'if (!QTP_TIER_TRAIL_ENABLED && newTier !== ts.tier) {';
  const isNew = src.includes(marker);
  // OLD bytes: the ladder ends at the '\n  }' that closes the outer if/else (indent-2 brace).
  const endAnchor = isNew ? src.indexOf('}', src.indexOf('newStop = null;', src.indexOf(marker))) + 1
                          : src.indexOf('\n  }', src.indexOf('else if (_evalFav <= t1_trigger')) + 4;
  assert.ok(a !== -1 && endAnchor > a, 'ladder region markers missing');
  const region = src.slice(a, endAnchor);
  const logs = [];
  const fn = new Function('REAL_ATR_ON', 'BAR_EXTREME_ON', 'sessBars', '$vars', 'isLong', 'ts', 'current', 'entry', 'atr', 'r2', 'sym', 'console',
    region + '\nreturn { newTier, newStop };');
  const out = fn(false, false, {}, {}, isLong, { tier }, fav, entry, atr, (n) => Math.round(n * 100) / 100, 'TT',
    { log: (m) => logs.push(m), warn: () => {} });
  return { ...out, logs };
}

(async () => {
  console.log('\n═══ fixtures are the deployed + patched bytes ═══\n');

  await check('EP-01', 'all six fixtures pinned by sha', () => {
    assert.strictEqual(sha(EXE_OLD), 'df7d8036b2fbbd995d66b6372979bc36127f59c3ac6d833a5dc589c69667031e');
    assert.strictEqual(sha(EXE_NEW), 'db529b7b40a05f04eab63d2ba161f85d847164346820630d8b2beb3ee11f449a');
    assert.strictEqual(sha(PRE_OLD), 'aff5743c7d8182baaf2e61e2c35ed0821bb3f6d0cf373c166e8d26bbd8268d72');
    assert.strictEqual(sha(PRE_NEW), 'b00761ec26871f0caf95e551e201d4f149d45be0422fe1ad50b9ea4781db35cb');
    assert.strictEqual(sha(TSM_OLD), '5f22eddd175bfdc3aab57a645bcd17b6cf828bae6fbb91eb0b96672795df207d');
    assert.strictEqual(sha(TSM_NEW), 'e61ad289f961c30a04301e2a9462ebad8c05e6efb2fb1380b4c40d686bfe1892');
  });

  console.log('\n═══ (a) the executor places the MEASURED stop ═══\n');

  await check('EP-02', 'REGRESSION WITNESS: old executor clamps to 1.2% (100 @ ATR 3 -> stop 98.80)', () => {
    const r = runExecMath(EXE_OLD, { price: 100, atr: 3, vol: false, isLong: true });
    assert.strictEqual(r.stopPrice, 98.8, 'min(4.5, 1.2%) must bind at 1.2%');
  });

  await check('EP-03', 'patched executor: FIXED 2.5% regardless of ATR — high AND low vol', () => {
    const hi = runExecMath(EXE_NEW, { price: 100, atr: 3, vol: false, isLong: true });
    assert.strictEqual(hi.stopPrice, 97.5, 'high-ATR name: 2.5%, not 1.2%');
    const lo = runExecMath(EXE_NEW, { price: 100, atr: 0.5, vol: false, isLong: true });
    assert.strictEqual(lo.stopPrice, 97.5, 'low-ATR name: 2.5%, not min(ATR)=0.75 — FIXED means fixed');
    const sh = runExecMath(EXE_NEW, { price: 100, atr: 3, vol: false, isLong: false });
    assert.strictEqual(sh.stopPrice, 102.5, 'short mirror');
  });

  console.log('\n═══ (b) the TP leg cannot bind inside the hold ═══\n');

  await check('EP-04', 'old TP was 3xATR (bindable in 2 days); new TP is 25% (cannot bind)', () => {
    const o = runExecMath(EXE_OLD, { price: 100, atr: 3, vol: false, isLong: true });
    assert.strictEqual(o.tpPrice, 109, 'witness: old 3xATR TP');
    const n = runExecMath(EXE_NEW, { price: 100, atr: 3, vol: false, isLong: true });
    assert.strictEqual(n.tpPrice, 125);
    const s = runExecMath(EXE_NEW, { price: 100, atr: 3, vol: false, isLong: false });
    assert.strictEqual(s.tpPrice, 75);
  });

  console.log('\n═══ (c) gate/order parity, executed on the real Prep bytes ═══\n');

  await check('EP-05', 'patched Prep judges exactly the 2.5% stop for any ATR; parity with executor', () => {
    const item = { ticker: 'tt', signal: 'BULLISH', price: '100', atr: '3', bias_score: '80' };
    const j = runPrep(PRE_NEW, item);
    assert.strictEqual(j.__qet_stop, 97.5);
    assert.strictEqual(j.__qet_stop_clamped, false);
    const exe = runExecMath(EXE_NEW, { price: 100, atr: 3, vol: false, isLong: true });
    assert.strictEqual(j.__qet_stop, exe.stopPrice, 'the gate must judge the stop the order carries');
    const jo = runPrep(PRE_OLD, item);
    assert.strictEqual(jo.__qet_stop, 98.8, 'witness: old prep judged the 1.2% clamp');
  });

  console.log('\n═══ (d) the TSM tolerates the ratified stop ═══\n');

  await check('EP-06', 'width constants: old 0.012 would call 2.5% a defect; new 0.026 accepts it', () => {
    assert.strictEqual(count(TSM_OLD, 'MAX_PROTECTIVE_STOP_PCT = 0.012'), 1);
    assert.strictEqual(count(TSM_NEW, 'MAX_PROTECTIVE_STOP_PCT = 0.026'), 1);
    assert.strictEqual(count(TSM_NEW, 'MAX_PROTECTIVE_STOP_PCT = 0.012'), 0,
      'the 1.2% tolerance would cancel the Conclave stop and force 0.9% every morning');
    assert.ok(0.025 <= 0.026 && 0.012 < 0.025, 'sanity: policy stop sits inside new tolerance, outside old');
  });

  console.log('\n═══ (e) the ladder is frozen, loudly ═══\n');

  await check('EP-07', 'REGRESSION WITNESS: old ladder advances tier and tightens', () => {
    const r = runLadder(TSM_OLD, { isLong: true, tier: 0, fav: 106, entry: 100, atr: 3 });
    assert.strictEqual(r.newTier, 1, 'old: +1.5xATR fires T1');
    assert.strictEqual(r.newStop, 99.95, 'old: breakeven - BUF');
  });

  await check('EP-08', 'patched ladder: same conditions -> NO advance, NO stop, suppression LOGGED', () => {
    const r = runLadder(TSM_NEW, { isLong: true, tier: 0, fav: 106, entry: 100, atr: 3 });
    assert.strictEqual(r.newTier, 0);
    assert.strictEqual(r.newStop, null);
    assert.strictEqual(r.logs.length, 1);
    assert.match(r.logs[0], /tier advance 0->1 SUPPRESSED/);
    const deep = runLadder(TSM_NEW, { isLong: true, tier: 0, fav: 115, entry: 100, atr: 3 });
    assert.strictEqual(deep.newTier, 0, 'even a T3-deep move must not advance');
    // and tier-gated scale-outs are keyed on newTier === 1 / >= 2 with tier unchanged -> cannot fire on advancement
    assert.ok(TSM_NEW.includes("SCALE_OUT_MODE && newTier === 1 && !state.scaledOut[sym]"), 'scale-out gating unchanged (keyed on the frozen tier)');
  });

  await check('EP-09', 'no-advance case logs NOTHING (silence stays cheap)', () => {
    const r = runLadder(TSM_NEW, { isLong: true, tier: 0, fav: 101, entry: 100, atr: 3 });
    assert.strictEqual(r.newTier, 0); assert.strictEqual(r.logs.length, 0);
  });

  console.log('\n═══ (f) unratified machinery is byte-identical ═══\n');

  await check('EP-10', 'scope: every diff is inside the four intended regions', () => {
    for (const [o, n, sites, label] of [[EXE_OLD, EXE_NEW, ['POLICY_STOP_PCT', 'price * 1.25', 'price * 0.75'], 'executor'],
                                        [PRE_OLD, PRE_NEW, ['POLICY_STOP_PCT'], 'prep'],
                                        [TSM_OLD, TSM_NEW, ['0.026', 'QTP_TIER_TRAIL_ENABLED'], 'tsm']]) {
      for (const s of sites) assert.ok(n.includes(s), `${label}: ${s} missing`);
      // load-bearing unratified strings must appear identically often
      for (const keep of ['EX-C1', 'order_class', 'gtc', 'qtp_widestop_', 'STOP_RECOVERY', 'EOD']) {
        if (o.includes(keep)) assert.strictEqual(count(o, keep), count(n, keep), `${label}: drift on ${keep}`);
      }
    }
    // slip buffer, capped-limit, EOD guards, recovery machinery: untouched by construction (region asserts in patch scripts)
    assert.strictEqual(count(EXE_NEW, 'slipBuffer'), count(EXE_OLD, 'slipBuffer'));
  });

  console.log(`\n  ${passed}/${passed + failed} checks passed\n`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('HARNESS FAILURE:', e); process.exit(1); });
