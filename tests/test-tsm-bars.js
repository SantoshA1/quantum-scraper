#!/usr/bin/env node
'use strict';
/**
 * Maya regression guard — the daily-bars window that feeds ATR-14 (QTP_TSM_BARS_WINDOW_v1).
 *
 * Maya asks: "You told me every stock trails on a fake 2% ATR because the bars call only
 * ever returns one bar. Prove the LIVE url is actually starved, prove the fix feeds all my
 * positions and not just the ones early in the alphabet, and prove that turning the real-ATR
 * flag on BEFORE this fix would stop my winners from ever locking in — which is exactly what
 * cost me $1,382 on July 24."
 *
 * Deterministic + offline. No network, no API keys, no clock: the suite drives the real
 * fetch path against an Alpaca simulator that implements the documented paging semantics
 * (results sorted BY SYMBOL then timestamp; `limit` shared across ALL symbols; start
 * defaults to the current day; adjustment defaults to raw).
 */
const assert = require('assert');
const B = require('../lib/tsm/bars');
const { calcATR, engineAtr, realAtrDecision, t1Move } = require('../lib/tsm/atr');
const { trailDecision } = require('../lib/tsm/trail');

let passed = 0, failed = 0;
const QUEUE = [];
function check(id, name, fn) { QUEUE.push({ id, name, fn }); }
const near = (a, b, eps) => assert.ok(Math.abs(a - b) <= eps, `${a} !~ ${b}`);

// ---------------------------------------------------------------------------
// Alpaca simulator — the documented behavior, not a convenient one.
// ---------------------------------------------------------------------------
const TODAY = '2026-08-04';
const NOW = new Date(`${TODAY}T13:00:00Z`);

/**
 * Deterministic daily series: constant close, symmetric range -> true range == 2*half.
 * `days` is TRADING days ending at TODAY, so the series always overlaps the lookback
 * window the module asks for (an earlier draft anchored the series in the past and every
 * symbol read zero bars — the fixture, not the module, was wrong).
 */
function series(close, atrPct, days = 90, opts = {}) {
  const half = (close * (atrPct / 100)) / 2;
  const dates = [];
  let d = new Date(`${TODAY}T00:00:00Z`);
  while (dates.length < days) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) dates.push(d.toISOString().slice(0, 10)); // weekdays only
    d = new Date(d.getTime() - 86400000);
  }
  dates.reverse();
  return dates.map((t) => {
    let c = close, h = close + half, l = close - half;
    if (opts.splitOn === t) { c = close * 4; h = h * 4; l = l * 4; } // pre-split raw prices
    return { t, o: c, h, l, c, v: 1e6 };
  });
}

/** Same series with the split removed, i.e. what adjustment=split|all returns. */
function adjustedSeries(close, atrPct, days = 90) { return series(close, atrPct, days); }

function makeAlpaca(universe, { maxLimit = B.ALPACA_MAX_LIMIT } = {}) {
  const calls = [];
  async function httpGet(url) {
    calls.push(url);
    const q = new URL(url).searchParams;
    const syms = String(q.get('symbols') || '').split(',').filter(Boolean).sort(); // BY SYMBOL
    const start = q.get('start') || TODAY;            // D1: default is the current day
    const adjustment = q.get('adjustment') || 'raw';  // D3: default is raw
    const limit = Math.min(Number(q.get('limit') || 1000), maxLimit);
    const offset = Number(q.get('page_token') || 0);

    const flat = [];
    for (const s of syms) {
      const entry = universe[s];
      if (!entry) continue;
      const useAdjusted = adjustment !== 'raw' && entry.adjusted;
      const rows = useAdjusted ? entry.adjusted : entry.raw;
      for (const bar of rows) if (bar.t >= start) flat.push([s, bar]);
    }
    const slice = flat.slice(offset, offset + limit);
    const bars = {};
    for (const [s, bar] of slice) (bars[s] = bars[s] || []).push(bar);
    const more = offset + limit < flat.length;
    return { bars, next_page_token: more ? String(offset + limit) : null };
  }
  return { httpGet, calls };
}

/** The two live-measured names from the 08-03 finding, plus a healthy mid-vol control. */
const AES = { price: 14.66, atrPct: 0.36 };
const XPEV = { price: 12.42, atrPct: 4.29 };
const VRSN = { price: 271.55, atrPct: 1.10 };

