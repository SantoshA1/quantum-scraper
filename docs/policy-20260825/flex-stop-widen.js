// gov241c one-shot (2026-08-26): widen FLEX protective stop to the ratified 2.5%-of-fill.
// PO ratified in-session. Ledger: fill 111.70, qty 93, defective stop 110.42 (1.146% of
// fill, EX-C3 pre-Patch-C). Policy stop = r2(111.70 * 0.975) = 108.91 (long).
// PATCH = atomic replace (no naked window) — proven on this account (probe 545502, EX-C3).
// Every precondition checked; ANY drift aborts loudly with nothing touched.
const BASE = String($vars.ALPACA_BASE_URL || 'https://paper-api.alpaca.markets').replace(/\/+$/, '');
if (BASE.indexOf('paper') === -1) { throw new Error('[FLEX-WIDEN gov241c] refusing non-paper endpoint'); }
const HDRS = { 'APCA-API-KEY-ID': $vars.ALPACA_API_KEY, 'APCA-API-SECRET-KEY': $vars.ALPACA_SECRET_KEY };
const req = async (m, p, b) => this.helpers.httpRequest({ method: m, url: BASE + p, headers: HDRS, body: b, json: true });
const SYM = 'FLEX', QTY = 93, NEW_STOP = '108.91', EXPECT_CUR = 110.42;
const positions = await req('GET', '/v2/positions');
const pos = (Array.isArray(positions) ? positions : []).find((p) => String(p.symbol).toUpperCase() === SYM);
if (!pos || !(Number(pos.qty) > 0)) { throw new Error('[FLEX-WIDEN gov241c] no live long FLEX position — nothing touched'); }
if (Number(pos.qty) !== QTY) { throw new Error('[FLEX-WIDEN gov241c] qty mismatch: live ' + pos.qty + ' vs expected ' + QTY + ' — nothing touched'); }
// v3 (after live probes 652883 + 652906): with the PARENT filled, neither a flat
// ?status=open nor open+nested lists the child legs. The TSM provably finds them via
// status=all&nested=true — mirror that exactly, filter live-ish states client-side,
// and dump a safe diagnostic (symbol/side/type/status only) before any abort.
const LIVE = ['new', 'accepted', 'held', 'partially_filled', 'pending_new', 'accepted_for_bidding'];
const since = new Date(Date.now() - 36 * 3600 * 1000).toISOString();
const all = await req('GET', '/v2/orders?status=all&nested=true&limit=200&after=' + encodeURIComponent(since) + '&symbols=' + SYM);
const flat = [];
for (const o of (Array.isArray(all) ? all : [])) { flat.push(o); for (const l of (o.legs || [])) { flat.push(l); } }
console.log('[FLEX-WIDEN gov241c] order census: ' + JSON.stringify(flat.map((o) => ({ sym: o.symbol, side: o.side, type: o.type, status: o.status, stop: o.stop_price || null }))));
const stops = flat.filter((o) => String(o.symbol).toUpperCase() === SYM && String(o.side) === 'sell' && String(o.type).indexOf('stop') === 0 && LIVE.indexOf(String(o.status)) >= 0);
if (stops.length !== 1) { throw new Error('[FLEX-WIDEN gov241c] expected exactly 1 open stop leg, found ' + stops.length + ' — nothing touched'); }
const leg = stops[0];
if (Math.abs(Number(leg.stop_price) - EXPECT_CUR) > 0.05) { throw new Error('[FLEX-WIDEN gov241c] stop leg at ' + leg.stop_price + ', expected ~' + EXPECT_CUR + ' — state drifted, nothing touched'); }
const r = await req('PATCH', '/v2/orders/' + encodeURIComponent(leg.id), JSON.stringify({ stop_price: NEW_STOP }));
const newId = (r && r.id) || leg.id;
console.log('[FLEX-WIDEN gov241c] stop ' + leg.stop_price + ' -> ' + NEW_STOP + ' (leg ' + leg.id + ' -> ' + newId + ', status ' + ((r && r.status) || '?') + ')');
return [{ json: { patched: true, symbol: SYM, qty: QTY, old_stop: leg.stop_price, new_stop: NEW_STOP, old_leg_id: leg.id, new_leg_id: newId, alpaca_status: (r && r.status) || null } }];
