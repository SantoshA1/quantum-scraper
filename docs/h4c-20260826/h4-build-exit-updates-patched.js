// QTP_H4_EXIT_RESOLUTION_v2_20260804
// Spec-mirror: lib/recon/ledger_divergence.js  |  Guard: tests/test-h4-exit-updates.js (22)
// v1 resolved the exit as (o.legs || []).find(l => l.status === 'filled') - only a bracket
// leg NESTED UNDER THE ENTRY ORDER. TSM cancels those legs and submits a STANDALONE
// replacement, which is what fills, so `leg` was always undefined and H4 logged
// "0 closed" forever (306 times on 2026-08-04; AEE/WSM/WMB all closed unwritten).
// v2 keeps the nested-leg path and ADDS an account-level scan. Strictly additive.
// Also fixes attribution: trail vs stop is decided by stop MOVEMENT vs the intended stop,
// and intended_exit gets the ACTUAL stop price so exit slippage is real.
// order_events was rejected as the source: it lagged the broker by 473 min at 08-04 22:00 ET.

const rows = $('Get Open Ledger Rows').all().map(i => i.json);
const orders = $('Fetch Order Status').all().map(i => i.json);

let closed = [];
try {
  const raw = $('Fetch Closed Orders').all().map(i => i.json);
  closed = raw.length === 1 && Array.isArray(raw[0]) ? raw[0] : raw;
} catch (e) {
  closed = []; // node absent or failed -> v1 behaviour, never worse than today
}
closed = (closed || []).filter(o => o && o.id);

const esc = (s) => (s == null ? '' : String(s).replace(/'/g, "''"));
const num = (v) => (v === null || v === undefined || v === '' || isNaN(Number(v))) ? 'NULL' : Number(v);

function normSide(side) {
  const s = String(side || '').toLowerCase();
  if (s.indexOf('sell') >= 0) return 'sell';
  if (s.indexOf('buy') >= 0) return 'buy';
  return s;
}
const OPPOSITE = { buy: 'sell', sell: 'buy' };

function resolveExitFromClosed(r, pool) {
  const want = OPPOSITE[normSide(r.side)];
  const entryMs = r.entry_fill_time ? new Date(r.entry_fill_time).getTime() : 0;
  const cands = pool.filter(function (o) {
    if (String(o.symbol).toUpperCase() !== String(r.symbol).toUpperCase()) return false;
    if (normSide(o.side) !== want) return false;
    if (String(o.status) !== 'filled' || !o.filled_at) return false;
    if (o.id === r.entry_order_id) return false;
    if (new Date(o.filled_at).getTime() < entryMs) return false;
    return Math.abs(Number(o.filled_qty) - Number(r.qty)) < 1e-9;
  });
  if (!cands.length) return null;
  cands.sort((a, b) => new Date(a.filled_at) - new Date(b.filled_at));
  return cands[0];
}

function classifyExitReason(r, ord) {
  // QTP_H4c_TIMEEXIT_20260826 (gov 242): deliberate exits self-identify by client_order_id
  // prefix — evidence beats geometry inference. The gov-241 time-exit runner tags its
  // market closes qtp_timeexit_<SYM>_<YYYYMMDD>; without this line they classify 'manual'
  // (schema already allows 'time' in trade_ledger_exit_reason_check).
  if (String(ord.client_order_id || '').indexOf('qtp_timeexit_') === 0) return 'time';
  const side = normSide(r.side);
  const type = String(ord.type || '').toLowerCase();
  const stopPx = ord.stop_price == null ? null : Number(ord.stop_price);
  const fillPx = Number(ord.filled_avg_price);
  const iStop = r.intended_stop == null ? null : Number(r.intended_stop);
  const iTgt = r.intended_target == null ? null : Number(r.intended_target);

  if (type.indexOf('trailing') >= 0) return 'trail';
  if (type.indexOf('stop') >= 0 && stopPx && iStop) {
    const ratcheted = side === 'buy' ? stopPx > iStop : stopPx < iStop;
    return ratcheted ? 'trail' : 'stop';
  }
  if (iTgt && fillPx) {
    const bp = Math.abs((fillPx - iTgt) / iTgt) * 10000;
    const rightSide = side === 'buy' ? fillPx >= iTgt * 0.995 : fillPx <= iTgt * 1.005;
    if (bp <= 50 && rightSide) return 'target';
  }
  if (type.indexOf('stop') >= 0) return 'stop';
  if (type.indexOf('limit') >= 0) return 'target';
  return 'manual';
}

function intendedExitFor(r, ord, reason) {
  const stopPx = ord.stop_price == null ? null : Number(ord.stop_price);
  const limPx = ord.limit_price == null ? null : Number(ord.limit_price);
  if ((reason === 'stop' || reason === 'trail') && stopPx) return stopPx;
  if (reason === 'target') return limPx || (r.intended_target == null ? null : Number(r.intended_target));
  return null;
}

const out = [];
for (let i = 0; i < rows.length; i++) {
  const r = rows[i];
  const o = orders[i] || {};
  const sets = [];
  let action = 'waiting';
  let via = null;

  const terminalUnfilled = ['canceled', 'expired', 'rejected'].indexOf(o.status) >= 0 && !o.filled_at;
  if (terminalUnfilled) {
    sets.push("status = 'busted'");
    action = 'busted';
  } else {
    if (o.filled_avg_price && !r.entry_fill_price) {
      sets.push('entry_fill_price = ' + num(o.filled_avg_price));
      sets.push("entry_fill_time = '" + esc(o.filled_at) + "'::timestamptz");
      action = 'entry_synced';
    }

    let exitOrd = (o.legs || []).find(l => l.status === 'filled') || null;
    if (exitOrd) via = 'bracket_leg';

    if (!exitOrd) {
      const entryTime = r.entry_fill_time || o.filled_at;
      exitOrd = resolveExitFromClosed(Object.assign({}, r, { entry_fill_time: entryTime }), closed);
      if (exitOrd) via = 'account_scan';
    }

    if (exitOrd && exitOrd.filled_avg_price) {
      const reason = classifyExitReason(r, exitOrd);
      sets.push("exit_reason = '" + reason + "'");
      sets.push("exit_order_id = '" + esc(exitOrd.id) + "'");
      sets.push('intended_exit = ' + num(intendedExitFor(r, exitOrd, reason)));
      sets.push('exit_fill_price = ' + num(exitOrd.filled_avg_price));
      sets.push("exit_fill_time = '" + esc(exitOrd.filled_at) + "'::timestamptz");
      sets.push("status = 'closed'");
      sets.push("lineage_source = 'H4_EXIT_RESOLUTION_v2'");
      action = 'closed';
    }
  }

  if (sets.length) {
    out.push({ json: {
      action: action, via: via, symbol: r.symbol, strategy: r.strategy, ledger_id: r.id,
      sql: 'UPDATE public.trade_ledger SET ' + sets.join(', ') +
           " WHERE id = '" + esc(r.id) + "'::uuid RETURNING id, status, net_pnl, r_multiple"
    } });
  }
}

if (!out.length) {
  out.push({ json: { action: 'none', via: null, symbol: '', strategy: '', ledger_id: '', sql: 'SELECT 1 AS noop' } });
}
return out;
