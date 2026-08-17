#!/usr/bin/env node
'use strict';
/**
 * Maya regression guard — MTF abstains on a dead sensor (gov 221, 2026-08-17).
 *
 * ┌──────────────────────────────────────────────────────────────────────────────────────┐
 * │ READ THIS FIRST. MT-01..MT-09 all pass, and they are all testing UNREACHABLE CODE.   │
 * │                                                                                      │
 * │ The patched term `&& !_mtfInputDead` sits on the FALSE branch of                     │
 * │     const mtfConfluenceBlock = _mtfShadowOn ? _mtfFloorBlock : (mtfWouldBlock && …)  │
 * │ and `_mtfShadowOn` is `gate_config.expansion_cohort_active === 1`, which was 1 in    │
 * │ production on 2026-08-17. The false branch never executes. gov 221's MTF half        │
 * │ changed NOTHING in the live system. MT-10 and MT-11 pin that fact so this suite      │
 * │ stops reading as proof that a live veto was repaired. It is not.                     │
 * │                                                                                      │
 * │ The premise was also wrong: the MTF sensor is ALIVE (live node inputs 2026-08-17:    │
 * │ BMNR 32.8, APH 49.5, AMAT 53.6, AEHR 54.7, ADPT 59.9). The constant zeros came from  │
 * │ quantum.exec_flow_audit.mtf_confluence_score, which is written BEFORE the MTF engine │
 * │ runs and is therefore structurally always 0. Broken observability, not a dead sensor.│
 * │                                                                                      │
 * │ Kept, not deleted, because the abstain expression itself is correct and this suite   │
 * │ is what makes it safe to enable — IF expansion_cohort_active is ever set to 0.       │
 * └──────────────────────────────────────────────────────────────────────────────────────┘
 *
 * Maya asks: "You are switching OFF a veto on a live trading gate, in the direction that
 * lets MORE trades through. Prove FROM THE DEPLOYED BYTES that (a) it only abstains when
 * there is genuinely no reading, (b) the veto still fires in full the instant real MTF
 * data comes back — including the very first non-zero score, (c) you did not weaken the
 * hard-floor block or the shadow-mode path, (d) show me the OLD bytes vetoing BMNR so
 * I know this test would have caught the bug, and (e) — added 2026-08-17 after the fact —
 * prove the branch you patched can actually EXECUTE in production, because a green suite
 * over dead code is worse than no suite at all."
 *
 * Deterministic + offline. Fixtures are the real `QTP Bias Filter` jsCode of workflow
 * vaqfCaELhOEWnkdo: `mtf-deployed.js` is pre-fix (sha a00f4ab9…) and `mtf-patched.js` is
 * what was published (sha 5d812f43…). The MTF decision region is sliced out of those exact
 * bytes by literal marker and EXECUTED.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FIX = path.join(__dirname, '..', 'docs', 'gate-repair-20260817');
const BEFORE = fs.readFileSync(path.join(FIX, 'mtf-deployed.js'), 'utf8');
const AFTER = fs.readFileSync(path.join(FIX, 'mtf-patched.js'), 'utf8');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

let passed = 0, failed = 0;
function check(id, name, fn) {
  try { fn(); console.log(`  ✅ ${id}  ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${id}  ${name}\n        ${e.message}`); failed++; }
}

// ── slice the MTF decision region out of the REAL body ───────────────────────
const START = "  const mtfEngineSeen = txt(output.mtf_confluence_engine_v, output.mtf_ai_judge_v) !== '';";
const END = 'mtfConfluenceBlock = _mtfShadowOn ? _mtfFloorBlock :';
function region(src) {
  const a = src.indexOf(START);
  const b = src.indexOf(END, a);
  const eol = src.indexOf('\n', b);
  assert.ok(a !== -1 && b !== -1, 'markers missing');
  return src.slice(a, eol + 1);
}
const R_BEFORE = region(BEFORE);
const R_AFTER = region(AFTER);

// Execute the region against a signal. `mtf` = the confluence engine's readings.
function decide(regionSrc, mtf) {
  const output = {
    mtf_confluence_score: mtf.det,
    ai_mtf_confluence_score: mtf.ai,
    mtf_confluence_engine_v: mtf.engineSeen === false ? '' : 'MTF_ENGINE_v5',
    mtf_ai_judge_v: '',
    final_mtf_confluence_decision: mtf.decision === undefined ? 'N/A' : mtf.decision,
  };
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const txt = (...v) => String(v.find((x) => x !== undefined && x !== null && String(x) !== '') || '');
  const staticData = () => ({ _gateConfig: { expansion_cohort_active: mtf.shadow ? 1 : 0, mtf_hard_floor: 40 } });
  const fn = new Function('output', 'num', 'txt', 'isEntry', '$getWorkflowStaticData', `
    ${regionSrc}
    return { mtfConfluenceBlock, mtfWouldBlock, _mtfFloorBlock,
             inputDead: (typeof _mtfInputDead === 'undefined' ? null : _mtfInputDead) };
  `);
  return fn(output, num, txt, mtf.isEntry !== false, staticData);
}

// BMNR, 2026-08-17 09:41 — bias 97, killed by this gate on a dead sensor.
const BMNR_TODAY = { det: 0, ai: 0, decision: 'N/A' };

(async () => {
  console.log('\n═══ the bytes are the deployed bytes ═══\n');

  check('MT-01', 'fixtures are the real pre-fix and published QTP Bias Filter bodies', () => {
    assert.strictEqual(sha(BEFORE), 'a00f4ab98c96e8e24e3988fe725efb0046fa5ea4ee026bc8d26f5353ac24a2bf');
    assert.strictEqual(sha(AFTER), '5d812f4354dc10396df6d7a8191782fff8990e39e3d2359bb544f5f8e52dbb41');
  });

  check('MT-02', 'the patch touched ONLY the MTF decision region — every other byte identical', () => {
    assert.strictEqual(sha(AFTER.replace(R_AFTER, R_BEFORE)), sha(BEFORE));
  });

  console.log('\n═══ the bug is real, and this test would have caught it ═══\n');

  check('MT-03', 'REGRESSION WITNESS: the OLD bytes veto BMNR on a score of zero', () => {
    const r = decide(R_BEFORE, BMNR_TODAY);
    assert.strictEqual(r.mtfWouldBlock, true);
    assert.strictEqual(r.mtfConfluenceBlock, true, 'the old gate blocked a signal it had no reading for');
  });

  console.log('\n═══ it abstains only when there is genuinely no reading ═══\n');

  check('MT-04', 'BMNR today: both scores zero → ABSTAIN, and the abstention is stamped', () => {
    const r = decide(R_AFTER, BMNR_TODAY);
    assert.strictEqual(r.inputDead, true);
    assert.strictEqual(r.mtfWouldBlock, true, 'the would-block signal is preserved for the audit');
    assert.strictEqual(r.mtfConfluenceBlock, false, 'but it must no longer block');
  });

  check('MT-05', 'the FIRST non-zero reading restores the veto in full — either leg is enough', () => {
    for (const mtf of [{ det: 1, ai: 0 }, { det: 0, ai: 1 }, { det: 0.5, ai: 0 }, { det: 39, ai: 39 }]) {
      const r = decide(R_AFTER, { ...mtf, decision: 'N/A' });
      assert.strictEqual(r.inputDead, false, `wrongly dead at det=${mtf.det} ai=${mtf.ai}`);
      assert.strictEqual(r.mtfConfluenceBlock, true, `veto did not fire at det=${mtf.det} ai=${mtf.ai}`);
    }
  });

  check('MT-06', 'a live reading that PASSES still passes, unchanged from before', () => {
    const live = { det: 80, ai: 75, decision: 'FINAL_MTF_CONFLUENCE_PASS' };
    assert.strictEqual(decide(R_AFTER, live).mtfConfluenceBlock, false);
    assert.strictEqual(decide(R_BEFORE, live).mtfConfluenceBlock, false);
  });

  check('MT-07', 'negative, NaN and missing scores all count as no reading, never as a pass', () => {
    for (const mtf of [{ det: -5, ai: -5 }, { det: NaN, ai: NaN }, { det: undefined, ai: undefined },
      { det: null, ai: null }, { det: '', ai: '' }]) {
      const r = decide(R_AFTER, { ...mtf, decision: 'N/A' });
      assert.strictEqual(r.inputDead, true, `not treated as dead: ${JSON.stringify(mtf)}`);
      assert.strictEqual(r.mtfConfluenceBlock, false);
    }
  });

  console.log('\n═══ nothing else about the gate moved ═══\n');

  check('MT-08', 'the hard-floor block is byte-identical and still fires on a live low score', () => {
    assert.ok(AFTER.includes('const _mtfFloorBlock = isEntry && mtfEngineSeen && Number.isFinite(mtfScore) && mtfScore > 0 && mtfScore < _mtfHardFloor;'),
      'the floor-block line must be untouched');
    const r = decide(R_AFTER, { det: 25, ai: 0, decision: 'FINAL_MTF_CONFLUENCE_PASS', shadow: true });
    assert.strictEqual(r._mtfFloorBlock, true, 'a real score of 25 is below the 40 floor and must still block');
    assert.strictEqual(r.mtfConfluenceBlock, true, 'shadow mode still routes through the floor block');
  });

  check('MT-09', 'shadow mode is untouched: with a dead sensor it blocks nothing, as before', () => {
    const b = decide(R_BEFORE, { ...BMNR_TODAY, shadow: true });
    const a = decide(R_AFTER, { ...BMNR_TODAY, shadow: true });
    assert.strictEqual(b.mtfConfluenceBlock, a.mtfConfluenceBlock,
      'the shadow path must be unaffected by this change');
  });

  console.log('\n═══ …and none of the above reaches production ═══\n');

  // Live gate_config read on 2026-08-17 while ADPT filled. Update this fixture ONLY from a
  // fresh `select live_value from quantum.gate_config where constant_name='expansion_cohort_active'`.
  const EXPANSION_COHORT_ACTIVE_AT_DEPLOY = 1;

  check('MT-10', 'the patched term lives on the branch _mtfShadowOn selects AWAY from', () => {
    assert.ok(R_AFTER.includes('_mtfShadowOn ? _mtfFloorBlock : (mtfWouldBlock && !_mtfInputDead)'),
      'the ternary shape changed — re-derive reachability before trusting MT-04..MT-07');
    assert.ok(AFTER.includes("const _mtfShadowOn = Number(_gcfgF1B.expansion_cohort_active || 0) === 1;"),
      '_mtfShadowOn must still be sourced from gate_config.expansion_cohort_active');
    // With the cohort ACTIVE the false branch is unreachable, so the patch is inert.
    assert.strictEqual(EXPANSION_COHORT_ACTIVE_AT_DEPLOY, 1,
      'cohort flipped to 0 — the patch is now LIVE; re-verify MT-04..MT-07 against production');
  });

  check('MT-11', 'even if it did fire, mtfConfluenceBlock is discarded downstream today', () => {
    // Its only consumer that affects routing is _pfWouldBlockRaw, and backtestValid overwrites
    // that with a constant true while the same cohort flag is set.
    assert.ok(AFTER.includes('const _pfWouldBlockRaw = !(baseBacktestValid && !paperWeakBacktestBlock && !paperCompositeOppositionBlock && !mtfConfluenceBlock);'));
    assert.ok(AFTER.includes('const backtestValid = _pfShadowOn ? true : !_pfWouldBlockRaw;'),
      'if this line changes, MTF regains the power to block and this suite becomes load-bearing');
    // Enumerate EVERY mention so a new consumer cannot appear unnoticed. Exactly one of these
    // can affect routing (_pfWouldBlockRaw); the rest are labels, reason strings, audit stamps.
    const mentions = AFTER.split('\n').filter((l) => l.includes('mtfConfluenceBlock'))
      .map((l) => l.trim().slice(0, 34));
    assert.deepStrictEqual(mentions, [
      'const mtfConfluenceBlock = _mtfSha',   // the definition
      'if (mtfConfluenceBlock) {',            // sets mtfVetoLeg — a label only
      'const _pfWouldBlockRaw = !(baseBac',   // THE ONLY ROUTING USE, and it is discarded
      'if (mtfConfluenceBlock) backtestRe',   // reason string
      'output._backtest_enforcement_resul',   // audit stamp
      'const _mtfStageGenuineBlock = mtfC',   // audit label
      'const _mtfStageDataMissing  = mtfC',   // audit label
      '`mtf_block=${mtfConfluenceBlock}`,',   // audit stamp
      'output.blocked_reason = `Cycle 007',   // reason string
    ], `the set of mtfConfluenceBlock consumers changed:\n${mentions.join('\n')}`);
    // …and the one `if` is label-only: it assigns mtfVetoLeg and nothing else.
    const ifBody = AFTER.slice(AFTER.indexOf('if (mtfConfluenceBlock) {'));
    assert.ok(/^if \(mtfConfluenceBlock\) \{\n(\s+(if|else)[^\n]*mtfVetoLeg = '[A-Z_]+';\n){4}\s*\}/.test(ifBody),
      'the mtfConfluenceBlock if-block does more than assign a label now — re-check routing');
  });

  console.log(`\n  ${passed}/${passed + failed} checks passed\n`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('HARNESS FAILURE:', e); process.exit(1); });
