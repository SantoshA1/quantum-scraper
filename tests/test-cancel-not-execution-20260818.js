#!/usr/bin/env node
'use strict';
/**
 * Maya regression guard — a cancelled order is not an execution (gov 226, 2026-08-18).
 *
 * Maya asks: "ECL never became a position — the order was cancelled 12 seconds after it was
 * placed — and your audit table says EXECUTED, and your daily entry cap counted it. Prove
 * FROM THE DEPLOYED BYTES that (a) the old code really does stamp EXECUTED on a cancel — on
 * the exact item shape ECL produced, not a convenient one; (b) the new code refuses, and
 * names the reason in blocked_stage; (c) a REAL fill still lands EXECUTED byte-for-byte as
 * before, because if you break fill accounting to fix cancel accounting I have gained
 * nothing; (d) TE-C4 skips and risk blocks are covered too, not just the 12-second cancel;
 * and (e) the daily-cap counter that reads EXECUTED rows therefore stops counting ghosts."
 *
 * Deterministic + offline. Fixtures are the real `QTP Late Exec Flow Audit Builder` jsCode of
 * workflow vaqfCaELhOEWnkdo (active a4358cbe): `late-audit-deployed.js` is what is live
 * (sha fc027a51…) and `late-audit-patched.js` is the gov-226 candidate (sha e0143ab8…).
 * The node body is EXECUTED against real item shapes; assertions are on the SQL it emits,
 * plus a literal evaluation of the finalize CASE the way Postgres would take it.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FIX = path.join(__dirname, '..', 'docs', 'cancel-exec-20260818');
const BEFORE = fs.readFileSync(path.join(FIX, 'late-audit-deployed.js'), 'utf8');
const AFTER = fs.readFileSync(path.join(FIX, 'late-audit-patched.js'), 'utf8');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

let passed = 0, failed = 0;
function check(id, name, fn) {
  try { fn(); console.log(`  ✅ ${id}  ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${id}  ${name}\n        ${e.message}`); failed++; }
}

// ── execute the real node body ────────────────────────────────────────────────
function run(src, itemJson) {
  const $input = { first: () => ({ json: itemJson }) };
  const fn = new Function('$input', src);
  return fn($input)[0].json;
}
const sqlOf = (src, item) => run(src, item)._late_audit_sql;

/**
 * Evaluate the finalize CASE exactly as Postgres would, for a row currently
 * (audit_status='PENDING', blocked_stage=<given>). Legs are read from the generated SQL.
 */
