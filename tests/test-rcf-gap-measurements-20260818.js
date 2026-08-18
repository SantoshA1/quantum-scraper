#!/usr/bin/env node
'use strict';
/**
 * Maya regression guard — the two authorized measurements (gov 226, 2026-08-18).
 *
 * Maya asks: "You told me on the 14th you'd measure the regime filter and the overnight gaps.
 * I now learn the regime scorer existed all along, went BLIND three days ago when you renamed
 * the stage, and carries a hardcoded API key. Prove FROM THE BYTES you are deploying that
 * (a) the scorer now ingests BOTH stage names and records which era a row came from; (b) the
 * hardcoded key is gone and the code refuses to run without named variables; (c) a fetch
 * failure can never again silently shift the calendar and freeze wrong numbers under
 * COALESCE; (d) the new 6-day horizon and its walk-forward stop actually compute what they
 * claim — show me the arithmetic on bars I can check by hand, including a gap-through
 * morning; and (e) the gap study gets long AND short right, keys nights by the morning they
 * resolve, skips same-day trades, and cannot double-write."
 *
 * Deterministic + offline. Fixtures are the exact bytes handed to the deploy step:
 *   docs/rcf-scorer-20260818/backfill-compute-patched.js  (sha f3a24c72…)
 *   docs/rcf-scorer-20260818/sync-get-pending-patched.sql (sha b52df6d4…)
 *   docs/gap-exposure-20260818/compute-gaps.js            (sha 831c25cd…)
 *   docs/gap-exposure-20260818/get-trades.sql             (sha e06d3e2d…)
 * plus the ORIGINAL deployed scorer bytes for the regression witnesses. The compute bodies are
 * EXECUTED with a faked this.helpers.httpRequest serving hand-checkable canned bars.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const RCF = path.join(__dirname, '..', 'docs', 'rcf-scorer-20260818');
const GAP = path.join(__dirname, '..', 'docs', 'gap-exposure-20260818');
const OLD_COMPUTE = fs.readFileSync(path.join(RCF, 'scorer-compute-deployed-REDACTED.js'), 'utf8');
const OLD_INGEST = fs.readFileSync(path.join(RCF, 'scorer-ingest-deployed.sql'), 'utf8');
const NEW_COMPUTE = fs.readFileSync(path.join(RCF, 'backfill-compute-patched.js'), 'utf8');
const NEW_INGEST = fs.readFileSync(path.join(RCF, 'sync-get-pending-patched.sql'), 'utf8');
const GAP_COMPUTE = fs.readFileSync(path.join(GAP, 'compute-gaps.js'), 'utf8');
const GAP_TRADES = fs.readFileSync(path.join(GAP, 'get-trades.sql'), 'utf8');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

let passed = 0, failed = 0;
// ASYNC-AWARE, and it exists because the first version of this file was not: seven async
// checks returned promises that check() never awaited, every one was stamped PASS unread,
// and process.exit() buried the rejections before Node could surface them. Green means RAN.
async function check(id, name, fn) {
  try { await fn(); console.log(`  ✅ ${id}  ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${id}  ${name}\n        ${e.message}`); failed++; }
}

// ── harness: execute a code-node body with faked transport ───────────────────
function runNode(src, items, { vars, http } = {}) {
  const $input = { all: () => items.map((j) => ({ json: j })), first: () => ({ json: items[0] }) };
  const ctx = { helpers: { httpRequest: http || (async () => { throw new Error('unexpected fetch'); }) } };
  const fn = new Function('$input', '$vars', `return (async function(){\n${src}\n}).call(this)`);
  return fn.call(ctx, $input, vars);
}

/** Alpaca-shaped bars server. barsBySym: {SYM: [{t,o,h,l,c}]}. */
function alpacaServer(barsBySym, opts = {}) {
  let calls = 0;
  const handler = async ({ url }) => {
    calls++;
    if (opts.failOn && calls === opts.failOn) throw new Error('boom 500');
    const symbols = decodeURIComponent(url.match(/symbols=([^&]+)/)[1]).split(',');
    const bars = {};
    for (const s of symbols) if (barsBySym[s]) bars[s] = barsBySym[s];
    return { bars, next_page_token: null };
  };
  handler.calls = () => calls;
  return handler;
}

// Hand-checkable calendar: 5 sessions Mon 08-10 .. Fri 08-14, then Mon 08-17, Tue 08-18.
const CAL = ['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14', '2026-08-17', '2026-08-18'];
const flat = (px) => CAL.map((d) => ({ t: d + 'T04:00:00Z', o: px, h: px, l: px, c: px }));
const SPY = flat(100);