function book(n) {
  // Alphabetically spread so "sorted by symbol" truncation is visible.
  const names = ['AES', 'AFL', 'BA', 'CBRE', 'JKHY', 'LDOS', 'MAR', 'RMD', 'VRSN', 'XPEV',
    'WMT', 'WDAY', 'ASML', 'NVDA', 'TSLA', 'AMD', 'MSFT', 'SPY', 'GILD', 'SMCI'];
  const u = {};
  for (const s of names.slice(0, n)) {
    const spec = s === 'AES' ? AES : s === 'XPEV' ? XPEV : VRSN;
    u[s] = { raw: series(spec.price, spec.atrPct), adjusted: adjustedSeries(spec.price, spec.atrPct) };
  }
  return u;
}

/** Replays the LIVE broken query exactly as docs/trail-stops-v2.js:771 builds it. */
async function liveBrokenFetch(alpaca, symbols) {
  const url = `https://data.alpaca.markets/v2/stocks/bars?symbols=${symbols.join(',')}&${B.LIVE_BROKEN_QUERY}`;
  const body = await alpaca.httpGet(url);
  return B.mergePage({}, body);
}

// ---------------------------------------------------------------------------
// THE BUG — prove the live url is starved before proving anything else
// ---------------------------------------------------------------------------
check('BUG-01', 'live url starves the book: no symbol gets enough bars for a real ATR', async () => {
  const syms = Object.keys(book(10));
  const got = await liveBrokenFetch(makeAlpaca(book(10)), syms);
  const cov = B.coverage(got, syms);
  assert.strictEqual(cov.covered, 0, `expected 0 covered, got ${cov.covered}`);
  assert.strictEqual(cov.skipRate, 1, 'every symbol is starved');
});

check('BUG-02', 'live url -> engine hands back the fake uniform 2% for AES and XPEV alike', async () => {
  const syms = Object.keys(book(10));
  const got = await liveBrokenFetch(makeAlpaca(book(10)), syms);
  near(engineAtr(got.AES || [], AES.price), AES.price * 0.02, 1e-9);
  near(engineAtr(got.XPEV || [], XPEV.price), XPEV.price * 0.02, 1e-9);
  // The whole finding in one line: a 0.36% name and a 4.29% name trail identically.
  assert.ok(AES.atrPct !== XPEV.atrPct, 'the two names really do move differently');
});

check('BUG-03', 'ARMING THE FLAG FIRST IS THE 07-24 BUG: real-ATR ON + broken fetch -> nothing trails', async () => {
  const syms = Object.keys(book(10));
  const got = await liveBrokenFetch(makeAlpaca(book(10)), syms);
  const d = realAtrDecision({ flagOn: true, bars: got.XPEV || [], entry: XPEV.price });
  assert.strictEqual(d.skip, true, 'starved bars must SKIP, never proxy');
  assert.strictEqual(d.atr, null);
  // and a skip means the tier engine declines to move the stop at all
  const t = trailDecision({ side: 'long', entry: XPEV.price, current: XPEV.price * 1.2, atr: d.atr, tier: 0 });
  assert.strictEqual(t, null, 'a 20% winner would NOT get its stop moved — the 07-24 failure mode');
});

check('BUG-04', 'sorted-by-symbol truncation: a bigger limit alone still blanks the back half', async () => {
  // start added but limit left at the universe-blind 20 -> alphabetically-first names eat it all
  const u = book(10); const syms = Object.keys(u);
  const alpaca = makeAlpaca(u);
  const body = await alpaca.httpGet(
    `https://data.alpaca.markets/v2/stocks/bars?symbols=${syms.join(',')}&timeframe=1Day&start=2026-06-01&limit=20&feed=iex`);
  const got = B.mergePage({}, body);
  const names = Object.keys(got);
  assert.ok(names.length < syms.length, `only ${names.length}/${syms.length} symbols came back`);
  assert.ok(names.includes('AES'), 'the alphabetically-first name is fed');
  assert.ok(!names.includes('XPEV'), 'the last name gets NOTHING — this is why limit must scale with N');
});

