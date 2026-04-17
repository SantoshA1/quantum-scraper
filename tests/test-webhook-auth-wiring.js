#!/usr/bin/env node
/* ─────────────────────────────────────────────────────────────
 *  PR #9 — Webhook auth wiring tests (SM-C4 + SE-C5)
 *
 *  What this verifies (6 properties):
 *    A. Each caller workflow's signal-emitting code/HTTP node now
 *       references the webhook_secret credential.
 *    B. SSM v5.21 auth guard REJECTS a payload with no _secret.
 *    C. SSM v5.21 auth guard REJECTS a payload with the wrong _secret.
 *    D. SSM v5.21 auth guard ACCEPTS a payload with the correct _secret.
 *    E. app.js requireInternalToken middleware fails closed on missing
 *       INTERNAL_API_TOKEN env var (503), and rejects with bad token (401).
 *    F. app.js requireInternalToken accepts correct token via header,
 *       Bearer auth, and ?token= (GET) — all three forms.
 *
 *  How it runs:
 *    - node tests/test-webhook-auth-wiring.js
 *    - Parses the workflow JSON for (A), (B), (C), (D).
 *    - For (B-D) we extract the SSM Code node jsCode, wrap it in an
 *      async IIFE, mock $getWorkflowStaticData and $input, and check
 *      its first output item for _sm_action.
 *    - For (E-F) we require() app.js? No — app.js calls process.exit
 *      without XAI_API_KEY. Instead we copy the middleware logic out
 *      into this test (same function body, evaluated here) and hit it
 *      with crafted req/res mocks. The middleware is self-contained.
 *
 *  The middleware copy is not ideal, but it's stable (pure function of
 *  process.env.INTERNAL_API_TOKEN + req headers/query). Any drift will
 *  be caught by the explicit source-check assertions at the end.
 * ───────────────────────────────────────────────────────────── */
'use strict';

const fs   = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const WF   = path.join(REPO, 'n8n-workflows');

