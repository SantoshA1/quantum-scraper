#!/usr/bin/env node
'use strict';
/**
 * A3 CI drift gate — lib/gates modules <-> live n8n baseline provenance.
 *
 * The extracted gate modules (lib/gates/*.js) are hand-written pure rewrites of
 * logic that lives inside monolithic n8n Code nodes. They can silently drift from
 * their source. This gate makes that impossible to miss: every module PINS the
 * sha256_live of the baseline node it was pulled from (.ci/gate-provenance.json).
 * Here we recompute those source hashes from the committed baseline and FAIL if:
 *   - a source node file is missing,
 *   - its recomputed sha256 != the pinned value (source drifted -> re-review module),
 *   - the pinned value disagrees with the baseline _MANIFEST.json (manifest drift),
 *   - a lib/gates/*.js module has no provenance entry (untracked extraction),
 *   - a named unit test file is missing (extraction not pinned by a test).
 *
 * Fail-closed: any inconsistency exits non-zero so the commit gate blocks.
 * Pure Node, offline, deterministic. Run: node .ci/check-gate-provenance.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const PROV_PATH = path.join(ROOT, '.ci', 'gate-provenance.json');

function sha16(absPath) {
  const buf = fs.readFileSync(absPath);
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
}

function fail(msg) { console.log(`  ❌ ${msg}`); return 1; }
function ok(msg) { console.log(`  ✅ ${msg}`); return 0; }

function main() {
  let errors = 0;
  console.log('[A3] gate provenance drift check');

  if (!fs.existsSync(PROV_PATH)) {
    console.log(fail(`.ci/gate-provenance.json missing`) && '');
    process.exit(1);
  }
  const prov = JSON.parse(fs.readFileSync(PROV_PATH, 'utf8'));
  const baseDir = path.join(ROOT, prov.baseline.dir);
  const manifestPath = path.join(baseDir, '_MANIFEST.json');

  // Build a name/file -> sha256_live index from the baseline manifest.
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const manByFile = new Map(manifest.inventory.map((n) => [n.file, n]));

  const modules = prov.modules || {};
  const entries = Object.entries(modules);
  if (entries.length === 0) errors += fail('provenance lists zero modules');

  // 1) every provenance entry: source exists, hash matches pinned AND manifest, test exists.
  for (const [modRel, meta] of entries) {
    const modAbs = path.join(ROOT, modRel);
    if (!fs.existsSync(modAbs)) { errors += fail(`module missing: ${modRel}`); continue; }

    const srcAbs = path.join(baseDir, meta.source_file);
    if (!fs.existsSync(srcAbs)) { errors += fail(`${modRel}: source node file missing (${meta.source_file})`); continue; }

    const live = sha16(srcAbs);
    if (live !== meta.sha256_live_at_extraction) {
      errors += fail(`${modRel}: SOURCE DRIFTED — ${meta.source_file} now ${live}, pinned ${meta.sha256_live_at_extraction}. Re-review the extraction against the changed node, then re-pin.`);
    } else {
      ok(`${modRel} <- ${meta.source_file}@${live} (in sync)`);
    }

    const man = manByFile.get(meta.source_file);
    if (!man) {
      errors += fail(`${modRel}: source ${meta.source_file} not in baseline _MANIFEST.json`);
    } else if (man.sha256_live !== meta.sha256_live_at_extraction) {
      errors += fail(`${modRel}: pinned ${meta.sha256_live_at_extraction} != manifest sha256_live ${man.sha256_live} for ${meta.source_file}`);
    }

    if (!meta.test || !fs.existsSync(path.join(ROOT, meta.test))) {
      errors += fail(`${modRel}: named test missing (${meta.test || 'none'})`);
    }
  }

  // 2) completeness: no lib/gates/*.js may exist without a provenance entry.
  const gatesDir = path.join(ROOT, 'lib', 'gates');
  const onDisk = fs.existsSync(gatesDir)
    ? fs.readdirSync(gatesDir).filter((f) => f.endsWith('.js')).map((f) => `lib/gates/${f}`)
    : [];
  for (const g of onDisk) {
    if (!modules[g]) errors += fail(`untracked gate module (no provenance entry): ${g}`);
  }
  if (onDisk.length && onDisk.every((g) => modules[g])) {
    ok(`all ${onDisk.length} lib/gates modules have provenance`);
  }

  console.log(errors === 0 ? '  ✅ provenance: 0 drift' : `  ❌ provenance: ${errors} problem(s)`);
  process.exit(errors === 0 ? 0 : 1);
}

main();