// ---------------------------------------------------------------------------
// THE FIX — request shape
// ---------------------------------------------------------------------------
check('REQ-01', 'fixed request carries an explicit start covering >=15 trading days (D1)', () => {
  const { params } = B.buildBarsRequest({ symbols: ['AES', 'XPEV'], now: NOW });
  assert.ok(params.start, 'start must be present — its absence IS the bug');
  const days = (NOW - new Date(`${params.start}T00:00:00Z`)) / 86400000;
  assert.ok(days >= 21, `window ${days}d must exceed the 21 calendar days that hold 15 sessions`);
});

check('REQ-02', 'limit scales with the universe, not with one symbol (D2)', () => {
  near(B.requestLimit(1), B.TARGET_BARS, 0);
  near(B.requestLimit(10), 10 * B.TARGET_BARS, 0);
  assert.ok(B.requestLimit(10) > 20, 'must exceed the live limit=20');
  assert.strictEqual(B.requestLimit(9999), B.ALPACA_MAX_LIMIT, 'clamped to the API ceiling');
});

check('REQ-03', 'split/dividend adjustment is requested, never raw (D3)', () => {
  const { params } = B.buildBarsRequest({ symbols: ['AES'], now: NOW });
  assert.strictEqual(params.adjustment, 'all');
  assert.strictEqual(params.feed, 'iex', 'feed unchanged from live (iex - the repo copy wrongly said sip)');
  assert.strictEqual(params.timeframe, '1Day', 'timeframe unchanged from live');
});

check('REQ-04', 'page_token is only sent when paging (a clean first request)', () => {
  const first = B.buildBarsRequest({ symbols: ['AES'], now: NOW });
  assert.ok(!('page_token' in first.params));
  const next = B.buildBarsRequest({ symbols: ['AES'], now: NOW, pageToken: 'abc' });
  assert.strictEqual(next.params.page_token, 'abc');
  assert.ok(next.url.includes('page_token=abc'));
});

// ---------------------------------------------------------------------------
// THE FIX — coverage, which is the thing that actually matters
// ---------------------------------------------------------------------------
check('FIX-01', 'every symbol in a 10-name book gets >=15 usable bars', async () => {
  const u = book(10); const syms = Object.keys(u);
  const r = await B.fetchDailyBars({ symbols: syms, now: NOW, httpGet: makeAlpaca(u).httpGet });
  assert.ok(r.coverage.ok, `insufficient: ${JSON.stringify(r.coverage.insufficient)}`);
  assert.strictEqual(r.coverage.skipRate, 0, 'skip rate must be zero — that is the canary');
});

check('FIX-02', 'still covers everyone at 20 names, including the end of the alphabet', async () => {
  const u = book(20); const syms = Object.keys(u);
  const r = await B.fetchDailyBars({ symbols: syms, now: NOW, httpGet: makeAlpaca(u).httpGet });
  assert.ok(r.coverage.ok, `insufficient: ${JSON.stringify(r.coverage.insufficient)}`);
  assert.ok(B.sufficientForAtr(r.bars.XPEV), 'XPEV — last alphabetically — is fed');
  assert.ok(B.sufficientForAtr(r.bars.AES), 'AES — first alphabetically — is fed');
});

check('FIX-03', 'pagination covers the universe when one response cannot hold it', async () => {
  const u = book(20); const syms = Object.keys(u);
  const alpaca = makeAlpaca(u, { maxLimit: 40 }); // force many small pages
  const r = await B.fetchDailyBars({ symbols: syms, now: NOW, httpGet: alpaca.httpGet, maxPages: 500 });
  assert.ok(r.pages > 1, `expected paging, got ${r.pages} page(s)`);
  assert.ok(r.coverage.ok, `insufficient after paging: ${JSON.stringify(r.coverage.insufficient)}`);
});

check('FIX-04', 'S&P-500-scale needs more than one round trip — paging is not optional', () => {
  assert.strictEqual(B.pagesNeeded(10), 1);
  assert.ok(B.pagesNeeded(503) > 1, 'the sp500.js whitelist cannot fit in one 10k response');
});

