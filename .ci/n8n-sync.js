#!/usr/bin/env node
/**
 * n8n <-> repo sync tool. Makes the repo the canonical source for n8n workflow
 * definitions, with guardrails that prevent a stale repo from clobbering live.
 *
 * Modes:
 *   export  — pull live workflow(s) from n8n INTO the repo (reconciliation).
 *             Run this FIRST to un-stale the repo before any publish.
 *   diff    — show what would change if the repo were published (read-only).
 *   publish — push repo workflow(s) TO n8n. Dry-run unless N8N_ALLOW_PUBLISH=true.
 *
 * Canonical store: n8n-workflows/<file>.json  (n8n export shape)
 * Sync manifest:   .ci/n8n-manifest.json  (id -> file, + versionId at last export)
 *
 * Env:
 *   N8N_BASE_URL   e.g. https://tradenextgen.app.n8n.cloud
 *   N8N_API_KEY    n8n Cloud API key (Settings -> n8n API). NEVER commit this.
 *   N8N_ALLOW_PUBLISH=true  required for publish to actually PUT (else dry-run)
 *
 * Usage:
 *   node .ci/n8n-sync.js export --id <workflowId>
 *   node .ci/n8n-sync.js export --all
 *   node .ci/n8n-sync.js diff   --id <workflowId>
 *   node .ci/n8n-sync.js publish --id <workflowId>          # dry-run
 *   N8N_ALLOW_PUBLISH=true node .ci/n8n-sync.js publish --id <workflowId>
 *
 * STALENESS GUARD (the important part): publish refuses if the live workflow's
 * versionId differs from the versionId recorded when the repo file was last
 * exported — i.e. live changed since you reconciled. Reconcile (export) first.
 * Override only with --force AND a documented reason; this is the same doctrine
 * as the reconciliation tripwire.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WF_DIR = path.join(ROOT, 'n8n-workflows');
const MANIFEST = path.join(__dirname, 'n8n-manifest.json');

const BASE = (process.env.N8N_BASE_URL || '').replace(/\/+$/, '');
const KEY = process.env.N8N_API_KEY || '';
const ALLOW_PUBLISH = process.env.N8N_ALLOW_PUBLISH === 'true';

function die(msg, code = 1) { console.error('n8n-sync: ' + msg); process.exit(code); }
function requireApi() {
  if (!BASE) die('N8N_BASE_URL not set');
  if (!KEY) die('N8N_API_KEY not set (generate in n8n Settings -> n8n API; add to env / GitHub secret; never commit)');
}
async function api(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'X-N8N-API-KEY': KEY, 'accept': 'application/json', 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) die(`${method} ${p} -> ${res.status} ${res.statusText}\n${await res.text()}`);
  return res.status === 204 ? null : res.json();
}
function loadManifest() { try { return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); } catch { return { workflows: {} }; } }
function saveManifest(m) { fs.writeFileSync(MANIFEST, JSON.stringify(m, null, 2) + '\n'); }
function slug(name) { return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60); }
// Only the fields n8n's PUT accepts — never persist secrets/credentials data here.
function canonical(wf) {
  return { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings: wf.settings || {} };
}

function args() {
  const a = process.argv.slice(3);
  const o = { id: null, all: false, force: false };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--id') o.id = a[++i];
    else if (a[i] === '--all') o.all = true;
    else if (a[i] === '--force') o.force = true;
  }
  return o;
}

async function doExport(o) {
  requireApi();
  const m = loadManifest();
  let list;
  if (o.all) list = (await api('GET', '/api/v1/workflows?limit=250')).data;
  else if (o.id) list = [await api('GET', `/api/v1/workflows/${o.id}`)];
  else die('export needs --id <workflowId> or --all');
  fs.mkdirSync(WF_DIR, { recursive: true });
  for (const wf of list) {
    const file = (m.workflows[wf.id] && m.workflows[wf.id].file) || `${slug(wf.name)}.json`;
    fs.writeFileSync(path.join(WF_DIR, file), JSON.stringify(canonical(wf), null, 2) + '\n');
    m.workflows[wf.id] = { file, name: wf.name, versionId: wf.versionId || null, exportedAt: new Date().toISOString() };
    console.log(`  exported ${wf.id}  ${wf.name}  -> n8n-workflows/${file}  (versionId ${wf.versionId || 'n/a'})`);
  }
  saveManifest(m);
  console.log(`\n✓ exported ${list.length} workflow(s). Review the diff, then commit — repo is now reconciled to live.`);
}

async function doDiffOrPublish(o, publish) {
  requireApi();
  const m = loadManifest();
  if (!o.id) die(`${publish ? 'publish' : 'diff'} needs --id <workflowId> (no mass-publish by default)`);
  const entry = m.workflows[o.id];
  if (!entry) die(`workflow ${o.id} not in manifest — run "export --id ${o.id}" to reconcile it first`);
  const repo = JSON.parse(fs.readFileSync(path.join(WF_DIR, entry.file), 'utf8'));
  const live = await api('GET', `/api/v1/workflows/${o.id}`);

  // STALENESS GUARD
  if (entry.versionId && live.versionId && entry.versionId !== live.versionId) {
    console.error(`\n✗ STALENESS GUARD: live versionId (${live.versionId}) != repo's last export (${entry.versionId}).`);
    console.error('  Live changed since you reconciled. Run "export" first, review, commit, then publish.');
    if (!(publish && o.force)) process.exit(3);
    console.error('  --force set: proceeding despite staleness (document this).');
  }

  const liveCanon = JSON.stringify(canonical(live));
  const repoCanon = JSON.stringify({ name: repo.name, nodes: repo.nodes, connections: repo.connections, settings: repo.settings || {} });
  if (liveCanon === repoCanon) { console.log(`= no change for ${o.id} (${entry.name})`); return; }
  console.log(`~ ${o.id} (${entry.name}) differs: repo ${repo.nodes.length} nodes vs live ${live.nodes.length} nodes`);

  if (!publish) { console.log('(diff mode — read-only; run publish to apply)'); return; }
  if (!ALLOW_PUBLISH) { console.log('\nDRY-RUN: set N8N_ALLOW_PUBLISH=true to actually PUT this change.'); return; }

  await api('PUT', `/api/v1/workflows/${o.id}`, { name: repo.name, nodes: repo.nodes, connections: repo.connections, settings: repo.settings || {} });
  const after = await api('GET', `/api/v1/workflows/${o.id}`);
  m.workflows[o.id].versionId = after.versionId || null;
  m.workflows[o.id].publishedAt = new Date().toISOString();
  saveManifest(m);
  console.log(`\n✓ published ${o.id} -> new versionId ${after.versionId || 'n/a'}.`);
  console.log('  IMPORTANT: record a governance row in quantum.ssm_workflow_updates (put_wrapped_update) for this publish.');
}

(async () => {
  const mode = process.argv[2];
  const o = args();
  if (mode === 'export') return doExport(o);
  if (mode === 'diff') return doDiffOrPublish(o, false);
  if (mode === 'publish') return doDiffOrPublish(o, true);
  die('usage: n8n-sync.js <export|diff|publish> [--id <id> | --all] [--force]');
})().catch((e) => die(e.stack || String(e), 2));
