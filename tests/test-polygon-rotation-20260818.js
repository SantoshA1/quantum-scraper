#!/usr/bin/env node
'use strict';
/**
 * Maya regression guard — Polygon key rotation readiness (gov 227, 2026-08-18).
 *
 * Maya asks: "I'm about to rotate the Polygon key. Two live workflows read the OLD key from
 * inside n8n — one hard-throws without it, one re-seeds the old literal every ten minutes.
 * Prove FROM THE BYTES being deployed that (a) after your patch I rotate by editing ONE
 * n8n Variable and both workflows pick it up; (b) deploying your patch BEFORE I create the
 * Variable changes nothing — the fallback carries it, because if publishing breaks the
 * signal path at 4:30pm I will find out at 9:30am; (c) with no key anywhere the pipeline
 * still fails CLOSED, not open; (d) the re-seeder can no longer resurrect a dead key over a
 * fresh one; and (e) not one credential-shaped literal remains in the deployed bytes."
 *
 * Deterministic + offline. Fixtures:
 *   indicator-enrichment-deployed.js — REAL main-pipeline node bytes (sha 95e2255c…), which
 *     contain NO key (staticData read only) and are safe to commit verbatim.
 *   indicator-enrichment-patched.js  — gov 227 candidate (sha 40a85a55…).
 *   polygon-key-init-v1-REDACTED.js  — redacted-RECONSTRUCTED v1 seeder (same structure,
 *     dummy token; the live sha is verified at deploy time, not here).
 *   polygon-key-init-patched.js      — gov 227 v2 seeder (sha cd230be1…).
 * The node bodies are EXECUTED with stubbed $vars / $getWorkflowStaticData / $input.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FIX = path.join(__dirname, '..', 'docs', 'polygon-rotation-20260818');
const IE_OLD = fs.readFileSync(path.join(FIX, 'indicator-enrichment-deployed.js'), 'utf8');
const IE_NEW = fs.readFileSync(path.join(FIX, 'indicator-enrichment-patched.js'), 'utf8');
const INIT_V1 = fs.readFileSync(path.join(FIX, 'polygon-key-init-v1-REDACTED.js'), 'utf8');
const INIT_V2 = fs.readFileSync(path.join(FIX, 'polygon-key-init-patched.js'), 'utf8');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

let passed = 0, failed = 0;
async function check(id, name, fn) {
  try { await fn(); console.log(`  ✅ ${id}  ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${id}  ${name}\n        ${e.message}`); failed++; }
}

// ── execute ONLY the key-resolution region of Indicator Enrichment ───────────
// The full node does live HTTP work; the rotation claim is entirely in the resolver, so we
// slice from the _creds_IE line through the SE-C1 throw and return POLYGON_KEY.
function resolveIEKey(src, { vars, staticCreds }) {
  const a = src.indexOf("const _creds_IE = ($getWorkflowStaticData('global')._credentials) || {};");
  assert.ok(a !== -1, 'resolver start marker missing');
  const t = src.indexOf("throw new Error('SE-C1", a);
  assert.ok(t !== -1, 'SE-C1 throw missing from resolver');
  const b = src.indexOf('\n', t);
  const region = src.slice(a, b + 1);
  const fn = new Function('$vars', '$getWorkflowStaticData', region + '\nreturn POLYGON_KEY;');
  return fn(vars, () => ({ _credentials: staticCreds }));
}

// ── execute the seeder node in full (it is small and self-contained) ─────────
function runInit(src, { vars, state }) {
  const $input = { all: () => [{ json: { marker: 'item-1' } }, { json: { marker: 'item-2' } }] };
  const fn = new Function('$input', '$vars', '$getWorkflowStaticData',
    `return (async()=>{\n${src}\n})()`);
  return fn($input, vars, () => state);
}

// A secret LITERAL is a key-ish ASSIGNMENT of a long token — plain long enum/marker strings
// (e.g. 'SKIPPED_HEARTBEAT_OR_NEUTRAL') are not secrets and must not trip this.
const LITERAL_RE = /(key|token|secret|apikey)\s*[:=]\s*['"][A-Za-z0-9_\-]{20,}['"]/i;

(async () => {
  console.log('\n═══ the bytes are the bytes being deployed ═══\n');

  await check('PR-01', 'fixtures match the artifacts handed to the deploy step', () => {
    assert.strictEqual(sha(IE_OLD), '95e2255c5c511d371bbd6a359f677733fe6856aea6d886b4ae2bf68463f13bc5');
    assert.strictEqual(sha(IE_NEW), '40a85a55fa498c2f592803563a5df2c08c64ea659a20a073926e6993d14aeec7');
    assert.strictEqual(sha(INIT_V2), 'cd230be1ac2125402a4ac16e944f71059b743d70b637e6181c4e703754c1d058');
  });

  console.log('\n═══ (a) rotation becomes one Variables edit ═══\n');

  await check('PR-02', 'REGRESSION WITNESS: the live enrichment ignores $vars entirely', () => {
    const k = resolveIEKey(IE_OLD, { vars: { POLYGON_API_KEY: 'NEWKEY' }, staticCreds: { polygon_key: 'OLDKEY' } });
    assert.strictEqual(k, 'OLDKEY', 'v(old) must not see the Variable — that is the whole problem');
  });

  await check('PR-03', 'patched enrichment prefers $vars.POLYGON_API_KEY over the staticData key', () => {
    const k = resolveIEKey(IE_NEW, { vars: { POLYGON_API_KEY: 'NEWKEY' }, staticCreds: { polygon_key: 'OLDKEY' } });
    assert.strictEqual(k, 'NEWKEY');
    assert.strictEqual(resolveIEKey(IE_NEW, { vars: { POLYGON_KEY: 'NEWKEY2' }, staticCreds: {} }), 'NEWKEY2',
      'the documented legacy var name must work too');
  });

  await check('PR-04', 'REGRESSION WITNESS: the v1 seeder can NEVER propagate a rotation', async () => {
    const state = { _credentials: { polygon_api_key: 'OLD_STATIC_KEY' } };
    await runInit(INIT_V1, { vars: { POLYGON_API_KEY: 'NEWKEY' }, state });
    assert.strictEqual(state._credentials.polygon_api_key, 'OLD_STATIC_KEY',
      'v1 only seeds when absent — a rotated key can never displace the old one');
    assert.ok(LITERAL_RE.test(INIT_V1), 'and v1 carries a key-shaped literal (dummy in this fixture)');
  });

  await check('PR-05', 'v2 seeder overwrites a stale staticData key from $vars on the next run', async () => {
    const state = { _credentials: { polygon_api_key: 'OLD_STATIC_KEY' } };
    const out = await runInit(INIT_V2, { vars: { POLYGON_API_KEY: 'NEWKEY' }, state });
    assert.strictEqual(state._credentials.polygon_api_key, 'NEWKEY', 'rotation must propagate');
    assert.strictEqual(out.length, 2, 'pass-through of items must be preserved');
    assert.strictEqual(out[1].json.marker, 'item-2');
  });

  console.log('\n═══ (b) deploying BEFORE the Variable exists changes nothing ═══\n');

  await check('PR-06', 'no Variable yet → enrichment resolves the staticData key exactly as today', () => {
    for (const vars of [undefined, {}, { POLYGON_API_KEY: '' }, { POLYGON_API_KEY: '   ' }]) {
      assert.strictEqual(resolveIEKey(IE_NEW, { vars, staticCreds: { polygon_key: 'OLDKEY' } }), 'OLDKEY',
        `fallback failed for vars=${JSON.stringify(vars)}`);
    }
  });

  await check('PR-07', 'no Variable yet → v2 seeder keeps running on the v1-seeded key and warns', async () => {
    const state = { _credentials: { polygon_api_key: 'OLD_STATIC_KEY' } };
    const out = await runInit(INIT_V2, { vars: {}, state });
    assert.strictEqual(state._credentials.polygon_api_key, 'OLD_STATIC_KEY', 'grace path must not clear it');
    assert.strictEqual(out.length, 2, 'and must not break the chain');
  });

  console.log('\n═══ (c) no key anywhere still fails CLOSED ═══\n');

  await check('PR-08', 'enrichment: SE-C1 throw retained; seeder: loud throw, not silent emptiness', async () => {
    assert.throws(() => resolveIEKey(IE_NEW, { vars: {}, staticCreds: {} }), /SE-C1/);
    await assert.rejects(() => runInit(INIT_V2, { vars: {}, state: { _credentials: {} } }),
      /POLYGON_KEY_INIT_v2.*Variable/i);
    // and a hostile $vars proxy must not bypass the fail-closed path
    const hostile = new Proxy({}, { get() { throw new Error('boom'); } });
    assert.throws(() => resolveIEKey(IE_NEW, { vars: hostile, staticCreds: {} }), /SE-C1/);
  });

  console.log('\n═══ (e) no credential-shaped literal in the deployed bytes ═══\n');

  await check('PR-09', 'both patched bodies are literal-free; the patch touched only the resolver', () => {
    assert.ok(!LITERAL_RE.test(IE_NEW), 'key-shaped literal in patched enrichment');
    assert.ok(!LITERAL_RE.test(INIT_V2), 'key-shaped literal in patched seeder');
    // scope: IE patch deletes exactly 2 pre-existing lines (the resolver read + SE-C1 line)
    const a = IE_OLD.split('\n'), b = IE_NEW.split('\n');
    const removed = a.filter((l) => !new Set(b).has(l));
    assert.deepStrictEqual(removed.map((l) => l.trim().slice(0, 40)), [
      'const POLYGON_KEY = _creds_IE.polygon_ke',
      "if (!POLYGON_KEY) throw new Error('SE-C1",
    ], `unexpected deletions:\n${removed.join('\n')}`);
    const OWNED = /gov 227|_pk_vars|POLYGON_API_KEY|POLYGON_KEY|SE-C1|^\/\/|^$/;
    const strays = b.filter((l) => !new Set(a).has(l)).filter((l) => !OWNED.test(l.trim()));
    assert.deepStrictEqual(strays, [], `lines added outside the resolver:\n${strays.join('\n')}`);
  });

  await check('PR-10', 'NEGATIVE CONTROL: the old bytes fail the rotation checks', async () => {
    // PR-03 on old bytes → OLDKEY wins → would fail
    assert.notStrictEqual(
      resolveIEKey(IE_OLD, { vars: { POLYGON_API_KEY: 'NEWKEY' }, staticCreds: { polygon_key: 'OLDKEY' } }),
      'NEWKEY');
    // PR-05 on v1 → stale key survives → would fail
    const state = { _credentials: { polygon_api_key: 'OLD_STATIC_KEY' } };
    await runInit(INIT_V1, { vars: { POLYGON_API_KEY: 'NEWKEY' }, state });
    assert.notStrictEqual(state._credentials.polygon_api_key, 'NEWKEY');
  });

  console.log(`\n  ${passed}/${passed + failed} checks passed\n`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('HARNESS FAILURE:', e); process.exit(1); });