check('SPLIT-01', 'a split in the window does not fake an enormous true range (D3)', async () => {
  // split placed inside the last 15 sessions so it lands in the ATR-14 slice
  const spl = { raw: series(100, 1.0, 90, { splitOn: '2026-07-28' }), adjusted: adjustedSeries(100, 1.0, 90) };
  const u = { AAAA: spl };
  const raw = await B.fetchDailyBars({ symbols: ['AAAA'], now: NOW, httpGet: makeAlpaca(u).httpGet, adjustment: 'raw' });
  const adj = await B.fetchDailyBars({ symbols: ['AAAA'], now: NOW, httpGet: makeAlpaca(u).httpGet, adjustment: 'all' });
  const rawAtr = calcATR(raw.bars.AAAA.slice(-15));
  const adjAtr = calcATR(adj.bars.AAAA.slice(-15));
  assert.ok(rawAtr > adjAtr * 5, `raw ATR ${rawAtr} should be wildly inflated vs adjusted ${adjAtr}`);
  near(adjAtr, 1.0, 1e-6); // clean 1% ATR once adjusted
});

// ---------------------------------------------------------------------------
// FAIL-CLOSED — the ways this must not go wrong quietly
// ---------------------------------------------------------------------------
check('SAFE-01', 'a repeated page token throws instead of looping forever', async () => {
  const httpGet = async () => ({ bars: {}, next_page_token: 'same' });
  await assert.rejects(
    () => B.fetchDailyBars({ symbols: ['AES'], now: NOW, httpGet }),
    /QTP_BARS_TOKEN_LOOP/);
});

check('SAFE-02', 'blowing the page budget throws instead of returning half the book', async () => {
  let i = 0;
  const httpGet = async () => ({ bars: {}, next_page_token: String(++i) });
  await assert.rejects(
    () => B.fetchDailyBars({ symbols: ['AES'], now: NOW, httpGet, maxPages: 3 }),
    /QTP_BARS_PAGE_LIMIT/);
});

check('SAFE-03', 'no symbols / no transport fail loudly, not with an empty result', async () => {
  await assert.rejects(() => B.fetchDailyBars({ symbols: [], now: NOW, httpGet: async () => ({}) }), /QTP_BARS_NO_SYMBOLS/);
  await assert.rejects(() => B.fetchDailyBars({ symbols: ['AES'], now: NOW }), /QTP_BARS_NO_TRANSPORT/);
  assert.throws(() => B.buildBarsRequest({ symbols: [], now: NOW }), /QTP_BARS_NO_SYMBOLS/);
  assert.throws(() => B.windowStart('not-a-date'), /QTP_BARS_BAD_NOW/);
});

check('SAFE-04', 'a newly-listed name with only 8 sessions is REPORTED, never quietly proxied', async () => {
  const u = { AES: { raw: series(AES.price, AES.atrPct), adjusted: adjustedSeries(AES.price, AES.atrPct) },
              NEWC: { raw: series(50, 2.0, 8), adjusted: adjustedSeries(50, 2.0, 8) } };
  const r = await B.fetchDailyBars({ symbols: ['AES', 'NEWC'], now: NOW, httpGet: makeAlpaca(u).httpGet });
  assert.strictEqual(r.coverage.ok, false, 'coverage must not claim OK');
  assert.deepStrictEqual(r.coverage.insufficient.map(x => x.symbol), ['NEWC']);
  assert.ok(B.sufficientForAtr(r.bars.AES), 'the healthy name is unaffected — skip is per-symbol');
});

check('SAFE-05', 'garbage bars are dropped before they can become a true range', () => {
  const merged = B.mergePage({}, { bars: { AES: [
    { t: '1', h: 10, l: 9, c: 9.5 },        // good
    { t: '2', h: 8, l: 9, c: 8.5 },         // high < low
    { t: '3', h: NaN, l: 9, c: 9.5 },       // NaN
    { t: '4', h: 10, l: 0, c: 9.5 },        // zero low
    null,                                    // null row
  ] } });
  assert.strictEqual(merged.AES.length, 1, 'only the coherent bar survives');
});

check('SAFE-06', 'symbols are de-duplicated and normalized so limit is not over-counted', () => {
  assert.deepStrictEqual(B.normalizeSymbols([' aes ', 'AES', 'xpev', '']), ['AES', 'XPEV']);
  assert.deepStrictEqual(B.normalizeSymbols('aes,AES,xpev'), ['AES', 'XPEV']);
  assert.strictEqual(B.requestLimit(B.normalizeSymbols('aes,AES').length), B.TARGET_BARS);
});

