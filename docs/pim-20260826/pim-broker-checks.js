// QTP Policy Invariant Monitor v1.0 (gov 242, 2026-08-26) — "PIM Broker Checks"
// Input: ONE row from "PIM DB Invariants" carrying jsonb `inv` (see pim-query.sql).
// READ-ONLY against Alpaca paper + the n8n public API. This node NEVER trades,
// cancels, or patches anything. It composes the nightly verdict and ALWAYS emits
// one summary item for the Telegram node — a green heartbeat proves the monitor
// itself is alive (gov 235 lesson: a silent guard is indistinguishable from a dead
// one). Any check that cannot run reports MONITOR_BLIND_<step>, never silent green.
// Invariants owned here: I2 live protection geometry (gov 241c), I3 gtc TIF
// (gov 211), I5 probation sizing vs live equity (gov 241 D3), I7-lite pinned
// workflows still published+active (public API exposes `active`, not the active
// version pointer — documented limitation; I1/I2 geometry is the deep detector).
const BASE = String($vars.ALPACA_BASE_URL || 'https://paper-api.alpaca.markets').replace(/\/+$/, '');
if (BASE.indexOf('paper') === -1) { throw new Error('[PIM gov242] refusing non-paper endpoint'); }
const HDRS = { 'APCA-API-KEY-ID': $vars.ALPACA_API_KEY, 'APCA-API-SECRET-KEY': $vars.ALPACA_SECRET_KEY };
const N8N_BASE = 'https://tradenextgen.app.n8n.cloud';
// gov-pinned workflows: a governance action that replaces one MUST update this table.
// gov 246 (Ratification B, 2026-08-31): the main pipeline (vaqfCaELhOEWnkdo,
// scanner -> AI -> SSM entry generation) is DELIBERATELY UNPUBLISHED — the funnel
// has no edge at n=904 and auto-entry is retired. It is REMOVED from the pins so
// its idled state never false-alarms I7. Re-add it here ONLY if a PO-ratified
// resurrection republishes it. Exits/protection/monitors remain pinned.
const PINNED = [
  { id: 'vFnPjyx8srnzcYgV', label: 'TSM (gov241 5607e03b)' },
  { id: 'OZx8Lh15zzo7jrJp', label: 'time exit (gov244 2fecc459)' },
];
const EPOCH_PIN = 1787692697; // gov241 activation second — value equality is I4's teeth
const LIVE = ['new', 'accepted', 'held', 'partially_filled', 'pending_new', 'accepted_for_bidding'];
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const req = async (m, p) => this.helpers.httpRequest({ method: m, url: BASE + p, headers: HDRS, json: true, timeout: 8000 });
const inv = $input.first().json.inv || $input.first().json;
const V = []; // violations: {code, detail}
let checks = 0;
const check = (name, arr) => { checks++; for (const d of (arr || [])) V.push({ code: name, detail: d }); };

// ---- DB-side verdicts (computed in SQL, judged here) ----
check('I1_STOP_WIDTH', (inv.I1_bad_stop_widths || []).map((r) => r.sym + ' stop ' + r.stop_pct + '% (reanchored=' + r.reanchored + ') outside the 1.8-3.2 fill-basis sanity band (policy: 2.5% of anchor)'));
checks++; const ep = inv.I4_epoch || {};
if (Number(ep.v) !== EPOCH_PIN) { V.push({ code: 'I4_EPOCH', detail: 'epoch row is ' + JSON.stringify(ep) + ', pinned ' + EPOCH_PIN + ' — cohort boundary compromised' }); }
check('I6_TIME_EXIT_DEAD', (inv.I6_overdue_longs || []).map((r) => r.sym + ' at session ' + r.sessions + ' — the 15:50 exit did not fire'));
checks++; if (Number(inv.I8_earnings_stale_days) > 3) { V.push({ code: 'I8_EARNINGS_STALE', detail: 'calendar ' + inv.I8_earnings_stale_days + 'd old (>3d)' }); }
check('I9_SHORT_LEAK', (inv.I9_short_entries_today || []).map((s) => s + ' — short entry past the gov219 halt'));
checks++; const coh = inv.I10_cohort || { n: 0 };
if (Number(coh.n) >= 10 && Number(coh.pf) < 0.6) { V.push({ code: 'I10_INTERIM_LOOK_DUE', detail: 'cohort n=' + coh.n + ' PF=' + coh.pf + ' — bring to PO before n=20 (gov241 pre-commitment)' }); }
// gov 243: I11 cumulative-brake knob pins (I4 pattern — silent knob tampering alarms) +
// I12 near-trip heads-up at 80% spent so the PO hears BEFORE the halt, not after.
const KS_BASELINE_PIN = 1787692697, KS_THRESHOLD_PIN = -1250;
checks++; const brk = inv.brake || {};
if (Number(brk.baseline) !== KS_BASELINE_PIN || Number(brk.threshold) !== KS_THRESHOLD_PIN) { V.push({ code: 'I11_KS_KNOBS', detail: 'brake knobs ' + JSON.stringify({ baseline: brk.baseline, threshold: brk.threshold }) + ', pinned ' + KS_BASELINE_PIN + '/' + KS_THRESHOLD_PIN + ' (gov243)' }); }
checks++; const spentPct = brk.threshold ? Math.round(1000 * Number(brk.new_net) / Number(brk.threshold)) / 10 : null;
if (spentPct !== null && spentPct >= 80) { V.push({ code: 'I12_BRAKE_NEAR', detail: 'cumulative brake ' + brk.new_net + ' of ' + brk.threshold + ' (' + spentPct + '% spent) — next stop-out class may halt the desk' }); }

