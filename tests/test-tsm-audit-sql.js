#!/usr/bin/env node
'use strict';
/**
 * Maya regression guard — TSM audit SQL builder (QTP_TSM_AUDIT_SQL_v4_2_2_20260806).
 *
 * Maya asks: "This morning a broker error message — just TEXT about a stop price — killed
 * the ENTIRE cycle's audit batch, and my XPEV tier advance vanished with it. You told me
 * the audit trail is how we catch money bugs; today the audit trail itself was the bug.
 * Reproduce EXACTLY what died at 13:45, prove the same payload now lands, prove a payload
 * from hell — quotes, backslashes, newlines, NULs, broken emoji, a whole JSON error body —
 * can never kill a batch again, and prove one poisoned row never takes out its neighbors."
 *
 * Deterministic + offline. Fixtures are the REAL exec-524111 builder inputs (reconstructed
 * from the captured failing SQL preserved in the execution record). The Postgres side is
 * simulated with a standard_conforming_strings=on literal decoder + JSON.parse, which agree
 * with jsonb on this defect class; the \u0000/lone-surrogate jsonb rejections are asserted
 * as never-emitted instead.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const A = require('../lib/tsm/audit_sql');

let passed = 0, failed = 0;
function check(id, name, fn) {
  try { fn(); console.log(`  ✅ ${id}  ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${id}  ${name}  — ${e.message}`); failed++; }
}

// ── the REAL exec-524111 cycle, reconstructed byte-for-byte ────────────────────
const ORPHAN = (sym, side, qty, entry, coid) => ({
  type: 'ORPHAN_ELIGIBLE_WINDOW_CLOSED', sym, side, qty, entry, activeStops: 1, recoveryStops: 1,
  recoveryClientOrderIds: [coid], marketOpen: true, carryoverWindow: false,
  note: 'orphan-reachable; flatten deferred until carryover window + market open',
  version: 'QTP_TSM_ORPHAN_FLATTEN_v4.3.4_20260709',
});
const WRB_422 = 'Request failed with status code 422 - {"code":42210000,"market_price":"71.99","message":"stop price must be less than current price","stop_price":"72.4"}';
const EXEC_524111_ROWS = [
  ORPHAN('ALLE', 'long', 64, 165.87, 'qtp_widestop_alle_1a4c4fc1'),
  ORPHAN('DGX', 'long', 45, 234.82, 'qtp_widestop_dgx_9d691dd7'),
  ORPHAN('XPEV', 'short', 858, 12.415003, 'qtp_widestop_xpev_a24b9a15'),
  { type: 'OCO_PROTECTED_AUDIT_SAFE', sym: 'AES', side: 'short', qty: 731, protectedQty: 731,
    nestedStopCount: 1, stopDistancePct: 0.0082, action: 'NO_ORDER_PLACED_ALREADY_PROTECTED',
    version: 'QTP_TSM_HELD_BRACKET_STOP_VISIBILITY_v4.2.6' },
  { type: 'UNPROTECTED_STOP_TOO_WIDE', sym: 'WRB', side: 'long', qty: 148, entry: 73.05527,
    current: 72.085, stopDistancePct: 0.0305, maxAllowedPct: 0.012, proposedStop: 72.4, nestedStopCount: 1,
    recovery: { type: 'STOP_TOO_WIDE_RECOVERY_FAILED_REVIEW_REQUIRED', sym: 'WRB', error: WRB_422,
      cancelled: ['4c1cc11d-2b1f-43d7-859d-7aeb453f0a3a'], cancelErrors: [],
      recoveryKey: 'stop_too_wide_recovery:WRB:e121c221' },
    requiresManualReview: true, version: 'QTP_TSM_STOPWIDTH_EOD403_v4.3.0_20260706' },
  { sym: 'XPEV', tier: 1, tierLabel: 'Breakeven + Scale Out', oldStop: 12.53, newStop: 12.47,
    entry: 12.415003, current: 11.59, atr: 0.53, gain: 0.83, gainPct: 6.69 },
];
const CTX = { executionId: '524111', workflowId: 'vFnPjyx8srnzcYgV', workflowName: 'Trailing Stop Manager v2.0 (credential-migrated)' };
const legacy = A.buildAuditSql(EXEC_524111_ROWS, CTX, { legacyEsc: true });
const fixed = A.buildAuditSql(EXEC_524111_ROWS, CTX);
// decode literal exactly as Postgres does under standard_conforming_strings=on
const decodePayload = (sql, idx) => A.pgUnquoteStandard(A.extractPayloadLiteral(sql, idx));

// ── reproduce this morning's kill, byte-anchored to the captured SQL ───────────
check('AUD-01', "REPRO 13:45 exec 524111: v4.2.1 turns WRB's 422 body into \\\\\" — jsonb parse dies, batch dies", () => {
  const lit = A.extractPayloadLiteral(legacy.sql, 4);
  assert.ok(lit.includes('{\\\\"code\\\\":42210000'), 'byte-anchor to the captured failing SQL');
  assert.throws(() => JSON.parse(decodePayload(legacy.sql, 4)), 'the exact production failure, offline');
});
check('AUD-02', 'the fix: the SAME WRB payload now decodes to valid JSON with the 422 body INTACT — and XPEV tier-1 lands with it', () => {
  const wrb = JSON.parse(decodePayload(fixed.sql, 4));
  assert.strictEqual(wrb.recovery.error, WRB_422, 'broker error text preserved byte-for-byte');
  assert.strictEqual(wrb.recovery.recoveryKey, 'stop_too_wide_recovery:WRB:e121c221');
  const xpev = JSON.parse(decodePayload(fixed.sql, 5));
  assert.strictEqual(xpev.tier, 1);
  assert.strictEqual(xpev.atr, 0.53, 'the lost tier-1 evidence now survives its neighbor');
});
check('AUD-03', 'identity continuity: audit_ids/idempotency keys byte-match the lost batch (recovery inserts the same identities)', () => {
  for (const id of ['tsm_1240207f_0', 'tsm_3b149d97_1', 'tsm_0bb9f924_2', 'tsm_37c7a739_3', 'tsm_36e3aab3_4', 'tsm_4c25c648_5']) {
    assert.ok(fixed.sql.includes("('" + id + "',"), id);
  }
  assert.ok(fixed.sql.includes("'tsm:524111:5:XPEV:TRAILING_STOP_MANAGER_RUN'"));
});

// ── the payload from hell can never kill a batch again ─────────────────────────
const hostile = (payload) => A.buildAuditSql([{ sym: 'EVIL', type: 'HOSTILE', ...payload }], CTX);
check('AUD-04', "single quotes can't break out: O'Brien's '); DROP TABLE stays INSIDE the literal", () => {
  const t = hostile({ note: "O'Brien's '); DROP TABLE quantum.audit_trail;--" });
  const p = JSON.parse(decodePayload(t.sql, 0));
  assert.strictEqual(p.note, "O'Brien's '); DROP TABLE quantum.audit_trail;--");
  // lex the SQL exactly as standard_conforming_strings=on does; the attacker's text must
  // never survive OUTSIDE a quoted literal
  const outside = t.sql.replace(/'(?:[^']|'')*'/g, '<lit>');
  assert.ok(!outside.includes('DROP TABLE'), 'attacker text never lands outside a literal');
  assert.ok(!outside.includes("'"), 'no unbalanced quote remains after lexing');
});
check('AUD-05', 'backslash tortures round-trip byte-equal: C:\\path, \\\\server\\share, regex \\d+\\.\\d, literal text "\\u0000"', () => {
  const vals = ['C:\\path\\to\\file', '\\\\server\\share', '\\d+\\.\\d', '\\u0000 as plain text'];
  const t = hostile({ a: vals[0], b: vals[1], c: vals[2], d: vals[3] });
  const p = JSON.parse(decodePayload(t.sql, 0));
  assert.deepStrictEqual([p.a, p.b, p.c, p.d], vals, 'v4.2.1 doubled every one of these');
});
check('AUD-06', 'real newline/tab/CR in a broker message round-trip EXACTLY (v4.2.1 silently corrupted them to \\n text)', () => {
  const msg = 'line1\nline2\ttabbed\rcarriage';
  const t = hostile({ error: msg });
  assert.strictEqual(JSON.parse(decodePayload(t.sql, 0)).error, msg);
  const legacyT = A.buildAuditSql([{ sym: 'EVIL', type: 'HOSTILE', error: msg }], CTX, { legacyEsc: true });
  assert.notStrictEqual(JSON.parse(decodePayload(legacyT.sql, 0)).error, msg, 'the old silent corruption, made visible');
});
check('AUD-07', 'NUL and lone surrogates -> U+FFFD; valid emoji pairs untouched; no \\u0000 or unpaired escape ever reaches jsonb', () => {
  const t = hostile({ nul: 'a\u0000b', hi: 'x\uD800y', lo: 'z\uDC00', pair: 'ok\uD83D\uDE00ok', tailHi: 'end\uD800' });
  const text = decodePayload(t.sql, 0);
  assert.ok(!/\\u0000/i.test(text), 'jsonb rejects \\u0000 — must never be emitted');
  assert.ok(!/\\u[dD][89a-fA-F]/.test(text), 'jsonb rejects surrogate escapes — must never be emitted');
  const p = JSON.parse(text);
  assert.strictEqual(p.nul, 'a\uFFFDb');
  assert.strictEqual(p.hi, 'x\uFFFDy');
  assert.strictEqual(p.lo, 'z\uFFFD');
  assert.strictEqual(p.pair, 'ok\uD83D\uDE00ok', 'well-formed emoji survives');
  assert.strictEqual(p.tailHi, 'end\uFFFD');
});
check('AUD-08', 'circular payload degrades to __stringify_error — the builder NEVER throws into the audit path', () => {
  const c = { sym: 'LOOP', type: 'CYCLE' }; c.self = c;
  const t = A.buildAuditSql([c], CTX);
  const p = JSON.parse(decodePayload(t.sql, 0));
  assert.ok(p.__stringify_error, 'degraded, not dead');
  assert.strictEqual(t.count, 1);
});
check('AUD-09', 'one poisoned row cannot take out its neighbors: every payload goes through quantum.safe_jsonb(), never a naked ::jsonb', () => {
  const t = A.buildAuditSql(EXEC_524111_ROWS.concat([{ sym: 'BAD', type: 'X', e: 'q"q\\¬\u0000' }]), CTX);
  const wrapped = (t.sql.match(/quantum\.safe_jsonb\('/g) || []).length;
  assert.strictEqual(wrapped, 7, 'all 7 rows wrapped');
  assert.ok(!t.sql.includes("::jsonb"), 'no unguarded cast remains anywhere in the batch');
});
check('AUD-10', 'hostile eventType (broker error as r.message) is truncated to 80 and cannot poison idempotency keys', () => {
  const long = 'ERR ' + WRB_422 + ' ' + WRB_422;
  const t = A.buildAuditSql([{ sym: 'WRB', message: long }], CTX);
  const m = t.sql.match(/'tsm:524111:0:WRB:((?:[^']|'')*)'/);
  assert.ok(m, 'idem key present');
  assert.ok(m[1].replace(/''/g, "'").length <= 84, 'event type bounded inside the key');
  assert.ok(JSON.parse(decodePayload(t.sql, 0)).message === long, 'payload still carries the FULL message');
});

// ── unchanged behavior where v4.2.1 was right ──────────────────────────────────
check('AUD-11', 'zero-diff for clean payloads: escaping byte-identical to v4.2.1, same ids, same idem scheme', () => {
  const cleanJson = JSON.stringify(EXEC_524111_ROWS[3]);
  assert.strictEqual(A.esc(cleanJson), A.escLegacy(cleanJson), 'no specials -> identical escaping');
  const l = A.buildAuditSql([EXEC_524111_ROWS[3]], CTX, { legacyEsc: true });
  const f = A.buildAuditSql([EXEC_524111_ROWS[3]], CTX);
  const idOf = (sql) => sql.match(/\('(tsm_[0-9a-f]{8}_0)'/)[1];
  assert.strictEqual(idOf(l.sql), idOf(f.sql), 'audit_id continuity across the fix');
});
check('AUD-12', 'empty cycle still short-circuits to NO_ROWS (no empty INSERT ever emitted)', () => {
  assert.strictEqual(A.buildAuditSql([], CTX).sql, "SELECT 'NO_ROWS' AS audit_status;");
  assert.strictEqual(A.buildAuditSql(null, CTX).count, 0);
});
check('AUD-13', 'batch shape guard: 25-column list unchanged, trailing COUNT select, version bumped to v4.2.2 everywhere', () => {
  assert.strictEqual((A.COLUMNS.match(/,/g) || []).length, 24, '25 columns');
  assert.ok(fixed.sql.includes('INSERT INTO quantum.audit_trail'));
  assert.ok(fixed.sql.includes('SELECT COUNT(*)::int AS audit_rows_attempted'));
  assert.ok(fixed.sql.includes('QTP_SUPABASE_TRAILING_STOP_MANAGER_v4.2.2'));
  assert.ok(!fixed.sql.includes('v4.2.1'), 'no stale version strings');
  for (const r of JSON.parse(JSON.stringify(EXEC_524111_ROWS.map((x, i) => JSON.parse(decodePayload(fixed.sql, i)))))) {
    assert.strictEqual(r.migration_version, 'QTP_SUPABASE_TRAILING_STOP_MANAGER_v4.2.2');
  }
});
check('AUD-14', 'determinism: same cycle input -> byte-identical SQL (idempotent rebuild, safe to re-run for recovery)', () => {
  assert.strictEqual(A.buildAuditSql(EXEC_524111_ROWS, CTX).sql, fixed.sql);
});

// ── lockstep with the deployable node code ─────────────────────────────────────
check('AUD-15', 'deployed node code carries the EXACT esc/cleanStr/safeJson/hash32 bodies from this mirror (lockstep pin)', () => {
  const nodeSrc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'tsm-audit-sql-v4.2.2.js'), 'utf8');
  const libSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'tsm', 'audit_sql.js'), 'utf8');
  for (const fn of ['esc', 'cleanStr', 'safeJson', 'hash32']) {
    const m = libSrc.match(new RegExp('function ' + fn + '\\([\\s\\S]*?\\n(?=\\n|/\\*\\*|const|function|module)'));
    assert.ok(m, 'lib source for ' + fn);
    assert.ok(nodeSrc.includes(m[0].trim()), 'node code must embed lib ' + fn + ' verbatim');
  }
  assert.ok(nodeSrc.includes('quantum.safe_jsonb('), 'node uses the guarded cast');
  assert.ok(!nodeSrc.includes("::jsonb"), 'node has no naked cast');
  assert.ok(nodeSrc.includes('QTP_SUPABASE_TRAILING_STOP_MANAGER_v4.2.2'));
});

console.log(`\n  ${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
