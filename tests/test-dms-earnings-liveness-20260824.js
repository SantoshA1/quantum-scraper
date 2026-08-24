#!/usr/bin/env node
'use strict';
/**
 * Maya regression guard — the earnings guard can no longer die quietly (gov 239, 2026-08-24).
 *
 * Maya asks: "You told me the earnings guard fails OPEN when the calendar goes stale, and
 * that its staleness alarm lives INSIDE the nightly workflow — so if that workflow stops
 * running, the alarm stops running with it, my entry guard silently stops blocking, and I
 * find out when the next WMT gaps 8% through a 1.15% stop. You've now put a liveness leg in
 * the Dead-Man's Switch. Prove: (a) a fresh calendar keeps the morning message GREEN and
 * says so; (b) a stale calendar turns the whole message into an ALARM that names the risk in
 * words I'd act on; (c) if the freshness probe itself returns NOTHING — node failed, query
 * changed, field renamed — that is treated as UNHEALTHY, not as silence, because 'no news'
 * is exactly how the last three guards failed; (d) zero forward rows alarms even if the
 * timestamp looks recent; and (e) you didn't break the Signal Agent or pipeline legs that
 * were already working, and the API key is still read by name."
 *
 * Deterministic + offline. EXECUTES the real patched node body with stubbed $()/$vars/helpers.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FIX = path.join(__dirname, '..', 'docs', 'dms-earnings-20260824');
const OLD = fs.readFileSync(path.join(FIX, 'check-agent-health-deployed.js'), 'utf8');
const NEW = fs.readFileSync(path.join(FIX, 'check-agent-health-patched.js'), 'utf8');
const W = JSON.parse(fs.readFileSync(path.join(FIX, 'liveness-witness-20260824.json'), 'utf8'));
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const count = (h, n) => h.split(n).length - 1;

// Execute the node body with controllable upstream data.
function runNode(src, { ecJson, saRuns = 5, saErrors = 0, ssRuns = 12 }) {
  const today = new Date().toISOString().substring(0, 10);
  const mk = (n, status) => Array.from({ length: n }, (_, i) => ({ startedAt: `${today}T14:0${i % 10}:00Z`, status }));
  const helpers = {
    httpRequest: async ({ url }) => {
      if (url.includes('qq1mZLLsuUtot0ID')) return { data: [...mk(saRuns, 'success'), ...mk(saErrors, 'error')] };
      if (url.includes('vaqfCaELhOEWnkdo')) return { data: mk(ssRuns, 'success') };
      throw new Error('unexpected url: ' + url);
    },
  };
  const $ = (name) => {
    if (name === 'Check Earnings Calendar Freshness') return { first: () => ({ json: ecJson }) };
    throw new Error('unexpected node ref: ' + name);
  };
  const fn = new Function('$vars', '$', 'helpers', `return (async function(){ const self={helpers}; ${src.replace(/this\.helpers/g, 'self.helpers')} })()`);
  return fn({ N8N_API_KEY: 'DUMMY_KEY_NOT_REAL' }, $, helpers).then((r) => r[0].json);
}

const FRESH = { calendar_fresh: true, hours_since_refresh: 64.65, forward_rows: 1610, expected_last_refresh_et: '2026-08-21 18:10' };
const STALE = { calendar_fresh: false, hours_since_refresh: 88.4, forward_rows: 1610, expected_last_refresh_et: '2026-08-24 18:10' };

let passed = 0, failed = 0;
async function check(id, name, fn) {
  try { await fn(); console.log(`  ✅ ${id}  ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${id}  ${name}\n        ${e.message}`); failed++; }
}

(async () => {
  console.log('\n═══ the bytes are the bytes being deployed ═══\n');

  await check('DL-01', 'fixtures pinned by sha', () => {
    assert.strictEqual(sha(OLD), 'ca032cff7bebca74d5d88a53c131a0fa85ce4eef1ce41d62b307b9e38121a208');
    assert.strictEqual(sha(NEW), '586b1d62bafb53f0f8c5148f8ecdeff50f63ddacad1578a2ae912e753f4567b5');
  });

  await check('DL-02', 'REGRESSION WITNESS: the live monitor is blind to the earnings calendar', () => {
    assert.ok(!/earnings/i.test(OLD), 'old monitor must not mention earnings — or this leg already exists');
    assert.strictEqual(count(OLD, 'allHealthy = agentHealthy && pipelineHealthy;'), 1);
  });

  console.log('\n═══ (a) fresh calendar → green, and it says so ═══\n');

  await check('DL-03', 'fresh: healthy true, green message names hours and forward rows', async () => {
    const out = await runNode(NEW, { ecJson: FRESH });
    assert.strictEqual(out.healthy, true);
    assert.strictEqual(out.earnings_healthy, true);
    assert.match(out.message, /All Systems GO/);
    assert.match(out.message, /Earnings Calendar: fresh \(64\.7h, 1610 forward rows\)/);
  });

  console.log('\n═══ (b) stale calendar → the whole message becomes an ALARM ═══\n');

  await check('DL-04', 'stale: healthy false even though agent+pipeline are fine', async () => {
    const out = await runNode(NEW, { ecJson: STALE });
    assert.strictEqual(out.healthy, false, 'a stale calendar alone must fail the morning check');
    assert.strictEqual(out.earnings_healthy, false);
    assert.match(out.message, /QUANTUM ALERT/);
  });

  await check('DL-05', 'the alarm text is actionable: names the failure mode, the cost, the workflow', async () => {
    const out = await runNode(NEW, { ecJson: STALE });
    assert.match(out.message, /EARNINGS CALENDAR STALE - entry guard is FAILING OPEN/);
    assert.match(out.message, /NOT being blocked/);
    assert.match(out.message, /WMT lost 7\.9R/, 'the alarm must carry the lesson that justifies it');
    assert.match(out.message, /SDE0GVo9FeFqvpxS/, 'must name the workflow to check');
    assert.match(out.message, /ALPHAVANTAGE_API_KEY/);
    assert.match(out.message, /expected by: 2026-08-24 18:10 ET/);
  });

  console.log('\n═══ (c) a silent probe is UNHEALTHY, never silence ═══\n');

  await check('DL-06', 'FAIL-SAFE: empty/renamed/missing probe output → unhealthy + explicit line', async () => {
    for (const bad of [{}, { some_other_field: 1 }, { calendar_fresh: null }, { calendar_fresh: undefined }]) {
      const out = await runNode(NEW, { ecJson: bad });
      assert.strictEqual(out.healthy, false, `probe ${JSON.stringify(bad)} must be unhealthy`);
      assert.strictEqual(out.earnings_probe_ok, false);
      assert.match(out.message, /Freshness probe returned no verdict \(treated as unhealthy\)/);
    }
  });

  await check('DL-07', 'string "true"/"false" from Postgres booleans handled both ways', async () => {
    const t = await runNode(NEW, { ecJson: { ...FRESH, calendar_fresh: 'true' } });
    assert.strictEqual(t.earnings_healthy, true, 'Postgres may hand back the string "true"');
    const f = await runNode(NEW, { ecJson: { ...FRESH, calendar_fresh: 'false' } });
    assert.strictEqual(f.earnings_healthy, false);
  });

  console.log('\n═══ (d) zero forward rows alarms even with a recent timestamp ═══\n');

  await check('DL-08', 'fresh timestamp + empty calendar → still unhealthy', async () => {
    const out = await runNode(NEW, { ecJson: { ...FRESH, forward_rows: 0 } });
    assert.strictEqual(out.healthy, false, 'an empty calendar cannot be "fresh"');
    assert.strictEqual(out.earnings_forward_rows, 0);
  });

  console.log('\n═══ (e) nothing that already worked was broken ═══\n');

  await check('DL-09', 'existing legs intact: agent-down and pipeline-down still alarm; key by name', async () => {
    const agentDown = await runNode(NEW, { ecJson: FRESH, saRuns: 0, saErrors: 3 });
    assert.strictEqual(agentDown.healthy, false);
    assert.match(agentDown.message, /Signal Agent DOWN/);
    const pipeDown = await runNode(NEW, { ecJson: FRESH, ssRuns: 0 });
    assert.strictEqual(pipeDown.healthy, false);
    assert.match(pipeDown.message, /AI Super Score Pipeline: 0 executions today/);
    // key must still be read BY NAME, never inlined
    assert.strictEqual(count(NEW, '$vars.N8N_API_KEY'), 1);
    assert.ok(!/['"][A-Za-z0-9_\-]{30,}['"]/.test(NEW.replace(/https?:\/\/\S+/g, '')), 'no credential-shaped literal');
  });

  await check('DL-10', 'scope: only the four intended sites differ from the deployed bytes', () => {
    const a = OLD.split('\n'), b = NEW.split('\n');
    const removed = a.filter((l) => !new Set(b).has(l));
    assert.deepStrictEqual(removed.map((l) => l.trim().slice(0, 40)), [
      'const allHealthy = agentHealthy && pipel',
      'railway_ok: railwayOk',
    ], `unexpected deletions:\n${removed.join('\n')}`);
    // and the added lines are all owned by this change
    // case-insensitive (the alarm text shouts), plus bare structural lines the block needs
    const OWNED = /gov239|QTP_EARNINGS_LIVENESS|earnings|ec[A-Z]|_ecRaw|allHealthy|railway_ok|freshness probe|WMT lost|SDE0GVo9FeFqvpxS|ALPHAVANTAGE|^\/\/|^\}?\s*else\s*\{?$|^\}$|^$/i;
    const strays = b.filter((l) => !new Set(a).has(l)).filter((l) => !OWNED.test(l.trim()));
    assert.deepStrictEqual(strays, [], `lines added outside the liveness leg:\n${strays.join('\n')}`);
  });

  console.log('\n═══ the SQL probe: live witness for what JS cannot prove offline ═══\n');

  await check('DL-11', 'probe expects the most recent WEEKDAY slot — Monday looks back to Friday', () => {
    const p = W.probe_result;
    assert.strictEqual(p.expected_last_refresh_et, '2026-08-21 18:10');
    assert.strictEqual(W.weekend_property.today_isodow, 1, 'witness taken on a Monday');
    assert.strictEqual(W.weekend_property.expected_slot_isodow, 5, 'expectation landed on Friday');
    assert.strictEqual(p.calendar_fresh, true);
  });

  await check('DL-12', 'ONE missed run flips it to alarm — the flat 72h rule would not have', () => {
    assert.strictEqual(W.counterfactual_one_missed_run.calendar_fresh, false,
      'the database itself computed the counterfactual: a 24h-older refresh is NOT fresh');
    const f = W.flat_threshold_comparison;
    assert.ok(f.actual_hours < f.flat_threshold_hours,
      'this Monday reads UNDER the flat threshold, so the old rule would have said healthy');
    assert.strictEqual(f.flat_threshold_hours, 72);
  });

  console.log(`\n  ${passed}/${passed + failed} checks passed\n`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('HARNESS FAILURE:', e); process.exit(1); });
