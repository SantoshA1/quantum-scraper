// QTP Policy Time Exit v1.0 (gov 241, 2026-08-25) — "Close Due Positions"
// Input: rows from "Find Due Policy Positions" (each: symbol, ledger_qty,
// sessions_incl_today, entered_et). This node only runs when >=1 row is due.
//
// Ratified policy (Conclave 2026-08-25, Decision 1): longs entered under the
// new-policy epoch exit at ~close of the 2nd session after entry (E1 time_2d).
// Order of operations per symbol — cancel protective legs FIRST, then market
// close (Alpaca rejects a close while shares are held by an open OCO leg):
//   1. position lookup from a single GET /v2/positions snapshot (absent -> skip,
//      note it: already flat via stop/manual/H5)
//   2. cancel every open SELL order on the symbol (stop / limit / OCO legs),
//      verify gone, one retry; still there -> FAIL LOUD for that symbol and DO
//      NOT market-close (the shares are still reserved)
//   3. POST market sell, tif=day, qty = live position qty,
//      client_order_id 'qtp_timeexit_<SYM>_<YYYYMMDD>' (<=48 chars)
// Per-symbol failures NEVER throw (earnings-guard lesson gov 235: a throw before
// the alarm kills the alarm) — they are collected into the loud Telegram text.
// The ONLY throw is the paper-guard: refusing to run against a non-paper base.
// Known gap (documented in gov 241 record): H5 heal may classify these exits as
// 'manual' until the classifier learns the qtp_timeexit_ prefix.
const BASE = String($vars.ALPACA_BASE_URL || 'https://paper-api.alpaca.markets').replace(/\/+$/, '');
if (BASE.indexOf('paper') === -1) { throw new Error('[TIME-EXIT gov241] refusing to run: ALPACA_BASE_URL is not a paper endpoint'); }
const HDRS = { 'APCA-API-KEY-ID': $vars.ALPACA_API_KEY, 'APCA-API-SECRET-KEY': $vars.ALPACA_SECRET_KEY };
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ymd = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }).replace(/-/g, '');
const req = async (method, path, body) => this.helpers.httpRequest({ method, url: BASE + path, headers: HDRS, body, json: true });
const due = $input.all().map((i) => i.json);
const closed = [], skipped = [], failed = [];
let positions = [], openOrders = [];
try { positions = await req('GET', '/v2/positions'); } catch (e) { failed.push({ symbol: '*', step: 'list_positions', err: String(e && e.message || e).slice(0, 200) }); }
try { openOrders = await req('GET', '/v2/orders?status=open&limit=500'); } catch (e) { failed.push({ symbol: '*', step: 'list_orders', err: String(e && e.message || e).slice(0, 200) }); }
const fatal = failed.length > 0; // cannot see the account -> touch nothing
if (due.length >= 10) { failed.push({ symbol: '*', step: 'blast_radius', err: 'selector returned ' + due.length + ' due positions (LIMIT 10) — investigate before trusting this run' }); }
for (const d of due) {
  const sym = String(d.symbol || '').toUpperCase();
  if (fatal) { failed.push({ symbol: sym, step: 'aborted', err: 'account snapshot unavailable' }); continue; }
  try {
    const pos = positions.find((p) => String(p.symbol).toUpperCase() === sym);
    if (!pos) { skipped.push({ symbol: sym, why: 'no live position (already flat — stop/manual/H5)' }); continue; }
    if (!(Number(pos.qty) > 0)) { skipped.push({ symbol: sym, why: 'live position not long (qty ' + pos.qty + ') — time exit covers longs only' }); continue; }
    const sells = openOrders.filter((o) => String(o.symbol).toUpperCase() === sym && String(o.side) === 'sell');
    for (const o of sells) { try { await req('DELETE', '/v2/orders/' + o.id); } catch (e) { /* verified below */ } }
    if (sells.length) {
      await sleep(1500);
      let still = (await req('GET', '/v2/orders?status=open&symbols=' + sym)).filter((o) => String(o.side) === 'sell');
      for (const o of still) { try { await req('DELETE', '/v2/orders/' + o.id); } catch (e) { /* verified below */ } }
      if (still.length) { await sleep(1500); still = (await req('GET', '/v2/orders?status=open&symbols=' + sym)).filter((o) => String(o.side) === 'sell'); }
      if (still.length) { failed.push({ symbol: sym, step: 'cancel_protective', err: still.length + ' sell order(s) refused to cancel — NOT closing (shares reserved)' }); continue; }
    }
    const ord = await req('POST', '/v2/orders', { symbol: sym, qty: String(pos.qty), side: 'sell', type: 'market', time_in_force: 'day', client_order_id: 'qtp_timeexit_' + sym + '_' + ymd });
    closed.push({ symbol: sym, qty: String(pos.qty), sessions: d.sessions_incl_today, entered_et: d.entered_et, order_id: ord.id, canceled_legs: sells.length });
    console.log('[TIME-EXIT gov241] ' + sym + ': canceled ' + sells.length + ' leg(s), market close ' + pos.qty + ' submitted (' + ord.id + ')');
  } catch (e) { failed.push({ symbol: sym, step: 'close', err: String(e && e.message || e).slice(0, 200) }); }
}
let tg = '<b>QTP Policy Time Exit</b> (gov 241 — 2-day rule)\n';
for (const c of closed) { tg += '⏱ <b>' + esc(c.symbol) + '</b>: closed ' + esc(c.qty) + ' at market (session ' + esc(c.sessions) + ', entered ' + esc(c.entered_et) + ' ET, ' + c.canceled_legs + ' protective leg(s) canceled)\n'; }
for (const s of skipped) { tg += '— ' + esc(s.symbol) + ': skipped — ' + esc(s.why) + '\n'; }
for (const f of failed) { tg += '⚠️ <b>' + esc(f.symbol) + ' ' + esc(f.step) + ' FAILED</b>: ' + esc(f.err) + ' — check Alpaca/n8n now\n'; }
return [{ json: { _tg_text: tg.trim(), closed_n: closed.length, skipped_n: skipped.length, failed_n: failed.length, closed, skipped, failed } }];
