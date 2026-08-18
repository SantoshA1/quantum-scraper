#!/usr/bin/env node
'use strict';
/**
 * Maya regression guard — the key stops riding the payload (gov 227b, 2026-08-18).
 *
 * Maya asks: "You rotated my key this evening, and you told me yourself that the pipeline
 * copies the key onto every signal item, where it lands in n8n execution logs. That means
 * the NEW key starts leaking again at 9:35 tomorrow morning. Prove FROM THE BYTES that
 * (a) the enrichment node no longer writes the key onto items; (b) all four Polygon HTTP
 * nodes and the Grok analyst now take the key from the Variable, so nothing downstream
 * needed the passthrough; (c) each URL changed by exactly that one token and nothing else —
 * I am not accepting a rewritten trading URL as a side effect of a security fix; and
 * (d) show me the old bytes doing the leaking, so this suite catches anyone putting it back."
 *
 * Deterministic + offline. Fixtures:
 *   indicator-enrichment-patched.js    — gov 227 bytes, live until this deploy (sha 40a85a55…)
 *   indicator-enrichment-patched-v2.js — gov 227b candidate (sha cd61e9bb…)
 *   grok-analysis-deployed.js          — live Grok AI Analysis bytes (sha 5f77e321…)
 *   grok-analysis-patched.js           — gov 227b candidate (sha 0ce228d3…)
 *   http-urls-patch.json               — before/after URL expressions for the 4 HTTP nodes
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FIX = path.join(__dirname, '..', 'docs', 'polygon-rotation-20260818');
const IE_V1 = fs.readFileSync(path.join(FIX, 'indicator-enrichment-patched.js'), 'utf8');
const IE_V2 = fs.readFileSync(path.join(FIX, 'indicator-enrichment-patched-v2.js'), 'utf8');
const GK_V1 = fs.readFileSync(path.join(FIX, 'grok-analysis-deployed.js'), 'utf8');
const GK_V2 = fs.readFileSync(path.join(FIX, 'grok-analysis-patched.js'), 'utf8');
const URLS = JSON.parse(fs.readFileSync(path.join(FIX, 'http-urls-patch.json'), 'utf8'));
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const REF = "$('Indicator Enrichment').first().json._polygon_key";

let passed = 0, failed = 0;
async function check(id, name, fn) {
  try { await fn(); console.log(`  ✅ ${id}  ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${id}  ${name}\n        ${e.message}`); failed++; }
}

// Execute the Grok resolver lines against stubbed $vars/item — the two patched sites only.
function grokResolver(src, marker, { vars, itemKey }) {
  const i = src.indexOf(marker);
  assert.ok(i !== -1, `marker missing: ${marker.slice(0, 40)}`);
  const line = src.slice(i, src.indexOf(';', i) + 1);
  const rhs = line.match(/=\s*([\s\S]*);$/);
  assert.ok(rhs, `resolver RHS not found in: ${line.slice(0, 60)}`);
  const fn = new Function('$vars', 'item', `return (${rhs[1]});`);
  return fn(vars, { _polygon_key: itemKey });
}

(async () => {
  console.log('\n═══ the bytes are the bytes being deployed ═══\n');

  await check('PP-01', 'fixtures match the artifacts handed to the deploy step', () => {
    assert.strictEqual(sha(IE_V1), '40a85a55fa498c2f592803563a5df2c08c64ea659a20a073926e6993d14aeec7');
    assert.strictEqual(sha(IE_V2), 'cd61e9bb52058b82c1bd57a27a5706b14a5577810fd5eff2e213a92bd73c8438');
    // Grok fixtures are committed REDACTED (a JWT-shaped QTP_SB_METER_KEY literal is swapped
    // for a same-shape dummy). The DEPLOY-time bytes were verified against the unredacted
    // originals: GK_V1 5f77e321…, GK_V2 0ce228d3… (diff exit 0, gov 227b deploy report).
    assert.strictEqual(sha(GK_V1), '0c565f62aaad9a1e5dcabd79bb90493d84aac6c3ebc2a7b9036ac0145953a9e4');
    assert.strictEqual(sha(GK_V2), 'e2cf54a8a7afee97d6a34263b0e29bc22dcc7c1404d77b34a800d7cb680da784');
  });

  console.log('\n═══ (d) the leak is real: the live bytes copy the key onto every item ═══\n');

  await check('PP-02', 'REGRESSION WITNESS: live enrichment stamps _polygon_key on the item', () => {
    assert.ok(IE_V1.includes('enriched._polygon_key = POLYGON_KEY;'),
      'the leaking line must exist in the pre-227b bytes, or this suite guards nothing');
    assert.ok(GK_V1.includes('const _pk = item._polygon_key;'), 'and Grok reads it off the item');
    for (const k of Object.keys(URLS)) {
      assert.ok(URLS[k].before.includes(REF), `${k} before-URL must reference the passthrough`);
    }
  });

  console.log('\n═══ (a) the enrichment stops emitting the key ═══\n');

  await check('PP-03', 'v2 enrichment never writes _polygon_key to any item', () => {
    // as CODE, not as a mention — the gov 227b comment legitimately names the removed line
    assert.ok(!/^\s*enriched\._polygon_key\s*=/m.test(IE_V2), 'the passthrough write survived');
    assert.ok(IE_V2.includes('gov 227b'), 'the removal must be documented in-band');
    // and the ONLY line-level deletions vs v1 are the passthrough write + its old comment
    const a = IE_V1.split('\n'), b = IE_V2.split('\n');
    const removed = a.filter((l) => !new Set(b).has(l));
    assert.deepStrictEqual(removed.map((l) => l.trim().slice(0, 44)), [
      '// Fix #17 Batch 2 (hotfix): expose polygon_',
      'enriched._polygon_key = POLYGON_KEY;',
    ], `unexpected deletions:\n${removed.join('\n')}`);
  });

  console.log('\n═══ (b) every consumer now takes the key from the Variable ═══\n');

  await check('PP-04', 'all four HTTP URLs read $vars.POLYGON_API_KEY, passthrough reference gone', () => {
    for (const k of Object.keys(URLS)) {
      const { before, after } = URLS[k];
      assert.ok(!after.includes('_polygon_key'), `${k}: passthrough still referenced`);
      assert.ok(after.includes('$vars.POLYGON_API_KEY'), `${k}: Variable not referenced`);
      // (c) exactly one token swapped — everything else byte-identical
      assert.strictEqual(after, before.replace(REF, '$vars.POLYGON_API_KEY'),
        `${k}: the URL changed beyond the single key-source token`);
    }
  });

  await check('PP-05', 'Grok resolver prefers the Variable; item fallback kept for deploy-order safety', () => {
    for (const marker of ['const _pk = (typeof $vars', 'const _pkChart = (typeof $vars']) {
      assert.strictEqual(grokResolver(GK_V2, marker, { vars: { POLYGON_API_KEY: 'NEWKEY' }, itemKey: 'ITEMKEY' }), 'NEWKEY');
      assert.strictEqual(grokResolver(GK_V2, marker, { vars: {}, itemKey: 'ITEMKEY' }), 'ITEMKEY');
      assert.strictEqual(grokResolver(GK_V2, marker, { vars: { POLYGON_KEY: 'LEGACY' }, itemKey: null }), 'LEGACY');
    }
    assert.ok(!GK_V2.includes('const _pk = item._polygon_key;'), 'old item-only read survived');
    assert.ok(GK_V2.includes("chart_vision_status: 'DATA_READ_SKIPPED_NO_POLYGON_KEY'"),
      'the no-key skip path must be preserved');
  });

  await check('PP-06', 'Grok patch scope: exactly the two resolver sites changed', () => {
    const a = GK_V1.split('\n'), b = GK_V2.split('\n');
    const removed = a.filter((l) => !new Set(b).has(l));
    assert.deepStrictEqual(removed.map((l) => l.trim().slice(0, 40)), [
      'const _pk = item._polygon_key;',
      'if (item._polygon_key) {',
      'const _cr = await qtpChartRead(this.help',
    ], `unexpected deletions:\n${removed.join('\n')}`);
    const OWNED = /gov 227b|_pkChart|_pk |POLYGON_API_KEY|POLYGON_KEY|qtpChartRead|^\/\/|^$/;
    const strays = b.filter((l) => !new Set(a).has(l)).filter((l) => !OWNED.test(l.trim()));
    assert.deepStrictEqual(strays, [], `lines added outside the resolvers:\n${strays.join('\n')}`);
  });

  await check('PP-07', 'NEGATIVE CONTROL: the pre-227b bytes fail these checks', () => {
    assert.ok(IE_V1.includes('enriched._polygon_key'), 'PP-03 would pass on v1 — witness broken');
    for (const k of Object.keys(URLS)) assert.ok(URLS[k].before.includes('_polygon_key'));
    assert.throws(() => grokResolver(GK_V1, 'const _pk = (typeof $vars', { vars: {}, itemKey: 'x' }),
      /marker missing/, 'the $vars resolver must not exist in the old Grok bytes');
  });

  console.log(`\n  ${passed}/${passed + failed} checks passed\n`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('HARNESS FAILURE:', e); process.exit(1); });