let passed = 0, failed = 0;
const results = [];
function check(name, cond, detail = '') {
  if (cond) { passed++; results.push({ name, ok: true }); console.log(`  ✅ ${name}`); }
  else      { failed++; results.push({ name, ok: false, detail }); console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}

// ─────────────────────────────────────────────────────────────
//  PROPERTY A — caller workflows reference webhook_secret
// ─────────────────────────────────────────────────────────────
console.log('\n[A] Caller workflows reference webhook_secret');

function readWf(name) {
  return JSON.parse(fs.readFileSync(path.join(WF, name), 'utf8'));
}

// Broad Scanner
{
  const wf = readWf('broad-scanner.json');
  const node = wf.nodes.find(n => n.name === 'Scan All Tickers');
  const code = node.parameters.jsCode;
  check('broad-scanner: Scan All Tickers loads _WEBHOOK_SECRET',
    code.includes('_WEBHOOK_SECRET') && code.includes('webhook_secret'));
  check('broad-scanner: signal object includes _secret field',
    /signals\.push\(\{\s*json:\s*\{\s*_secret:\s*_WEBHOOK_SECRET/.test(code));
}

// RT Signal Agent
{
  const wf = readWf('rt-signal-agent.json');
  const node = wf.nodes.find(n => n.name === 'Fetch & Evaluate');
  const code = node.parameters.jsCode;
  check('rt-signal-agent: Fetch & Evaluate loads _WEBHOOK_SECRET',
    code.includes('_WEBHOOK_SECRET'));
  check('rt-signal-agent: outgoing httpRequest body includes _secret',
    /body:\s*\{\s*_secret:\s*_WEBHOOK_SECRET,\s*ticker:/.test(code));
  // SM-C4 regression: heartbeat (no-signal) return must carry _no_signals
  // so Push to Pipeline short-circuits and never POSTs an unauth'd payload.
  check('rt-signal-agent: heartbeat return carries _no_signals flag',
    /return\s*\{\s*_no_signals:\s*true,\s*signalsFound,\s*tickersScanned/.test(code));
}

// Daily Testing Agent
{
  const wf = readWf('daily-testing-agent-health-report.json');
  const node = wf.nodes.find(n => n.name === 'Testing Agent — Node A');
  const code = node.parameters.jsCode;
  check('daily-testing: Node A loads _WEBHOOK_SECRET',
    code.includes('_WEBHOOK_SECRET'));
  check('daily-testing: T7 probe body includes _secret',
    /body:\s*\{\s*_secret:\s*_WEBHOOK_SECRET,\s*ticker:\s*'TWTEST'/.test(code));
  check('daily-testing: fire() payload spreads _secret',
    /JSON\.stringify\(\{\s*_secret:\s*_WEBHOOK_SECRET,\s*\.\.\.payload/.test(code));
}

// Polygon News Grok Sentiment
{
  const wf = readWf('polygon-news-grok-sentiment.json');
  const set = wf.nodes.find(n => n.name === 'Watchlist and Config');
  const assigns = set.parameters.assignments.assignments;
  check('polygon-sentiment: Watchlist and Config assigns webhook_secret',
    assigns.some(a => a.name === 'webhook_secret'
      && String(a.value).includes('webhook_secret')));

  const split = wf.nodes.find(n => n.name === 'Split and Prepare Tickers');
  check('polygon-sentiment: Split forwards webhook_secret per-item',
    /webhook_secret:\s*cfg\.webhook_secret/.test(split.parameters.jsCode));

  const parse = wf.nodes.find(n => n.name === 'Parse and Validate Score');
  check('polygon-sentiment: Parse forwards webhook_secret to final item',
    /webhook_secret:\s*meta\.webhook_secret/.test(parse.parameters.jsCode));

  const post  = wf.nodes.find(n => n.name === 'POST Kill to Signal State Machine');
  check('polygon-sentiment: POST Kill body includes _secret',
    /_secret:\s*\$json\.webhook_secret/.test(post.parameters.jsonBody));
}

// ─────────────────────────────────────────────────────────────
//  PROPERTY B, C, D — SSM auth guard behavior
// ─────────────────────────────────────────────────────────────
console.log('\n[B/C/D] SSM auth guard');

// Extract SSM auth guard and run it in isolation.
function extractAuthGuard() {
  const wf = readWf('signal-state-machine-v5.21-sheets-v2.json');
  const node = wf.nodes.find(n => n.name === 'Signal State Machine');
  const full = node.parameters.jsCode;
  // The auth guard is a stand-alone block ending with the AUTH PASSED comment.
  const endMarker = '// ── AUTH PASSED — continue to Signal State Machine ───────────';
  const endIdx = full.indexOf(endMarker);
  if (endIdx === -1) throw new Error('AUTH PASSED marker not found in SSM jsCode');
  // Find start: the `{` that opens the auth block, right after the C-3 comment header.
  const headerIdx = full.indexOf('// ── C-3 FIX: Webhook Authentication');
  if (headerIdx === -1) throw new Error('C-3 header marker not found');
  return full.slice(headerIdx, endIdx);
}

async function runAuthGuard({ credentials, payload }) {
  const guardSource = extractAuthGuard();
  // Mock the n8n runtime globals the guard uses.
  const mockStatic = { _credentials: credentials };
  const $getWorkflowStaticData = () => mockStatic;
  const $input = { first: () => ({ json: payload }) };
  // The auth guard does `return [{ json: ... }]` from an *outer* function
  // context. Wrap in an async fn so `return` is legal.
  const fn = new Function('$getWorkflowStaticData', '$input',
    `return (async () => {\n${guardSource}\nreturn 'PASS';\n})();`);
  return await fn($getWorkflowStaticData, $input);
}

const SECRET = 'test-webhook-secret-abcdef123456';

(async () => {
  // B: no _secret → AUTH_FAILED
  {
    const r = await runAuthGuard({
      credentials: { webhook_secret: SECRET },
      payload: { ticker: 'AAPL', execution: 'BUY' },
    });
    check('B: SSM rejects payload missing _secret',
      Array.isArray(r) && r[0]?.json?._sm_action === 'AUTH_FAILED',
      JSON.stringify(r).slice(0, 120));
  }

  // C: wrong _secret → AUTH_FAILED
  {
    const r = await runAuthGuard({
      credentials: { webhook_secret: SECRET },
      payload: { ticker: 'AAPL', execution: 'BUY', _secret: 'WRONG' },
    });
    check('C: SSM rejects payload with wrong _secret',
      Array.isArray(r) && r[0]?.json?._sm_action === 'AUTH_FAILED',
      JSON.stringify(r).slice(0, 120));
  }

  // D: correct _secret → PASS (guard falls through)
  {
    const r = await runAuthGuard({
      credentials: { webhook_secret: SECRET },
      payload: { ticker: 'AAPL', execution: 'BUY', _secret: SECRET },
    });
    check('D: SSM accepts payload with correct _secret',
      r === 'PASS',
      JSON.stringify(r).slice(0, 120));
  }

  // D-bis: missing credential config → AUTH_FAILED (fail-closed misconfig guard)
  {
    const r = await runAuthGuard({
      credentials: {},
      payload: { ticker: 'AAPL', _secret: SECRET },
    });
    check('D-bis: SSM fails closed when webhook_secret not configured',
      Array.isArray(r) && r[0]?.json?._sm_action === 'AUTH_FAILED');
  }

  // ─────────────────────────────────────────────────────────────
  //  PROPERTY E, F — app.js INTERNAL_API_TOKEN middleware
  // ─────────────────────────────────────────────────────────────
  console.log('\n[E/F] app.js requireInternalToken middleware');

  // Extract middleware source from app.js and eval it.
  const appSrc = fs.readFileSync(path.join(REPO, 'app.js'), 'utf8');
  const ctEqMatch = appSrc.match(/function constantTimeEq[\s\S]*?\n\}\n/);
  const reqMatch  = appSrc.match(/function requireInternalToken[\s\S]*?\n\}\n/);
  if (!ctEqMatch || !reqMatch) throw new Error('middleware source not found in app.js');

  function makeMw(token) {
    const src = `${ctEqMatch[0]}\n${reqMatch[0]}\nreturn { requireInternalToken };`;
    const factory = new Function('INTERNAL_API_TOKEN', src);
    return factory(token).requireInternalToken;
  }

  function callMw(mw, req) {
    return new Promise((resolve) => {
      const res = {
        statusCode: 200,
        _body: null,
        status(c) { this.statusCode = c; return this; },
        json(b) { this._body = b; resolve({ status: this.statusCode, body: b }); return this; },
      };
      const next = () => resolve({ status: 200, body: null, nexted: true });
      try { mw(req, res, next); } catch (e) { resolve({ status: 500, body: { error: e.message } }); }
    });
  }

  // E: missing env var → 503
  {
    const mw = makeMw('');
    const r = await callMw(mw, { method: 'POST', path: '/run', headers: {}, query: {}, ip: '1.1.1.1' });
    check('E: missing INTERNAL_API_TOKEN → 503 Service not configured',
      r.status === 503 && r.body?.error === 'Service not configured');
  }

  // E: wrong token → 401
  {
    const mw = makeMw('correct-token');
    const r = await callMw(mw, {
      method: 'POST', path: '/run',
      headers: { 'x-internal-token': 'wrong' }, query: {}, ip: '1.1.1.1',
    });
    check('E: wrong token → 401 Unauthorized', r.status === 401);
  }

  // E: no token presented → 401
  {
    const mw = makeMw('correct-token');
    const r = await callMw(mw, { method: 'POST', path: '/run', headers: {}, query: {}, ip: '1.1.1.1' });
    check('E: no token presented → 401 Unauthorized', r.status === 401);
  }

  // F: correct x-internal-token → next()
  {
    const mw = makeMw('correct-token');
    const r = await callMw(mw, {
      method: 'POST', path: '/run',
      headers: { 'x-internal-token': 'correct-token' }, query: {}, ip: '1.1.1.1',
    });
    check('F: correct header token → next() called', r.nexted === true);
  }

  // F: correct Bearer token → next()
  {
    const mw = makeMw('correct-token');
    const r = await callMw(mw, {
      method: 'POST', path: '/signal',
      headers: { authorization: 'Bearer correct-token' }, query: {}, ip: '1.1.1.1',
    });
    check('F: correct Bearer token → next() called', r.nexted === true);
  }

  // F: correct ?token=... on GET → next()
  {
    const mw = makeMw('correct-token');
    const r = await callMw(mw, {
      method: 'GET', path: '/results',
      headers: {}, query: { token: 'correct-token' }, ip: '1.1.1.1',
    });
    check('F: correct query token on GET → next() called', r.nexted === true);
  }

  // F-negative: ?token=... on POST is ignored (header-only path)
  {
    const mw = makeMw('correct-token');
    const r = await callMw(mw, {
      method: 'POST', path: '/signal',
      headers: {}, query: { token: 'correct-token' }, ip: '1.1.1.1',
    });
    check('F-neg: query token on POST is rejected (header/bearer only)', r.status === 401);
  }

  // ─────────────────────────────────────────────────────────────
  //  Source-level sanity: the 5 protected routes in app.js all
  //  pass requireInternalToken as a middleware.
  // ─────────────────────────────────────────────────────────────
  console.log('\n[Source] app.js protected-route wiring');
  const routes = [
    [/app\.post\('\/run',\s*requireInternalToken/,          'POST /run'],
    [/app\.post\('\/signal',\s*requireInternalToken/,       'POST /signal'],
    [/app\.post\('\/ai-analysis',\s*requireInternalToken/,  'POST /ai-analysis'],
    [/app\.get\('\/technical',\s*requireInternalToken/,     'GET  /technical'],
    [/app\.get\('\/results',\s*requireInternalToken/,       'GET  /results'],
  ];
  for (const [re, label] of routes) {
    check(`${label} has requireInternalToken middleware`, re.test(appSrc));
  }
  // /health should NOT require token (Railway probes)
  check('/health is NOT gated (Railway liveness probe)',
    /app\.get\('\/health',\s*\(_req/.test(appSrc));

  console.log(`\n═══════════════════════════════════════════`);
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log(`═══════════════════════════════════════════\n`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(err => {
  console.error('FATAL:', err);
  process.exit(2);
});
