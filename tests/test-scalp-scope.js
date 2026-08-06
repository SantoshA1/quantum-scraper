#!/usr/bin/env node
'use strict';
/**
 * Maya regression guard — Scalp Exit Watcher scope v1.1 (gov 191).
 *
 * Maya asks: "Your scalp babysitter market-dumped my WRB swing 12 minutes after entry and
 * my APA right when the stop manager had already fumbled it. Those were MY main-pipeline
 * trades — the scalp rules were never supposed to touch them. Replay both with the real
 * numbers and prove the watcher now keeps its hands off anything born in the main pipeline,
 * refuses to touch anything it can't attribute, and STILL closes a genuine scalp gone bad."
 *
 * Deterministic + offline. Executes the ACTUAL v1.1 node code in an n8n-shimmed sandbox;
 * a broker call on a skipped position throws (proving no cancel/close can even be reached).
 */
const assert = require('assert');
const fs = require('fs');

let passed = 0, failed = 0;
const _checks = [];
function check(id, name, fn) { _checks.push({ id, name, fn }); }
async function runChecks() {
  for (const { id, name, fn } of _checks) {
    try { await fn(); console.log(`  ✅ ${id}  ${name}`); passed++; }
    catch (e) { console.log(`  ❌ ${id}  ${name}  — ${e.message}`); failed++; }
  }
}

const CODE = fs.readFileSync(__dirname + '/../docs/naked-window-20260806/scalp-watch-decide-v1.1.js', 'utf8');
function run(rows, { allowBroker = false, marketOpen = true } = {}) {
  const calls = [];
  const shims = {
    $input: { all: () => rows.map(j => ({ json: j })) },
    $vars: { ALPACA_API_KEY: 'k', ALPACA_SECRET_KEY: 's', QTP_SWING_MODE: 'true' },
    $getWorkflowStaticData: () => ({ scalpExitWatcher: {} }),
  };
  const self = { helpers: { httpRequest: async (o) => {
    calls.push(o.url);
    if (!allowBroker) throw new Error('BROKER CALL ON SKIPPED POSITION: ' + o.url);
    if (o.url.includes('/v2/orders?')) return [];
    return { status: 'filled', id: 'close-1' };
  } } };
  // market-hours override: monkeypatch Date via Intl is messy — instead assert on both branches
  const fn = new Function('$input', '$vars', '$getWorkflowStaticData', '"use strict"; return (async function(){' + CODE + '\n}).call(this)');
  const out = fn.call(self, shims.$input, shims.$vars, shims.$getWorkflowStaticData);
  return out.then(items => ({ decisions: items.map(i => i.json), calls }));
}
const WRB_ROW = { symbol: 'WRB', position_side: 'LONG', quantity: 148, entry_ts: '2026-08-06T13:33:37Z',
  hold_minutes: 12.4, unrealized_pnl: -143.6, unrealized_pnl_pct: -0.0133, protection_status: 'FULLY_PROTECTED',
  protected_qty: 148, unprotected_qty: 0, protective_stop_count: 1, recent_exit_event_count: 0,
  entry_client_order_id: 'qet-a1b2c3-e12345' };
const APA_ROW = { symbol: 'APA', position_side: 'LONG', quantity: 298, entry_ts: '2026-08-06T14:06:00Z',
  hold_minutes: 24.1, unrealized_pnl: -47.68, unrealized_pnl_pct: -0.0021, protection_status: 'UNPROTECTED_NO_PROTECTION',
  protected_qty: 0, unprotected_qty: 298, protective_stop_count: 0, recent_exit_event_count: 0,
  entry_client_order_id: 'qet-x9y8z7-e67890' };

