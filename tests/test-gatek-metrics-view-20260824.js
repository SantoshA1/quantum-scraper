#!/usr/bin/env node
'use strict';
/**
 * Maya regression guard — the certified-metrics view IS the gate's own predicate
 * (gov 238, 2026-08-24).
 *
 * Maya asks: "Two mornings running, the scheduled check told me it could not verify my
 * Gate-K numbers because a .sql file lives on a laptop it cannot reach — and then it
 * guessed, and its guess hinted my tail winners had DROPPED. A guess about whether my
 * edge is decaying is worse than silence. You have now put the metrics in a database view
 * so any session can read them. Prove: (a) the view's WHERE clause reproduces EVERY
 * predicate the live compute_kelly_gate uses for its direction-scoped sample — clause by
 * clause, not 'looks similar'; (b) the one clause you deliberately left out (user_id)
 * provably cannot change a number today; (c) the view and the live function returned the
 * SAME n and PF when you ran them side by side; (d) the tail canary is data now, not a
 * proxy — and it says what the real numbers say, not what a guess said; and (e) if anyone
 * edits the gate's predicate without editing the view, this suite fails."
 *
 * Deterministic + offline over captured fixtures (docs/gatek-view-20260824/).
 *
 * FIELD LESSON (this suite, first run): three checks failed on HARNESS bugs, not on the
 * view — norm() strips ::interval so the interval regexes never matched, and the WHERE
 * splitter cut the first clause's column name off. Both would have read as "the view is
 * broken" and sent me chasing a healthy object. A parity suite must be validated against a
 * known-GOOD subject first (it was: live parity had already MATCHED) so that a red result
 * is evidence about the harness until proven otherwise.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FIX = path.join(__dirname, '..', 'docs', 'gatek-view-20260824');
const FN = fs.readFileSync(path.join(FIX, 'fn-sample-region-deployed.sql'), 'utf8');
const VIEW = fs.readFileSync(path.join(FIX, 'view-def-deployed.sql'), 'utf8');
const W = JSON.parse(fs.readFileSync(path.join(FIX, 'parity-witness-20260824.json'), 'utf8'));
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const norm = (s) => s.toLowerCase().replace(/::[a-z_]+/g, '').replace(/\s+/g, ' ');

let passed = 0, failed = 0;
async function check(id, name, fn) {
  try { await fn(); console.log(`  ✅ ${id}  ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${id}  ${name}\n        ${e.message}`); failed++; }
}

// Every predicate the live function applies to its direction-scoped sample.
// Each entry: [human label, regex that must match the NORMALISED view definition]
const REQUIRED_PREDICATES = [
  ['strategy = qtp-main-pipeline', /strategy = 'qtp-main-pipeline'/],
  ['mode = paper',                 /mode = 'paper'/],
  ['status = closed',              /status = 'closed'/],
  ['r_multiple IS NOT NULL',       /r_multiple is not null/],
  ['exit_fill_time >= now()-90d',  /exit_fill_time >= \(now\(\) - '90 days'\)/],
  ['entry_fill_time >= now()-90d', /entry_fill_time >= \(now\(\) - '90 days'\)/],
  ['quarantine excluded',          /coalesce\(t\.lineage_source, ''\) !~~ 'recert_quarantine%'/],
  ['risk_amount IS NOT NULL',      /risk_amount is not null/],
  ['risk_amount > 0',              /risk_amount > 0/],
  ['intended_stop IS NOT NULL',    /intended_stop is not null/],
  ['entry_fill_price IS NOT NULL', /entry_fill_price is not null/],
  ['direction CASE mapping',       /when t\.side = any \(array\['buy', 'buy_call', 'sell_put'\]\) then 'bullish'/],
];

(async () => {
  console.log('\n═══ fixtures are the live definitions, captured ═══\n');

  await check('GV-01', 'fixtures pinned by sha', () => {
    assert.strictEqual(sha(FN), '76ceea062ae8e330b106467586aa1e365a278c28d1e1fb1cbb0c0d2e389b3fac');
    assert.strictEqual(sha(VIEW), '4555b73351755eaa8a6e573d5448cbb29439e3d18856be2a0d1381cbe693e310');
    assert.strictEqual(sha(JSON.stringify(W)) .length, 64);
  });

  console.log('\n═══ (a) clause-by-clause predicate parity ═══\n');

  await check('GV-02', `all ${REQUIRED_PREDICATES.length} gate predicates appear in the view`, () => {
    const v = norm(VIEW);
    const missing = REQUIRED_PREDICATES.filter(([, re]) => !re.test(v)).map(([label]) => label);
    assert.deepStrictEqual(missing, [], `view is missing gate predicates: ${missing.join(', ')}`);
  });

  await check('GV-03', 'the function really does use each of those clauses (witness, not assumption)', () => {
    const f = norm(FN);
    for (const frag of ["status = 'closed'", 'r_multiple is not null', 'risk_amount is not null',
                        'risk_amount > 0', 'intended_stop is not null', 'entry_fill_price is not null',
                        "not like 'recert_quarantine%'"]) {
      assert.ok(f.includes(frag), `function fixture lost: ${frag} — recapture the fixture`);
    }
    assert.ok(/case when side in \('buy','buy_call','sell_put'\) then 'bullish'/.test(f));
  });

  await check('GV-04', 'the view adds NO extra row filter the gate does not have', () => {
    // every AND-clause in the view's WHERE must be traceable to the gate's predicate set
    const where = (norm(VIEW).split(' where ')[1] || '').split(' ) select ')[0];
    const clauses = where.split(' and ').map((c) => c.trim()).filter(Boolean);
    const allowed = /strategy|mode|status|r_multiple|exit_fill_time|entry_fill_time|lineage_source|risk_amount|intended_stop|entry_fill_price/;
    const strays = clauses.filter((c) => !allowed.test(c));
    assert.deepStrictEqual(strays, [], `view narrows the sample beyond the gate: ${strays.join(' | ')}`);
  });

  console.log('\n═══ (b) the one omitted clause is provably inert ═══\n');

  await check('GV-05', 'user_id clause omitted — and exactly one account exists in the window', () => {
    assert.ok(norm(FN).includes('user_id = p_user_id'), 'the gate does scope by user_id');
    assert.ok(!norm(VIEW).includes('user_id'), 'the view intentionally omits it');
    assert.strictEqual(W.user_id_scope.distinct_user_ids_in_certified_window, 1,
      'a second account appeared — the view MUST gain the user_id clause now');
    assert.strictEqual(W.user_id_scope.all_rows_match_gate_user, true);
  });

  console.log('\n═══ (c) live side-by-side parity ═══\n');

  await check('GV-06', 'view n/PF equalled the live function n/PF when run together', () => {
    assert.strictEqual(W.PARITY_MATCH, true);
    assert.strictEqual(W.view_output_bullish.n_trades, W.live_function_probe.fn_n_trades);
    assert.strictEqual(W.view_output_bullish.dollar_pf, W.live_function_probe.fn_dollar_pf);
    assert.strictEqual(W.live_function_probe.fn_reason, 'negative_measured_edge');
  });

  await check('GV-07', 'the metrics are internally consistent (recompute from the parts)', () => {
    const b = W.view_output_bullish;
    assert.ok(Math.abs(b.gross_win / b.gross_loss - b.dollar_pf) < 0.0001, 'PF != gw/gl');
    assert.ok(Math.abs(b.wins / b.n_trades - b.win_rate) < 0.0001, 'win_rate != wins/n');
    const k = (b.win_rate / b.avg_loss_r) - ((1 - b.win_rate) / b.avg_win_r);
    assert.ok(Math.abs(k - b.kelly_star) < 0.001, `kelly* recompute ${k.toFixed(4)} != ${b.kelly_star}`);
    assert.strictEqual(b.meets_pf_bar, false, 'PF 0.6585 must NOT meet the 1.0 bar');
    assert.strictEqual(b.meets_sample_bar, true, 'n=27 >= 20 must meet the sample bar');
  });

  console.log('\n═══ (d) the tail canary is data, and it refutes the proxy guess ═══\n');

  await check('GV-08', 'tail canary: 15 consecutive, 5 of 28 winners — NOT a drop from 4/20', () => {
    const t = W.tail_canary_view;
    assert.strictEqual(t.consecutive_since_last_tail_winner, 15);
    assert.ok(t.consecutive_since_last_tail_winner >= t.alarm_threshold, 'alarm state is real');
    assert.strictEqual(t.tail_winners, 5);
    assert.strictEqual(t.tail_universe, 28);
    // the 08-22 scheduled proxy hinted winners had DROPPED from the 4/20 baseline.
    assert.ok(t.tail_winners > 4, 'winners went 4 -> 5; the proxy hinted a drop and was WRONG');
    assert.ok(t.tail_winners / t.tail_universe > 0 && t.tail_universe > 20);
  });

  console.log('\n═══ (e) drift detection ═══\n');

  await check('GV-09', 'NEGATIVE CONTROL: a view missing any gate predicate fails GV-02', () => {
    const sabotaged = norm(VIEW).replace("coalesce(t.lineage_source, '') !~~ 'recert_quarantine%'", 'true');
    const missing = REQUIRED_PREDICATES.filter(([, re]) => !re.test(sabotaged));
    const labels = missing.map(([l]) => l);
    assert.ok(labels.includes('quarantine excluded'),
      `dropping the quarantine filter must be detected; got: ${labels.join(', ')}`);
  });

  await check('GV-10', 'NEGATIVE CONTROL: a widened lookback is detected', () => {
    const sabotaged = norm(VIEW).replace(/'90 days'/g, "'180 days'");
    const missing = REQUIRED_PREDICATES.filter(([, re]) => !re.test(sabotaged)).map(([l]) => l);
    assert.ok(missing.includes('exit_fill_time >= now()-90d'), 'lookback drift must be detected');
  });

  console.log(`\n  ${passed}/${passed + failed} checks passed\n`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('HARNESS FAILURE:', e); process.exit(1); });
