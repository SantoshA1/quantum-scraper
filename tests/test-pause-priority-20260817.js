#!/usr/bin/env node
'use strict';
/**
 * Maya regression guard — a cancelled halt must never come back (gov 223, 2026-08-17).
 *
 * Maya asks: "On 14 August you told me trading was back on. There is still a row in the
 * pause table from the halt you cancelled, and until today it sat FIRST in line — dated
 * 12 September, four weeks in the future, on a row that died on the 14th. Prove to me
 * that (a) that dead row really would have stopped my trades, so I know this was a real
 * bug and not you tidying up; (b) it cannot any more; (c) a halt that is genuinely LIVE
 * still stops entries instantly, because you have just made the halt mechanism weaker and
 * I care much more about that than about the tidy-up; and (d) the one thing keeping this
 * safe — the expiry filter in the query — is still in the query."
 *
 * Deterministic + offline. Fixtures are captured reality (Maya V2-1):
 *   docs/pause-priority-20260817/pause-prep-deployed.js  — the REAL `Prepare Supabase Pause
 *       Guard Query` jsCode of workflow vaqfCaELhOEWnkdo, active version a4358cbe.
 *   docs/pause-priority-20260817/pause-format-deployed.js — the REAL `Format Supabase Pause
 *       Guard Context` jsCode from the same version.
 *   docs/short-halt-20260814/pauseguard-patched.js       — the REAL `QTP-10FC New Entry
 *       Pause Guard` body, already sha-pinned by test-short-halt-20260814.js.
 *   docs/pause-priority-20260817/rows-captured-20260817.json — the actual table rows.
 *
 * Both jsCode bodies are EXECUTED. The row-selection step is SQL, so it cannot be executed
 * offline; instead PG-01 pins the two clauses that do the selecting and `selectRow()`
 * implements exactly those and nothing else — if the SQL ever gains a clause the model does
 * not know about, PG-01 fails before any selection check is trusted. PG-11 is the negative
 * control: strip the expiry clause and the suite must go red.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'docs', 'pause-priority-20260817');
const PREP = fs.readFileSync(path.join(FIX, 'pause-prep-deployed.js'), 'utf8');
const FORMAT = fs.readFileSync(path.join(FIX, 'pause-format-deployed.js'), 'utf8');
const GUARD = fs.readFileSync(path.join(ROOT, 'docs', 'short-halt-20260814', 'pauseguard-patched.js'), 'utf8');
const ROWS = JSON.parse(fs.readFileSync(path.join(FIX, 'rows-captured-20260817.json'), 'utf8'));
const NODES = JSON.parse(fs.readFileSync(path.join(FIX, 'pause-nodes-deployed.json'), 'utf8'));
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

let passed = 0, failed = 0;
function check(id, name, fn) {
  try { fn(); console.log(`  ✅ ${id}  ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${id}  ${name}\n        ${e.message}`); failed++; }
}

// ── the deployed SQL, lifted out of the deployed node body ───────────────────
function deployedSql(src) {
  const fn = new Function('$json', src);
  return fn({})[0].json.__supabase_pause_sql;
}
const SQL = deployedSql(PREP);

// The ONLY row-selection semantics this suite models. Justified by PG-01, which asserts the
// deployed SQL contains these two clauses and no other WHERE/ORDER term.
function selectRow(rows, nowIso, sql = SQL) {
  const now = Date.parse(nowIso);
  let pool = rows;
  if (/WHERE\s+expires_at\s*>\s*CURRENT_TIMESTAMP/i.test(sql)) {
    pool = pool.filter((r) => Date.parse(r.expires_at) > now);
  }
  if (/ORDER BY\s+checked_at\s+DESC/i.test(sql)) {
    pool = [...pool].sort((a, b) => Date.parse(b.checked_at) - Date.parse(a.checked_at));
  }
  const ctrl = /LIMIT\s+1/i.test(sql) ? pool.slice(0, 1) : pool;
  // the COALESCE projection, verbatim from the deployed SELECT
  return ctrl.length
    ? { pause_new_entries: ctrl[0].pause_new_entries, reason: ctrl[0].reason,
        status: ctrl[0].status, checked_at: ctrl[0].checked_at, expires_at: ctrl[0].expires_at,
        _control_id: ctrl[0].control_id }
    : { pause_new_entries: false, reason: 'no active pause control',
        status: 'NO_ACTIVE_PAUSE', checked_at: null, expires_at: null, _control_id: null };
}

// ── run the selected row through the REAL deployed nodes ─────────────────────
// The Format node reaches BACK to the Prepare node for the original signal and reads the
// Postgres result off $input — so the harness supplies both seams exactly as n8n does.
function formatNode(row, signal) {
  const $ = (nodeName) => {
    assert.strictEqual(nodeName, 'Prepare Supabase Pause Guard Query',
      `the Format node now reaches back to "${nodeName}" — the graph changed, re-derive this harness`);
    return { first: () => ({ json: signal }) };
  };
  const $input = { first: () => ({ json: row }) };
  const fn = new Function('$', '$input', FORMAT);
  return fn($, $input)[0].json;
}
function pauseGuard(item) {
  const fn = new Function('items', '$vars', GUARD);
  return fn([{ json: item }], undefined)[0].json;
}
/** Full path: table rows -> deployed SQL semantics -> Format node -> Pause Guard node. */
function wouldTrade(rows, nowIso, signal, sql = SQL) {
  const row = selectRow(rows, nowIso, sql);
  const formatted = formatNode(row, signal);
  const verdict = pauseGuard(formatted);
  return { row, verdict, allowed: verdict._pause_guard_live_order_allowed === true };
}

