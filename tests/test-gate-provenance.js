#!/usr/bin/env node
'use strict';
/**
 * A3 meta-suite (Maya doctrine) — proves the drift gate actually catches drift.
 *
 * Maya asks: "You told me the provenance check is green. Fine — but does it
 * actually go RED when something drifts? Show me it fails when a source node is
 * edited, when a gate module has no provenance, when the named test is gone, and
 * when the pinned hash disagrees with the manifest. A checker that can't fail is
 * not a gate."
 *
 * Black-box + deterministic + offline: builds a MINIMAL synthetic repo in a temp
 * dir, copies the REAL .ci/check-gate-provenance.js into it, and runs it via
 * child_process for each scenario — asserting exit code AND that the failure
 * message names the culprit. Nothing here touches the real repo or network.
 * Run: node tests/test-gate-provenance.js  (or: npm test)
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const REAL_ROOT = path.resolve(__dirname, '..');
const REAL_CHECKER = path.join(REAL_ROOT, '.ci', 'check-gate-provenance.js');

let passed = 0, failed = 0;
function check(id, name, fn) {
  try { fn(); console.log(`  ✅ ${id}  ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${id}  ${name}  — ${e.message}`); failed++; }
}

function sha16(buf) { return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16); }

// Build a minimal synthetic repo whose layout mirrors the real one, then let the
// mutate() callback tamper with it before we run the checker.
function runScenario(mutate) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a3prov_'));
  const baseDir = path.join(root, 'n8n-workflows', '_baseline_test');
  fs.mkdirSync(path.join(root, '.ci'), { recursive: true });
  fs.mkdirSync(path.join(root, 'lib', 'gates'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.mkdirSync(baseDir, { recursive: true });

  // one synthetic source node + its extracted module + its test
  const srcBody = Buffer.from('// synthetic node\nconst x = 1;\n');
  fs.writeFileSync(path.join(baseDir, 'node-a.js'), srcBody);
  const srcSha = sha16(srcBody);
  fs.writeFileSync(path.join(root, 'lib', 'gates', 'gate_a.js'), "module.exports={a:1};\n");
  fs.writeFileSync(path.join(root, 'tests', 'test-gate-a.js'), "// test\n");

  fs.writeFileSync(path.join(baseDir, '_MANIFEST.json'), JSON.stringify({
    inventory: [{ name: 'Node A', file: 'node-a.js', kind: 'code_nodes', sha256_live: srcSha }],
  }));

  const prov = {
    baseline: { workflow_id: 'wf', versionId: 'test', dir: 'n8n-workflows/_baseline_test/' },
    modules: {
      'lib/gates/gate_a.js': {
        source_node: 'Node A', source_file: 'node-a.js',
        sha256_live_at_extraction: srcSha, test: 'tests/test-gate-a.js',
      },
    },
  };
  fs.writeFileSync(path.join(root, '.ci', 'gate-provenance.json'), JSON.stringify(prov, null, 2));

  // copy the REAL checker in unchanged — we test the real logic, not a stub
  fs.copyFileSync(REAL_CHECKER, path.join(root, '.ci', 'check-gate-provenance.js'));

  if (mutate) mutate({ root, baseDir, prov, provPath: path.join(root, '.ci', 'gate-provenance.json') });

  try {
    const out = execFileSync('node', [path.join(root, '.ci', 'check-gate-provenance.js')], { encoding: 'utf8' });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status == null ? 1 : e.status, out: `${e.stdout || ''}${e.stderr || ''}` };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// --- baseline: an in-sync synthetic repo passes (exit 0) ---
check('GP-01', 'clean synthetic repo passes (exit 0, "0 drift")', () => {
  const r = runScenario(null);
  assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.out}`);
  assert.ok(/0 drift/.test(r.out), 'should report 0 drift');
});

// --- source node edited => hash drift caught ---
check('GP-02', 'editing the source node fails with SOURCE DRIFTED (exit 1)', () => {
  const r = runScenario(({ baseDir }) => {
    fs.writeFileSync(path.join(baseDir, 'node-a.js'), '// TAMPERED\nconst x = 999;\n');
  });
  assert.strictEqual(r.code, 1, `expected exit 1, got ${r.code}`);
  assert.ok(/SOURCE DRIFTED/.test(r.out), 'must name the drift');
  assert.ok(/gate_a\.js/.test(r.out), 'must name the affected module');
});

// --- gate module with no provenance entry => untracked ---
check('GP-03', 'an extra lib/gates module without provenance fails (untracked)', () => {
  const r = runScenario(({ root }) => {
    fs.writeFileSync(path.join(root, 'lib', 'gates', 'gate_orphan.js'), 'module.exports={};\n');
  });
  assert.strictEqual(r.code, 1, `expected exit 1, got ${r.code}`);
  assert.ok(/untracked gate module/.test(r.out), 'must flag the untracked module');
  assert.ok(/gate_orphan\.js/.test(r.out), 'must name the orphan');
});

// --- named test missing => extraction not pinned by a test ---
check('GP-04', 'deleting the named test fails (exit 1)', () => {
  const r = runScenario(({ root }) => {
    fs.rmSync(path.join(root, 'tests', 'test-gate-a.js'));
  });
  assert.strictEqual(r.code, 1, `expected exit 1, got ${r.code}`);
  assert.ok(/named test missing/.test(r.out), 'must flag the missing test');
});

// --- pinned hash disagreeing with the manifest => manifest drift ---
check('GP-05', 'pinned hash != manifest sha256_live fails (exit 1)', () => {
  const r = runScenario(({ provPath, prov }) => {
    prov.modules['lib/gates/gate_a.js'].sha256_live_at_extraction = 'deadbeefdeadbeef';
    fs.writeFileSync(provPath, JSON.stringify(prov, null, 2));
  });
  assert.strictEqual(r.code, 1, `expected exit 1, got ${r.code}`);
  // source recompute mismatch OR manifest mismatch — either way it must fail and name gate_a
  assert.ok(/gate_a\.js/.test(r.out), 'must name the affected module');
});

// --- missing source node file => caught, not a crash ---
check('GP-06', 'deleting the source node file fails cleanly (exit 1, not a stack trace)', () => {
  const r = runScenario(({ baseDir }) => {
    fs.rmSync(path.join(baseDir, 'node-a.js'));
  });
  assert.strictEqual(r.code, 1, `expected exit 1, got ${r.code}`);
  assert.ok(/source node file missing/.test(r.out), 'must report the missing source cleanly');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
