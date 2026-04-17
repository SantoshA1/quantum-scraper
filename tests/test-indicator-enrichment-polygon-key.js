#!/usr/bin/env node
/**
 * Test harness for SE-C1: Polygon API key sourcing in the Signal State Machine.
 *
 * Covers TWO surfaces inside signal-state-machine-v5.21-sheets-v2.json:
 *   1. The `Indicator Enrichment` Code node (was: hardcoded POLYGON_KEY constant)
 *   2. The 4 `Fetch ...` HTTP Request node URLs (was: literal apiKey=<hardcoded>)
 *
 * Properties asserted:
 *   A. The leaked key `LxG0VrVzcQYEtWDfg8d6G49iapiC4Ec_` is absent from every
 *      node parameter in the workflow JSON (top-level AND activeVersion).
 *   B. Every Polygon URL references the workflow credential expression
 *      `polygon_api_key` (i.e. no bare literal keys remain).
 *   C. Indicator Enrichment Code node fails CLOSED when the credential is
 *      missing — no HTTP calls are made, and the item is forwarded with a
 *      data-quality flag that prevents downstream fake-indicator use.
 *   D. Indicator Enrichment Code node happy path: with a credential present
 *      and the 5 indicators missing from the item, it calls Polygon once per
 *      missing indicator and enriches the item.
 *   E. Regression: if all indicators are present, NO HTTP calls are made
 *      (pre-existing short-circuit preserved).
 *
 * Run:  node tests/test-indicator-enrichment-polygon-key.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const WORKFLOW = path.join(
  __dirname, '..',
  'n8n-workflows/signal-state-machine-v5.21-sheets-v2.json'
);
const LEAKED_KEY = 'LxG0VrVzcQYEtWDfg8d6G49iapiC4Ec_';
const INDICATOR_NODE = 'Indicator Enrichment';
const HTTP_NODES = [
  'Fetch Options Chain',
  'Fetch Price History',
  'Fetch Cross-Asset Today',
  'Fetch Cross-Asset Previous',
];

function loadWorkflow() {
  return JSON.parse(fs.readFileSync(WORKFLOW, 'utf8'));
}

function findNode(wf, name, where = 'top') {
  const nodes = where === 'top'
    ? (wf.nodes || [])
    : ((wf.activeVersion || {}).nodes || []);
  return nodes.find(n => n.name === name);
}

function buildRunner(jsCode) {
  const wrapped = `
    return (async function($input, $getWorkflowStaticData) {
      ${jsCode}
    }).call(this, $input, $getWorkflowStaticData);
  `;
  // eslint-disable-next-line no-new-func
  return new Function('$input', '$getWorkflowStaticData', wrapped);
}

async function runIndicatorNode({ item, apiKey, httpMock }) {
  const wf = loadWorkflow();
  const node = findNode(wf, INDICATOR_NODE);
  const runner = buildRunner(node.parameters.jsCode);

  const $input = { first: () => ({ json: item }) };
  const staticData = { _credentials: apiKey ? { polygon_api_key: apiKey } : {} };
  const $getWorkflowStaticData = () => staticData;
  const ctx = { helpers: { httpRequest: httpMock } };
  return await runner.call(ctx, $input, $getWorkflowStaticData);
}

const SAMPLE_ITEM = {
  ticker: 'AAPL',
  timeframe: '15',
  rsi: 0, macd_hist: 0, sma50: 0, ema200: 0, vwap: 0,
  price: '185.42',
};

async function main() {
  let passed = 0, failed = 0;
  const pass = (n) => { passed++; console.log(`\u2713 ${n}`); };
  const fail = (n, e) => { failed++; console.error(`\u2717 ${n}`); console.error('  ', e.message); };

  // ===== Property A: leaked key is absent from every node parameter =====
  try {
    const wf = loadWorkflow();
    const checkNodes = (nodes, label) => {
      for (const n of nodes || []) {
        const blob = JSON.stringify(n.parameters || {});
        assert.ok(!blob.includes(LEAKED_KEY),
          `${label}: leaked key found in node '${n.name}'`);
      }
    };
    checkNodes(wf.nodes, 'top-level nodes');
    checkNodes((wf.activeVersion || {}).nodes, 'activeVersion.nodes');
    pass('A: leaked Polygon key is absent from every node parameter (top-level + activeVersion)');
  } catch (e) { fail('A: leaked-key scan', e); }

  // ===== Property B: every Polygon URL references the credential expression =====
  try {
    const wf = loadWorkflow();
    for (const layer of ['nodes', 'activeVersion']) {
      const nodes = layer === 'nodes'
        ? wf.nodes : ((wf.activeVersion || {}).nodes || []);
      for (const name of HTTP_NODES) {
        const n = nodes.find(x => x.name === name);
        if (!n) continue;
        const url = (n.parameters || {}).url || '';
        assert.ok(url.includes('polygon_api_key'),
          `${layer}:${name}: URL lacks polygon_api_key credential reference`);
        assert.ok(!url.includes(LEAKED_KEY),
          `${layer}:${name}: still has leaked key`);
      }
    }
    pass('B: every Polygon HTTP node URL references polygon_api_key credential');
  } catch (e) { fail('B: URL credential references', e); }

  // ===== Property C: missing-key fail-closed behavior =====
  try {
    let httpCalls = 0;
    const result = await runIndicatorNode({
      item: SAMPLE_ITEM,
      apiKey: null, // credential not configured
      httpMock: async () => { httpCalls++; return {}; },
    });
    assert.strictEqual(httpCalls, 0, 'expected ZERO HTTP calls when key missing');
    assert.ok(Array.isArray(result) && result.length === 1);
    const out = result[0].json;
    assert.strictEqual(out._dq_polygon_key_missing, true);
    assert.strictEqual(out._dq_quality_score, 0);
    assert.strictEqual(out._dq_missing_fields, 'POLYGON_API_KEY');
    // Critical: the original item fields are preserved, not fabricated indicators
    assert.strictEqual(out.rsi, SAMPLE_ITEM.rsi);
    assert.strictEqual(out.macd_hist, SAMPLE_ITEM.macd_hist);
    pass('C: missing Polygon credential \u2192 fail-closed, no HTTP calls, DQ flag set');
  } catch (e) { fail('C: missing-key fail-closed', e); }

  // ===== Property D: happy path with credential present =====
  try {
    let httpCalls = [];
    const result = await runIndicatorNode({
      item: SAMPLE_ITEM,
      apiKey: 'polygon-test-key-abc123',
      httpMock: async ({ url }) => {
        httpCalls.push(url);
        assert.ok(url.includes('apiKey=polygon-test-key-abc123'),
          'Polygon URL must embed the configured credential');
        assert.ok(!url.includes(LEAKED_KEY),
          'Polygon URL must not reintroduce the leaked key');
        // Return shapes matching what the node expects for each indicator
        if (url.includes('/indicators/rsi/')) {
          return { results: { values: [{ value: 55.25 }] } };
        } else if (url.includes('/indicators/macd/')) {
          return { results: { values: [{ histogram: 0.1234 }] } };
        } else if (url.includes('/indicators/sma/')) {
          return { results: { values: [{ value: 180.50 }] } };
        } else if (url.includes('/indicators/ema/')) {
          return { results: { values: [{ value: 170.00 }] } };
        } else if (url.includes('/v2/aggs/ticker/')) {
          return { results: [{ vw: 183.45 }] };
        }
        return {};
      },
    });
    assert.ok(Array.isArray(result) && result.length === 1);
    const out = result[0].json;
    assert.strictEqual(out._enriched, true);
    assert.strictEqual(out.rsi, '55.25');
    assert.strictEqual(out.macd_hist, '0.1234');
    assert.strictEqual(out.sma50, '180.50');
    assert.strictEqual(out.ema200, '170.00');
    assert.strictEqual(out.vwap, '183.45');
    // Should have made one call per missing indicator (5 indicators \u2192 5 calls)
    assert.ok(httpCalls.length >= 5, `expected \u22655 HTTP calls, got ${httpCalls.length}`);
    pass('D: happy path \u2014 credential embedded, 5 indicators fetched, no leaked key in URLs');
  } catch (e) { fail('D: happy path', e); }

  // ===== Property E: regression \u2014 fully-populated item short-circuits =====
  try {
    let httpCalls = 0;
    const fullItem = {
      ticker: 'AAPL',
      timeframe: '15',
      rsi: '55.00',
      macd_hist: '0.12',
      sma50: '180.0',
      ema200: '170.0',
      vwap: '183.0',
    };
    const result = await runIndicatorNode({
      item: fullItem,
      apiKey: 'polygon-test-key-abc123',
      httpMock: async () => { httpCalls++; return {}; },
    });
    assert.strictEqual(httpCalls, 0, 'expected no HTTP calls when all indicators present');
    assert.ok(Array.isArray(result) && result.length === 1);
    pass('E: regression \u2014 fully-populated item still short-circuits (no HTTP)');
  } catch (e) { fail('E: pass-through regression', e); }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => { console.error('Harness crashed:', e); process.exit(2); });