// A long exactly like ADPT, the trade that filled at 11:31:05 ET on the day of this fix.
const ADPT_LONG = { symbol: 'ADPT', side: 'BUY', execution: 'BUY', bias_score: 85 };
const NOW = '2026-08-17T16:35:00.000Z';                       // 12:35 ET, mid-session
const BEFORE = [...ROWS.afto_nominal, ROWS.po_halt_before];   // the table until today
const AFTER = [...ROWS.afto_nominal, ROWS.po_halt_after];     // the table now

(async () => {
  console.log('\n═══ the bytes and the rows are real ═══\n');

  check('PG-01', 'the deployed query still filters on expiry and orders by checked_at — nothing else selects', () => {
    assert.strictEqual(sha(PREP), '0dc3c8d7009c93c84debd679aa612b8c5f3041d8092de4865bf3cd0de16574eb');
    assert.strictEqual(sha(FORMAT), 'fa41e56981ce42c39e067f832ad87b719dcebfed95a8ae6200068a7af22274a6');
    assert.strictEqual(sha(GUARD), '133458389c5a368f52288972268cdaee74bcc61a9ce9681d5bdca038a42cacbb');
    assert.ok(/WHERE\s+expires_at\s*>\s*CURRENT_TIMESTAMP/.test(SQL), 'THE EXPIRY FILTER IS GONE');
    assert.ok(/ORDER BY\s+checked_at\s+DESC/.test(SQL) && /LIMIT\s+1/.test(SQL));
    // selectRow() models exactly these; a new WHERE/ORDER term would silently invalidate it.
    assert.deepStrictEqual(SQL.match(/\bWHERE\b/g), ['WHERE'], 'a second WHERE appeared — re-derive selectRow()');
    assert.deepStrictEqual(SQL.match(/\bORDER BY\b/g), ['ORDER BY'], 'a second ORDER BY appeared — re-derive selectRow()');
  });

  check('PG-02', 'the captured halt row is the real one, and only its checked_at was touched', () => {
    const { po_halt_before: b, po_halt_after: a } = ROWS;
    for (const k of Object.keys(b)) {
      if (k === 'checked_at') continue;
      assert.deepStrictEqual(a[k], b[k], `gov 223 changed ${k} — it must only have moved checked_at`);
    }
    assert.strictEqual(b.pause_new_entries, true, 'this row really does say "stop trading"');
    assert.strictEqual(a.checked_at, a.expires_at, 'the correction is checked_at = expires_at (the gov215 pattern)');
  });

  console.log('\n═══ the bug was real: a cancelled halt sat first in line ═══\n');

  check('PG-03', 'REGRESSION WITNESS: before the fix, the dead halt outranked every live row', () => {
    const ordered = [...BEFORE].sort((x, y) => Date.parse(y.checked_at) - Date.parse(x.checked_at));
    assert.strictEqual(ordered[0].control_id, 'po_halt_20260813_entries_off',
      'the whole bug is that a row cancelled on 08-14 sorted ahead of rows written minutes ago');
    assert.ok(Date.parse(ROWS.po_halt_before.checked_at) > Date.parse(NOW),
      'and its checked_at was in the FUTURE relative to a live session');
  });

  check('PG-04', 'REGRESSION WITNESS: drop the expiry filter and ADPT is killed by a halt the PO cancelled', () => {
    const noExpiry = SQL.replace(/WHERE\s+expires_at\s*>\s*CURRENT_TIMESTAMP/, '');
    const r = wouldTrade(BEFORE, NOW, ADPT_LONG, noExpiry);
    assert.strictEqual(r.row._control_id, 'po_halt_20260813_entries_off');
    assert.strictEqual(r.allowed, false, 'this is the failure mode gov 223 removes');
    assert.strictEqual(r.verdict._pause_guard_action, 'BLOCK_NEW_ENTRY_ONLY');
  });

  check('PG-05', 'the expiry filter was the ONLY thing holding it back — deployed query traded fine', () => {
    const r = wouldTrade(BEFORE, NOW, ADPT_LONG);
    assert.strictEqual(r.row.status, 'NOMINAL');
    assert.strictEqual(r.allowed, true, 'production was safe, but on one clause');
  });

  console.log('\n═══ after the fix it cannot happen, with or without that clause ═══\n');

  check('PG-06', 'ADPT trades on the corrected table — the deployed query is unchanged in effect', () => {
    const before = wouldTrade(BEFORE, NOW, ADPT_LONG);
    const after = wouldTrade(AFTER, NOW, ADPT_LONG);
    assert.strictEqual(after.allowed, true);
    assert.deepStrictEqual(after.row.status, before.row.status, 'gov 223 must be a NO-OP for the live reader');
    assert.strictEqual(after.row._control_id, before.row._control_id);
  });

  check('PG-07', 'and now it survives the sabotage: no expiry filter, still trades', () => {
    const noExpiry = SQL.replace(/WHERE\s+expires_at\s*>\s*CURRENT_TIMESTAMP/, '');
    const r = wouldTrade(AFTER, NOW, ADPT_LONG, noExpiry);
    assert.notStrictEqual(r.row._control_id, 'po_halt_20260813_entries_off');
    assert.strictEqual(r.allowed, true, 'a future reader written without the expiry clause is no longer fatal');
  });

  check('PG-08', 'no row anywhere may be dated past its own expiry — that is the invariant', () => {
    for (const r of AFTER) {
      assert.ok(Date.parse(r.checked_at) <= Date.parse(r.expires_at),
        `${r.control_id} outlives its priority window: checked_at ${r.checked_at} > expires_at ${r.expires_at}`);
    }
    assert.ok(Date.parse(ROWS.po_halt_before.checked_at) > Date.parse(ROWS.po_halt_before.expires_at),
      'the pre-fix row must violate it, or PG-08 is not testing anything');
  });

  console.log('\n═══ but a LIVE halt still stops entries dead ═══\n');

  check('PG-09', 'a real halt written the gov215 way outranks AFTO and blocks the entry', () => {
    // checked_at = expires_at = 30 days out, exactly what the kill-switch monitor writes.
    const liveHalt = { control_id: 'qtp_ks_live', source: 'qtp-expansion-killswitch-monitor',
      status: 'EXPANSION_CUMULATIVE_HALT', pause_new_entries: true, trading_blocked: false,
      checked_at: '2026-09-16T16:35:00.000Z', expires_at: '2026-09-16T16:35:00.000Z',
      reason: 'cumulative loss limit breached' };
    const r = wouldTrade([...AFTER, liveHalt], NOW, ADPT_LONG);
    assert.strictEqual(r.row._control_id, 'qtp_ks_live', 'a live halt must still win the ordering');
    assert.strictEqual(r.allowed, false, 'THE HALT MECHANISM STILL WORKS — this is the check that matters most');
    assert.ok(r.verdict._pause_guard_reason.includes('cumulative loss limit breached'));
  });

  check('PG-10', 'an exit is never blocked, even under a live halt — a position can always get out', () => {
    const liveHalt = { control_id: 'qtp_ks_live', source: 'qtp-expansion-killswitch-monitor',
      status: 'EXPANSION_CUMULATIVE_HALT', pause_new_entries: true, trading_blocked: false,
      checked_at: '2026-09-16T16:35:00.000Z', expires_at: '2026-09-16T16:35:00.000Z', reason: 'halt' };
    const exit = { symbol: 'ADPT', side: 'SELL', action: 'SELL_TO_CLOSE' };
    const r = wouldTrade([...AFTER, liveHalt], NOW, exit);
    assert.strictEqual(r.verdict._pause_guard_action, 'BYPASS_PROTECTIVE_OR_CLOSING');
    assert.strictEqual(r.allowed, true, 'stranding a live position is the one unacceptable failure');
  });

  check('PG-11', 'NEGATIVE CONTROL: put the future date back and PG-04/PG-08 must bite', () => {
    const regressed = [...ROWS.afto_nominal, ROWS.po_halt_before];
    const noExpiry = SQL.replace(/WHERE\s+expires_at\s*>\s*CURRENT_TIMESTAMP/, '');
    assert.strictEqual(wouldTrade(regressed, NOW, ADPT_LONG, noExpiry).allowed, false,
      'the sabotage must still block — otherwise PG-07 proves nothing');
    assert.throws(() => {
      for (const r of regressed) {
        assert.ok(Date.parse(r.checked_at) <= Date.parse(r.expires_at), 'invariant');
      }
    }, /invariant/, 'PG-08 must fail on the pre-fix rows or it is decoration');
  });

  check('PG-12', 'an empty table means TRADE, not halt — absence of a row is not a halt', () => {
    const r = wouldTrade([], NOW, ADPT_LONG);
    assert.strictEqual(r.row.status, 'NO_ACTIVE_PAUSE');
    assert.strictEqual(r.row.pause_new_entries, false, 'the COALESCE default must stay false');
    assert.strictEqual(r.allowed, true);
  });

  check('PG-13', 'a database failure kills the branch — it never trades blind past a pause it could not read', () => {
    const pg = NODES.nodes.find((n) => n.name === 'Query Supabase Pause Guard');
    assert.ok(pg, 'the pause-reading Postgres node vanished from the workflow');
    assert.strictEqual(pg.alwaysOutputData, null,
      'alwaysOutputData was turned ON: a 0-row/failed read would now emit an empty item and the ' +
      'COALESCE defaults would read as NO_ACTIVE_PAUSE — i.e. fail-OPEN past an unreadable pause table');
    assert.strictEqual(pg.onError, null, 'onError left unset = stopWorkflow = fail-closed. Keep it that way.');
    assert.strictEqual(NODES.activeVersionId, 'a4358cbe-78c0-48e4-a485-e53f1e835a24');
  });

  console.log(`\n  ${passed}/${passed + failed} checks passed\n`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('HARNESS FAILURE:', e); process.exit(1); });
