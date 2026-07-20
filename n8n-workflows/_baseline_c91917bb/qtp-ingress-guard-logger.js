// QTP Ingress Guard Logger — log-only, parallel tap. NEVER throws, NEVER affects signal flow.
try {
  const items = $input.all();
  const item = (items && items[0]) ? items[0] : { json: {} };
  const j = item.json || {};
  const body = (j.body && typeof j.body === 'object') ? j.body : j;
  const headers = (j.headers && typeof j.headers === 'object') ? j.headers : {};

  const callerIp = headers['cf-connecting-ip']
    || headers['x-real-ip']
    || ((headers['x-forwarded-for'] || '').split(',')[0] || '').trim()
    || null;
  const bodyBytes = parseInt(headers['content-length']) || null;
  const cfRay = headers['cf-ray'] || null;
  const qtpSource = (body && body.qtp_source) ? body.qtp_source : null;
  const alertType = (body && body.alert_type) ? body.alert_type : null;
  const symbolCount = (body && (body.ticker || body.symbol)) ? 1 : null;

  const sq = (v) => (v === null || v === undefined) ? 'NULL' : ("'" + String(v).replace(/'/g, "''") + "'");
  const ni = (v) => (v === null || v === undefined || isNaN(v)) ? 'NULL' : String(parseInt(v));

  const sql = 'INSERT INTO quantum.webhook_ingress_log '
    + '(caller_ip, body_bytes, symbol_count, qtp_source, alert_type, cf_ray, note) VALUES ('
    + sq(callerIp) + ', '
    + ni(bodyBytes) + ', '
    + ni(symbolCount) + ', '
    + sq(qtpSource) + ', '
    + sq(alertType) + ', '
    + sq(cfRay) + ', '
    + sq('ingress_tap_v1') + ')';

  return [{ json: { _ig_sql: sql } }];
} catch (e) {
  return [{ json: { _ig_sql: null, note: 'ingress_logger_error' } }];
}
