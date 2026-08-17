#!/usr/bin/env node
'use strict';
/**
 * Maya regression guard — the Terminal Audit Write-Back (gov 217, 2026-08-14).
 *
 * Maya asks: "The audit table lied by omission for a month. Kills on two terminal
 * branches either froze at PENDING or left no row at all, so every attribution
 * number computed from that table under-counted. You closed both. Prove FROM THE
 * DEPLOYED BYTES that (a) each of the four terminal causes lands under its OWN name
 * and never under a gate it never reached, (b) nothing that arrives is ever silently
 * dropped, (c) a batch of five candidates produces five attributions, not one,
 * (d) the write can neither duplicate a row nor downgrade one that a real stage
 * already finalized, and (e) a hostile string can't rewrite my audit table."
 *
 * Deterministic + offline. The fixture is the LIVE jsCode of both new Code nodes in
 * workflow vaqfCaELhOEWnkdo, published version 8ddf1775 (both instances verified
 * byte-identical, sha256 9c60bd1b…). The builder is EXECUTED
 * here, not grepped. First production fire: exec 577728/577729 at 12:50 ET wrote
 * SSM_KILL rows for WMB/XOM duplicate-suppression kills — a kill class that had
 * never once appeared in quantum.exec_flow_audit.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FIX = path.join(__dirname, '..', 'docs', 'audit-writeback-20260814');
const CODE = fs.readFileSync(path.join(FIX, 'writeback-builder.js'), 'utf8');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

let passed = 0, failed = 0;
function check(id, name, fn) {
  try { fn(); console.log(`  ✅ ${id}  ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${id}  ${name}\n        ${e.message}`); failed++; }
}

// ── offline executor for the deployed Code-node body ────────────────────────
function build(items, execId) {
  const $input = { all: () => items.map((j) => ({ json: j })) };
  const $execution = { id: execId === undefined ? '577728' : execId };
  const fn = new Function('$input', '$execution', `return (function(){ ${CODE}\n })();`);
  return fn($input, $execution).map((o) => o.json);
}
const one = (item) => build([item])[0];

// ── fixtures drawn from real production items ───────────────────────────────
const PAUSE_KILL = {           // WRB 09:30 today: bias 100, killed by the gov-213 halt
  symbol: 'WRB', side: 'BUY', bias_score: 100,
  _sm_signal_id: 'WRB_5_20260814133016', _sm_idempotency_key: 'WRB_5_20260814133016',
  _pause_guard_action: 'BLOCK_NEW_ENTRY_ONLY', _pause_guard_live_order_allowed: false,
  _pause_guard_reason: 'QTP-10FC gov-213 manual entry halt',
  _sm_action: 'KILLED', _sm_route: 'SKIP',
};
const SCORE_KILL = {           // BMNR 12:45 today: bias 54, passed the pause, failed leg 2
  symbol: 'BMNR', side: 'SELL', bias_score: 54,
  _sm_signal_id: 'BMNR_5_20260814164509', _sm_idempotency_key: 'BMNR_5_20260814164509',
  _pause_guard_action: 'ALLOW_NEW_ENTRY', _pause_guard_live_order_allowed: true,
  _sm_action: 'PASS', _sm_route: 'FULL',
};
const SSM_KILL = {             // ARM 08-13: ATR>8%, produced NO audit row at all
  symbol: 'ARM', side: 'BUY', bias_score: 88,
  _sm_signal_id: 'ARM_5_20260813150000', _sm_idempotency_key: 'ARM_5_20260813150000',
  _sm_action: 'KILLED', _sm_route: 'SKIP',
  _sm_kill_stage_attribution: 'Extreme volatility: ATR 8.2% of price (> 8% — untradeable)',
};
const SSM_DUP = {              // WMB 12:50 today: the first row this fix ever wrote
  symbol: 'WMB', side: 'LONG', bias_score: 100,
  _sm_signal_id: 'WMB_5_20260814165008', _sm_idempotency_key: 'WMB_5_20260814165008',
  _sm_action: 'KILLED', _sm_route: 'SKIP',
  _sm_reason: 'Duplicate: WMB_5 already BUY/BULLISH (3599s ago)',
};

(async () => {
  console.log('\n═══ the bytes are the deployed bytes ═══\n');

  check('AW-01', 'fixture is sha256-identical to BOTH deployed builder instances (version 8ddf1775)', () => {
    assert.strictEqual(sha(CODE), '9c60bd1b8cea92098221d10b622535ffee186d659545708a366f84d75004fee3');
  });

  console.log('\n═══ every terminal cause lands under its own name ═══\n');

  check('AW-02', 'entry-pause block → ENTRY_PAUSE, carrying the pause reason', () => {
    const r = one(PAUSE_KILL);
    assert.strictEqual(r._audit_writeback_stage, 'ENTRY_PAUSE');
    assert.ok(r._audit_writeback_kill.includes('gov-213 manual entry halt'), r._audit_writeback_kill);
  });

  check('AW-03', 'bias 54 < 65 with the pause OPEN → PAUSE_GATE_SCORE, not ENTRY_PAUSE', () => {
    const r = one(SCORE_KILL);
    assert.strictEqual(r._audit_writeback_stage, 'PAUSE_GATE_SCORE');
    assert.ok(r._audit_writeback_kill.includes('bias_score=54'), r._audit_writeback_kill);
    assert.ok(!r._audit_writeback_kill.includes('ENTRY_PAUSE'));
  });

  check('AW-04', 'the two legs of ONE IF are told apart: pause wins when both could fire', () => {
    // a pause block whose score is also under 65 — the pause is the true cause
    const r = one({ ...PAUSE_KILL, bias_score: 41 });
    assert.strictEqual(r._audit_writeback_stage, 'ENTRY_PAUSE');
  });

  check('AW-05', 'SSM kill → SSM_KILL with the SSM reason (ARM ATR>8%: previously NO row at all)', () => {
    const r = one(SSM_KILL);
    assert.strictEqual(r._audit_writeback_stage, 'SSM_KILL');
    assert.ok(r._audit_writeback_kill.includes('ATR 8.2%'), r._audit_writeback_kill);
  });

  check('AW-06', 'SSM kill carrying a LOW score is never blamed on the score gate it never reached', () => {
    const r = one({ ...SSM_KILL, bias_score: 12 });
    assert.strictEqual(r._audit_writeback_stage, 'SSM_KILL',
      'a Route-Fast-Only out[1] item must not be attributed to the pause gate');
    assert.ok(!r._audit_writeback_kill.includes('PAUSE_GATE_SCORE'));
  });

  check('AW-07', 'duplicate suppression is attributed — the class that fired first in production', () => {
    const r = one(SSM_DUP);
    assert.strictEqual(r._audit_writeback_stage, 'SSM_KILL');
    assert.ok(r._audit_writeback_kill.includes('Duplicate: WMB_5'), r._audit_writeback_kill);
  });

  console.log('\n═══ nothing that arrives is ever dropped ═══\n');

  check('AW-07b', 'gov 219 short-side halt gets its OWN stage, not filed under ENTRY_PAUSE', () => {
    const r = one({ symbol: 'ZTS', side: 'SELL', bias_score: 74,
      _sm_signal_id: 'ZTS_5_20260817133000', _sm_idempotency_key: 'ZTS_5_20260817133000',
      _pause_guard_action: 'BLOCK_SHORT_ENTRY_ONLY', _pause_guard_live_order_allowed: false,
      _pause_guard_reason: 'gov 219 short-side halt: PF 0.2802', _sm_action: 'KILLED', _sm_route: 'SKIP' });
    assert.strictEqual(r._audit_writeback_stage, 'SHORT_SIDE_HALT',
      'a permanent strategy halt must never be conflated with a temporary manual pause');
    assert.ok(r._audit_writeback_kill.includes('PF 0.2802'), r._audit_writeback_kill);
    assert.strictEqual(one(PAUSE_KILL)._audit_writeback_stage, 'ENTRY_PAUSE',
      'a real gov-213-style entry pause must still read ENTRY_PAUSE');
  });

  check('AW-08', 'an unrecognised terminal item still produces a row, named UNROUTED_TERMINAL', () => {
    const r = one({ symbol: 'ZZZ', side: 'BUY', bias_score: 90, _sm_route: 'FULL', _sm_action: 'PASS' });
    assert.strictEqual(r._audit_writeback_stage, 'UNROUTED_TERMINAL');
    assert.ok(r.__audit_writeback_sql.includes('INSERT INTO quantum.exec_flow_audit'));
    assert.ok(r._audit_writeback_kill.includes('sm_route=FULL'), r._audit_writeback_kill);
  });

  check('AW-09', 'a bare item with no fields at all still produces a row, never an exception', () => {
    const r = one({});
    assert.strictEqual(r._audit_writeback_stage, 'UNROUTED_TERMINAL');
    assert.ok(r.__audit_writeback_sql.includes("'UNKNOWN'"), 'symbol/side fall back to UNKNOWN');
    assert.strictEqual(r._audit_writeback_mode, 'INSERT_DEDUPE_BY_SYMBOL_WINDOW', 'no key → dedupe on window');
    // v1.1: a MISSING score must never be laundered into "score kill, bias_score=0".
    // The gate does default it to 0 and kills it; the audit must say the input was gone.
    assert.ok(r._audit_writeback_kill.includes('score=ABSENT'), r._audit_writeback_kill);
    assert.ok(!r._audit_writeback_kill.includes('PAUSE_GATE_SCORE'));
    const scored = one({ bias_score: 0 });
    assert.strictEqual(scored._audit_writeback_stage, 'PAUSE_GATE_SCORE',
      'a real, present score of 0 IS a score kill — absent and zero are different facts');
  });

  console.log('\n═══ a batch of five is five attributions, not one ═══\n');

  check('AW-10', 'multi-item batch: every candidate gets its own SQL and its own stage', () => {
    // the real 09:30 batch was 4 symbols in one execution; the pre-existing
    // SKIP-branch builder reads $json and would have attributed only WRB.
    const out = build([PAUSE_KILL, SCORE_KILL, SSM_KILL, SSM_DUP, {}]);
    assert.strictEqual(out.length, 5, 'one output item per input item');
    assert.deepStrictEqual(out.map((r) => r._audit_writeback_stage),
      ['ENTRY_PAUSE', 'PAUSE_GATE_SCORE', 'SSM_KILL', 'SSM_KILL', 'UNROUTED_TERMINAL']);
    const keys = out.slice(0, 4).map((r) => r._audit_writeback_key);
    assert.strictEqual(new Set(keys).size, 4, 'each row must carry its OWN correlation key');
  });

  console.log('\n═══ the write cannot duplicate, downgrade, or be injected ═══\n');

  check('AW-11', 'keyed path: finalizes a PENDING row, and its INSERT is guarded by NOT EXISTS', () => {
    const sql = one(PAUSE_KILL).__audit_writeback_sql;
    assert.ok(sql.includes("a.idempotency_key = 'WRB_5_20260814133016' AND a.audit_status = 'PENDING'"),
      'the UPDATE must only ever touch a PENDING row — never downgrade a finalized one');
    assert.ok(/WHERE NOT EXISTS \(SELECT 1 FROM quantum\.exec_flow_audit a2 WHERE a2\.idempotency_key = 'WRB_5_20260814133016'\)/.test(sql),
      'the INSERT must be blocked whenever any row already exists for the key');
    assert.strictEqual((sql.match(/INSERT INTO quantum\.exec_flow_audit/g) || []).length, 1);
    assert.strictEqual((sql.match(/UPDATE quantum\.exec_flow_audit/g) || []).length, 1);
  });

  check('AW-12', 'an attribution already on the row always wins — COALESCE on every written column', () => {
    const sql = one(PAUSE_KILL).__audit_writeback_sql;
    for (const col of ['blocked_stage', 'kill_stage_attribution']) {
      assert.ok(new RegExp(`${col} = COALESCE\\(a\\.${col},`).test(sql), `${col} must be COALESCE-protected`);
    }
    assert.ok(sql.includes("gate_decision = COALESCE(a.gate_decision, '') ||"),
      'gate_decision is appended to, never replaced');
  });

  check('AW-13', 'unkeyed path dedupes on symbol + attribution inside a 10-minute window', () => {
    const sql = one({ symbol: 'NOKEY', side: 'SELL', _sm_route: 'SKIP', _sm_reason: 'x' }).__audit_writeback_sql;
    assert.ok(!sql.includes('UPDATE quantum.exec_flow_audit'), 'nothing to update without a key');
    assert.ok(sql.includes("a2.ts >= NOW() - INTERVAL '10 minutes'"));
    assert.ok(sql.includes("a2.symbol = 'NOKEY'"));
  });

  check('AW-14', 'a hostile string cannot escape its quotes anywhere it is written', () => {
    const nasty = "'); DROP TABLE quantum.exec_flow_audit; --";
    const r = one({ ...SSM_KILL, _sm_kill_stage_attribution: nasty, symbol: "A'B" });
    const sql = r.__audit_writeback_sql;
    // Scan the statement the way Postgres does: track whether each character sits
    // inside a single-quoted literal, honouring '' as an escaped quote. Then assert
    // every byte of the payload lands INSIDE a literal - the only proof that counts.
    const inLiteral = new Array(sql.length).fill(false);
    let i = 0, open = false;
    while (i < sql.length) {
      if (sql[i] === "'") {
        if (open && sql[i + 1] === "'") { inLiteral[i] = true; inLiteral[i + 1] = true; i += 2; continue; }
        inLiteral[i] = true; open = !open; i += 1; continue;
      }
      inLiteral[i] = open; i += 1;
    }
    assert.strictEqual(open, false, 'the statement must end with every quote closed');
    const needle = 'DROP TABLE quantum.exec_flow_audit';
    let at = sql.indexOf(needle), seen = 0;
    while (at !== -1) {
      seen += 1;
      for (let k = at; k < at + needle.length; k += 1) {
        assert.ok(inLiteral[k], 'injected payload escaped its literal at offset ' + k);
      }
      at = sql.indexOf(needle, at + 1);
    }
    assert.ok(seen > 0, 'the payload should still be present - as inert text, not stripped');
    assert.ok(sql.includes("''); DROP TABLE"), 'single quotes are doubled');
    assert.ok(sql.includes("'A''B'"), 'symbol quotes are doubled too');
    const bareSemis = [...sql].filter((c, k) => c === ';' && !inLiteral[k]).length;
    assert.strictEqual(bareSemis, 2, 'only the statement + status SELECT may end in a bare semicolon (saw ' + bareSemis + ')');
  });

  check('AW-15', 'the row is self-describing: version token and stage land in gate_decision', () => {
    const r = one(SSM_DUP);
    assert.ok(r.__audit_writeback_sql.includes('QTP_AUDIT_WRITEBACK_v1.2_gov217_20260814:SSM_KILL'),
      'the append token names the version AND the stage, so a backfill is never mistaken for an observation');
    assert.ok(r.__audit_writeback_sql.includes('branch=TERMINAL_WRITEBACK'));
    assert.strictEqual(r._audit_writeback_version, 'QTP_AUDIT_WRITEBACK_v1.2_gov217_20260814');
  });

  check('AW-16', 'observability only: the builder writes no table but exec_flow_audit and mutates no gate field', () => {
    const before = JSON.parse(JSON.stringify(SCORE_KILL));
    const r = one(SCORE_KILL);
    assert.deepStrictEqual(SCORE_KILL, before, 'the input item must not be mutated in place');
    for (const k of Object.keys(before)) {
      assert.deepStrictEqual(r[k], before[k], `pass-through field ${k} must be untouched`);
    }
    const tables = (r.__audit_writeback_sql.match(/(?:INTO|FROM|UPDATE)\s+([a-z_]+\.[a-z_]+)/g) || [])
      .map((s) => s.split(/\s+/).pop());
    assert.deepStrictEqual([...new Set(tables)], ['quantum.exec_flow_audit']);
  });

  console.log(`\n  ${passed}/${passed + failed} checks passed\n`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('HARNESS FAILURE:', e); process.exit(1); });
