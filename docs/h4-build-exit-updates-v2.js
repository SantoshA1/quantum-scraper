// ══ QTP_H4_EXIT_RESOLUTION_v2_20260804 ════════════════════════════════════════
// Replaces the jsCode of node "Build Exit Updates" in QET H4 Exit-Fill Sync
// (workflow bBIAbsClonHP94hk, live versionId f26312e7).
//
// Spec-mirror: lib/recon/ledger_divergence.js
// Guard:       tests/test-ledger-divergence.js (20) + tests/test-h4-exit-updates.js
//
// THE BUG (found 2026-08-04 — AEE, WSM, WMB all closed and none written back).
// v1 resolves the exit as:
//     const leg = (o.legs || []).find(l => l.status === 'filled');
// i.e. only a bracket leg NESTED UNDER THE ENTRY ORDER. TSM does not fill those
// legs — it CANCELS them and submits a STANDALONE replacement, which is what
// fills. Every original leg was CANCELED with filled_qty=0, so `leg` is always
// undefined and H4 reports "0 closed" forever (306 times on 2026-08-04).
//
// v2 keeps the nested-leg path (an untouched bracket still resolves exactly as
// before) and ADDS an account-level fallback over recently-closed orders. It is
// strictly additive: it can only close more rows, never fewer.
//
// ALSO FIXED — attribution. v1 read the leg TYPE, so a TSM stop that had been
// ratcheted toward entry to lock profit was filed as a plain 'stop'. That is why
// exit_reason='trail' shows n=2 in v_learning_summary while trail is the ONLY
// profitable exit bucket. v2 classifies on stop MOVEMENT relative to the intended
// stop, and writes the ACTUAL stop price into intended_exit so exit slippage is
// measured against the order that really existed.
//
// REQUIRES a new node between "Fetch Order Status" and this one:
//   name:        Fetch Closed Orders
//   type:        n8n-nodes-base.httpRequest   (typeVersion 4.4)
//   executeOnce: true
//   method:      GET
//   url:         https://paper-api.alpaca.markets/v2/orders
//   auth:        genericCredentialType / httpCustomAuth  (same credential as
//                "Fetch Order Status")
//   query:       status=closed  limit=500  direction=desc  nested=false
//                after={{ new Date(Date.now() - 7*86400000).toISOString() }}
//   onError:     continueRegularOutput   <- fallback degrades to v1 behaviour
//   rewire:      Fetch Order Status -> Fetch Closed Orders -> Build Exit Updates
//
// NOTE: quantum.order_events was evaluated as the data source and rejected — at
// 2026-08-04 22:00 ET it lagged the broker by 473 minutes. Exit sync reconciles to
// broker truth, so it asks the broker.

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

// Alpaca spells sides many ways: buy, sell, sell_short, buy_to_close, sell:sell_to_close…
function normSide(side) {
  const s = String(side || '').toLowerCase();
  if (s.indexOf('sell') >= 0) return 'sell';
  if (s.indexOf('buy') >= 0) return 'buy';
  return s;
}
const OPPOSITE = { buy: 'sell', sell: 'buy' };

/**
 * Identity-free exit resolution: whichever order actually closed the position.
 * Exact quantity match so a partial, a scale-out, or a different position can
 * never be claimed as this row's exit.
 */
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

/**
 * A stop moved TOWARD entry is profit-locking -> 'trail'.
 * A stop moved AWAY from entry is a recovery re-stop -> 'stop'.
 * A non-stop exit landing within 50bp of the target on the right side -> 'target'.
 */
function classifyExitReason(r, ord) {
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

/** intended_exit = the price the exit order actually promised, not the original plan. */
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

    // (1) untouched bracket — same as v1
    let exitOrd = (o.legs || []).find(l => l.status === 'filled') || null;
    if (exitOrd) via = 'bracket_leg';

    // (2) NEW: TSM cancel/replaced the leg, or the position was flattened outright
    if (!exitOrd) {
      const entryTime = r.entry_fill_time || o.filled_at;
      exitOrd = resolveExitFromClosed({ ...r, entry_fill_time: entryTime }, closed);
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
