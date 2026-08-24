#!/usr/bin/env python3
# gov 239 count-asserted patch: add the earnings-calendar liveness leg to the
# Dead-Man's Switch. The staleness alarm inside the nightly earnings workflow can never
# report "that workflow stopped running" — this monitor runs independently and can.
import hashlib
src = open('check-agent-health-deployed.js').read()

A_OLD = """// Determine health
const agentHealthy = saSuccessToday >= 3 && saErrorsToday < saSuccessToday;
const pipelineHealthy = ssToday > 0;
const allHealthy = agentHealthy && pipelineHealthy; // QTP_RAILWAY_DECOMMISSION_20260724: railwayOk dropped"""

A_NEW = """// QTP_EARNINGS_LIVENESS_v1_gov239_20260824: the earnings guard's own staleness alarm
// lives INSIDE the nightly workflow, so it can report "the fetch came back empty" but can
// never report "that workflow stopped running" (the gov-216/231 guard-can't-fire class).
// This monitor runs independently, so it can. The upstream node computes the expectation
// in SQL (most recent weekday 18:10 ET); we only read the verdict. Fail-SAFE: if the probe
// itself returns nothing, that is treated as UNHEALTHY, never as silence.
const _ecRaw = $('Check Earnings Calendar Freshness').first().json || {};
const ecProbeOk = _ecRaw.calendar_fresh !== undefined && _ecRaw.calendar_fresh !== null;
const ecFresh = ecProbeOk ? (_ecRaw.calendar_fresh === true || _ecRaw.calendar_fresh === 'true') : false;
const ecHours = _ecRaw.hours_since_refresh === null || _ecRaw.hours_since_refresh === undefined
  ? null : Number(_ecRaw.hours_since_refresh);
const ecForward = Number(_ecRaw.forward_rows || 0);
const ecExpected = String(_ecRaw.expected_last_refresh_et || 'unknown');
const earningsHealthy = ecProbeOk && ecFresh && ecForward > 0;

// Determine health
const agentHealthy = saSuccessToday >= 3 && saErrorsToday < saSuccessToday;
const pipelineHealthy = ssToday > 0;
const allHealthy = agentHealthy && pipelineHealthy && earningsHealthy; // gov239: earnings liveness joined"""

B_OLD = """  lines.push('AI Super Score: ' + ssToday + ' executions received');
  lines.push('Railway Scraper: ' + railwayStatus);"""
B_NEW = """  lines.push('AI Super Score: ' + ssToday + ' executions received');
  lines.push('Earnings Calendar: fresh (' + (ecHours === null ? '?' : ecHours.toFixed(1)) + 'h, ' + ecForward + ' forward rows)');
  lines.push('Railway Scraper: ' + railwayStatus);"""

C_OLD = """  if (!railwayOk) {
    lines.push(String.fromCharCode(128308) + ' <b>Railway Scraper: ' + railwayStatus + '</b>');
    lines.push('');
  }
  lines.push('<i>Check n8n immediately: https://tradenextgen.app.n8n.cloud</i>');"""
C_NEW = """  if (!earningsHealthy) {
    lines.push(String.fromCharCode(128308) + ' <b>EARNINGS CALENDAR STALE - entry guard is FAILING OPEN</b>');
    if (!ecProbeOk) {
      lines.push('  Freshness probe returned no verdict (treated as unhealthy).');
    } else {
      lines.push('  Last refresh: ' + (ecHours === null ? 'never' : ecHours.toFixed(1) + 'h ago')
        + ' | expected by: ' + ecExpected + ' ET');
      lines.push('  Forward rows: ' + ecForward);
    }
    lines.push('  <b>Earnings-window entries are NOT being blocked. WMT lost 7.9R this way on 08-20.</b>');
    lines.push('  Check workflow SDE0GVo9FeFqvpxS (nightly 18:10 ET) and $vars.ALPHAVANTAGE_API_KEY.');
    lines.push('');
  }
  if (!railwayOk) {
    lines.push(String.fromCharCode(128308) + ' <b>Railway Scraper: ' + railwayStatus + '</b>');
    lines.push('');
  }
  lines.push('<i>Check n8n immediately: https://tradenextgen.app.n8n.cloud</i>');"""

D_OLD = """  pipeline_runs: ssToday,
  railway_ok: railwayOk
}}];"""
D_NEW = """  pipeline_runs: ssToday,
  railway_ok: railwayOk,
  earnings_healthy: earningsHealthy,
  earnings_probe_ok: ecProbeOk,
  earnings_hours_since_refresh: ecHours,
  earnings_forward_rows: ecForward
}}];"""

out = src
for old, new, label in [(A_OLD,A_NEW,'health-calc'),(B_OLD,B_NEW,'green-line'),(C_OLD,C_NEW,'alarm-block'),(D_OLD,D_NEW,'return-fields')]:
    n = out.count(old)
    assert n == 1, f"{label}: expected 1 occurrence, found {n}"
    out = out.replace(old, new, 1)

assert out.count('QTP_EARNINGS_LIVENESS_v1_gov239_20260824') == 1
assert out.count('earningsHealthy') == 4
assert out.count("$('Check Earnings Calendar Freshness')") == 1
assert out.count('$vars.N8N_API_KEY') == 1, 'key-by-name must survive'
# fail-safe: probe returning nothing must NOT be healthy
assert 'ecProbeOk && ecFresh && ecForward > 0' in out
# nothing else changed
probe = src
for o in [A_OLD,B_OLD,C_OLD,D_OLD]: probe = probe.replace(o,'\x00',1)
probe2 = out
for n2 in [A_NEW,B_NEW,C_NEW,D_NEW]: probe2 = probe2.replace(n2,'\x00',1)
assert probe == probe2, 'patch leaked outside the four sites'

open('check-agent-health-patched.js','w').write(out)
print('OLD sha:', hashlib.sha256(src.encode()).hexdigest())
print('NEW sha:', hashlib.sha256(out.encode()).hexdigest())
print('sizes:', len(src), '->', len(out))
print('PATCH OK - 4 sites, 0 collateral')
