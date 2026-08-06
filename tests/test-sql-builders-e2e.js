#!/usr/bin/env node
'use strict';
/**
 * Maya regression guard — end-to-end sandbox execution of the SIX deployed fixed builders
 * (docs/sql-builders-20260806/*-v*.js, byte-identical to live n8n jsCode) with POISON inputs.
 *
 * Maya asks: "The unit suite proves the helpers. Now run my ACTUAL node code — the bytes
 * that are live — feed each one the nastiest input we've seen (a broker 422 body, quotes,
 * $1 amounts, NUL, a broken emoji), and show me every builder still emits structurally
 * intact SQL whose payloads decode. If someone edits a node without the suite, this catches
 * the drift."
 *
 * Deterministic + offline (assertions avoid the Date.now/Math.random trace-id parts).
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { pgUnquoteStandard } = require('../lib/tsm/audit_sql');

let passed = 0, failed = 0;
function check(id, name, fn) {
  try { fn(); console.log(`  ✅ ${id}  ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${id}  ${name}  — ${e.message}`); failed++; }
}
const POISON = 'Request failed with status code 422 - {"code":42210000,"message":"stop price must be less than current price"} $1 ${x} \uD800 O\'Brien';
const DIR = path.join(__dirname, '..', 'docs', 'sql-builders-20260806');
const run = (file, globals) => {
  const code = fs.readFileSync(path.join(DIR, file), 'utf8');
  const g = { require, ...globals };  // n8n Code nodes expose require for built-ins
  const names = Object.keys(g);
  return new Function(...names, code)(...names.map((n) => g[n]));
};
const decodeAll = (sql) => {
  let m, n = 0;
  const re = /quantum\.safe_jsonb\('((?:[^']|'')*)'\)/g;
  while ((m = re.exec(sql)) !== null) {
    JSON.parse(pgUnquoteStandard("'" + m[1] + "'"));
    assert.ok(!m[1].includes('$'), 'jsonb literal must carry no $ at all');
    n++;
  }
  return n;
};
// NOTE: $ handling in plain-TEXT columns is preserved per node's HISTORICAL behavior
// (scalp/VC never defanged; ingestor/10FC/thesis keep theirs). The fixed surface — and what
// decodeAll enforces — is the jsonb path: zero $ characters, always decodable.

check('E2E-01', 'scalp v1.4: poison close-status batch (events + order_events) intact, 3 guarded payloads decode', () => {
  const rows = [
    { run_id: 'r1', symbol: 'WRB', position_side: 'LONG', quantity: 148, action: 'PAPER_CLOSE_SUBMITTED',
      alpaca_close_status: POISON, alpaca_close_order_id: 'ord-1', idempotency_key: 'k1', paper_only: true,
      live_alpaca_trading_allowed: false, reasons: ['held>60m', "O'Brien's rule"] },
    { run_id: 'r1', symbol: 'AES', action: 'HOLD', reason: 'protected', paper_only: true },
  ];
  const out = run('scalp-audit-v1.4.js', { $input: { all: () => rows.map(j => ({ json: j })) } });
  const sql = out[0].json.__supabase_scalp_exit_audit_sql;
  assert.ok(sql.includes('INSERT INTO quantum.scalp_exit_watch_events'));
  assert.ok(sql.includes('INSERT INTO quantum.order_events'), 'close row emits order event');
  assert.strictEqual(decodeAll(sql), 3);
  assert.ok(sql.includes('QTP_SCALP_EXIT_AUDIT_BUILDER_v1.4_20260806'));
});
check('E2E-02', 'ingestor v1.3: poison order + nested leg land, heartbeat always present, real $1 preserved in payload', () => {
  const orders = [
    { id: 'o1', status: 'rejected', updated_at: '2026-08-06T14:00:00Z', symbol: 'WRB', side: 'buy', type: 'stop',
      time_in_force: 'day', qty: '148', reject_reason: POISON, legs: [
        { id: 'o1b', status: 'canceled', updated_at: '2026-08-06T14:00:01Z', symbol: 'WRB', side: 'sell', type: 'limit', qty: '148' }] },
    { id: 'o2', status: 'filled', updated_at: '2026-08-06T14:01:00Z', symbol: 'XPEV', side: 'sell', type: 'market', qty: '858', filled_avg_price: '11.59' },
  ];
  const out = run('ingestor-lifecycle-v1.3.js', { $input: { all: () => orders.map(j => ({ json: j })) } });
  const sql = out[0].json.__supabase_insert_sql;
  assert.ok(sql.startsWith('WITH ins AS (INSERT INTO quantum.order_events'));
  assert.ok(sql.includes('quantum.ingest_heartbeat'));
  assert.ok(sql.includes("'v1.3'"));
  assert.strictEqual(decodeAll(sql), 3, 'incl. nested leg');
  assert.ok(!/\$\d/.test(sql) && !/\$\{/.test(sql), 'ingestor keeps its full $-defang on text');
  const rej = sql.match(/quantum\.safe_jsonb\('((?:[^']|'')*)'\)/);
  const p = JSON.parse(pgUnquoteStandard("'" + rej[1] + "'"));
  assert.ok(p.reject_reason.includes('$1'), 'real $1 preserved in stored payload');
});
check('E2E-03', '10FC v4.2.3: hostile blocked_reason survives; fail-open output shape preserved', () => {
  const its = [{ json: { ticker: 'wrb', execution: 'BUY', score: 88, _sm_action: 'ROUTE', _blocked_reason: POISON, _vc_feedback: 'watch "gap" risk\nline2' } }];
  const out = run('mp-10fc-trace-v4.2.3.js', { items: its, $execution: { id: '999' } });
  const sql = out[0].json._candidate_trace_sql;
  assert.ok(sql.includes('INSERT INTO quantum.candidate_path_trace_10fc'));
  assert.strictEqual(decodeAll(sql), 1);
  assert.ok(!/\$\d/.test(sql) && !/\$\{/.test(sql), '10FC keeps its $-defangs on text');
  assert.ok(out[0].json._10fc_trace_logged === true);
});
check('E2E-04', 'VC audit v4.2.2: LLM poison feedback survives, ON CONFLICT idempotency intact', () => {
  const its = [{ json: { ticker: 'WRB', _vc_score: 55, _vc_verdict: 'CAUTION', _vc_feedback: POISON, signal: 'BUY ' + POISON } }];
  const out = run('mp-vc-audit-v4.2.2.js', { items: its });
  const sql = out[0].json.__supabase_backtest_audit_sql;
  assert.ok(sql.includes('INSERT INTO quantum.vc_gate_forensics_shadow'));
  assert.ok(sql.includes('ON CONFLICT (idempotency_key) DO NOTHING'));
  assert.strictEqual(decodeAll(sql), 1);
});
check('E2E-05', 'PF_MARGIN v1.1: raw broker JSON with poison lands; is_dummy hard-guard intact', () => {
  const j = { _pfm_executor_status: 'ok', _pfm_route_mode: 'paper_fill', _pfm_flag_value: 'SHADOW',
    _pfm_symbol: 'WRB', _pfm_side: 'buy', _pfm_reason: 'gate ok', _pfm_executor_reason: POISON,
    _pfm_det_score: 0.8, _pfm_backtest_pf: 1.4,
    _pfm_executor_result: { filled_avg_price: '71.99', alpaca_order_id: 'a1', raw_submit_response: { err: POISON }, raw_final_order: { status: 'filled', legs: [{ note: 'q"q' }] } } };
  const out = run('mp-pfmargin-v1.1.js', { $input: { first: () => ({ json: j }) } });
  const sql = out[0].json._pfm_sql;
  assert.ok(sql.includes('INSERT INTO quantum.experiment_paper_trades'));
  assert.ok(sql.includes("CASE WHEN 'SHADOW' = 'LIVE' THEN false ELSE true END"));
  assert.strictEqual(decodeAll(sql), 1);
  assert.ok(!/\$\d/.test(sql));
});
check('E2E-06', 'thesis v1.1: $3/$580 preserved inside jsonb, /$digit/ refusal guard green, lone surrogate cleaned', () => {
  const verdict = { market_regime: 'CHOP', regime_confidence: 0.6, regime_rationale: 'mixed "tape", target $3 zone',
    spy_view: "SPY pins near $580; O'Brien's level holds", sector_tilts: [{ sector: 'Tech', tilt: 'neutral', note: 'watch $NVDA $1 moves' }],
    names: [{ symbol: 'WRB', stance: 'avoid', confidence: 0.5, bull_case: 'b', bear_case: POISON, judge_note: 'n' }] };
  const shimNode = (name) => ({ first: () => ({ json: name === 'Build Crew Prompts'
    ? { trading_date: '2026-08-06', symbols: ['WRB'], yesterday_sides: {}, degradations: [] }
    : { bull_text: 'bull $2 case', bear_text: 'bear\ncase', judge_user: 'x' } }) });
  const out = run('thesis-prepare-v1.1.js', {
    $input: { first: () => ({ json: { text: JSON.stringify(verdict) } }) },
    $: shimNode, $now: { setZone: () => ({ toFormat: (f) => (f === 'yyyy-MM-dd' ? '2026-08-06' : '20260806_0830'), weekday: 4 }) },
  });
  const sql = out[0].json.insert_sql;
  assert.ok(sql.includes('INSERT INTO quantum.daily_research_thesis'));
  assert.strictEqual(decodeAll(sql), 3, 'sector_tilts + names + raw_payload all guarded');
  assert.ok(!/\$\d/.test(sql), 'the workflow refusal guard passes');
  const lits = [...sql.matchAll(/quantum\.safe_jsonb\('((?:[^']|'')*)'\)/g)];
  const names = JSON.parse(pgUnquoteStandard("'" + lits[1][1] + "'"));
  assert.ok(names[0].bear_case.includes('$1') && names[0].bear_case.includes("O'Brien"), 'real dollars + quotes preserved');
  assert.ok(names[0].bear_case.includes('�') && !names[0].bear_case.includes('\uD800'), 'lone surrogate cleaned');
});

console.log(`\n  ${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