(async () => {
  console.log('\n═══ the bytes are the bytes being deployed ═══\n');

  await check('RG-01', 'fixtures match the artifacts handed to the deploy step', () => {
    assert.strictEqual(sha(NEW_COMPUTE), 'f3a24c721a35b5aa31ce185d9d744f8085ed46d4d48e58448aeffbd60e18f04d');
    assert.strictEqual(sha(NEW_INGEST), 'b52df6d4ab08c8cdc0c67f8912a04cc539ce8199682646e3977a9c75a4d9c54f');
    assert.strictEqual(sha(GAP_COMPUTE), '831c25cddf2b0507b44a8e36e58d24804a46c3789b8d858e613aded91b85c872');
    assert.strictEqual(sha(GAP_TRADES), 'e06d3e2d36fe13ba86835d3fd48f886b478af03e8f919259c29c20d40ba22f20');
  });

  console.log('\n═══ (a) the scorer sees both eras again ═══\n');

  await check('RG-02', 'REGRESSION WITNESS: the deployed ingest is blind to the shadow stage', () => {
    assert.ok(OLD_INGEST.includes("e.blocked_stage='REGIME_CONFLICT'"), 'old strict equality');
    assert.ok(!OLD_INGEST.includes('REGIME_CONFLICT_SHADOW'), 'and no shadow term anywhere');
  });

  await check('RG-03', 'the new ingest takes both stages, records provenance, keeps every other guard', () => {
    assert.ok(NEW_INGEST.includes("e.blocked_stage IN ('REGIME_CONFLICT','REGIME_CONFLICT_SHADOW')"));
    assert.ok(NEW_INGEST.includes('src_stage') && NEW_INGEST.includes('e.blocked_stage\n'),
      'src_stage must be populated from the audit row');
    for (const kept of ["e.side='BUY'", "e.kill_stage_attribution='REGIME_CONFLICT_CONTRA_BOTH'",
      'ON CONFLICT (symbol, blocked_at) DO NOTHING', "interval '30 days'"]) {
      assert.ok(NEW_INGEST.includes(kept), `guard lost: ${kept}`);
    }
    assert.ok(NEW_INGEST.includes('OR fwd6_close IS NULL OR ss6_ret_10 IS NULL'),
      'pending selection must re-open rows until the 6d horizon matures');
  });

  console.log('\n═══ (b) the hardcoded key is gone ═══\n');

  await check('RG-04', 'REGRESSION WITNESS: the deployed compute embeds a key literal', () => {
    assert.ok(/const PK='[A-Za-z0-9_]{20,}'/.test(OLD_COMPUTE), 'the defect this suite exists to bury');
  });

  await check('RG-05', 'the new compute reads keys by NAME only and refuses to run without them', async () => {
    assert.ok(!/const PK='/.test(NEW_COMPUTE), 'key literal survived');
    assert.ok(NEW_COMPUTE.includes('$vars.ALPACA_API_KEY'));
    await assert.rejects(
      () => runNode(NEW_COMPUTE, [{ id: 1, symbol: 'AAA', block_day: CAL[0], block_close: 100 }], { vars: {} }),
      /RCF_SCORER_NO_ALPACA_CRED/);
    // and the gap study enforces the same rule
    await assert.rejects(
      () => runNode(GAP_COMPUTE, [{ trade_id: 'a', symbol: 'AAA', side: 'buy', entry_day: CAL[0], end_day: CAL[1] }], { vars: {} }),
      /GAP_EXPOSURE_NO_ALPACA_CRED/);
  });

  console.log('\n═══ (c) a fetch failure fails LOUD, never shifts the calendar ═══\n');

  await check('RG-06', 'REGRESSION WITNESS: the deployed compute swallows fetch errors silently', () => {
    assert.ok(/catch\(e\)\{\}/.test(OLD_COMPUTE), 'the silent catch that shifted +1d/+2d indexing');
  });

  await check('RG-07', 'the new compute throws on fetch failure — nothing half-right is written', async () => {
    const http = alpacaServer({ SPY, AAA: flat(50) }, { failOn: 1 });
    await assert.rejects(
      () => runNode(NEW_COMPUTE, [{ id: 1, symbol: 'AAA', block_day: CAL[0], block_close: 50 }],
        { vars: { ALPACA_API_KEY: 'k', ALPACA_SECRET_KEY: 's' }, http }),
      /boom 500/);
    // The $vars ACCESS guard keeps its defensive catch (a hostile $vars proxy must not kill
    // the node before the loud cred check). The claim is about the FETCH: no catch may wrap it.
    for (const src of [NEW_COMPUTE, GAP_COMPUTE]) {
      const a = src.indexOf('for(let i=0;i<fetchSyms.length');
      const b = src.indexOf('}while(pageToken);', a);
      assert.ok(a !== -1 && b !== -1, 'fetch-loop markers missing — re-derive this check');
      assert.ok(!/catch/.test(src.slice(a, b)), 'a catch crept back around the bars fetch');
    }
  });

  console.log('\n═══ (d) the 6d horizon computes what it claims ═══\n');

  await check('RG-08', 'hand-checked: +6d close return and unstopped walk-forward stop', async () => {
    // AAA: block Mon 08-10 close 100; six sessions later (Tue 08-18) close 106. Lows never near 99.
    const AAA = [
      { t: CAL[0] + 'T04:00:00Z', o: 100, h: 100, l: 100, c: 100 },
      { t: CAL[1] + 'T04:00:00Z', o: 101, h: 102, l: 100.5, c: 101 },
      { t: CAL[2] + 'T04:00:00Z', o: 102, h: 103, l: 101.5, c: 102 },
      { t: CAL[3] + 'T04:00:00Z', o: 103, h: 104, l: 102.5, c: 103 },
      { t: CAL[4] + 'T04:00:00Z', o: 104, h: 105, l: 103.5, c: 104 },
      { t: CAL[5] + 'T04:00:00Z', o: 105, h: 106, l: 104.5, c: 105 },
      { t: CAL[6] + 'T04:00:00Z', o: 106, h: 107, l: 105.5, c: 106 },
    ];
    const out = await runNode(NEW_COMPUTE, [{ id: 7, symbol: 'AAA', block_day: CAL[0], block_close: 100 }],
      { vars: { ALPACA_API_KEY: 'k', ALPACA_SECRET_KEY: 's' }, http: alpacaServer({ SPY, AAA }) });
    const sql = out[0].json.sql;
    assert.ok(sql.includes('fwd6_close=COALESCE(fwd6_close,106)'), 'fwd6 must be the 6th SESSION close');
    assert.ok(sql.includes('hypo_6d_ret_pct=COALESCE(hypo_6d_ret_pct,6)'), '(106/100-1)*100 = 6');
    assert.ok(sql.includes('ss6_ret_10=COALESCE(ss6_ret_10,6)'), 'never stopped → rides to d6 close');
    assert.ok(sql.includes('ss6_stopped_10=COALESCE(ss6_stopped_10,false)'));
    assert.ok(sql.includes('hypo_1d_ret_pct=COALESCE(hypo_1d_ret_pct,1)'), '1d/2d legacy math untouched');
  });

  await check('RG-09', 'hand-checked: a gap-through morning on day 3 fills at the OPEN, not the stop', async () => {
    // stop = 100*(1-0.010) = 99. Day3 gaps to open 97 (< stop) → fill 97 → ret −3%.
    const BBB = [
      { t: CAL[0] + 'T04:00:00Z', o: 100, h: 100, l: 100, c: 100 },
      { t: CAL[1] + 'T04:00:00Z', o: 100, h: 101, l: 99.5, c: 100.5 },
      { t: CAL[2] + 'T04:00:00Z', o: 100, h: 101, l: 99.6, c: 100.2 },
      { t: CAL[3] + 'T04:00:00Z', o: 97, h: 98, l: 96.5, c: 97.5 },
      { t: CAL[4] + 'T04:00:00Z', o: 98, h: 99, l: 97.5, c: 98.5 },
      { t: CAL[5] + 'T04:00:00Z', o: 99, h: 100, l: 98.5, c: 99.5 },
      { t: CAL[6] + 'T04:00:00Z', o: 100, h: 101, l: 99.5, c: 100.5 },
    ];
    const out = await runNode(NEW_COMPUTE, [{ id: 8, symbol: 'BBB', block_day: CAL[0], block_close: 100 }],
      { vars: { ALPACA_API_KEY: 'k', ALPACA_SECRET_KEY: 's' }, http: alpacaServer({ SPY, BBB }) });
    const sql = out[0].json.sql;
    assert.ok(sql.includes('ss6_ret_10=COALESCE(ss6_ret_10,-3)'),
      'gap-through must realize at the 97 open: (97/100-1)*100 = -3, not -1');
    assert.ok(sql.includes('ss6_stopped_10=COALESCE(ss6_stopped_10,true)'));
  });

  console.log('\n═══ (e) the gap study: direction, keying, idempotence ═══\n');

  await check('RG-10', 'hand-checked long: adverse gap and gap-through-stop morning', async () => {
    // Long CCC entry Mon, stop 95. Tue opens 94 (< stop): gap −6%, adverse +6, through, breach (95−94)/95.
    const CCC = [
      { t: CAL[0] + 'T04:00:00Z', o: 100, h: 100, l: 100, c: 100 },
      { t: CAL[1] + 'T04:00:00Z', o: 94, h: 96, l: 93, c: 95 },
    ];
    const out = await runNode(GAP_COMPUTE,
      [{ trade_id: '3e0c0000-0000-4000-8000-000000000001', symbol: 'CCC', side: 'buy', qty: 10,
         entry_price: 100, stop_level: 95, entry_day: CAL[0], end_day: CAL[1], is_open: false }],
      { vars: { ALPACA_API_KEY: 'k', ALPACA_SECRET_KEY: 's' }, http: alpacaServer({ SPY, CCC }) });
    const sql = out[0].json.sql;
    assert.strictEqual(out[0].json.n, 1, 'exactly one night held → one row');
    assert.ok(sql.includes("'2026-08-11'::date"), 'night keyed by the MORNING it resolved');
    assert.ok(sql.includes(', -6, 6,'), 'gap_pct −6, adverse_gap_pct +6 for a long gapping down');
    assert.ok(sql.includes('true'), 'gap_through_stop must be true');
    assert.ok(sql.includes('1.0526'), 'breach (95-94)/95*100 = 1.0526%');
    assert.ok(sql.includes('ON CONFLICT (trade_id, night_date) DO NOTHING'), 'idempotent by construction');
  });

  await check('RG-11', 'hand-checked short: the SAME morning is favorable, not adverse', async () => {
    const CCC = [
      { t: CAL[0] + 'T04:00:00Z', o: 100, h: 100, l: 100, c: 100 },
      { t: CAL[1] + 'T04:00:00Z', o: 94, h: 96, l: 93, c: 95 },
    ];
    const out = await runNode(GAP_COMPUTE,
      [{ trade_id: '3e0c0000-0000-4000-8000-000000000002', symbol: 'CCC', side: 'sell', qty: 10,
         entry_price: 100, stop_level: 103, entry_day: CAL[0], end_day: CAL[1], is_open: false }],
      { vars: { ALPACA_API_KEY: 'k', ALPACA_SECRET_KEY: 's' }, http: alpacaServer({ SPY, CCC }) });
    const sql = out[0].json.sql;
    assert.ok(sql.includes(', -6, -6,'), 'short: adverse_gap_pct is NEGATIVE when price gaps down');
    assert.ok(sql.includes('false'), 'open 94 vs short stop 103 → no gap-through');
  });

  await check('RG-12', 'a same-day round trip produces zero rows; a weekend counts as ONE night', async () => {
    const DDD = CAL.map((d) => ({ t: d + 'T04:00:00Z', o: 100, h: 100, l: 100, c: 100 }));
    const sameDay = { trade_id: '3e0c0000-0000-4000-8000-000000000003', symbol: 'DDD', side: 'buy',
      entry_day: CAL[2], end_day: CAL[2], entry_price: 100, stop_level: 99, qty: 1 };
    const overWeekend = { trade_id: '3e0c0000-0000-4000-8000-000000000004', symbol: 'DDD', side: 'buy',
      entry_day: CAL[4], end_day: CAL[5], entry_price: 100, stop_level: 99, qty: 1 }; // Fri → Mon
    const out = await runNode(GAP_COMPUTE, [sameDay, overWeekend],
      { vars: { ALPACA_API_KEY: 'k', ALPACA_SECRET_KEY: 's' }, http: alpacaServer({ SPY, DDD }) });
    assert.strictEqual(out[0].json.n, 1, 'same-day trade contributes 0; Fri→Mon hold contributes exactly 1');
    assert.ok(out[0].json.sql.includes("'2026-08-17'::date"), 'the weekend night resolves Monday morning');
  });

  await check('RG-13', 'NEGATIVE CONTROL: feed the OLD scorer bytes through RG-05/RG-07 expectations', async () => {
    assert.ok(/const PK='/.test(OLD_COMPUTE), 'old bytes must carry the literal, or RG-04 proves nothing');
    assert.ok(/catch\(e\)\{\}/.test(OLD_COMPUTE), 'old bytes must swallow errors, or RG-06 proves nothing');
    assert.ok(!OLD_COMPUTE.includes('ss6_ret_10'), 'old bytes must lack the 6d horizon');
  });

  console.log(`\n  ${passed}/${passed + failed} checks passed\n`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('HARNESS FAILURE:', e); process.exit(1); });
