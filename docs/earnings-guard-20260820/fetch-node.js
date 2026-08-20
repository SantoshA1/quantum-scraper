// ENGINE_START gov235_earnings — embedded VERBATIM in the nightly workflow's Code nodes
// and byte-verified at deploy (region diff must be exit 0).
function splitCsvLine(line) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function parseEarningsCsv(text) {
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return { rows: [], skipped: 0, headerOk: false };
  const header = lines[0].toLowerCase();
  const headerOk = header.startsWith('symbol,') && header.includes('reportdate');
  if (!headerOk) return { rows: [], skipped: 0, headerOk: false };
  const rows = [];
  let skipped = 0;
  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  const SYM = /^[A-Z][A-Z0-9.\-]{0,9}$/;
  for (let i = 1; i < lines.length; i++) {
    const f = splitCsvLine(lines[i]);
    const symbol = String(f[0] || '').trim().toUpperCase();
    const reportDate = String(f[2] || '').trim();
    const fiscal = String(f[3] || '').trim();
    const estRaw = String(f[4] || '').trim();
    if (!SYM.test(symbol) || !DATE.test(reportDate)) { skipped++; continue; }
    const estimate = estRaw !== '' && Number.isFinite(Number(estRaw)) ? Number(estRaw) : null;
    rows.push({
      symbol,
      report_date: reportDate,
      fiscal_date_ending: DATE.test(fiscal) ? fiscal : null,
      estimate,
    });
  }
  return { rows, skipped, headerOk: true };
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildEarningsAdvisory(input) {
  const { hits, staleDays, staleLimit, forwardRows, todayEt } = input;
  const stale = staleDays !== null && staleLimit !== null && Number(staleDays) > Number(staleLimit);
  const empty = !forwardRows || Number(forwardRows) === 0;
  if ((stale || empty)) {
    const reason = empty ? 'calendar has ZERO forward rows' : 'calendar last refreshed ' + Number(staleDays).toFixed(1) + 'd ago (limit ' + staleLimit + 'd)';
    return {
      send: true,
      kind: 'stale',
      text: '⚠️ <b>[EARNINGS GUARD] calendar unhealthy</b> — ' + escHtml(reason)
        + '. The entry guard FAILS OPEN on missing data: earnings windows are currently NOT blocking entries. '
        + 'Check the nightly fetch and the ALPHAVANTAGE_API_KEY Variable.',
    };
  }
  if (!hits || hits.length === 0) return { send: false, kind: 'none', text: '' };
  const lines = ['📅 <b>[EARNINGS GUARD] open position(s) approaching a print</b> (' + escHtml(todayEt) + ')', ''];
  for (const h of hits) {
    const when = Number(h.days_until) === 0 ? 'TODAY/tonight' : 'in ' + h.days_until + ' trading-calendar day(s)';
    lines.push('• <b>' + escHtml(h.symbol) + '</b> (' + escHtml(h.side) + ') reports ' + escHtml(h.report_date) + ' — ' + when);
  }
  lines.push('');
  lines.push('WMT 08-20 lost 7.9R through an earnings gap. Decide per position: close before the print, or hold it knowingly.');
  return { send: true, kind: 'hits', text: lines.join('\n') };
}
// ENGINE_END gov235_earnings

// QTP_EARNINGS_CAL_FETCH_v1_gov235_20260820 — nightly one-call Alpha Vantage 3-month
// calendar. Key BY NAME from n8n Variables; fail-loud on every bad shape; refuses to
// poison the table with a stub response.
const key = (typeof $vars !== 'undefined' && ($vars.ALPHAVANTAGE_API_KEY || $vars.ALPHA_VANTAGE_API_KEY)) || '';
if (!key) {
  // Do NOT throw: a dead chain buries the alarm in an error execution nobody reads.
  // Emit zero rows so the advisory's zero-forward-rows path sends the LOUD Telegram
  // (gov235 field lesson: the guard's own failure mode must reach the operator channel).
  console.log('[EARNINGS CAL] ALPHAVANTAGE_API_KEY missing - emitting zero rows; advisory will alarm');
  return [{ json: { rows: [], chunk_index: 0, no_key: true } }];
}
const url = 'https://www.alphavantage.co/query?function=EARNINGS_CALENDAR&horizon=3month&apikey=' + encodeURIComponent(key);
const body = await this.helpers.httpRequest({ method: 'GET', url, timeout: 45000, json: false });
const text = typeof body === 'string' ? body : String(body);
const lower = text.slice(0, 300).toLowerCase();
if (lower.includes('thank you for using alpha vantage') || lower.includes('rate limit') || lower.includes('"error')) {
  throw new Error('EARNINGS_CAL_BAD_RESPONSE: ' + text.slice(0, 160));
}
const parsed = parseEarningsCsv(text);
if (!parsed.headerOk) throw new Error('EARNINGS_CAL_BAD_HEADER: ' + text.slice(0, 120));
if (parsed.rows.length < 100) throw new Error('EARNINGS_CAL_TOO_FEW_ROWS: ' + parsed.rows.length + ' (skipped=' + parsed.skipped + ')');
const out = [];
for (let i = 0; i < parsed.rows.length; i += 800) out.push({ json: { rows: parsed.rows.slice(i, i + 800), chunk_index: out.length } });
console.log('[EARNINGS CAL] rows=' + parsed.rows.length + ' skipped=' + parsed.skipped + ' chunks=' + out.length);
return out;
