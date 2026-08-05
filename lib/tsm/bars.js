'use strict';
/**
 * QTP_TSM_BARS_WINDOW_v1_20260804 — spec-mirror for the daily-bars fetch that feeds ATR-14.
 *
 * ROOT CAUSE (QTP_TSM_ATR_PROXY_BUG, found 2026-08-03). The live TSM calls:
 *
 *     /v2/stocks/bars?symbols=${symbols}&timeframe=1Day&limit=20&feed=iex
 *     (docs/trail-stops-v2.js:771)
 *
 * Three independent defects, any ONE of which is enough to starve calcATR:
 *
 *   D1 — NO `start`. Alpaca defaults `start` to the current day, so at most ONE daily
 *        bar per symbol exists to be returned. calcATR needs >=2 bars -> null -> the
 *        engine falls back to entry*0.02 (the "2% proxy") for every symbol.
 *
 *   D2 — `limit` is shared, and results are sorted BY SYMBOL first, then by timestamp.
 *        So limit=20 does NOT mean "~20/N bars each". It means the alphabetically-first
 *        symbols consume the whole budget and every symbol after the cutoff gets ZERO
 *        bars. This is the dangerous one: with QTP_TSM_REAL_ATR_v1 ON it would give the
 *        first names a real ATR and silently SKIP the trail for all the rest.
 *
 *   D3 — NO `adjustment` (Alpaca defaults to `raw`). A split inside the lookback window
 *        produces one enormous fake true range, which either blows past the A2 clamp
 *        (-> SKIP) or, worse, lands inside it and gets FROZEN at entry for the life of
 *        the trade.
 *
 * THE FIX is all three plus pagination — `limit` caps at 10,000, and MIN_BARS * N
 * symbols exceeds that above ~333 names (the S&P 500 whitelist is 503).
 *
 * ORDER OF OPERATIONS: this must ship and be verified BEFORE QTP_TSM_REAL_ATR_v1 is
 * armed. Arming the flag while the fetch is still starved converts "every symbol trails
 * on a fake 2% ATR" into "nothing trails at all" (realAtrDecision -> skip:true ->
 * trailDecision -> null), which is the 2026-07-24 failure mode (-$1,382, worst day on
 * record, TSM never moved a stop).
 *
 * Pure + dependency-free by the lib/ convention: `fetchDailyBars` takes an injected
 * `httpGet` so the Maya suite can drive it offline against a simulator that implements
 * Alpaca's documented paging semantics.
 */

const ATR_PERIOD = 14;
/** ATR-14 needs 14 true ranges, and a true range needs a prior close -> 15 bars. */
const MIN_BARS = ATR_PERIOD + 1;
/** realAtrDecision does bars.slice(-15); anything beyond that is cushion, not payload. */
const TARGET_BARS = 30;
const ALPACA_MAX_LIMIT = 10000;
const DEFAULT_MAX_PAGES = 64;

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * Calendar days needed to be confident of `bars` trading days.
 * 5 trading days per 7 calendar days, plus a holiday/long-weekend cushion.
 */
function lookbackCalendarDays(bars = TARGET_BARS, cushionDays = 10) {
  const n = Math.max(1, Math.ceil(Number(bars)));
  return Math.ceil((n * 7) / 5) + cushionDays;
}

