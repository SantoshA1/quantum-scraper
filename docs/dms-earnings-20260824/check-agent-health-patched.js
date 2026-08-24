const NL = String.fromCharCode(10);
const N8N_KEY = $vars.N8N_API_KEY;
const SIGNAL_AGENT_ID = 'qq1mZLLsuUtot0ID';
const SUPER_SCORE_ID = 'vaqfCaELhOEWnkdo';

const today = new Date().toISOString().substring(0, 10);

// Fetch recent Signal Agent executions
const saResp = await this.helpers.httpRequest({
  method: 'GET',
  url: 'https://tradenextgen.app.n8n.cloud/api/v1/executions?workflowId=' + SIGNAL_AGENT_ID + '&limit=20',
  headers: { 'X-N8N-API-KEY': N8N_KEY },
  json: true
});

let saSuccessToday = 0;
let saErrorsToday = 0;
let saSignalsFound = 0;
let saLastSuccess = 'never';

for (const e of (saResp.data || [])) {
  if (!e.startedAt || !e.startedAt.startsWith(today)) continue;
  if (e.status === 'success') {
    saSuccessToday++;
    if (saLastSuccess === 'never') saLastSuccess = e.startedAt.substring(11, 16) + ' UTC';
  } else {
    saErrorsToday++;
  }
}

// Fetch recent AI Super Score executions
const ssResp = await this.helpers.httpRequest({
  method: 'GET',
  url: 'https://tradenextgen.app.n8n.cloud/api/v1/executions?workflowId=' + SUPER_SCORE_ID + '&limit=20',
  headers: { 'X-N8N-API-KEY': N8N_KEY },
  json: true
});

let ssToday = 0;
let ssFullRoute = 0;

for (const e of (ssResp.data || [])) {
  if (!e.startedAt || !e.startedAt.startsWith(today)) continue;
  ssToday++;
}

// QTP_RAILWAY_DECOMMISSION_20260724: Railway service retired; stop pinging /health so this
// dead-man's switch never false-alarms on a service we intentionally shut down. Reversible.
let railwayOk = true;
let railwayStatus = 'decommissioned (n/a)';

// QTP_EARNINGS_LIVENESS_v1_gov239_20260824: the earnings guard's own staleness alarm
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
const allHealthy = agentHealthy && pipelineHealthy && earningsHealthy; // gov239: earnings liveness joined

const lines = [];
if (allHealthy) {
  lines.push('<b>' + String.fromCharCode(9989) + ' Quantum Morning Health — All Systems GO</b>');
  lines.push('');
  lines.push('Signal Agent: ' + saSuccessToday + ' successful runs, ' + saErrorsToday + ' errors');
  lines.push('AI Super Score: ' + ssToday + ' executions received');
  lines.push('Earnings Calendar: fresh (' + (ecHours === null ? '?' : ecHours.toFixed(1)) + 'h, ' + ecForward + ' forward rows)');
  lines.push('Railway Scraper: ' + railwayStatus);
  lines.push('');
  lines.push('<i>All systems operational. Monitoring active.</i>');
} else {
  lines.push('<b>' + String.fromCharCode(9888) + String.fromCharCode(65039) + ' QUANTUM ALERT — System Issue Detected</b>');
  lines.push('');
  if (!agentHealthy) {
    lines.push(String.fromCharCode(128308) + ' <b>Signal Agent DOWN</b>');
    lines.push('  Successes today: ' + saSuccessToday);
    lines.push('  Errors today: ' + saErrorsToday);
    lines.push('  Last success: ' + saLastSuccess);
    if (saErrorsToday > 0 && saSuccessToday === 0) {
      lines.push('  <b>Agent has not evaluated any tickers since market open!</b>');
    }
    lines.push('');
  }
  if (!pipelineHealthy) {
    lines.push(String.fromCharCode(128308) + ' <b>AI Super Score Pipeline: 0 executions today</b>');
    lines.push('');
  }
  if (!earningsHealthy) {
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
  lines.push('<i>Check n8n immediately: https://tradenextgen.app.n8n.cloud</i>');
}

return [{ json: {
  message: lines.join(NL),
  healthy: allHealthy,
  agent_successes: saSuccessToday,
  agent_errors: saErrorsToday,
  pipeline_runs: ssToday,
  railway_ok: railwayOk,
  earnings_healthy: earningsHealthy,
  earnings_probe_ok: ecProbeOk,
  earnings_hours_since_refresh: ecHours,
  earnings_forward_rows: ecForward
}}];