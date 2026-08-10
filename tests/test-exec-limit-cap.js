#!/usr/bin/env node
'use strict';
/**
 * Maya regression guard — APT v4.9 EX-C1/C2/C3, the execution fix (2026-08-10).
 *
 * Maya asks: "You told me the guard that was supposed to stop me overpaying was measuring
 * the wrong price, and then you told me the fix for that was ALSO wrong. Now you've
 * replaced my market orders with limit orders that might not fill at all — a failure mode
 * this pipeline has never had. So prove it. Prove WST cannot happen again. Prove that when
 * nothing fills you cancel cleanly and don't leave me a naked order. Prove that when
 * something PARTIALLY fills you don't cancel my stop out from under the shares I'm already
 * holding. Prove that when your own API calls fail you say 'I don't know' instead of
 * guessing. And prove the off switch actually switches it off."
 *
 * Deterministic and fully offline. Executes the ACTUAL v4.9 node bytes inside an n8n shim
 * against a scripted fake broker that records every single HTTP call, so the assertions are
 * about what the deployed code really sends — not about a paraphrase of it.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const L = require('../lib/exec/limit_cap');

let passed = 0, failed = 0;
function check(id, name, fn) {
  try { fn(); console.log(`  ✅ ${id}  ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${id}  ${name}\n        ${e.message}`); failed++; }
}
function acheck(id, name, fn) { return { id, name, fn }; }

const NODE_PATH = path.join(__dirname, '..', 'docs', 'execution-fix-20260810', 'alpaca-paper-trade-v4.9.js');
const LIVE_PATH = path.join(__dirname, '..', 'docs', 'execution-fix-20260810', 'alpaca-paper-trade-v4.8-LIVE.js');
const NODE = fs.readFileSync(NODE_PATH, 'utf8');
const PREV = fs.readFileSync(LIVE_PATH, 'utf8');

// ── the n8n shim ─────────────────────────────────────────────────────────────
// `this.helpers.httpRequest` is reached through arrow functions in the node, so the wrapper
// must be an arrow too or `this` is lost. setTimeout is shadowed so the 12s poll runs instantly.
function makeBroker(plan) {
  const calls = [];
  const notFound = (what) => { const e = new Error('Request failed with status code 404 - ' + what); e.statusCode = 404; throw e; };
  const httpRequest = async (opts) => {
    const url = String(opts.url || '');
    const method = String(opts.method || 'GET').toUpperCase();
    let body = null;
    try { body = opts.body ? JSON.parse(opts.body) : null; } catch (_) { body = opts.body; }
    calls.push({ method, url, body });

    if (url.includes('data.alpaca.markets') && url.includes('/trades/latest')) {
      if (plan.tradeLatest === 'throw') throw new Error('feed down');
      return { trade: { p: plan.tradeLatest } };
    }
    if (method === 'GET' && /\/v2\/positions\//.test(url)) {
      if (plan.position) return plan.position;
      return notFound('position does not exist');
    }
    if (method === 'GET' && /\/v2\/account$/.test(url)) return { portfolio_value: String(plan.portfolio || 100000) };
    if (method === 'POST' && /\/v2\/orders$/.test(url)) {
      const r = plan.entryResponses ? plan.entryResponses.shift() : plan.entryResponse;
      if (r === 'throw') { const e = new Error('order rejected'); e.statusCode = 422; throw e; }
      return r;
    }
    if (method === 'GET' && /\/v2\/orders\//.test(url)) {
      const s = plan.orderStates.shift();
      if (s === undefined) throw new Error('no scripted order state left');
      if (s === 'throw') throw new Error('order status read failed');
      return s;
    }
    if (method === 'DELETE' && /\/v2\/orders\//.test(url)) {
      if (plan.cancel === 'throw') throw new Error('cancel failed');
      return {};
    }
    if (method === 'PATCH' && /\/v2\/orders\//.test(url)) {
      if (plan.patch === 'throw') { const e = new Error('replace rejected'); e.statusCode = 422; throw e; }
      return plan.patch || { id: 'NEWLEG-1', stop_price: String(body.stop_price), status: 'held' };
    }
    throw new Error('unscripted call: ' + method + ' ' + url);
  };
  return { calls, ctx: { helpers: { httpRequest } } };
}

async function runNode(signal, { vars = {}, plan = {}, code = NODE } = {}) {
  const broker = makeBroker(Object.assign({ orderStates: [] }, plan));
  const logs = [];
  const staticData = { _credentials: {} };
  const $input = { first: () => ({ json: signal }) };
  const V = Object.assign({ ALPACA_API_KEY: 'k', ALPACA_SECRET_KEY: 's' }, vars);
  const shimConsole = { log: m => logs.push('LOG ' + m), error: m => logs.push('ERR ' + m), warn: m => logs.push('WARN ' + m) };
  const fn = new Function('$input', '$vars', '$getWorkflowStaticData', 'console', 'setTimeout',
    'return (async () => {\n' + code + '\n})()');
  const out = await fn.call(broker.ctx, $input, V, () => staticData, shimConsole, (cb) => cb());
  return { json: out[0].json, logs, calls: broker.calls, staticData };
}

const posts   = c => c.filter(x => x.method === 'POST' && /\/v2\/orders$/.test(x.url));
const deletes = c => c.filter(x => x.method === 'DELETE');
const patches = c => c.filter(x => x.method === 'PATCH');

// ── fixtures: the REAL trades, exactly as they hit the pipeline ──────────────
// WST 2026-08-10 09:33 ET — signal 353.62, filled 360.00 (+1.804%), $191.40 cost, and the
// stop it produced (349.38) sat 2.950% below the fill, arming the TSM's forced-0.9% recovery
// which then noise-stopped the trade at a price ABOVE its own signal.
const WST  = { ticker: 'WST',  price: '353.62', atr: '5.20', signal: 'BULLISH', execution: 'BUY', eff_position_size: '2', vix_size_mult: '1', order_qty: '30' };
// WSM same session — a FAVOURABLE fill (250.8467 vs signal 251.75). Its stop sat 0.844%
// from the fill, i.e. already tighter than the cap.
const WSM  = { ticker: 'WSM',  price: '251.75', atr: '4.10', signal: 'BULLISH', execution: 'BUY', order_qty: '42' };
const SHRT = { ticker: 'ZETA', price: '50.00',  atr: '1.00', signal: 'BEARISH', execution: 'SELL', order_qty: '10' };

const filledOrder = (id, qty, avg, slId = 'SL-1', tpId = 'TP-1', stop = '349.38') => ({
  id, status: 'filled', filled_qty: String(qty), filled_avg_price: String(avg),
  legs: [{ id: tpId, type: 'limit', status: 'new' }, { id: slId, type: 'stop', status: 'held', stop_price: stop }]
});
const submitResp = (id, slId = 'SL-1', tpId = 'TP-1') => ({
  id, status: 'accepted', filled_qty: '0',
  legs: [{ id: tpId, type: 'limit', status: 'held' }, { id: slId, type: 'stop', status: 'held' }]
});

(async () => {
console.log('\n═══ APT v4.9 execution fix — EX-C1 (capped limit) ═══\n');

// EXE-01
{
  const { json, calls } = await runNode(WST, { plan: {
    tradeLatest: 353.62, entryResponse: submitResp('E1'),
    orderStates: [filledOrder('E1', 30, 353.90)] } });
  check('EXE-01', 'a long entry submits a marketable LIMIT at signal x (1 + 0.30%) — never a market order', () => {
    const p = posts(calls);
    assert.strictEqual(p.length, 1, `expected 1 entry POST, got ${p.length}`);
    assert.strictEqual(p[0].body.type, 'limit', `type=${p[0].body.type}`);
    assert.strictEqual(p[0].body.time_in_force, 'day', `tif=${p[0].body.time_in_force}`);
    assert.strictEqual(p[0].body.order_class, 'bracket');
    assert.strictEqual(p[0].body.limit_price, '354.68', `limit=${p[0].body.limit_price}`);
    assert.strictEqual(Number(p[0].body.limit_price), L.capLimit(353.62, true, 0.003), 'agrees with the spec-mirror');
    assert.strictEqual(json.alpaca_bracket_v, '4.9');
  });
}
// EXE-02
{
  const { calls } = await runNode(SHRT, { plan: {
    tradeLatest: 50.00, entryResponse: submitResp('E2'),
    orderStates: [filledOrder('E2', 10, 49.95, 'SL-2', 'TP-2', '50.60')] } });
  check('EXE-02', 'a short entry caps on the correct side — signal x (1 - 0.30%)', () => {
    const b = posts(calls)[0].body;
    assert.strictEqual(b.side, 'sell');
    assert.strictEqual(b.limit_price, '49.85', `limit=${b.limit_price}`);
    assert.strictEqual(Number(b.limit_price), L.capLimit(50.00, false, 0.003));
  });
}
// EXE-03
{
  const { calls } = await runNode(WST, { plan: {
    tradeLatest: 371.30, entryResponse: submitResp('E3'),   // IEX print 5% away — the falsified reference
    orderStates: [filledOrder('E3', 30, 354.00)] } });
  check('EXE-03', 'the cap is anchored to the SIGNAL, so a 5%-off IEX print cannot move the limit', () => {
    assert.strictEqual(posts(calls)[0].body.limit_price, '354.68',
      'a limit that tracked the IEX print would be ~372.4 and would re-import the falsified reference');
  });
}
// EXE-04 — the headline
{
  const { json, calls } = await runNode(WST, { plan: {
    tradeLatest: 353.62, entryResponse: submitResp('E4'),
    orderStates: [submitResp('E4'), submitResp('E4'), submitResp('E4'), submitResp('E4'),
                  submitResp('E4'), submitResp('E4'), submitResp('E4'), submitResp('E4')] } });
  check('EXE-04', 'WST replay: the market was at 360.00, the limit is 354.68 — the $191.40 is not paid', () => {
    assert.strictEqual(Number(posts(calls)[0].body.limit_price), 354.68);
    assert.ok(354.68 < 360.00, 'the limit is below the price that was actually paid on 08-10');
    assert.strictEqual(json.alpaca_status, 'SKIPPED_NO_FILL_WITHIN_CAP',
      'unfilled at the cap is the CORRECT outcome here — the trade is skipped, not bought at 360');
    assert.strictEqual(deletes(calls).length, 1, 'and the resting bracket is cancelled, not left working');
  });
}

console.log('\n═══ EX-C2 (fill poll, cancel, partial) ═══\n');

// EXE-05
{
  const st = Array.from({ length: 8 }, () => submitResp('E5'));
  const { json, calls } = await runNode(WST, { plan: { tradeLatest: 353.62, entryResponse: submitResp('E5'), orderStates: st } });
  check('EXE-05', 'zero fill -> DELETE the entry, report SKIPPED_NO_FILL_WITHIN_CAP, place no further orders', () => {
    assert.strictEqual(json.alpaca_status, 'SKIPPED_NO_FILL_WITHIN_CAP');
    assert.strictEqual(json.alpaca_cancelled, true);
    assert.strictEqual(json.alpaca_filled_qty, 0);
    assert.strictEqual(json.alpaca_qty, 0, 'qty 0 — nothing was bought, and the ledger must not be told otherwise');
    assert.strictEqual(deletes(calls).length, 1);
    assert.strictEqual(posts(calls).length, 1, 'exactly one POST: the entry. No replacement order was chased.');
    assert.strictEqual(patches(calls).length, 0);
  });
}
// EXE-06 — the one that protects real money
{
  const partial = { id: 'E6', status: 'partially_filled', filled_qty: '12', filled_avg_price: '353.80',
                    legs: [{ id: 'TP-6', type: 'limit', status: 'held' }, { id: 'SL-6', type: 'stop', status: 'held', stop_price: '349.38' }] };
  const { json, calls } = await runNode(WST, { plan: {
    tradeLatest: 353.62, entryResponse: submitResp('E6', 'SL-6', 'TP-6'),
    orderStates: Array.from({ length: 8 }, () => partial) } });
  check('EXE-06', 'PARTIAL fill on a bracket -> NO cancel is issued (cancelling the group would strip the stop from shares already held)', () => {
    assert.strictEqual(json.alpaca_poll_outcome, 'PARTIAL');
    assert.strictEqual(json.alpaca_partial_fill, true);
    assert.strictEqual(deletes(calls).length, 0,
      'Alpaca cancels every open order in a bracket group — one DELETE here would leave 12 filled shares naked');
    assert.strictEqual(json.alpaca_filled_qty, 12);
    assert.strictEqual(json.alpaca_qty, 12, 'the ledger records what was actually filled, not what was asked for');
  });
}
// EXE-07 — the deliberate asymmetry
{
  const VOLSIG = { ticker: 'IONQ', price: '40.00', atr: '1.20', signal: 'BULLISH', execution: 'BUY', order_qty: '25' };
  const partial = { id: 'E7', status: 'partially_filled', filled_qty: '10', filled_avg_price: '40.05', legs: [] };
  const { json, calls } = await runNode(VOLSIG, { plan: {
    tradeLatest: 40.00, entryResponses: [submitResp('E7'), { id: 'TRAIL-7' }],
    orderStates: Array.from({ length: 8 }, () => partial) } });
  check('EXE-07', 'PARTIAL on the VOLATILE path -> cancel IS issued (standalone order, no group) and the trailing stop is sized to the FILLED qty', () => {
    assert.strictEqual(deletes(calls).length, 1, 'standalone limit: the remainder must go, or a later fill sits unprotected for 15 min');
    const trail = posts(calls).find(p => p.body.type === 'trailing_stop');
    assert.ok(trail, 'a trailing stop was placed');
    assert.strictEqual(trail.body.qty, '10', `trailing stop qty=${trail.body.qty} — must protect 10 held shares, not the 25 requested`);
    assert.strictEqual(json.alpaca_qty, 10);
  });
}

console.log('\n═══ EX-C3 (fill-anchored stop, PATCH) ═══\n');

// EXE-08 — the WST chain, broken
{
  const { json, calls } = await runNode(WST, { plan: {
    tradeLatest: 353.62, entryResponse: submitResp('E8'),
    orderStates: [filledOrder('E8', 30, 360.00)] } });
  check('EXE-08', 'adverse fill -> PATCH re-anchors the stop to the FILL, landing inside the TSM 1.2% bar it used to breach', () => {
    const p = patches(calls);
    assert.strictEqual(p.length, 1, `expected exactly 1 PATCH, got ${p.length}`);
    assert.strictEqual(p[0].body.stop_price, '355.86');
    assert.ok(L.tsmWouldCallTooWide(349.38, 360.00), 'the ORIGINAL stop was 2.950% from the fill — the TSM would force a 0.9% stop');
    assert.ok(!L.tsmWouldCallTooWide(355.86, 360.00), 'the re-anchored stop is inside the bar, so no forced recovery is armed');
    assert.strictEqual(json.alpaca_stop_price, 355.86);
    assert.strictEqual(json.alpaca_stop_price_initial, 349.38);
    assert.strictEqual(json.alpaca_stop_reanchor.ok, true);
    assert.strictEqual(json.alpaca_stop_reanchor.realised_pct_before, 2.95);
    assert.strictEqual(json.alpaca_stop_reanchor.realised_pct_after, 1.15);
  });
}
// EXE-09 — the probe's most operationally dangerous finding
{
  const { json } = await runNode(WST, { plan: {
    tradeLatest: 353.62, entryResponse: submitResp('E9'),
    orderStates: [filledOrder('E9', 30, 360.00)],
    patch: { id: 'REPLACED-LEG-9', stop_price: '355.86', status: 'held' } } });
  check('EXE-09', 'Alpaca returns a NEW order id from a replace — the node records the new id, not the stale one', () => {
    assert.strictEqual(json.alpaca_sl_id, 'REPLACED-LEG-9',
      'probe 545502 measured this: the old leg goes to status "replaced" and a new id is issued');
    assert.notStrictEqual(json.alpaca_sl_id, 'SL-1');
    assert.strictEqual(json.alpaca_stop_reanchor.new_leg_id, 'REPLACED-LEG-9');
  });
}
// EXE-10 — only ever tighten
{
  const { json, calls } = await runNode(WSM, { plan: {
    tradeLatest: 251.75, entryResponse: submitResp('EA', 'SL-A', 'TP-A'),
    orderStates: [filledOrder('EA', 42, 250.8467, 'SL-A', 'TP-A', '248.73')] } });
  check('EXE-10', 'a FAVOURABLE fill does not trigger a PATCH — the stop is only ever tightened, never widened back out', () => {
    assert.ok(Math.abs(248.73 - 250.8467) / 250.8467 < L.STOP_SAFE_BAR, 'WSM real stop was 0.844% from its fill');
    assert.strictEqual(patches(calls).length, 0, 'widening a stop on a good fill would be an unauthorised increase in risk');
    assert.strictEqual(json.alpaca_stop_reanchor, null);
  });
}
// EXE-11 / EXE-12 — the rounding trap, pure functions
check('EXE-11', 'the fill-anchored stop is provably inside the TSM bar at every price QTP trades (and below it)', () => {
  for (const px of [3.00, 7.77, 14.03, 35.90, 73.06, 172.31, 250.85, 360.00, 376.43, 1234.56]) {
    for (const long of [true, false]) {
      const s = L.fillStop(px, long);
      const d = Math.abs(s - px) / px;
      assert.ok(d <= L.STOP_SAFE_BAR, `px=${px} long=${long} stop=${s} dist=${(d * 100).toFixed(4)}% exceeds the 1.19% safety bar`);
      assert.ok(!L.tsmWouldCallTooWide(s, px), `px=${px} long=${long} would be classified TOO_WIDE by the TSM`);
    }
  }
  // the historical near-miss this exists to prevent
  assert.ok(1.2003 > L.TSM_TOO_WIDE_BAR * 100, 'ALGN 08-07 landed at 1.2003% against its signal — over the bar by rounding alone');
});
check('EXE-12', 'the stop never crosses the fill, even where one cent is a large fraction of the target', () => {
  for (const px of [0.55, 1.00, 2.00, 3.00, 5.00]) {
    assert.ok(L.fillStop(px, true) < px, `long stop ${L.fillStop(px, true)} must stay below fill ${px}`);
    assert.ok(L.fillStop(px, false) > px, `short stop ${L.fillStop(px, false)} must stay above fill ${px}`);
  }
});

console.log('\n═══ failure modes: say "I do not know" rather than guess ═══\n');

// EXE-13
{
  const { json, calls } = await runNode(Object.assign({}, WST, { price: '0' }), { plan: { tradeLatest: 353.62 } });
  check('EXE-13', 'cap active but no usable price -> BLOCKED_EXEC_CAP, and NOT a silent fall back to a market order', () => {
    assert.strictEqual(json.alpaca_status, 'BLOCKED_EXEC_CAP');
    assert.strictEqual(posts(calls).length, 0, 'no order was placed at all');
  });
}
// EXE-14 — the divergence-avoidance test
{
  const { json, calls } = await runNode(WST, { plan: {
    tradeLatest: 353.62, entryResponse: submitResp('EB'),
    orderStates: Array.from({ length: 8 }, () => 'throw') } });
  check('EXE-14', 'every status read fails -> ERROR_FILL_STATE_UNKNOWN, no cancel, flagged for reconciliation', () => {
    assert.strictEqual(json.alpaca_status, 'ERROR_FILL_STATE_UNKNOWN');
    assert.strictEqual(json.alpaca_poll_outcome, 'UNREADABLE');
    assert.strictEqual(json.alpaca_needs_reconciliation, true);
    assert.strictEqual(deletes(calls).length, 0,
      'cancelling here could kill a bracket protecting a position we just failed to read — and reporting a skip would hide it from the ledger');
    assert.notStrictEqual(json.alpaca_status, 'SKIPPED_NO_FILL_WITHIN_CAP', '"did not fill" and "could not find out" must not share an outcome');
  });
}
// EXE-15
{
  const { json } = await runNode(WST, { plan: {
    tradeLatest: 353.62, entryResponse: submitResp('EC'),
    orderStates: [...Array.from({ length: 8 }, () => submitResp('EC')), submitResp('EC')],
    cancel: 'throw' } });
  check('EXE-15', 'no fill AND the cancel fails -> a distinct status that admits the entry may still be working', () => {
    assert.strictEqual(json.alpaca_status, 'SKIPPED_NO_FILL_CANCEL_FAILED');
    assert.strictEqual(json.alpaca_needs_reconciliation, true);
    assert.strictEqual(json.alpaca_cancelled, false);
  });
}
// EXE-16 — PATCH failure is fail-SAFE, not fail-closed
{
  const { json } = await runNode(WST, { plan: {
    tradeLatest: 353.62, entryResponse: submitResp('ED'),
    orderStates: [filledOrder('ED', 30, 360.00)], patch: 'throw' } });
  check('EXE-16', 'a failed re-anchor leaves the ORIGINAL stop live and says so — the position is never left unprotected', () => {
    assert.strictEqual(json.alpaca_stop_reanchor.ok, false);
    assert.strictEqual(json.alpaca_stop_price, 349.38, 'the original protective stop is untouched and still live');
    assert.strictEqual(json.alpaca_sl_id, 'SL-1', 'and its id is unchanged, because nothing was replaced');
  });
}

console.log('\n═══ the off switch, and the footgun ═══\n');

// EXE-17
{
  const { json, calls } = await runNode(WST, { vars: { QTP_ENTRY_LIMIT_CAP_ACTIVE: '0' }, plan: {
    tradeLatest: 353.62, entryResponse: submitResp('EE'),
    orderStates: [filledOrder('EE', 30, 360.00)] } });
  check('EXE-17', 'QTP_ENTRY_LIMIT_CAP_ACTIVE=0 restores the v4.8 market/gtc order, with no cancel and no re-anchor', () => {
    const b = posts(calls)[0].body;
    assert.strictEqual(b.type, 'market');
    assert.strictEqual(b.time_in_force, 'gtc');
    assert.strictEqual(b.limit_price, undefined);
    assert.strictEqual(deletes(calls).length, 0);
    assert.strictEqual(patches(calls).length, 0);
    assert.strictEqual(json.alpaca_anchor_used, 'fresh', 'and TE-C3 re-anchoring is restored too');
  });
}
// EXE-18 — the footgun, learned the hard way from gate_config
check('EXE-18', 'FAIL-CLOSED: deleting the variable does NOT revert — only the literal "0" does', () => {
  assert.strictEqual(L.capActive(undefined), true, 'a missing variable leaves the cap ACTIVE');
  assert.strictEqual(L.capActive(''), true);
  assert.strictEqual(L.capActive('1'), true);
  assert.strictEqual(L.capActive('0'), false);
  assert.ok(/QTP_ENTRY_LIMIT_CAP_ACTIVE/.test(NODE), 'the node reads the flag');
  assert.ok(/DELETING the variable does not revert it/.test(NODE), 'and the footgun is documented in the deployed bytes, not just here');
});
// EXE-19
check('EXE-19', 'the cap percentage is bounded — garbage and oversized values fall back to 0.30%, never to "off"', () => {
  assert.strictEqual(L.capPct(undefined), 0.003);
  assert.strictEqual(L.capPct('abc'), 0.003);
  assert.strictEqual(L.capPct('0'), 0.003);
  assert.strictEqual(L.capPct('-1'), 0.003);
  assert.strictEqual(L.capPct('5'), 0.003, '5% would be the status quo with extra steps');
  assert.strictEqual(L.capPct('0.40'), 0.004, 'a legitimate widening is honoured');
});

console.log('\n═══ things that must NOT have changed ═══\n');

// EXE-20 — G16 harness isolation
{
  const { json, calls } = await runNode(Object.assign({}, WST, { harness: true }), { plan: { tradeLatest: 353.62 } });
  check('EXE-20', 'G16 harness isolation survives: no broker POST, no poll, no cancel, no PATCH', () => {
    assert.strictEqual(posts(calls).length, 0, 'a harness signal must never place a real order');
    assert.strictEqual(deletes(calls).length, 0);
    assert.strictEqual(patches(calls).length, 0);
    assert.ok(!calls.some(c => /\/v2\/orders\//.test(c.url)), 'and it must not poll an order id that does not exist');
    assert.strictEqual(json.alpaca_bracket_v, '4.9');
  });
}
// EXE-21 — paper-only assert
check('EXE-21', 'the paper-only assert and the fail-closed credential guard are byte-identical to v4.8', () => {
  const grab = (s, re) => (s.match(re) || [])[0];
  const re1 = /if \(!String\(BASE \|\| ''\)\.toLowerCase\(\)\.includes\('paper-api\.alpaca\.markets'\)\) \{[\s\S]*?\}/;
  const re2 = /if \(!ALPACA_KEY \|\| !ALPACA_SEC\) throw new Error\([^\n]*\);/;
  assert.strictEqual(grab(NODE, re1), grab(PREV, re1), 'paper-only assert drifted');
  assert.strictEqual(grab(NODE, re2), grab(PREV, re2), 'credential fail-closed drifted');
});
// EXE-22 — TE-C3 disarmed while capped, restored when reverted
{
  const capped = await runNode(WST, { plan: {
    tradeLatest: 500.00, entryResponse: submitResp('EF'), orderStates: [filledOrder('EF', 30, 354.00)] } });
  const reverted = await runNode(WST, { vars: { QTP_ENTRY_LIMIT_CAP_ACTIVE: '0' }, plan: { tradeLatest: 500.00 } });
  check('EXE-22', 'the falsified >2% staleness reject is disarmed while the cap is active, and restored exactly when reverted', () => {
    assert.notStrictEqual(capped.json.alpaca_status, 'REJECTED',
      'a 41% "slip" against a 36-minute-stale IEX print must no longer halt a symbol');
    assert.strictEqual(reverted.json.alpaca_status, 'REJECTED', 'and the revert really is a revert');
  });
}
// EXE-23 — the notional bug
{
  const { json } = await runNode(WST, { plan: {
    tradeLatest: 'throw', entryResponse: submitResp('EG'), orderStates: [filledOrder('EG', 30, 360.00)] } });
  check('EXE-23', 'notional no longer multiplies by a null fresh_price when the data feed fails', () => {
    assert.strictEqual(json.alpaca_fresh_price, null, 'the feed did fail');
    assert.ok(json.alpaca_notional > 0, `notional=${json.alpaca_notional} — v4.8 wrote 0 here`);
    assert.strictEqual(json.alpaca_notional, Number((30 * 360).toFixed(2)));
  });
}
// EXE-24 — E3
{
  const filled  = await runNode(WST, { plan: { tradeLatest: 353.62, entryResponse: submitResp('EH'), orderStates: [filledOrder('EH', 30, 354.00)] } });
  const skipped = await runNode(WST, { plan: { tradeLatest: 353.62, entryResponse: submitResp('EI'), orderStates: Array.from({ length: 8 }, () => submitResp('EI')) } });
  check('EXE-24', 'E3: every outcome carries the execution regime, so the rebuild can be measured pre- vs post-fix', () => {
    for (const [k, r] of [['filled', filled], ['skipped', skipped]]) {
      assert.strictEqual(r.json.alpaca_exec_regime, 'EXEC_V49_LIMIT_CAP', `${k} payload missing the regime tag`);
      assert.strictEqual(r.json.alpaca_exec_cap_pct, 0.3, `${k} payload missing the cap`);
    }
  });
}
// EXE-25 — structural: no reachable market order while capped
check('EXE-25', 'structurally, every entry-order market literal sits inside a statement gated by _exCapActive', () => {
  const lines = NODE.split('\n').filter(l => !/^\s*\/\//.test(l));
  const hits = [];
  lines.forEach((l, i) => {
    if (/type:\s*'market'/.test(l)) {
      // look at the enclosing statement, not just the one physical line: the volatile
      // path's ternary spans several lines and the gate is on the first of them.
      const window = lines.slice(Math.max(0, i - 4), i + 1).join('\n');
      hits.push({ line: l.trim(), gated: /_exCapActive/.test(window) });
    }
  });
  assert.ok(hits.length > 0, 'the revert path still exists');
  for (const h of hits) assert.ok(h.gated, `a market order literal with no cap gate in its statement:\n        ${h.line}`);
});
// EXE-26 / EXE-27 — behavioural coverage of the two paths EXE-01 does not touch
{
  const VOLSIG = { ticker: 'IONQ', price: '40.00', atr: '1.20', signal: 'BULLISH', execution: 'BUY', order_qty: '25' };
  const { calls } = await runNode(VOLSIG, { plan: {
    tradeLatest: 40.00, entryResponses: [submitResp('EJ'), { id: 'TRAIL-J' }],
    orderStates: [{ id: 'EJ', status: 'filled', filled_qty: '25', filled_avg_price: '40.05', legs: [] }] } });
  check('EXE-26', 'the VOLATILE path is capped too — a limit at 40.12, not a market order', () => {
    const entry = posts(calls)[0].body;
    assert.strictEqual(entry.type, 'limit', `volatile entry type=${entry.type}`);
    assert.strictEqual(entry.time_in_force, 'day');
    assert.strictEqual(entry.limit_price, '40.12', `limit=${entry.limit_price}`);
    assert.strictEqual(entry.order_class, undefined, 'trailing_stop cannot be a bracket leg — this path stays standalone');
  });
}
{
  const EXT = Object.assign({}, WST, { is_extended_hours: true, market_session: 'PRE' });
  const { calls } = await runNode(EXT, { plan: {
    tradeLatest: 353.62, entryResponse: submitResp('EK'), orderStates: [filledOrder('EK', 30, 354.00)] } });
  check('EXE-27', 'the EXTENDED-HOURS path is capped and keeps extended_hours=true (limit-only is a hard broker requirement there)', () => {
    const b = posts(calls)[0].body;
    assert.strictEqual(b.type, 'limit');
    assert.strictEqual(b.time_in_force, 'day');
    assert.strictEqual(b.extended_hours, true);
    assert.strictEqual(b.limit_price, '354.68', 'capped rather than pinned exactly at the signal, so it can actually fill');
  });
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
})();
