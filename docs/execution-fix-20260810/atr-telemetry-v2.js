// QTP_TSM_ATR_TELEMETRY_v2_20260810 — adds the CONSOLIDATED-vs-IEX feed shadow.
// v1 header retained below; the only change is that this observer now fetches the daily bars
// TWICE and reports the difference. It still decides nothing.
//
// WHY (measured 2026-08-10): all four of the TSM's daily-bars calls hard-code `&feed=iex`,
// including the REAL_ATR-14 fetch that sets the tier ladder — and this observer's own fetch.
// IEX carries only 4.9%-9.1% of consolidated volume on the names QTP holds, so its daily bars
// miss the extremes and ATR-14 comes out LOW on every symbol tested: -2.27% (XPEV) to -10.45%
// (AES), mean about -7.5%.
//
// The correction is FREE. On this account the DEFAULT bars feed IS consolidated for historical
// bars — `default_matches_sip` was true on all 8 probed symbols while `feed=iex` returned
// different, thinner bars. Only the REAL-TIME quote path is IEX-gated. This is not a
// subscription question; it is a parameter discarding data the account already has.
//
// WHY SHADOW BEFORE DELETING THE PARAMETER: ATR feeds the T1/T2 trail tiers and the REAL-mode
// clamp, so a ~7.5% ATR rise moves live stop tiers on open positions. This observer is the one
// place that can prove the per-symbol tier delta without touching the risk node. It proves it
// first; the parameter comes out afterwards, in a separate change.
// Spec-mirror lib/tsm/atr_telemetry.js buildFeedShadow · suite tests/test-tsm-atr-telemetry.js SHD-01..07.
//
// QTP_TSM_ATR_TELEMETRY_v1_20260806 (PO-authorized 2026-08-06, market-open safe).
// ISOLATED OBSERVER — deliberately a separate branch: the live "Trail Stops" risk node is
// NOT modified, so instrumentation cannot affect stop management. Re-derives the same ATR
// inputs the engine sees (Alpaca positions + daily bars) and records, per cycle:
//   * QTP_TSM_REAL_ATR_ON state  <- previously invisible to SQL (lives only in n8n $vars)
//   * bars actually received per symbol  <- proves/refutes the 08-04 bars-window fix
//   * the ATR model in force (REAL / LEGACY_BARS / PROXY_2PCT)
//   * while the flag is OFF: what flipping it WOULD do per symbol (clamp verdict + T1)
// Fail-silent by construction: any error emits a FAILED marker row, never throws.
// Spec-mirror lib/tsm/atr_telemetry.js · suite tests/test-tsm-atr-telemetry.js (12/12).
const KEY = String(($vars && ($vars.ALPACA_API_KEY || $vars.ALPACA_KEY_ID)) || '');
const SEC = String(($vars && ($vars.ALPACA_SECRET || $vars.ALPACA_SECRET_KEY)) || '');
const FLAG = String(($vars && $vars.QTP_TSM_REAL_ATR_ON) || 'off').toLowerCase() === 'on';
const FLOOR_PCT = Number(($vars && $vars.QTP_TSM_T1_FLOOR_PCT) || 0.7);
const esc = (v) => String(v == null ? '' : v).replace(/'/g, "''").replace(/\$(\d)/g, 'USD $1');

function calcATR(bars) {
  if (!bars || bars.length < 2) return null;
  let s = 0;
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].h, l = bars[i].l, pc = bars[i - 1].c;
    s += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  return s / (bars.length - 1);
}
const clampV = (a, e) => (!(a > 0) || !(e > 0)) ? 'NO_BARS' : (a < e * 0.004 ? 'BELOW_FLOOR' : (a > e * 0.06 ? 'ABOVE_CAP' : 'PASS'));
const r4 = (n) => (n == null ? null : Math.round(Number(n) * 10000) / 10000);
const pc = (a, e) => (a > 0 && e > 0 ? Math.round((a / e) * 1000000) / 10000 : null);