function finalStatus(sql, preBlockedStage) {
  const caseBlock = sql.match(/audit_status\s*=\s*\(\s*CASE([\s\S]*?)END\s*\)::quantum\.audit_status_enum/);
  assert.ok(caseBlock, 'finalize CASE not found in generated SQL');
  const legs = caseBlock[1];
  // leg 1: already REJECTED — our row is PENDING, skip.
  // leg 2: COALESCE(blocked_stage, '<late>') NOT IN ('NONE','UNKNOWN','')
  const late = (legs.match(/COALESCE\(blocked_stage, '([^']*)'\) NOT IN/) || [])[1];
  const effective = preBlockedStage != null ? preBlockedStage : late;
  if (effective !== 'NONE' && effective !== 'UNKNOWN' && effective !== '') return 'REJECTED';
  // leg 3: '<risk>' IN ('RISK_HOLD','RISK_BLOCK','RISK_ERROR')
  const risk = (legs.match(/WHEN '([^']*)' IN \('RISK_HOLD','RISK_BLOCK','RISK_ERROR'\)/) || [])[1];
  if (['RISK_HOLD', 'RISK_BLOCK', 'RISK_ERROR'].includes(risk)) return 'REJECTED';
  // leg 4 (v4.1 only): WHEN TRUE/FALSE
  const lit = (legs.match(/WHEN (TRUE|FALSE) THEN 'REJECTED'/) || [])[1];
  if (lit === 'TRUE') return 'REJECTED';
  return 'EXECUTED';
}

// ── real item shapes, from today's production rows ───────────────────────────
// ECL 2026-08-18 09:55:45 — placed, unfilled in 12s, cancelled. Carried an order id.
// Late token on the real row read: bias_pass=UNKNOWN, risk fields not HOLD/BLOCK at node time.
const ECL_CANCEL = {
  ticker: 'ECL', alpaca_status: 'SKIPPED_NO_FILL_WITHIN_CAP',
  alpaca_order_id: '2a548577-0cf2-48b8-a7e3-514ffe48a63f',
  risk_status: 'WARN',
  _early_exec_flow_audit_gate_decision_preview: 'vc=PASS | bias_score=70 | bias=BIAS_PASS | blocked_stage=NONE | ssm_action=PASS',
};
// DASH 2026-08-18 09:45 — a real fill.
const DASH_FILL = {
  ticker: 'DASH', alpaca_status: 'PENDING_NEW', alpaca_order_id: 'ord-dash-1',
  _bias_filter_pass: true, risk_status: 'OK',
  _early_exec_flow_audit_gate_decision_preview: 'vc=PASS | bias=BIAS_PASS | blocked_stage=NONE',
};
const TEC4_SKIP = { ...ECL_CANCEL, ticker: 'WMB', alpaca_status: 'SKIPPED', alpaca_order_id: null };
const RISK_BLOCKED = { ...ECL_CANCEL, ticker: 'XYZ', alpaca_status: 'BLOCKED_RISK_GATE' };
const EXT_HOURS = { ...ECL_CANCEL, ticker: 'ABC', alpaca_status: 'EXT_HOURS_RISK_BLOCK' };

(async () => {
  console.log('\n═══ the bytes are the deployed bytes ═══\n');

  check('CE-01', 'fixtures are the live builder and the gov-226 candidate', () => {
    assert.strictEqual(sha(BEFORE), 'fc027a51f6cd4f9009b42f10861e46226f440dd56fedc8c7df102b069c58471a');
    assert.strictEqual(sha(AFTER), 'e0143ab830cd6314a5468edb772350be3adea6d402194b21bf5699cab12cd1d2');
  });

  check('CE-02', 'the patch only adds the cancel classification — no pre-existing line deleted but version+4', () => {
    const a = BEFORE.split('\n'), b = AFTER.split('\n');
    const removed = a.filter((l) => !new Set(b).has(l));
    // exactly these pre-existing lines are rewritten: version constant, the final_outcome
    // ternary (3 lines of it), and the blocked_stage SET line. Nothing else may vanish.
    const EXPECTED = [
      /^const LATE_AUDIT_VERSION = 'QTP_LATE_EXEC_FLOW_AUDIT_BUILDER_v4_/,
      /^const final_outcome = alpaca_order_id$/,
      /^\? 'FILLED_OR_NEW'$/,
      /^: \(item\.blocked_stage \|\| item\._blocked_stage \|\| 'BLOCKED_OR_REJECTED'\);$/,
      /^blocked_stage\s+= COALESCE\(blocked_stage, \$\{sqlText\(blockedStageLate\)\}\),$/,
    ];
    assert.strictEqual(removed.length, EXPECTED.length,
      `expected ${EXPECTED.length} rewritten lines, got ${removed.length}:\n${removed.join('\n')}`);
    removed.forEach((l, i) => assert.ok(EXPECTED[i].test(l.trim()),
      `unexpected deletion at ${i}: ${l.trim()}`));
    const OWNED = /v4\.1|gov 226|orderNotPlaced|notPlacedStage|apStatusStr|ORDER_NOT_PLACED_OR_CANCELLED|FILLED_OR_NEW|blocked_stage|final_outcome|LATE_AUDIT_VERSION|alpaca_order_id|^\/\/|^$/;
    const strays = b.filter((l) => !new Set(a).has(l)).filter((l) => !OWNED.test(l.trim()));
    assert.deepStrictEqual(strays, [], `lines added outside the fix:\n${strays.join('\n')}`);
  });

  console.log('\n═══ the bug is real: the live bytes stamp EXECUTED on ECL\'s cancel ═══\n');

  check('CE-03', 'REGRESSION WITNESS: live bytes + ECL item → finalize lands EXECUTED', () => {
    const sql = sqlOf(BEFORE, ECL_CANCEL);
    // the real row had blocked_stage='UNKNOWN' pre-update (bias fields absent on executor path)
    assert.strictEqual(finalStatus(sql, 'UNKNOWN'), 'EXECUTED',
      'this is the defect: a cancelled order finalized as an execution');
    assert.ok(sql.includes("COALESCE(blocked_stage, 'UNKNOWN')"), 'UNKNOWN is not blocking in v4');
    assert.ok(run(BEFORE, ECL_CANCEL)._late_audit_sql.includes('final_outcome=FILLED_OR_NEW') === false
      || sqlOf(BEFORE, ECL_CANCEL).includes('final_outcome=FILLED_OR_NEW'),
      'sanity: token present');
    assert.ok(sqlOf(BEFORE, ECL_CANCEL).includes('final_outcome=FILLED_OR_NEW'),
      'and the old token even calls the cancel FILLED_OR_NEW, because it carries an order id');
  });

  console.log('\n═══ the fix: refusals are REJECTED, and say why ═══\n');

  check('CE-04', 'ECL cancel → REJECTED with blocked_stage ENTRY_CANCELLED_NO_FILL', () => {
    const sql = sqlOf(AFTER, ECL_CANCEL);
    assert.strictEqual(finalStatus(sql, 'UNKNOWN'), 'REJECTED');
    assert.ok(sql.includes("WHEN TRUE THEN 'REJECTED'"), 'the explicit executor-refusal leg must fire');
    assert.ok(sql.includes("IN ('','NONE','UNKNOWN') THEN 'ENTRY_CANCELLED_NO_FILL'"),
      'blocked_stage must upgrade UNKNOWN to the named cause');
    assert.ok(sql.includes('final_outcome=ORDER_NOT_PLACED_OR_CANCELLED'));
    assert.ok(sql.includes('v4.1_CANCEL_IS_NOT_EXECUTION_20260818'), 'idempotency marker must be the new version');
  });

  check('CE-05', 'TE-C4 skip / risk block / ext-hours all covered, each with its own stage', () => {
    for (const [item, stage] of [[TEC4_SKIP, 'ENTRY_SKIPPED_EXECUTOR'],
      [RISK_BLOCKED, 'ENTRY_BLOCKED_EXECUTOR'], [EXT_HOURS, 'ENTRY_BLOCKED_EXECUTOR']]) {
      const sql = sqlOf(AFTER, item);
      assert.strictEqual(finalStatus(sql, 'UNKNOWN'), 'REJECTED', `${item.alpaca_status} not rejected`);
      assert.ok(sql.includes(`THEN '${stage}'`), `${item.alpaca_status} → expected stage ${stage}`);
    }
  });

  console.log('\n═══ a real fill is untouched ═══\n');

  check('CE-06', 'DASH fill → EXECUTED, blocked_stage NONE, same as the live bytes', () => {
    const a = sqlOf(AFTER, DASH_FILL), b = sqlOf(BEFORE, DASH_FILL);
    assert.strictEqual(finalStatus(a, null), 'EXECUTED');
    assert.strictEqual(finalStatus(b, null), 'EXECUTED');
    assert.ok(a.includes("WHEN FALSE THEN 'REJECTED'"), 'the new leg must be inert on fills');
    assert.ok(a.includes("COALESCE(blocked_stage, 'NONE')"), 'fill path keeps the plain COALESCE');
    assert.ok(a.includes('final_outcome=FILLED_OR_NEW'));
  });

  check('CE-07', 'a genuinely REJECTED row can never be flipped by either version', () => {
    for (const src of [BEFORE, AFTER]) {
      const sql = sqlOf(src, DASH_FILL);
      assert.ok(/WHEN audit_status = 'REJECTED' THEN 'REJECTED'/.test(sql),
        'the never-downgrade leg must stay first');
    }
  });

  check('CE-08', 'missing/normal alpaca_status shapes never throw and never classify as refusal', () => {
    for (const ap of [null, undefined, '', 'N/A', 'FILLED', 'ACCEPTED', 'NEW', 'PARTIALLY_FILLED']) {
      const out = run(AFTER, { ...DASH_FILL, alpaca_status: ap });
      assert.ok(out._late_audit_sql.includes("WHEN FALSE THEN 'REJECTED'"),
        `refusal leg wrongly armed on alpaca_status=${JSON.stringify(ap)}`);
    }
  });

  console.log('\n═══ and the daily cap stops counting ghosts ═══\n');

  check('CE-09', 'the Gate-K wrapper counts audit_status=EXECUTED — so the fix IS the cap fix', () => {
    // Pinned from the deployed QET Kelly SQL Build (workflow vaqfCaELhOEWnkdo, a4358cbe):
    // exec_today  = count(*) WHERE audit_status='EXECUTED' AND ts >= today (ET)
    // sell_today  = same + side='SELL'
    // This check documents the coupling; if the wrapper ever stops counting EXECUTED rows,
    // revisit whether this suite still guards the cap.
    const wrapper = fs.readFileSync(path.join(__dirname, '..', 'docs', 'cancel-exec-20260818', 'kelly-wrapper-excerpt.txt'), 'utf8');
    assert.ok(wrapper.includes("WHERE audit_status = 'EXECUTED'"), 'wrapper no longer counts EXECUTED — re-derive');
    assert.ok(wrapper.includes('AS exec_today'));
  });

  check('CE-10', 'NEGATIVE CONTROL: run the OLD bytes through CE-04 and it must fail', () => {
    const sql = sqlOf(BEFORE, ECL_CANCEL);
    assert.notStrictEqual(finalStatus(sql, 'UNKNOWN'), 'REJECTED',
      'if the old bytes already reject, CE-03/CE-04 prove nothing');
    assert.ok(!sql.includes('ENTRY_CANCELLED_NO_FILL'));
  });

  console.log(`\n  ${passed}/${passed + failed} checks passed\n`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('HARNESS FAILURE:', e); process.exit(1); });
