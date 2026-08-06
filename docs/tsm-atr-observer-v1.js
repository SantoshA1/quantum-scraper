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
  let bars = {};
  if (syms.length) {
    const start = new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10);
    const resp = await this.helpers.httpRequest({ method: 'GET', url: 'https://data.alpaca.markets/v2/stocks/bars?symbols=' + syms.join(',') + '&timeframe=1Day&start=' + start + '&limit=10000&adjustment=all&feed=iex', headers: H, json: true, timeout: 15000 });
    bars = (resp && resp.bars) || {};
  }
  const rows = [];
  for (const p of positions) {
    const s = String(p.symbol || '').toUpperCase();
    if (!s) continue;
    const e = parseFloat(p.avg_entry_price) || 0;
    const b = bars[s] || [];
    const aL = calcATR(b);
    const aR = calcATR(b.slice(-15));
    let model, aU;
    if (FLAG) { const v = clampV(aR, e); model = v === 'PASS' ? 'REAL' : 'SKIP_' + v; aU = v === 'PASS' ? aR : null; }
    else if (aL > 0) { model = 'LEGACY_BARS'; aU = aL; }
    else { model = 'PROXY_2PCT'; aU = e * 0.02; }
    rows.push({ sym: s, entry: r4(e), qty: parseFloat(p.qty) || 0, legacy_bars: b.length, real_bars: b.slice(-15).length,
      atr_legacy: r4(aL), atr_legacy_pct: pc(aL, e), atr_real: r4(aR), atr_real_pct: pc(aR, e),
      real_clamp: clampV(aR, e), atr_used: r4(aU), atr_used_pct: pc(aU, e), model, proxy_atr_pct: 2,
      t1_pct_if_real: (aR > 0 && e > 0) ? Math.round(Math.max(1.5 * aR / e * 100, FLOOR_PCT) * 100) / 100 : null,
      t1_pct_now: (aU > 0 && e > 0) ? Math.round((FLAG ? Math.max(1.5 * aU / e * 100, FLOOR_PCT) : 1.5 * aU / e * 100) * 100) / 100 : null });
  }
  const ok = rows.filter(r => r.legacy_bars >= 15).length;
  const skipList = rows.filter(r => r.real_clamp !== 'PASS').map(r => r.sym + ':' + r.real_clamp);
  const arr = skipList.length ? "ARRAY[" + skipList.map(x => "'" + esc(x) + "'").join(',') + "]::text[]" : "ARRAY[]::text[]";
  sql = "INSERT INTO quantum.tsm_atr_telemetry (execution_id, real_atr_flag, t1_floor_pct, positions, legacy_bars_ok, bars_fix_healthy, would_skip_if_flag_on, symbols, version, note) VALUES ('" + esc($execution.id) + "', " + (FLAG ? 'true' : 'false') + ", " + FLOOR_PCT + ", " + rows.length + ", " + ok + ", " + (rows.length > 0 && ok === rows.length ? 'true' : 'false') + ", " + arr + ", '" + esc(JSON.stringify(rows)) + "'::jsonb, 'QTP_TSM_ATR_TELEMETRY_v1_20260806', '" + esc(note) + "')";
  console.log('[ATR_TEL] flag=' + (FLAG ? 'ON' : 'OFF') + ' pos=' + rows.length + ' barsOk=' + ok + ' skipIfOn=' + JSON.stringify(skipList));
} catch (err) {
  note = 'observer_failed: ' + String(err && err.message).slice(0, 160);
  sql = "INSERT INTO quantum.tsm_atr_telemetry (execution_id, real_atr_flag, t1_floor_pct, positions, legacy_bars_ok, bars_fix_healthy, would_skip_if_flag_on, symbols, version, note) VALUES ('" + esc($execution.id) + "', " + (FLAG ? 'true' : 'false') + ", " + FLOOR_PCT + ", 0, 0, false, ARRAY[]::text[], '[]'::jsonb, 'QTP_TSM_ATR_TELEMETRY_v1_20260806', '" + esc(note) + "')";
}
return [{ json: { __atr_tel_sql: sql, note } }];