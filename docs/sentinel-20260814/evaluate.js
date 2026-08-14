// QTP Guard-Liveness Sentinel — evaluate + alert + build log SQL (gov 216, 2026-08-14)
// Input: one item per check from "Run Liveness Checks" (check_name, expected, observed, status).
// Statuses: OK (alive input alive) | EXPECTED (known-dead input still dead) |
//           ALARM (alive input died/stale/missing) | NOTICE (known-dead input changed state).
// Alerting: Telegram on signature CHANGE (including recovery to clean) plus a 4h re-remind
// while any ALARM persists. Signature state lives in workflow staticData so restarts of the
// n8n worker do not re-alert on an unchanged picture.
const rows = $input.all().map((i) => ({
  check_name: String(i.json.check_name || ''),
  expected: String(i.json.expected || ''),
  observed: String(i.json.observed || ''),
  status: String(i.json.status || ''),
}));
const alarms = rows.filter((r) => r.status === 'ALARM');
const notices = rows.filter((r) => r.status === 'NOTICE');
const overall = alarms.length ? 'ALARM' : (notices.length ? 'NOTICE' : 'OK');
const sig = alarms.map((r) => r.check_name).sort().join('|') + '::' + notices.map((r) => r.check_name).sort().join('|');

const sd = $getWorkflowStaticData('global');
const prevSig = String(sd._glsSig || '::');
const lastAlertAt = Number(sd._glsLastAlertAt || 0);
const nowMs = Date.now();
const REMIND_MS = 4 * 60 * 60 * 1000;

const changed = sig !== prevSig;
const remind = alarms.length > 0 && nowMs - lastAlertAt > REMIND_MS;
const recovered = changed && sig === '::' && prevSig !== '::';
const shouldAlert = (changed && sig !== '::') || remind || recovered;

let alerted = false;
const t = (typeof $vars !== 'undefined' && $vars.TELEGRAM_BOT_TOKEN) || '';
if (shouldAlert && t) {
  let text;
  if (recovered) {
    text = '✅ [GUARD-LIVENESS] All clear — previously flagged inputs are back to their expected state.';
  } else {
    const a = alarms.map((r) => r.check_name + ' (' + r.observed + ')').join('; ');
    const n = notices.map((r) => r.check_name + ' (' + r.observed + ', expected ' + r.expected + ')').join('; ');
    text = '🩺 [GUARD-LIVENESS] ' + (alarms.length ? '🛑 DEAD/STALE GUARD INPUT: ' + a + '. ' : '')
         + (notices.length ? 'ℹ️ known-dead input CHANGED: ' + n + '. ' : '')
         + 'A guard reading a dead input fails open silently — this is the check that catches it.';
  }
  try {
    await this.helpers.httpRequest({ method: 'POST', url: 'https://api.telegram.org/bot' + t + '/sendMessage', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: 6648680513, text }), timeout: 6000 });
    alerted = true;
    sd._glsLastAlertAt = nowMs;
  } catch (_) { /* fail-soft: never let alerting break the log write */ }
}
sd._glsSig = sig;

const runId = 'gls-' + new Date(nowMs).toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
const esc = (s) => String(s).split("'").join("''");
const resultsJson = esc(JSON.stringify(rows));
const logSql = "INSERT INTO quantum.guard_liveness_log (run_id, overall, alarms, notices, results) VALUES ('"
  + esc(runId) + "','" + esc(overall) + "'," + alarms.length + ',' + notices.length + ",'" + resultsJson + "'::jsonb) ON CONFLICT (run_id) DO NOTHING;";

return [{ json: { run_id: runId, overall, alarms: alarms.length, notices: notices.length, alerted, signature: sig, __log_sql: logSql } }];