// ---- broker truth ----
let account = null, positions = [], orders = [];
try { account = await req('GET', '/v2/account'); } catch (e) { V.push({ code: 'MONITOR_BLIND_account', detail: String(e && e.message || e).slice(0, 160) }); }
try { positions = await req('GET', '/v2/positions'); } catch (e) { V.push({ code: 'MONITOR_BLIND_positions', detail: String(e && e.message || e).slice(0, 160) }); }
try {
  const since = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  orders = await req('GET', '/v2/orders?status=all&nested=true&limit=500&after=' + encodeURIComponent(since));
} catch (e) { V.push({ code: 'MONITOR_BLIND_orders', detail: String(e && e.message || e).slice(0, 160) }); }
const flat = [];
for (const o of (Array.isArray(orders) ? orders : [])) { flat.push(o); for (const l of (o.legs || [])) { flat.push(l); } }

// I2 + I3: every post-epoch open long is protected at policy geometry, gtc
checks++;
for (const p of (inv.open_post_epoch || [])) {
  const sym = String(p.sym).toUpperCase();
  const live = (Array.isArray(positions) ? positions : []).find((x) => String(x.symbol).toUpperCase() === sym);
  if (!live || !(Number(live.qty) > 0)) { V.push({ code: 'I2_DESYNC', detail: sym + ' open in ledger, absent at broker' }); continue; }
  const legs = flat.filter((o) => String(o.symbol).toUpperCase() === sym && String(o.side) === 'sell' && LIVE.indexOf(String(o.status)) >= 0);
  const stopsL = legs.filter((o) => String(o.type).indexOf('stop') === 0);
  const cover = stopsL.reduce((a, o) => a + Number(o.qty || 0), 0);
  if (cover < Number(live.qty)) { V.push({ code: 'I2_UNPROTECTED', detail: sym + ' stop coverage ' + cover + ' < position ' + live.qty }); }
  for (const o of stopsL) {
    const w = Math.abs(Number(o.stop_price) - Number(p.entry)) / Number(p.entry) * 100;
    // v1.2: fill-basis sanity band [1.8, 3.2] — the placed stop is 2.5% of the entry
    // ANCHOR; fill slip legitimately moves the pct-of-fill (see I1 note in pim-query.sql).
    if (w < 1.8 || w > 3.2) { V.push({ code: 'I2_STOP_DRIFT', detail: sym + ' live stop ' + o.stop_price + ' = ' + w.toFixed(2) + '% of entry (policy 2.5 of anchor; sanity 1.8-3.2 of fill)' }); }
    if (String(o.time_in_force) !== 'gtc') { V.push({ code: 'I3_TIF', detail: sym + ' stop leg tif=' + o.time_in_force + ' (gov211: gtc)' }); }
  }
  for (const o of legs.filter((x) => String(x.type) === 'limit')) {
    const d = (Number(o.limit_price) - Number(p.entry)) / Number(p.entry) * 100;
    if (d < 15) { V.push({ code: 'I2_TP_TOO_CLOSE', detail: sym + ' TP ' + o.limit_price + ' only ' + d.toFixed(1) + '% away (gov241: far TP, >=15)' }); }
  }
}
// I5: probation sizing vs live equity
checks++;
if (account && Number(account.equity) > 0) {
  const cap = 0.0055 * Number(account.equity);
  for (const e of (inv.entries || [])) {
    if (['buy', 'buy_call'].indexOf(String(e.side)) >= 0 && Number(e.risk) > cap) {
      V.push({ code: 'I5_OVERSIZED', detail: e.sym + ' risk $' + e.risk + ' > 0.55% of equity ($' + cap.toFixed(0) + ')' });
    }
  }
}
// I7-lite: pinned workflows still published+active
checks++;
for (const w of PINNED) {
  try {
    const r = await this.helpers.httpRequest({ method: 'GET', url: N8N_BASE + '/api/v1/workflows/' + w.id, headers: { 'X-N8N-API-KEY': $vars.N8N_API_KEY }, json: true, timeout: 8000 });
    if (!r || r.active !== true) { V.push({ code: 'I7_WORKFLOW_DOWN', detail: w.label + ' active=' + (r && r.active) }); }
  } catch (e) { V.push({ code: 'MONITOR_BLIND_n8n', detail: w.label + ': ' + String(e && e.message || e).slice(0, 120) }); }
}

// ---- verdict ----
let tg;
if (V.length === 0) {
  tg = '✅ <b>PIM green</b> — ' + checks + ' invariant groups verified. Entries today: ' + (inv.entries_today_n || 0)
     + ', post-epoch open: ' + (inv.open_post_epoch || []).length
     + ', cohort n=' + (coh.n || 0) + (coh.pf != null ? ' PF ' + coh.pf : '')
     + '. Brake: ' + (brk.new_net != null ? brk.new_net + ' of ' + brk.threshold + ' (' + (spentPct != null ? spentPct : '?') + '%)' : 'unread')
     + '; legacy ' + (brk.legacy_net != null ? brk.legacy_net : '?') + ' + adjudicated ' + (brk.adjudicated_net != null ? brk.adjudicated_net : '?') + ' (historical, non-tripping).';
} else {
  tg = '🚨 <b>PIM: ' + V.length + ' violation(s)</b>\n';
  for (const v of V.slice(0, 12)) { tg += '• <b>' + esc(v.code) + '</b>: ' + esc(v.detail) + '\n'; }
  if (V.length > 12) { tg += '…and ' + (V.length - 12) + ' more (see execution log)'; }
}
console.log('[PIM gov242] ' + (V.length === 0 ? 'green' : V.length + ' violations') + ' | ' + checks + ' groups');
return [{ json: { _tg_text: tg.trim(), violations: V, checks_run: checks, green: V.length === 0 } }];