let sql, note = 'ok';
try {
  if (!KEY || !SEC) throw new Error('alpaca_vars_missing');
  const H = { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SEC };
  const positions = await this.helpers.httpRequest({ method: 'GET', url: 'https://paper-api.alpaca.markets/v2/positions', headers: H, json: true, timeout: 12000 }) || [];
  const syms = positions.map(p => String(p.symbol || '').toUpperCase()).filter(Boolean);
  let bars = {}, sipBars = {};
  if (syms.length) {
    const start = new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10);
    const base = 'https://data.alpaca.markets/v2/stocks/bars?symbols=' + syms.join(',') + '&timeframe=1Day&start=' + start + '&limit=10000&adjustment=all';
    // (a) exactly what the live engine sees today
    const resp = await this.helpers.httpRequest({ method: 'GET', url: base + '&feed=iex', headers: H, json: true, timeout: 15000 });
    bars = (resp && resp.bars) || {};
    // (b) v2 shadow: the same request with no feed override. Non-fatal by design — if this
    // one fails the shadow is simply absent and every v1 field is unchanged, because the
    // whole point of an observer branch is that it cannot degrade the thing it observes.
    try {
      const resp2 = await this.helpers.httpRequest({ method: 'GET', url: base, headers: H, json: true, timeout: 15000 });
      sipBars = (resp2 && resp2.bars) || {};
    } catch (_se) { sipBars = {}; console.log('[ATR_TEL v2] consolidated shadow fetch failed: ' + String(_se && _se.message).slice(0, 120)); }
  }
  const rows = [];
  for (const p of positions) {
    const s = String(p.symbol || '').toUpperCase();
    if (!s) continue;
    const e = parseFloat(p.avg_entry_price) || 0;
    const b = bars[s] || [];
    const bS = sipBars[s] || [];
    const aL = calcATR(b);
    const aR = calcATR(b.slice(-15));
    const aS = calcATR(bS.slice(-15));                 // v2: consolidated ATR-14
    let model, aU;
    if (FLAG) { const v = clampV(aR, e); model = v === 'PASS' ? 'REAL' : 'SKIP_' + v; aU = v === 'PASS' ? aR : null; }
    else if (aL > 0) { model = 'LEGACY_BARS'; aU = aL; }
    else { model = 'PROXY_2PCT'; aU = e * 0.02; }
    rows.push({ sym: s, entry: r4(e), qty: parseFloat(p.qty) || 0, legacy_bars: b.length, real_bars: b.slice(-15).length,
      atr_legacy: r4(aL), atr_legacy_pct: pc(aL, e), atr_real: r4(aR), atr_real_pct: pc(aR, e),
      real_clamp: clampV(aR, e), atr_used: r4(aU), atr_used_pct: pc(aU, e), model, proxy_atr_pct: 2,
      t1_pct_if_real: (aR > 0 && e > 0) ? Math.round(Math.max(1.5 * aR / e * 100, FLOOR_PCT) * 100) / 100 : null,
      t1_pct_now: (aU > 0 && e > 0) ? Math.round((FLAG ? Math.max(1.5 * aU / e * 100, FLOOR_PCT) : 1.5 * aU / e * 100) * 100) / 100 : null,
      // ── v2 feed shadow. Observational only: nothing below is read by the engine. ──
      sip_bars: bS.slice(-15).length,
      atr_sip: r4(aS), atr_sip_pct: pc(aS, e),
      // negative = IEX understates, the direction thin-venue bars should err in
      atr_iex_vs_sip_pct_diff: (aR > 0 && aS > 0) ? Math.round((aR - aS) / aS * 1000000) / 10000 : null,
      clamp_sip: clampV(aS, e),
      // a verdict FLIP is the case where the feed changes whether a symbol is managed at all,
      // rather than merely how widely — it is not a tier shift and must be read separately
      // guarded on BOTH ATRs existing: a missing consolidated fetch yields NO_BARS, and
      // reporting that as a "flip" would put a fake decision signal in the summary line
      clamp_verdict_flips: (aR > 0 && aS > 0) ? (clampV(aR, e) !== clampV(aS, e)) : false,
      t1_pct_sip: (aS > 0 && e > 0) ? Math.round(Math.max(1.5 * aS / e * 100, FLOOR_PCT) * 100) / 100 : null,
      t1_delta_pct_points: (aR > 0 && aS > 0 && e > 0)
        ? Math.round((Math.max(1.5 * aS / e * 100, FLOOR_PCT) - Math.max(1.5 * aR / e * 100, FLOOR_PCT)) * 100) / 100 : null });
  }
  const ok = rows.filter(r => r.legacy_bars >= 15).length;
  const skipList = rows.filter(r => r.real_clamp !== 'PASS').map(r => r.sym + ':' + r.real_clamp);
  // v2 shadow summary -> note column, so the flip decision is answerable from SQL alone
  const cmp = rows.filter(r => r.atr_iex_vs_sip_pct_diff != null);
  const diffs = cmp.map(r => r.atr_iex_vs_sip_pct_diff);
  const flips = rows.filter(r => r.clamp_verdict_flips).map(r => r.sym + ':' + r.real_clamp + '->' + r.clamp_sip);
  const maxT1 = rows.length ? Math.max.apply(null, rows.map(r => Math.abs(r.t1_delta_pct_points || 0))) : 0;
  note = 'ok | feed_shadow n=' + cmp.length + '/' + rows.length
       + ' understates=' + cmp.filter(r => r.atr_iex_vs_sip_pct_diff < 0).length
       + ' overstates=' + cmp.filter(r => r.atr_iex_vs_sip_pct_diff > 0).length
       + ' meanDiff=' + (diffs.length ? Math.round(diffs.reduce((a, x) => a + x, 0) / diffs.length * 100) / 100 : 'n/a') + '%'
       + ' worst=' + (diffs.length ? Math.min.apply(null, diffs) : 'n/a') + '%'
       + ' maxT1delta=' + Math.round(maxT1 * 100) / 100 + 'pp'
       + ' clampFlips=' + (flips.length ? flips.join(',') : 'none');
  const arr = skipList.length ? "ARRAY[" + skipList.map(x => "'" + esc(x) + "'").join(',') + "]::text[]" : "ARRAY[]::text[]";
  sql = "INSERT INTO quantum.tsm_atr_telemetry (execution_id, real_atr_flag, t1_floor_pct, positions, legacy_bars_ok, bars_fix_healthy, would_skip_if_flag_on, symbols, version, note) VALUES ('" + esc($execution.id) + "', " + (FLAG ? 'true' : 'false') + ", " + FLOOR_PCT + ", " + rows.length + ", " + ok + ", " + (rows.length > 0 && ok === rows.length ? 'true' : 'false') + ", " + arr + ", '" + esc(JSON.stringify(rows)) + "'::jsonb, 'QTP_TSM_ATR_TELEMETRY_v2_20260810', '" + esc(note) + "')";
  console.log('[ATR_TEL v2] flag=' + (FLAG ? 'ON' : 'OFF') + ' pos=' + rows.length + ' barsOk=' + ok + ' skipIfOn=' + JSON.stringify(skipList));
  console.log('[ATR_TEL v2] ' + note);
} catch (err) {
  note = 'observer_failed: ' + String(err && err.message).slice(0, 160);
  sql = "INSERT INTO quantum.tsm_atr_telemetry (execution_id, real_atr_flag, t1_floor_pct, positions, legacy_bars_ok, bars_fix_healthy, would_skip_if_flag_on, symbols, version, note) VALUES ('" + esc($execution.id) + "', " + (FLAG ? 'true' : 'false') + ", " + FLOOR_PCT + ", 0, 0, false, ARRAY[]::text[], '[]'::jsonb, 'QTP_TSM_ATR_TELEMETRY_v1_20260806', '" + esc(note) + "')";
}
return [{ json: { __atr_tel_sql: sql, note } }];