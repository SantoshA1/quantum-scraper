// QTP ORDER-STATE PROBE — 2026-08-10
// Purpose: empirically settle two API questions the Alpaca docs do NOT answer, both of
// which the composed execution fix depends on:
//   Q1  Can a bracket entry that has NOT filled be cancelled cleanly (whole group gone,
//       no position, no orphan legs)?  -> the SKIPPED_NO_FILL_WITHIN_CAP path
//   Q2  Can a bracket's stop_loss child leg be PATCHed (replaced) after the parent fills,
//       and DOES THE ORDER ID CHANGE?  -> the E2 fill-anchored stop, and whether
//       state._bracketOrders[sym].slId / trade_ledger.alpaca_sl_id go stale afterwards.
// SECURITY: runs inside n8n. Credentials are referenced via $vars by NAME only and are
// never logged, echoed, or returned. Only derived facts leave this node.
// SAFETY: paper-endpoint assert; qty is hard-pinned to 1; symbol must be FLAT first;
// Phase A cannot fill by construction; Phase B is flattened in a finally block.
const K = $vars.ALPACA_API_KEY || $vars.ALPACA_KEY_ID;
const S = $vars.ALPACA_SECRET_KEY || $vars.ALPACA_SECRET;
if (!K || !S) throw new Error('probe: creds missing (fail-closed)');
const BASE = 'https://paper-api.alpaca.markets';
if (!BASE.includes('paper-api.alpaca.markets')) throw new Error('probe: PAPER-ONLY assert');
const DATA = 'https://data.alpaca.markets';
const H = { 'APCA-API-KEY-ID': K, 'APCA-API-SECRET-KEY': S, 'Content-Type': 'application/json' };
const SYM = 'F';
const QTY = 1;                     // hard-pinned. Never parameterised.
const log = [];
const rec = (k, v) => { log.push({ step: k, ...v }); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const req = async (method, url, body) => {
  try {
    const r = await this.helpers.httpRequest({ method, url, headers: H, json: true, timeout: 8000,
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { ok: true, status: 200, body: r };
  } catch (e) {
    let b = e.response?.body || e.response?.data || e.error || null;
    if (typeof b === 'string') { try { b = JSON.parse(b); } catch (_) {} }
    return { ok: false, status: e.statusCode || e.response?.statusCode || null, body: b, msg: String(e.message || e).slice(0, 300) };
  }
};

// ── pre-flight: must be FLAT on SYM, and no working orders on SYM ─────────────
const pos0 = await req('GET', BASE + '/v2/positions/' + SYM);
const flat0 = !pos0.ok && (pos0.status === 404);
rec('preflight_position', { flat: flat0, status: pos0.status, qty: pos0.ok ? pos0.body.qty : null });
if (!flat0) return [{ json: { probe: 'ABORTED', reason: 'not flat on ' + SYM, log } }];
const oo0 = await req('GET', BASE + '/v2/orders?status=open&symbols=' + SYM);
const openN0 = oo0.ok ? (oo0.body || []).length : -1;
rec('preflight_open_orders', { n: openN0 });
if (openN0 !== 0) return [{ json: { probe: 'ABORTED', reason: 'open orders exist on ' + SYM, log } }];

// reference price
const q = await req('GET', DATA + '/v2/stocks/' + SYM + '/quotes/latest');
const ask = q.ok ? Number(q.body?.quote?.ap) : 0;
const bid = q.ok ? Number(q.body?.quote?.bp) : 0;
rec('quote', { bid, ask, ok: q.ok });
if (!(ask > 0 && bid > 0)) return [{ json: { probe: 'ABORTED', reason: 'no usable quote', log } }];
const r2 = n => Math.round(n * 100) / 100;

let phaseA = {}, phaseB = {}, cleanup = {};

// ══ PHASE A — unfillable bracket, then cancel. Cannot fill by construction. ══
try {
  const farLimit = r2(bid * 0.80);                    // 20% below the bid: will not fill
  const a1 = await req('POST', BASE + '/v2/orders', {
    symbol: SYM, qty: String(QTY), side: 'buy', type: 'limit', time_in_force: 'day',
    limit_price: String(farLimit), order_class: 'bracket',
    stop_loss:   { stop_price:  String(r2(farLimit * 0.95)) },
    take_profit: { limit_price: String(r2(farLimit * 1.10)) }
  });
  phaseA.submit = { ok: a1.ok, status: a1.status, id: a1.body?.id || null, order_status: a1.body?.status || null,
                    legs: (a1.body?.legs || []).map(l => ({ id: l.id, type: l.type, status: l.status, side: l.side })) };
  if (a1.ok) {
    await sleep(1500);
    const aId = a1.body.id;
    const del = await req('DELETE', BASE + '/v2/orders/' + aId);
    phaseA.cancel = { ok: del.ok, status: del.status, body: del.body || null, msg: del.msg || null };
    await sleep(2000);
    const after = await req('GET', BASE + '/v2/orders/' + aId + '?nested=true');
    phaseA.after_parent = after.ok ? { status: after.body.status, filled_qty: after.body.filled_qty,
      legs: (after.body.legs || []).map(l => ({ id: l.id, type: l.type, status: l.status })) } : { err: after.msg };
    const ooA = await req('GET', BASE + '/v2/orders?status=open&symbols=' + SYM);
    phaseA.open_orders_after = ooA.ok ? (ooA.body || []).length : -1;
    const posA = await req('GET', BASE + '/v2/positions/' + SYM);
    phaseA.flat_after = !posA.ok && posA.status === 404;
  }
} catch (e) { phaseA.error = String(e.message || e).slice(0, 300); }

// ══ PHASE B — marketable bracket, fill, then PATCH the stop leg ═══════════════
let bEntryId = null;
try {
  const mktLimit = r2(ask * 1.005);                   // marketable: 0.5% through the ask
  const b1 = await req('POST', BASE + '/v2/orders', {
    symbol: SYM, qty: String(QTY), side: 'buy', type: 'limit', time_in_force: 'day',
    limit_price: String(mktLimit), order_class: 'bracket',
    stop_loss:   { stop_price:  String(r2(bid * 0.90)) },   // 10% away: cannot trigger
    take_profit: { limit_price: String(r2(ask * 1.15)) }    // 15% away: cannot trigger
  });
  phaseB.submit = { ok: b1.ok, status: b1.status, id: b1.body?.id || null, order_status: b1.body?.status || null,
                    msg: b1.msg || null,
                    legs_at_submit: (b1.body?.legs || []).map(l => ({ id: l.id, type: l.type, status: l.status })) };
  if (!b1.ok) throw new Error('phaseB submit failed');
  bEntryId = b1.body.id;

  // poll for fill (this is exactly the poll the production patch will use)
  let filled = null, polls = 0;
  for (let i = 0; i < 10; i++) {
    await sleep(1500); polls++;
    const g = await req('GET', BASE + '/v2/orders/' + bEntryId + '?nested=true');
    if (!g.ok) continue;
    const st = g.body.status, fq = Number(g.body.filled_qty || 0);
    if (st === 'filled' || fq >= QTY) { filled = g.body; break; }
    if (['canceled', 'expired', 'rejected'].includes(st)) { filled = g.body; break; }
  }
  phaseB.poll = { polls, status: filled?.status || 'timeout', filled_qty: filled?.filled_qty || '0',
                  filled_avg_price: filled?.filled_avg_price || null };
  const legs = filled?.legs || [];
  phaseB.legs_after_fill = legs.map(l => ({ id: l.id, type: l.type, status: l.status, side: l.side,
                                            stop_price: l.stop_price, limit_price: l.limit_price }));
  const slLeg = legs.find(l => l.type === 'stop' || l.type === 'stop_limit');
  if (filled?.status === 'filled' && slLeg) {
    const oldStop = Number(slLeg.stop_price);
    const newStop = r2(oldStop + 0.11);               // move it, still far from market
    const pt = await req('PATCH', BASE + '/v2/orders/' + slLeg.id, { stop_price: String(newStop) });
    phaseB.patch = { ok: pt.ok, http_status: pt.status, msg: pt.msg || null,
                     requested_from: oldStop, requested_to: newStop,
                     returned_id: pt.body?.id || null, returned_stop: pt.body?.stop_price || null,
                     returned_status: pt.body?.status || null,
                     ID_CHANGED: pt.ok ? (String(pt.body?.id) !== String(slLeg.id)) : null,
                     error_body: pt.ok ? null : pt.body };
    await sleep(1500);
    const oldGet = await req('GET', BASE + '/v2/orders/' + slLeg.id);
    phaseB.old_leg_after_patch = oldGet.ok
      ? { id: oldGet.body.id, status: oldGet.body.status, stop_price: oldGet.body.stop_price, replaced_by: oldGet.body.replaced_by || null }
      : { err: oldGet.msg, status: oldGet.status };
    if (phaseB.patch.returned_id && phaseB.patch.returned_id !== slLeg.id) {
      const newGet = await req('GET', BASE + '/v2/orders/' + phaseB.patch.returned_id);
      phaseB.new_leg_after_patch = newGet.ok
        ? { id: newGet.body.id, status: newGet.body.status, stop_price: newGet.body.stop_price, qty: newGet.body.qty, side: newGet.body.side, order_class: newGet.body.order_class, legs: newGet.body.legs || null }
        : { err: newGet.msg };
    }
    // is the position still protected? count live stop orders on SYM
    const ooB = await req('GET', BASE + '/v2/orders?status=open&symbols=' + SYM + '&nested=false');
    phaseB.open_orders_after_patch = ooB.ok
      ? (ooB.body || []).map(o => ({ id: o.id, type: o.type, status: o.status, stop_price: o.stop_price, limit_price: o.limit_price, side: o.side }))
      : { err: ooB.msg };
  } else {
    phaseB.patch = { skipped: true, reason: 'no fill or no stop leg' };
  }
} catch (e) { phaseB.error = String(e.message || e).slice(0, 300); }

// ══ CLEANUP — always flatten and cancel, regardless of what happened above ════
try {
  const dp = await req('DELETE', BASE + '/v2/positions/' + SYM + '?cancel_orders=true');
  cleanup.close_position = { ok: dp.ok, status: dp.status, order_id: dp.body?.id || null, msg: dp.msg || null };
  await sleep(2500);
  const oo = await req('GET', BASE + '/v2/orders?status=open&symbols=' + SYM);
  cleanup.open_orders_left = oo.ok ? (oo.body || []).map(o => ({ id: o.id, type: o.type, status: o.status })) : { err: oo.msg };
  if (oo.ok && (oo.body || []).length) {
    for (const o of oo.body) { await req('DELETE', BASE + '/v2/orders/' + o.id); }
    await sleep(1500);
    const oo2 = await req('GET', BASE + '/v2/orders?status=open&symbols=' + SYM);
    cleanup.open_orders_left_2 = oo2.ok ? (oo2.body || []).length : -1;
  }
  const pf = await req('GET', BASE + '/v2/positions/' + SYM);
  cleanup.FLAT = !pf.ok && pf.status === 404;
  cleanup.residual_qty = pf.ok ? pf.body.qty : '0';
} catch (e) { cleanup.error = String(e.message || e).slice(0, 300); }

return [{ json: { probe: 'ORDER_STATE_v1', symbol: SYM, qty: QTY, at: new Date().toISOString(),
                  preflight: log, phaseA, phaseB, cleanup } }];