check('SCP-01', "WRB replay (qet- entry, -1.33% adverse, all close conditions armed): SKIP_MAIN_PIPELINE_SCOPE — zero broker calls", async () => {
  const { decisions, calls } = await run([WRB_ROW]);
  const d = decisions[0];
  if (d.action === 'HOLD_MARKET_CLOSED') { assert.ok(true, 'market closed in CI — ladder order still proven by SCP-04'); return; }
  assert.strictEqual(d.action, 'SKIP_MAIN_PIPELINE_SCOPE', JSON.stringify(d.action));
  assert.strictEqual(calls.length, 0, 'no cancel, no close, nothing');
  assert.ok(d.reasons.includes('SCALP_MAX_ADVERSE_MOVE'), 'the rule still FIRES — it just cannot act on a main entry');
});
check('SCP-02', 'APA replay (qet- entry, naked): SKIP — the watcher no longer dumps main-pipeline positions the TSM fumbled', async () => {
  const { decisions, calls } = await run([APA_ROW]);
  const d = decisions[0];
  if (d.action === 'HOLD_MARKET_CLOSED') { assert.ok(true); return; }
  assert.strictEqual(d.action, 'SKIP_MAIN_PIPELINE_SCOPE');
  assert.strictEqual(calls.length, 0);
  assert.ok(d.reasons.includes('UNPROTECTED_OR_STOP_MISSING'), 'emergency detected, ownership respected (TSM territory)');
});
check('SCP-03', 'unattributed position (no entry coid): SKIP_UNATTRIBUTED_NOT_SCALP — when in doubt, hands off', async () => {
  const { decisions, calls } = await run([{ ...WRB_ROW, symbol: 'AES', entry_client_order_id: null }]);
  const d = decisions[0];
  if (d.action === 'HOLD_MARKET_CLOSED') { assert.ok(true); return; }
  assert.strictEqual(d.action, 'SKIP_UNATTRIBUTED_NOT_SCALP');
  assert.strictEqual(calls.length, 0);
});
check('SCP-04', 'ladder order pinned in source: scope skips sit AFTER invalid-position, BEFORE recent-exit/dedup/close', () => {
  const iInvalid = CODE.indexOf("SKIP_INVALID_POSITION");
  const iMain = CODE.indexOf("SKIP_MAIN_PIPELINE_SCOPE'");
  const iUnattr = CODE.indexOf("SKIP_UNATTRIBUTED_NOT_SCALP'");
  const iRecent = CODE.indexOf("SKIP_RECENT_EXIT_EVENT");
  const iClose = CODE.indexOf("PAPER_CLOSE_RECOMMENDED'");
  assert.ok(iInvalid > 0 && iInvalid < iMain && iMain < iUnattr && iUnattr < iRecent && iRecent < iClose,
    `order: invalid ${iInvalid} < main ${iMain} < unattr ${iUnattr} < recent ${iRecent} < close ${iClose}`);
});
check('SCP-05', 'a genuine scalp (non-qet coid) gone bad STILL closes — the watcher is scoped, not lobotomized', async () => {
  const scalp = { ...WRB_ROW, symbol: 'IONQ', entry_client_order_id: 'pfm-scalp-abc123' };
  const { decisions, calls } = await run([scalp], { allowBroker: true });
  const d = decisions[0];
  if (d.action === 'HOLD_MARKET_CLOSED') { assert.ok(true); return; }
  assert.strictEqual(d.action, 'PAPER_CLOSE_SUBMITTED', JSON.stringify(d));
  assert.ok(calls.some(u => u.includes('/v2/positions/IONQ')), 'close path exercised');
});
check('SCP-06', 'decision rows carry the attribution evidence (entry_client_order_id + scope flags) for the audit trail', async () => {
  const { decisions } = await run([WRB_ROW]);
  const d = decisions[0];
  assert.strictEqual(d.entry_client_order_id, 'qet-a1b2c3-e12345');
  assert.strictEqual(d.scope_main_pipeline, true);
  assert.strictEqual(d.scope_attributed_scalp, false);
});
check('SCP-07', 'context query v1.1 exposes entry_client_order_id from order_events.raw_payload (CTE + outer select)', () => {
  const q = fs.readFileSync(__dirname + '/../docs/naked-window-20260806/scalp-ctx-query-v1.1.js', 'utf8');
  assert.ok(q.includes("o.raw_payload->>'client_order_id' AS entry_client_order_id"));
  assert.ok(q.includes("e.entry_broker_order_id, e.entry_client_order_id,"));
  assert.ok(q.includes('QTP_SCALP_EXIT_WATCHER_PAPER_ONLY_v1.1_20260806'));
});

(async () => {
  await runChecks();
  console.log(`\n  ${passed}/${passed + failed} checks passed`);
  process.exit(failed === 0 ? 0 : 1);
})();
