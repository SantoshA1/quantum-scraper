#!/usr/bin/env node
/**
 * Test harness for Grok Signal Analyzer node (Quantum Trading Pipeline).
 *
 * Audit references:
 *   SE-C2 — xAI API Key guard (block if key missing instead of silent 401)
 *   SE-C7 — Fail-CLOSED fallback on Grok API failure (was WEAK/HOLD auto-pass)
 *
 * This harness extracts the node's jsCode from the n8n workflow JSON, wraps it
 * in an async function with the n8n runtime surface mocked, and runs three
 * scenarios:
 *
 *   1. API_KEY missing          → expect KILL/REJECT fallback, no HTTP call made
 *   2. Grok API throws          → expect KILL/REJECT fallback, _grok_error set
 *   3. Grok API responds OK     → expect Grok content passed through verbatim
 *
 * The test asserts the downstream execution gate will BLOCK in scenarios 1+2
 * (signal_verdict !== WEAK/PASS, trade_action !== HOLD/BUY/SELL).
 *
 * Run:  node tests/test-grok-signal-analyzer-fail-closed.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const WORKFLOW = path.join(
  __dirname, '..',
  'n8n-workflows/signal-state-machine-v5.21-sheets-v2.json'
);
const NODE_NAME = 'Grok Signal Analyzer';

function extractNodeCode(workflowPath, nodeName) {
  const wf = JSON.parse(fs.readFileSync(workflowPath, 'utf8'));
  const node = (wf.nodes || []).find(n => n.name === nodeName);
  if (!node) throw new Error(`Node ${nodeName} not found in ${workflowPath}`);
  const code = node.parameters && node.parameters.jsCode;
  if (!code) throw new Error(`Node ${nodeName} has no jsCode`);
  return code;
}

/**
 * Build a callable async function from n8n node code.
 * We inject:
 *   - $input.first().json  → the input item
 *   - $getWorkflowStaticData('global')._credentials → { xai_api_key }
 *   - this.helpers.httpRequest → mock
 *   - console  → captured
 */
function buildRunner(jsCode) {
  // The node body uses top-level `return` and references `this.helpers.httpRequest`.
  // We wrap it in an async IIFE and forward the outer `this` via `.call(this, ...)`.
  const wrapped = `
    return (async function($input, $getWorkflowStaticData) {
      ${jsCode}
    }).call(this, $input, $getWorkflowStaticData);
  `;
  // eslint-disable-next-line no-new-func
  return new Function('$input', '$getWorkflowStaticData', wrapped);
}

async function run(codeFn, { item, apiKey, httpMock }) {
  const $input = { first: () => ({ json: item }) };
  const staticData = { _credentials: apiKey ? { xai_api_key: apiKey } : {} };
  const $getWorkflowStaticData = (_scope) => staticData;

  // n8n exposes this.helpers.httpRequest inside the Code node — we rebind `this`
  const context = { helpers: { httpRequest: httpMock } };

  // Invoke the compiled wrapper with `this` === context so that
  // `this.helpers.httpRequest` inside the node body resolves to our mock.
  return await codeFn.call(context, $input, $getWorkflowStaticData);
}

/**
 * Parse the choices[0].message.content JSON string and return the fallback verdict.
 * Returns null if not parsable.
 */
