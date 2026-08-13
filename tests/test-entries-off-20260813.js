#!/usr/bin/env node
'use strict';
/**
 * Maya regression guard — the PO entry halt of 2026-08-13 (gov 213).
 *
 * Maya asks: "You refused the PO's literal order (flip expansion_cohort_active=0) and did
 * something else instead. Prove BOTH halves from the deployed bytes: prove the flip really
 * would have removed the caps instead of stopping entries, and prove the thing you actually
 * did — the entry_pause_control halt row — blocks every new entry while letting every stop,
 * trail and close through. And pin the reader quirk that forced the future checked_at, so
 * if anyone ever fixes the reader, this suite tells them the weird row can be normalised."
 *
 * Deterministic + offline. Fixtures are the LIVE node code lifted verbatim from workflow
 * vaqfCaELhOEWnkdo (sha256-pinned in docs/entries-off-20260813/deployed-bytes.json).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FIX = path.join(__dirname, '..', 'docs', 'entries-off-20260813');
const meta = JSON.parse(fs.readFileSync(path.join(FIX, 'deployed-bytes.json'), 'utf8'));
const read = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');

let passed = 0, failed = 0;
function check(id, name, fn) {
  try { fn(); console.log(`  ✅ ${id}  ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${id}  ${name}\n        ${e.message}`); failed++; }
}

// ── run a deployed n8n Code node body against fixture items ─────────────────
function runPauseGuard(itemsIn) {
  const code = read('pause-guard.node.js');
  const fn = new Function('items', `${code}\n`);
  return fn(itemsIn.map((j) => ({ json: j })));
}
function runKellyBuild(prepJson, inputJson) {
  const code = read('kelly-sql-build.node.js');
  const fn = new Function('$', '$json', `return (function(){ ${code} })();`);
  const $ = (name) => ({ first: () => ({ json: prepJson }) });
  return fn($, inputJson)[0].json.__kelly_sql;
}

console.log('\n═══ the bytes are the ones that are live ═══\n');

check('EO-01', 'fixtures are byte-identical to the deployed workflow (sha256 pinned)', () => {
  for (const [f, m] of Object.entries(meta)) {
    const h = crypto.createHash('sha256').update(read(f)).digest('hex');
    assert.strictEqual(h, m.sha256, `${f} drifted from the pinned deploy — re-extract before trusting this suite`);
  }
});

console.log('\n═══ why the PO\'s literal order was refused ═══\n');

check('EO-02', 'THE REFUSAL: flag=0 does not stop entries — every cap clause requires exp.is_on', () => {
  const sql = runKellyBuild(
    { __qet_conf: 8, __qet_entry: 100, __qet_stop: 95, __qet_side: 'BUY', __qet_symbol: 'TEST' },
    { equity: 100000 }
  );
  assert.ok(sql.includes("coalesce((SELECT live_value FROM cfg WHERE constant_name = 'expansion_cohort_active'), 0) = 1 AS is_on"),
    'is_on must be defined as flag=1');
  // every EXPANSION block clause is conjoined with exp.is_on — with is_on=false none can fire
  const clauses = sql.split(/\bWHEN\b/).slice(1).filter((c) => c.includes("'approved', false"));
  assert.ok(clauses.length >= 5, `expected >=5 blocking cap clauses, found ${clauses.length}`);
  for (const c of clauses) {
    assert.ok(c.trimStart().startsWith('exp.is_on'),
      `blocking clause not gated on exp.is_on — flip semantics changed, re-review: WHEN${c.slice(0, 80)}`);
  }
  assert.ok(sql.includes('ELSE public.compute_kelly_gate('),
    'with is_on=false the SQL falls through to the normal Kelly approval path — i.e. the flip REMOVES caps, it does not stop trading');
});

console.log('\n═══ the halt that was actually shipped ═══\n');

check('EO-03', 'a pause row blocks a plain new entry (the Broad Scanner shape)', () => {
  const out = runPauseGuard([{
    ticker: 'ARM', execution: 'BUY',
    order_intent: 'buy_open_or_close_per_downstream_state', // real scanner intent — OR-clause, not a close
    _supabase_pause_control: { pause_new_entries: 'true', reason: 'EXPANSION_CUMULATIVE_HALT gov213' },
  }]);
  const j = out[0].json;
  assert.strictEqual(j._pause_guard_action, 'BLOCK_NEW_ENTRY_ONLY');
  assert.strictEqual(j._pause_guard_live_order_allowed, false);
  assert.strictEqual(j._sm_route, 'SKIP', 'blocked entries must take the same SKIP route as state-machine kills');
  assert.ok(String(j._sm_reason).includes('EXPANSION_CUMULATIVE_HALT'), 'the halt reason must survive into the audit trail');
});

check('EO-04', 'the same pause row does NOT block exits, stops, trails or covers', () => {
  const pause = { pause_new_entries: 'true', reason: 'gov213' };
  for (const intent of ['TRAILING_STOP', 'PROTECTIVE_STOP', 'SELL_TO_CLOSE', 'BUY_TO_COVER', 'EXIT', 'STOP']) {
    const out = runPauseGuard([{ ticker: 'WMB', action: intent, _supabase_pause_control: pause }]);
    assert.strictEqual(out[0].json._pause_guard_action, 'BYPASS_PROTECTIVE_OR_CLOSING',
      `${intent} must bypass the halt — the six open positions stay protected`);
    assert.strictEqual(out[0].json._pause_guard_live_order_allowed, true);
  }
  const reduceOnly = runPauseGuard([{ ticker: 'XPEV', reduce_only: true, _supabase_pause_control: pause }]);
  assert.strictEqual(reduceOnly[0].json._pause_guard_action, 'BYPASS_PROTECTIVE_OR_CLOSING');
});

check('EO-05', 'no pause row → entries flow (the halt is the only thing standing in the way)', () => {
  const out = runPauseGuard([{ ticker: 'AMD', execution: 'BUY', order_intent: 'buy_open_or_close_per_downstream_state', _supabase_pause_control: { pause_new_entries: 'false' } }]);
  assert.strictEqual(out[0].json._pause_guard_action, 'ALLOW_NEW_ENTRY');
});

console.log('\n═══ the reader quirk that dictated the row shape ═══\n');

check('EO-06', 'READER PIN: guard reads ONE latest unexpired row — so the halt row must out-sort AFTO NOMINAL writes', () => {
  const reader = read('pause-reader.node.js');
  assert.ok(reader.includes('ORDER BY checked_at DESC'), 'reader sorts by checked_at');
  assert.ok(reader.includes('LIMIT 1'), 'reader takes exactly one row');
  assert.ok(reader.includes('expires_at > CURRENT_TIMESTAMP'), 'reader filters only on expiry');
  // This is WHY po_halt_20260813_entries_off carries checked_at = now()+30d / expires_at = now()+60d.
  // qtp_afto_monitor unconditionally inserts a fresh NOMINAL row every 15 min (no carry-forward,
  // verified in workflow AaaQOrBVEXwJkOyz) — a halt row with checked_at=now() would be masked
  // within 15 minutes. If this check ever fails, the reader changed: normalise the halt row and
  // fix the automated kill-switch halt writer at the same time (it has the same masking bug).
});

console.log(`\n  ${passed}/${passed + failed} checks passed\n`);
process.exit(failed === 0 ? 0 : 1);
