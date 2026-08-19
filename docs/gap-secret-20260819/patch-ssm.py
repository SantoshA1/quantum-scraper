#!/usr/bin/env python3
# gov 232 count-asserted patch: EVENT_OVERRIDE signals must authenticate like their
# parent scanner item; AUTH_FAILED audit rows must carry the ticker.
import hashlib

src = open('ssm-deployed.js').read()

CHAIN_OLD = "  const _handoffAlertType = String(_authRaw.alert_type || _authRaw._alert_type || _authBody.alert_type || '').toUpperCase();"
CHAIN_NEW = """  // QTP_SSM_HANDOFF_ORIG_ALERT_v1_gov232_20260819: the Gap News Detector rewrites
  // alert_type to EVENT_OVERRIDE (not in the handoff allowlist), so every gap/vix/surge
  // override died here as AUTH_FAILED (3/day since 08-17; e.g. exec 608346 DLR gap-down
  // SELL, 607166 ABNB gap-up BUY) while the ORIGINAL trusted type sat unread in
  // _original_alert_type. Resolve the original type FIRST; override items then
  // authenticate exactly like the scanner item they came from. No new surface: same
  // allowlist, same _ingress_source + payload-shape gates still required.
  const _handoffAlertType = String(_authRaw._original_alert_type || _authRaw.alert_type || _authRaw._alert_type || _authBody.alert_type || '').toUpperCase();"""

FAIL1_OLD = """    return [{ json: {
      _sm_action: 'AUTH_FAILED',
      _sm_route: 'SKIP',
      _auth_reason: 'webhook_secret not configured in staticData._credentials — fail-closed',
      _auth_ts: new Date().toISOString()
    }}];"""
FAIL1_NEW = """    return [{ json: {
      _sm_action: 'AUTH_FAILED',
      _sm_route: 'SKIP',
      _auth_reason: 'webhook_secret not configured in staticData._credentials — fail-closed',
      _auth_ts: new Date().toISOString(),
      // gov232: carry identity so the audit writeback attributes the kill (was symbol UNKNOWN)
      ticker: String(_authRaw.ticker || _authBody.ticker || ''),
      symbol: String(_authRaw.symbol || _authBody.symbol || _authRaw.ticker || _authBody.ticker || '')
    }}];"""

FAIL2_OLD = """        return [{ json: {
          _sm_action: 'AUTH_FAILED',
          _sm_route: 'SKIP',
          _auth_reason: 'Invalid or missing webhook secret',
          _auth_ts: new Date().toISOString(),
          _auth_ip: (_authHeaders['x-forwarded-for'] || _authHeaders['x-real-ip'] || 'unknown').toString().split(',')[0].trim()
        }}];"""
FAIL2_NEW = """        return [{ json: {
          _sm_action: 'AUTH_FAILED',
          _sm_route: 'SKIP',
          _auth_reason: 'Invalid or missing webhook secret',
          _auth_ts: new Date().toISOString(),
          _auth_ip: (_authHeaders['x-forwarded-for'] || _authHeaders['x-real-ip'] || 'unknown').toString().split(',')[0].trim(),
          // gov232: carry identity so the audit writeback attributes the kill (was symbol UNKNOWN)
          ticker: String(_authRaw.ticker || _authBody.ticker || ''),
          symbol: String(_authRaw.symbol || _authBody.symbol || _authRaw.ticker || _authBody.ticker || '')
        }}];"""

out = src
for old, new, label in [(CHAIN_OLD, CHAIN_NEW, 'chain'), (FAIL1_OLD, FAIL1_NEW, 'fail-misconfig'), (FAIL2_OLD, FAIL2_NEW, 'fail-invalid')]:
    n = out.count(old)
    assert n == 1, f"{label}: expected 1 occurrence, found {n}"
    out = out.replace(old, new, 1)

assert out.count('_authRaw._original_alert_type ||') == 1
assert out.count('QTP_SSM_HANDOFF_ORIG_ALERT_v1_gov232_20260819') == 1
assert out.count('gov232: carry identity') == 2
# remainder identical outside the three sites
probe = src
for old in [CHAIN_OLD, FAIL1_OLD, FAIL2_OLD]: probe = probe.replace(old, '\x00', 1)
probe2 = out
for new in [CHAIN_NEW, FAIL1_NEW, FAIL2_NEW]: probe2 = probe2.replace(new, '\x00', 1)
assert probe == probe2, 'patch leaked outside the three sites'
# no secret-shaped literal introduced
import re
assert not re.search(r"['\"][A-Fa-f0-9]{40,}['\"]", out), 'hex literal in patched bytes'

open('ssm-patched.js', 'w').write(out)
print('OLD sha256:', hashlib.sha256(src.encode()).hexdigest())
print('NEW sha256:', hashlib.sha256(out.encode()).hexdigest())
print('sizes:', len(src), '->', len(out))
print('PATCH OK — 3 sites, 0 collateral')
