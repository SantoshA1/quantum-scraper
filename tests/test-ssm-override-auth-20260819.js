#!/usr/bin/env node
'use strict';
/**
 * Maya regression guard — event overrides must authenticate; auth kills must be
 * attributable (gov 232, 2026-08-19).
 *
 * Maya asks: "Your Gap News Detector found a 3.5% gap-down on DLR, promoted it to a SELL
 * candidate, and then your own auth guard killed it as 'Invalid or missing webhook secret'
 * — and the audit wrote symbol UNKNOWN so nobody even knew WHAT died. Three a day since
 * 08-17. Prove FROM THE BYTES that (a) the deployed guard really rejects its own override
 * items — reproduce exec 608346 exactly; (b) after the patch the SAME item passes, because
 * the handoff now reads the ORIGINAL alert type the ingress stamped; (c) a forged payload
 * with the same fields but no internal ingress stamps still fails CLOSED — you have not
 * opened a bypass; (d) every legacy auth path (body secret, header secret, TradingView
 * fingerprint, plain scanner handoff) behaves byte-for-byte the same; and (e) when auth
 * DOES fail, the corpse now has a name on it."
 *
 * Deterministic + offline. The REAL auth region of the deployed/patched SSM node is
 * EXECUTED via new Function with stubbed $getWorkflowStaticData/$input. Secrets in this
 * suite are same-shape dummies — no production value appears here or in any fixture.
 * Fixtures (docs/gap-secret-20260819/):
 *   ssm-deployed.js               — live SSM bytes, version 379178db (sha db1ed3c2…)
 *   ssm-patched.js                — gov 232 candidate (sha 16a90e69…)
 *   gap-news-detector-deployed.js — GND bytes (sha bb6c2869…), evidence: override rewrite
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FIX = path.join(__dirname, '..', 'docs', 'gap-secret-20260819');
const OLD = fs.readFileSync(path.join(FIX, 'ssm-deployed.js'), 'utf8');
const NEW = fs.readFileSync(path.join(FIX, 'ssm-patched.js'), 'utf8');
const GND = fs.readFileSync(path.join(FIX, 'gap-news-detector-deployed.js'), 'utf8');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const count = (h, n) => h.split(n).length - 1;

const SECRET = 'f0'.repeat(32);           // same-shape dummy (64 hex) — NOT the real value
const WRONG  = 'a'.repeat(64);

function runAuth(src, { creds, item }) {
  const a = src.indexOf("{\n  const _authState = $getWorkflowStaticData('global');");
  const b = src.indexOf('// ── Correlation groups');
  assert.ok(a !== -1 && b > a, 'auth region markers missing');
  const region = src.slice(a, b).trimEnd();
  assert.ok(region.endsWith('}'), 'auth region must end at its closing brace');
  const fn = new Function('$getWorkflowStaticData', '$input', 'console',
    region + "\nreturn 'FELL_THROUGH';");
  return fn(() => ({ _credentials: creds }), { first: () => ({ json: item }) }, { log: () => {} });
}
const CREDS = { webhook_secret: SECRET };

// exec 608346's item, as the SSM actually received it (sanitized: no secrets on the item)
const overrideItem = () => ({
  ticker: 'DLR', symbol: 'DLR', alert_type: 'EVENT_OVERRIDE',
  _original_alert_type: 'BROAD_SCANNER', _ingress_source: 'TRADINGVIEW_MARKET_ALERT',
  _tv_payload_shape: 'ticker+market_fields', _source_ua: 'n8n', _event_override: true,
});
const scannerItem = () => ({
  ticker: 'CRDO', symbol: 'CRDO', alert_type: 'BROAD_SCANNER',
  _original_alert_type: 'BROAD_SCANNER', _ingress_source: 'TRADINGVIEW_MARKET_ALERT',
  _tv_payload_shape: 'ticker+market_fields', _source_ua: 'n8n',
});

let passed = 0, failed = 0;
async function check(id, name, fn) {
  try { await fn(); console.log(`  ✅ ${id}  ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${id}  ${name}\n        ${e.message}`); failed++; }
}

(async () => {
  console.log('\n═══ the bytes are the bytes being deployed ═══\n');

  await check('GS-01', 'fixtures match the artifacts handed to the deploy step', () => {
    assert.strictEqual(sha(OLD), 'db1ed3c20593f28f94d1605277bc25ed396b8a344e77aeb49e2ddd27f312b113');
    assert.strictEqual(sha(NEW), '16a90e696808cd5aa0a6dc460ea9b2f212b885e43780d09a7db3b14977466616');
    assert.strictEqual(sha(GND), 'bb6c28694745636068c535bb1b4429f65312f01be48d0e4311a0cc8dc3720996');
    // the GND evidence: it really does rewrite alert_type on overrides
    assert.ok(GND.includes("output.alert_type = 'EVENT_OVERRIDE';"));
  });

  console.log('\n═══ (a) the corpse: the guard kills its own override items ═══\n');

  await check('GS-02', 'REGRESSION WITNESS: exec-608346 item dies on the live bytes', () => {
    const item = overrideItem();
    const out = runAuth(OLD, { creds: CREDS, item });
    assert.notStrictEqual(out, 'FELL_THROUGH', 'old guard must reject the override item');
    assert.strictEqual(out[0].json._sm_action, 'AUTH_FAILED');
    assert.strictEqual(out[0].json._auth_reason, 'Invalid or missing webhook secret');
    assert.strictEqual(out[0].json.ticker, undefined, 'old fail item is anonymous — the audit-blindness witness');
  });

  console.log('\n═══ (b) the fix: the SAME item authenticates via its original type ═══\n');

  await check('GS-03', 'patched guard passes the override item through the upstream handoff', () => {
    const item = overrideItem();
    const out = runAuth(NEW, { creds: CREDS, item });
    assert.strictEqual(out, 'FELL_THROUGH', 'patched guard must fall through to the state machine');
    assert.strictEqual(item._auth_method, 'upstream_auth_gate');
  });

  await check('GS-04', 'no regression: plain sanitized scanner item passes on BOTH', () => {
    for (const src of [OLD, NEW]) {
      const item = scannerItem();
      assert.strictEqual(runAuth(src, { creds: CREDS, item }), 'FELL_THROUGH');
      assert.strictEqual(item._auth_method, 'upstream_auth_gate');
    }
  });

  console.log('\n═══ (c) fail-closed holds: the fix grants NOTHING by itself ═══\n');

  await check('GS-05', 'forged override without ingress stamps still fails on BOTH', () => {
    for (const src of [OLD, NEW]) {
      const forged = { ticker: 'EVIL', alert_type: 'EVENT_OVERRIDE',
        _original_alert_type: 'BROAD_SCANNER', _source_ua: 'n8n' }; // no _ingress_source/_tv_payload_shape
      const out = runAuth(src, { creds: CREDS, item: forged });
      assert.notStrictEqual(out, 'FELL_THROUGH', 'forged item must be rejected');
      assert.strictEqual(out[0].json._sm_action, 'AUTH_FAILED');
    }
  });

  console.log('\n═══ (d) every legacy auth path byte-for-byte intact ═══\n');

  await check('GS-06', 'body-secret compare: right secret passes, wrong secret fails (both)', () => {
    for (const src of [OLD, NEW]) {
      assert.strictEqual(runAuth(src, { creds: CREDS, item: { _secret: SECRET, alert_type: 'X' } }), 'FELL_THROUGH');
      const out = runAuth(src, { creds: CREDS, item: { _secret: WRONG, alert_type: 'X', ticker: 'ZZ' } });
      assert.strictEqual(out[0].json._sm_action, 'AUTH_FAILED');
    }
  });

  await check('GS-07', 'GND-propagated header secret passes (both)', () => {
    for (const src of [OLD, NEW]) {
      const item = { _header_webhook_secret: SECRET, alert_type: 'X' };
      assert.strictEqual(runAuth(src, { creds: CREDS, item }), 'FELL_THROUGH');
      assert.strictEqual(item._auth_method, 'header_secret');
    }
  });

  await check('GS-08', 'TradingView fingerprint path intact (both)', () => {
    for (const src of [OLD, NEW]) {
      const item = { _source_ua: 'Go-http-client/2.0', bias_score: '88', vix: '24', regime: 'TRENDING', adx: '30' };
      assert.strictEqual(runAuth(src, { creds: CREDS, item }), 'FELL_THROUGH');
      assert.strictEqual(item._auth_method, 'tv_fingerprint');
    }
  });

  console.log('\n═══ (e) failed auth now leaves a named corpse ═══\n');

  await check('GS-09', 'patched fail items carry ticker+symbol for the audit writeback', () => {
    const bad = runAuth(NEW, { creds: CREDS, item: { _secret: WRONG, ticker: 'DLR', symbol: 'DLR' } });
    assert.strictEqual(bad[0].json._sm_action, 'AUTH_FAILED');
    assert.strictEqual(bad[0].json.ticker, 'DLR');
    assert.strictEqual(bad[0].json.symbol, 'DLR');
    const mis = runAuth(NEW, { creds: {}, item: { ticker: 'WMB' } });
    assert.match(mis[0].json._auth_reason, /not configured/);
    assert.strictEqual(mis[0].json.ticker, 'WMB', 'misconfig path must also attribute');
  });

  await check('GS-10', 'scope: exactly 3 sites changed; NEGATIVE CONTROL on old bytes', () => {
    assert.strictEqual(count(NEW, '_authRaw._original_alert_type ||'), 1);
    assert.strictEqual(count(OLD, '_authRaw._original_alert_type ||'), 0);
    assert.strictEqual(count(NEW, 'gov232: carry identity'), 2);
    assert.strictEqual(count(OLD, 'gov232'), 0);
    // untouched load-bearing strings drift check
    for (const s of ['HEARTBEAT','BROAD_SCANNER','REALTIME_AGENT_HYBRID','POLYGON_NEWS','STRONG_SETUP',
                     'QTP_SSM_AUTH_HANDOFF_20260508', 'Constant-time comparison', 'tv_fingerprint']) {
      assert.strictEqual(count(OLD, s), count(NEW, s), `drift: ${s}`);
    }
    // old bytes must fail the fix assertions (suite bites)
    const item = overrideItem();
    assert.notStrictEqual(runAuth(OLD, { creds: CREDS, item }), 'FELL_THROUGH');
  });

  console.log(`\n  ${passed}/${passed + failed} checks passed\n`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('HARNESS FAILURE:', e); process.exit(1); });
