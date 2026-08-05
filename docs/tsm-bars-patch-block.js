// ══ QTP_TSM_BARS_WINDOW_v1_20260804 ═══════════════════════════════════════════
// Spec-mirror: lib/tsm/bars.js   ·   Maya guard: tests/test-tsm-bars.js (24/24)
// Replaces the two lines that fetch daily bars for ATR-14.
//   D1  explicit `start`  — without it Alpaca returns only the current day (1 bar)
//   D2  `limit` scaled to the universe — it is shared across ALL symbols, and results
//       are sorted BY SYMBOL, so a fixed limit=20 blanks everything after the cutoff
//   D3  `adjustment=all`  — raw prices turn a split into one enormous fake true range
//   +   paging — limit caps at 10,000; 30 bars x N symbols exceeds that above ~333 names
// Any throw lands in the existing catch, which keeps today's 2% proxy: strictly no worse.
const _syms = [...new Set(String(symbols).split(',').map(s => s.trim().toUpperCase()).filter(Boolean))];
const _TARGET = 30;
const _startISO = new Date(Date.now() - (Math.ceil(_TARGET * 7 / 5) + 10) * 86400000).toISOString().slice(0, 10);
const _limit = Math.min(10000, Math.max(15, _syms.length * _TARGET));
const _seen = new Set();
let _tok = null, _pages = 0;
const _acc = {};
do {
  if (_pages >= 64) throw new Error('QTP_BARS_PAGE_LIMIT');
  const _path = `/v2/stocks/bars?symbols=${_syms.join(',')}&timeframe=1Day&start=${_startISO}`
    + `&limit=${_limit}&adjustment=all&feed=iex&sort=asc`
    + (_tok ? `&page_token=${encodeURIComponent(_tok)}` : '');
  const _page = await alp.call(this, 'GET', _path, null, 'data');
  const _pb = (_page && _page.bars) || {};
  for (const _s of Object.keys(_pb)) _acc[_s] = (_acc[_s] || []).concat(_pb[_s] || []);
  _pages++;
  const _next = _page && _page.next_page_token ? String(_page.next_page_token) : null;
  if (_next && _seen.has(_next)) throw new Error('QTP_BARS_TOKEN_LOOP');
  if (_next) _seen.add(_next);
  _tok = _next;
} while (_tok);
barsData = _acc;
// CANARY — watch this line on the first live execution. Anything but "skip-rate 0%"
// means the window/limit still is not feeding every open position.
const _short = _syms.filter(s => (_acc[s] || []).length < 15);
console.log(`[QTP BARS v1] ${_pages} req · ${_syms.length - _short.length}/${_syms.length} symbols >=15 bars`
  + (_short.length ? ` · SHORT: ${_short.join(',')}` : ' · skip-rate 0%'));