// ---------------------------------------------------------------------------
// END TO END — bars -> ATR -> trail, which is the only thing the PO cares about
// ---------------------------------------------------------------------------
check('E2E-01', 'after the fix a high-vol name gets its REAL ATR, not the 2% fake', async () => {
  const u = book(10);
  const r = await B.fetchDailyBars({ symbols: Object.keys(u), now: NOW, httpGet: makeAlpaca(u).httpGet });
  const d = realAtrDecision({ flagOn: true, bars: r.bars.XPEV, entry: XPEV.price });
  assert.strictEqual(d.model, 'REAL');
  assert.strictEqual(d.skip, false);
  near(d.atr / XPEV.price * 100, XPEV.atrPct, 1e-6);
  assert.ok(Math.abs(d.atr - XPEV.price * 0.02) > XPEV.price * 0.02, 'materially different from the proxy');
});

check('E2E-02', 'two names that move differently now get different trail triggers', async () => {
  const u = book(10);
  const r = await B.fetchDailyBars({ symbols: Object.keys(u), now: NOW, httpGet: makeAlpaca(u).httpGet });
  const x = realAtrDecision({ flagOn: true, bars: r.bars.XPEV, entry: XPEV.price });
  const v = realAtrDecision({ flagOn: true, bars: r.bars.VRSN, entry: VRSN.price });
  const xMove = t1Move({ flagOn: true, atr: x.atr, entry: XPEV.price }) / XPEV.price;
  const vMove = t1Move({ flagOn: true, atr: v.atr, entry: VRSN.price }) / VRSN.price;
  assert.ok(xMove > vMove * 2, `XPEV T1 (${(xMove * 100).toFixed(2)}%) must be far wider than VRSN (${(vMove * 100).toFixed(2)}%)`);
});

check('E2E-03', 'a winner past T1 finally gets its stop moved once bars are real', async () => {
  const u = book(10);
  const r = await B.fetchDailyBars({ symbols: Object.keys(u), now: NOW, httpGet: makeAlpaca(u).httpGet });
  const v = realAtrDecision({ flagOn: true, bars: r.bars.VRSN, entry: VRSN.price });
  const past = VRSN.price + 1.6 * v.atr;
  const d = trailDecision({ side: 'long', entry: VRSN.price, current: past, atr: v.atr, tier: 0 });
  assert.ok(d, 'a winner past 1.5*ATR must produce a stop move — this is the 07-24 regression');
});

check('E2E-04', 'flag OFF after the fix still behaves: engine uses the REAL atr, not the proxy', async () => {
  const u = book(10);
  const r = await B.fetchDailyBars({ symbols: Object.keys(u), now: NOW, httpGet: makeAlpaca(u).httpGet });
  const legacy = engineAtr(r.bars.XPEV.slice(-15), XPEV.price);
  near(legacy / XPEV.price * 100, XPEV.atrPct, 1e-6);
  // The fix is worth shipping on its own: it removes the 2% proxy even with the flag off.
  assert.ok(Math.abs(legacy - XPEV.price * 0.02) > 1e-3, 'no longer the 2% proxy');
});

// ---------------------------------------------------------------------------
// KNOWN OPEN DEFECT — pinned so it cannot be forgotten before the flag is armed
// ---------------------------------------------------------------------------
check('CLAMP-01', 'OPEN DEFECT: the A2 clamp still rejects AES-class names even with perfect bars', async () => {
  const u = book(10);
  const r = await B.fetchDailyBars({ symbols: Object.keys(u), now: NOW, httpGet: makeAlpaca(u).httpGet });
  assert.ok(B.sufficientForAtr(r.bars.AES), 'bars are now sufficient — the fetch is not the problem');
  const d = realAtrDecision({ flagOn: true, bars: r.bars.AES, entry: AES.price });
  assert.strictEqual(d.skip, true,
    'AES real ATR 0.36% < the 0.4% A2 clamp floor -> SKIP. The 0.7% t1Move floor it was ' +
    'written for can never be reached. Reconcile the clamp with the floor before arming ' +
    'QTP_TSM_REAL_ATR_v1, or low-vol names silently stop trailing.');
});

// ---------------------------------------------------------------------------
async function main() {
  for (const { id, name, fn } of QUEUE) {
    try { await fn(); console.log(`  ✅ ${id}  ${name}`); passed++; }
    catch (e) { console.log(`  ❌ ${id}  ${name}  — ${e.message}`); failed++; }
  }
  console.log(`\n  ${passed}/${passed + failed} checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}
main();
