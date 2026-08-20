'use strict';
/**
 * QTP_EARNINGS_GUARD_LIB_v1_gov235_20260820
 * Pure functions for the E3 earnings-calendar guard. No I/O, no clocks.
 *
 * parseEarningsCsv(text)  — Alpha Vantage EARNINGS_CALENDAR CSV (3-month horizon):
 *   header: symbol,name,reportDate,fiscalDateEnding,estimate,currency
 *   Handles quoted fields containing commas, CRLF, blank lines. Rows with a
 *   malformed symbol or reportDate are SKIPPED (counted), never guessed.
 *
 * buildEarningsAdvisory(input) — composes the nightly Telegram advisory.
 *   input: { hits: [{symbol, side, report_date, days_until}], staleDays, staleLimit,
 *            forwardRows, todayEt }
 *   Returns { send, kind: 'hits'|'stale'|'none', text } — HTML parse mode
 *   (Telegram Markdown underscore bug, gov 225b: never Markdown here), all
 *   dynamic strings escaped. Silent (send:false) when nothing needs a human.
 */

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

module.exports = { splitCsvLine, parseEarningsCsv, escHtml, buildEarningsAdvisory };