/** D1 fix: an explicit inclusive `start`, as YYYY-MM-DD. `now` is injected for determinism. */
function windowStart(now, bars = TARGET_BARS, cushionDays = 10) {
  const t = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(t.getTime())) throw new Error('QTP_BARS_BAD_NOW');
  const d = new Date(t.getTime() - lookbackCalendarDays(bars, cushionDays) * 86400000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/**
 * D2 fix: size the shared budget for the WHOLE universe, not for one symbol.
 * Clamped to Alpaca's hard ceiling — above that, pagination carries the remainder.
 */
function requestLimit(symbolCount, barsPerSymbol = TARGET_BARS) {
  const n = Math.max(0, Math.floor(Number(symbolCount) || 0));
  if (n === 0) return 0;
  return Math.min(ALPACA_MAX_LIMIT, Math.max(MIN_BARS, n * Math.ceil(barsPerSymbol)));
}

/** How many round trips the universe needs at Alpaca's ceiling. >1 means paging is mandatory. */
function pagesNeeded(symbolCount, barsPerSymbol = TARGET_BARS) {
  const n = Math.max(0, Math.floor(Number(symbolCount) || 0));
  if (n === 0) return 0;
  return Math.ceil((n * Math.ceil(barsPerSymbol)) / ALPACA_MAX_LIMIT);
}

function normalizeSymbols(symbols) {
  const list = Array.isArray(symbols) ? symbols : String(symbols || '').split(',');
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const s = String(raw || '').trim().toUpperCase();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/**
 * Build one page of the corrected request. Returns the URL and the parsed params so a
 * caller (or a test) can assert on individual fields without re-parsing a string.
 */
function buildBarsRequest({
  symbols,
  now,
  bars = TARGET_BARS,
  feed = 'iex',
  adjustment = 'all',
  pageToken = null,
  host = 'https://data.alpaca.markets',
} = {}) {
  const syms = normalizeSymbols(symbols);
  if (syms.length === 0) throw new Error('QTP_BARS_NO_SYMBOLS');

  const params = {
    symbols: syms.join(','),
    timeframe: '1Day',
    start: windowStart(now, bars),      // D1
    limit: requestLimit(syms.length, bars), // D2
    adjustment,                          // D3
    feed,
    sort: 'asc',
  };
  if (pageToken) params.page_token = pageToken;

  const qs = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');

  return { url: `${host}/v2/stocks/bars?${qs}`, params, symbols: syms };
}

/** A bar is usable for true range only if h/l/c are finite and coherent. */
function isUsableBar(b) {
  if (!b) return false;
  const h = Number(b.h), l = Number(b.l), c = Number(b.c);
  return Number.isFinite(h) && Number.isFinite(l) && Number.isFinite(c)
    && h > 0 && l > 0 && c > 0 && h >= l;
}

/** Merge one Alpaca page ({bars:{SYM:[...]}}) into the accumulator, in timestamp order. */
function mergePage(acc, page) {
  const out = acc || {};
  const bars = (page && page.bars) || {};
  for (const sym of Object.keys(bars)) {
    const incoming = (bars[sym] || []).filter(isUsableBar);
    out[sym] = (out[sym] || []).concat(incoming);
  }
  return out;
}

/** True when this symbol can produce a real ATR-14 (not a 1-bar range wearing its name). */
function sufficientForAtr(bars, minBars = MIN_BARS) {
  return Array.isArray(bars) && bars.length >= minBars;
}

/**
 * The assertion the whole fix exists to satisfy:
 * every requested symbol came back with >= MIN_BARS usable bars.
 */
function coverage(barsBySymbol, symbols, minBars = MIN_BARS) {
  const syms = normalizeSymbols(symbols);
  const map = barsBySymbol || {};
  const insufficient = [];
  for (const s of syms) {
    const n = (map[s] || []).length;
    if (n < minBars) insufficient.push({ symbol: s, bars: n });
  }
  return {
    ok: insufficient.length === 0,
    requested: syms.length,
    covered: syms.length - insufficient.length,
    minBars,
    insufficient,
    skipRate: syms.length === 0 ? 0 : insufficient.length / syms.length,
  };
}

/**
 * Fetch every symbol's daily bars, following next_page_token until the universe is
 * covered. `httpGet(url)` must resolve to Alpaca's JSON body.
 *
 * Fails CLOSED in the ways that matter:
 *  - a repeated page_token throws rather than looping forever
 *  - exceeding maxPages throws rather than silently returning a partial universe
 * Under-covered symbols are REPORTED (never proxied) so the caller can skip exactly
 * those and trail the rest.
 */
async function fetchDailyBars({
  symbols,
  now,
  httpGet,
  bars = TARGET_BARS,
  feed = 'iex',
  adjustment = 'all',
  maxPages = DEFAULT_MAX_PAGES,
  host = 'https://data.alpaca.markets',
} = {}) {
  if (typeof httpGet !== 'function') throw new Error('QTP_BARS_NO_TRANSPORT');
  const syms = normalizeSymbols(symbols);
  if (syms.length === 0) throw new Error('QTP_BARS_NO_SYMBOLS');

  let acc = {};
  let pageToken = null;
  let pages = 0;
  const seenTokens = new Set();
  const urls = [];

  do {
    if (pages >= maxPages) throw new Error('QTP_BARS_PAGE_LIMIT');
    const req = buildBarsRequest({ symbols: syms, now, bars, feed, adjustment, pageToken, host });
    urls.push(req.url);
    const body = await httpGet(req.url);
    acc = mergePage(acc, body);
    pages += 1;

    const next = body && body.next_page_token ? String(body.next_page_token) : null;
    if (next && seenTokens.has(next)) throw new Error('QTP_BARS_TOKEN_LOOP');
    if (next) seenTokens.add(next);
    pageToken = next;
  } while (pageToken);

  return { bars: acc, pages, urls, coverage: coverage(acc, syms) };
}

/** The literal live string this spec replaces — pinned so the suite can prove it is broken. */
const LIVE_BROKEN_QUERY = 'timeframe=1Day&limit=20&feed=iex';

module.exports = {
  ATR_PERIOD,
  MIN_BARS,
  TARGET_BARS,
  ALPACA_MAX_LIMIT,
  LIVE_BROKEN_QUERY,
  lookbackCalendarDays,
  windowStart,
  requestLimit,
  pagesNeeded,
  normalizeSymbols,
  buildBarsRequest,
  isUsableBar,
  mergePage,
  sufficientForAtr,
  coverage,
  fetchDailyBars,
};
