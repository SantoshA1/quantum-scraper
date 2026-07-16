#!/usr/bin/env node
/**
 * Secret-leak commit gate (baseline ratchet).
 *
 * Scans SHIPPABLE files (deployed code + n8n workflow exports) for known-leaked
 * literals and generic high-risk credential patterns. FAILS (exit 1) on any match
 * that is NOT recorded in .ci/secret-baseline.json — so all NEW leaks are blocked
 * while pre-existing debt (documented in the baseline) ships green.
 *
 * Scope: root *.js and n8n-workflows/*.json. Excludes tests/ and docs/ (which
 * intentionally reference leaked literals to assert their ABSENCE elsewhere).
 *
 * Run:  node .ci/check-secrets.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Files in scope: shippable code + workflow definitions only.
function shippableFiles() {
  const out = [];
  for (const f of fs.readdirSync(ROOT)) {
    if (f.endsWith('.js') && fs.statSync(path.join(ROOT, f)).isFile()) out.push(f);
  }
  const wfDir = path.join(ROOT, 'n8n-workflows');
  if (fs.existsSync(wfDir)) {
    for (const f of fs.readdirSync(wfDir)) {
      if (f.endsWith('.json')) out.push(path.join('n8n-workflows', f));
    }
  }
  return out;
}

// Known-leaked literals + generic credential patterns. Add new patterns as new
// secret classes appear; never remove one to silence a finding.
const PATTERNS = [
  { name: 'polygon_key',      re: /LxG0VrVzcQYEtWDfg8d6G49iapiC4Ec_/g },
  { name: 'telegram_token',   re: /\b\d{9,10}:AA[A-Za-z0-9_-]{30,}\b/g },
  { name: 'webhook_secret64', re: /\b[0-9a-f]{64}\b/g },
  { name: 'xai_key',          re: /\bxai-[A-Za-z0-9]{16,}\b/g },
  { name: 'openai_key',       re: /\bsk-[A-Za-z0-9]{20,}\b/g },
  { name: 'alpaca_key_id',    re: /\bPK[A-Z0-9]{16,}\b/g },
  { name: 'aws_akid',         re: /\bAKIA[0-9A-Z]{16}\b/g },
];

function loadBaseline() {
  const p = path.join(ROOT, '.ci', 'secret-baseline.json');
  if (!fs.existsSync(p)) return [];
  try {
    return (JSON.parse(fs.readFileSync(p, 'utf8')).allow) || [];
  } catch (e) {
    console.error('check-secrets: baseline is not valid JSON:', e.message);
    process.exit(2);
  }
}

function isAllowed(baseline, file, match) {
  return baseline.some((b) => b.file === file && b.match === match);
}

const baseline = loadBaseline();
const files = shippableFiles();
const newFindings = [];
let baselinedCount = 0;

// n8n emits a 64-hex tracking hash inside utm_campaign=n8n-nodes-base.<node>_<hash>
// links (e.g. the Telegram "powered by n8n" footer). Those are framework artifacts,
// not credentials, so a bare-64-hex match preceded by that context is not a leak.
const FRAMEWORK_HASH_CONTEXT = /telegram_|utm_campaign|n8n-nodes-base|powered_by|instanceId|versionId|webhookId|nodeId/i;

for (const rel of files) {
  let text;
  try { text = fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { continue; }
  for (const { name, re } of PATTERNS) {
    re.lastIndex = 0;
    const seen = new Set();
    let m;
    while ((m = re.exec(text)) !== null) {
      const hit = m[0];
      if (name === 'webhook_secret64') {
        const before = text.slice(Math.max(0, m.index - 32), m.index);
        if (FRAMEWORK_HASH_CONTEXT.test(before)) continue; // n8n tracking hash, not a secret
      }
      if (seen.has(hit)) continue;
      seen.add(hit);
      if (isAllowed(baseline, rel, hit)) { baselinedCount++; continue; }
      newFindings.push({ rel, name, redacted: hit.slice(0, 10) + '…(' + hit.length + ' chars)' });
    }
  }
}

console.log(`check-secrets: scanned ${files.length} shippable files; ${baselinedCount} baselined (tech-debt), ${newFindings.length} new.`);

if (newFindings.length > 0) {
  console.error('\n✗ NEW secret leak(s) detected — not in .ci/secret-baseline.json:');
  for (const f of newFindings) console.error(`  [${f.name}] ${f.rel} :: ${f.redacted}`);
  console.error('\nScrub the secret (do NOT add it to the baseline to silence this).');
  process.exit(1);
}
console.log('✓ No new secret leaks.');
process.exit(0);
