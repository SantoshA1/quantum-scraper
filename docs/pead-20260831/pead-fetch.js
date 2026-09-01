// QTP PEAD Backfill (A'2, gov 246) — "Fetch AV Earnings"
// Data ingestion only: Alpha Vantage EARNINGS per symbol, key by $vars name.
// 15s pacing (AV free = 5/min); per-symbol fail-soft (unfetched symbols are NOT
// marked done, so they retry tomorrow). Emits one item per symbol carrying a
// single parameterized-safe SQL statement (numbers + whitelisted symbol only).
const KEY = (typeof $vars !== 'undefined' && $vars.ALPHAVANTAGE_API_KEY) || '';
const row = $input.first().json;
const batch = Array.isArray(row.batch) ? row.batch : JSON.parse(row.batch || '[]');
const remainingBefore = Number(row.remaining_before || 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = [];
const SYMRX = /^[A-Z][A-Z0-9.\-]{0,9}$/;
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? String(n) : 'NULL'; };
const dt = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? "'" + v + "'" : 'NULL');
if (!KEY) { return [{ json: { done: false, error: 'ALPHAVANTAGE_API_KEY missing', remaining_before: remainingBefore, sql: 'SELECT 1' } }]; }
for (let bi = 0; bi < batch.length; bi++) {
  const symRaw = batch[bi];
  const sym = String(symRaw).toUpperCase();
  if (!SYMRX.test(sym)) { out.push({ json: { symbol: sym, ok: false, why: 'symbol failed whitelist', sql: 'SELECT 1' } }); continue; }
  try {
    const r = await this.helpers.httpRequest({
      method: 'GET', json: true, timeout: 15000,
      url: 'https://www.alphavantage.co/query?function=EARNINGS&symbol=' + sym + '&apikey=' + KEY });
    // PD-04 lesson: a rate-limit stub ({Note:...}) has NO quarterlyEarnings key —
    // it must fail-soft (retry tomorrow), never be marked done with zero data.
    if (!r || !Array.isArray(r.quarterlyEarnings)) { out.push({ json: { symbol: sym, ok: false, why: 'no quarterlyEarnings (rate limit or unknown symbol)', sql: 'SELECT 1' } }); }
    else {
      const q = r.quarterlyEarnings;
      const vals = [];
      for (const e of q) {
        if (!e || !/^\d{4}-\d{2}-\d{2}$/.test(String(e.fiscalDateEnding || ''))) continue;
        if (String(e.fiscalDateEnding) < '2025-06-01') continue;
        vals.push('(' + ["'" + sym + "'", dt(e.fiscalDateEnding), dt(e.reportedDate),
          num(e.reportedEPS), num(e.estimatedEPS), num(e.surprise), num(e.surprisePercentage)].join(',') + ')');
      }
      const ins = vals.length
        ? 'insert into quantum.earnings_history (symbol,fiscal_date,reported_date,reported_eps,estimated_eps,surprise,surprise_pct) values '
          + vals.join(',') + ' on conflict (symbol,fiscal_date) do nothing; '
        : '';
      out.push({ json: { symbol: sym, ok: true, quarters: vals.length,
        sql: ins + "insert into quantum.pead_backfill_progress (symbol) values ('" + sym + "') on conflict do nothing" } });
    }
  } catch (err) {
    out.push({ json: { symbol: sym, ok: false, why: String(err && err.message || err).slice(0, 120), sql: 'SELECT 1' } });
  }
  if (bi < batch.length - 1) { await sleep(13000); } // pace BETWEEN calls only (60s node cap)
}
const okN = out.filter((x) => x.json.ok).length;
out.push({ json: { summary: true, fetched_ok: okN, batch_n: batch.length,
  remaining_after: Math.max(0, remainingBefore - okN), sql: 'SELECT 1' } });
return out;