function parseVerdict(result) {
  if (!Array.isArray(result) || result.length === 0) return null;
  const out = result[0].json;
  try {
    const content = out.choices[0].message.content;
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/** Downstream execution gate simulator. */
function passesExecutionGate(verdict) {
  if (!verdict) return false;
  // Matches how Format Telegram / Alpaca Paper Trade branches off verdict
  const bad = ['KILL', 'REJECT'];
  if (bad.includes(verdict.signal_verdict)) return false;
  if (bad.includes(verdict.trade_action)) return false;
  if (typeof verdict.confidence === 'number' && verdict.confidence < 5) return false;
  // Everything else (PASS / WEAK / HOLD / BUY / SELL) would let the signal proceed.
  return true;
}

// ---------- Test fixtures ----------
const SAMPLE_ITEM = {
  ticker: 'AAPL',
  execution: 'BUY',
  signal: 'LONG',
  price: '185.42',
  regime: 'BULL',
  bias_score: '72',
  timeframe: '15',
  _sm_action: 'PASS',
  _sm_route: 'FULL'
};

// ---------- Scenarios ----------
async function main() {
  const jsCode = extractNodeCode(WORKFLOW, NODE_NAME);
  const runner = buildRunner(jsCode);

  let passed = 0;
  let failed = 0;
  const fail = (name, err) => { failed++; console.error(`✗ ${name}`); console.error('  ', err.message); };
  const pass = (name) => { passed++; console.log(`✓ ${name}`); };

  // Scenario 1: API key missing (SE-C2)
  try {
    let httpCalled = false;
    const result = await run(runner, {
      item: SAMPLE_ITEM,
      apiKey: null, // simulates staticData._credentials.xai_api_key missing
      httpMock: async () => { httpCalled = true; return { choices: [{ message: { content: '{}' } }] }; }
    });
    assert.strictEqual(httpCalled, false, 'expected NO HTTP call when key missing');
    const verdict = parseVerdict(result);
    assert.ok(verdict, 'expected a parseable verdict JSON');
    assert.strictEqual(verdict.signal_verdict, 'KILL', `expected KILL, got ${verdict.signal_verdict}`);
    assert.strictEqual(verdict.trade_action, 'REJECT', `expected REJECT, got ${verdict.trade_action}`);
    assert.strictEqual(verdict.confidence, 0, `expected confidence 0, got ${verdict.confidence}`);
    assert.strictEqual(passesExecutionGate(verdict), false, 'signal must NOT pass downstream execution gate');
    assert.strictEqual(result[0].json._grok_error, 'xAI API key missing');
    pass('SE-C2: missing xAI key → fail-closed KILL, no HTTP call, signal blocked');
  } catch (e) { fail('SE-C2 missing-key guard', e); }

  // Scenario 2: Grok API throws (SE-C7)
  try {
    let httpCalled = 0;
    const result = await run(runner, {
      item: SAMPLE_ITEM,
      apiKey: 'xai-test-key-12345',
      httpMock: async () => { httpCalled++; throw new Error('ECONNREFUSED api.x.ai'); }
    });
    assert.strictEqual(httpCalled, 1, 'expected exactly 1 HTTP call attempt');
    const verdict = parseVerdict(result);
    assert.ok(verdict, 'expected a parseable verdict JSON');
    assert.strictEqual(verdict.signal_verdict, 'KILL', `expected KILL fallback, got ${verdict.signal_verdict}`);
    assert.strictEqual(verdict.trade_action, 'REJECT', `expected REJECT, got ${verdict.trade_action}`);
    assert.strictEqual(verdict.confidence, 0, `expected confidence 0, got ${verdict.confidence}`);
    assert.strictEqual(passesExecutionGate(verdict), false, 'signal must NOT pass downstream execution gate on Grok failure');
    assert.ok(String(result[0].json._grok_error).includes('ECONNREFUSED'));
    pass('SE-C7: Grok API failure → fail-closed KILL, signal blocked');
  } catch (e) { fail('SE-C7 fail-closed fallback', e); }

  // Scenario 3: Happy path — Grok responds with valid analysis
  try {
    const grokAnalysis = JSON.stringify({
      signal_verdict: 'PASS', confidence: 8, trade_action: 'BUY'
    });
    const result = await run(runner, {
      item: SAMPLE_ITEM,
      apiKey: 'xai-test-key-12345',
      httpMock: async () => ({ choices: [{ message: { content: grokAnalysis } }] })
    });
    const verdict = parseVerdict(result);
    assert.ok(verdict, 'expected a parseable verdict JSON');
    assert.strictEqual(verdict.signal_verdict, 'PASS');
    assert.strictEqual(verdict.trade_action, 'BUY');
    assert.strictEqual(passesExecutionGate(verdict), true, 'valid PASS/BUY should proceed downstream');
    assert.strictEqual(result[0].json._grok_error, null);
    assert.strictEqual(result[0].json._grok_called, true);
    pass('Happy path: valid Grok response passes through verbatim');
  } catch (e) { fail('Happy path', e); }

  // Scenario 4: STAND ASIDE short-circuit (behavior-unchanged regression check)
  try {
    const result = await run(runner, {
      item: { ...SAMPLE_ITEM, execution: 'STAND ASIDE' },
      apiKey: 'xai-test-key-12345',
      httpMock: async () => { throw new Error('should not be called'); }
    });
    assert.deepStrictEqual(result, [], 'STAND ASIDE should return [] (no downstream fire)');
    pass('Regression: STAND ASIDE still short-circuits with []');
  } catch (e) { fail('STAND ASIDE regression', e); }

  // Scenario 5: Unexpected Grok response shape (defense-in-depth)
  try {
    const result = await run(runner, {
      item: SAMPLE_ITEM,
      apiKey: 'xai-test-key-12345',
      httpMock: async () => ({ weird: 'no choices field' })
    });
    const verdict = parseVerdict(result);
    assert.ok(verdict, 'expected a parseable verdict JSON');
    assert.strictEqual(verdict.signal_verdict, 'KILL',
      'unexpected response shape must fail closed (not be JSON.stringified through)');
    assert.strictEqual(passesExecutionGate(verdict), false);
    pass('Defense-in-depth: unexpected Grok response shape → fail closed');
  } catch (e) { fail('Unexpected response shape', e); }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => { console.error('Harness crashed:', e); process.exit(2); });
