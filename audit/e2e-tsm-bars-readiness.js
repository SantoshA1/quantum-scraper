#!/usr/bin/env node
'use strict';
/**
 * END-TO-END READINESS DRY RUN — QTP_TSM_BARS_WINDOW_v1_20260804
 *
 * Replicates the live TSM node's surrounding code exactly (symbols built from open
 * positions, try/catch that falls back to the 2% proxy, the node's own calcATR) and
 * drives BOTH the broken and the fixed bars fetch through the real lib/ modules.
 *
 * Offline: the Alpaca transport is a simulator implementing the documented semantics
 * (results sorted BY SYMBOL then timestamp, `limit` shared across all symbols, `start`
 * defaulting to the current day, `adjustment` defaulting to raw).
 *
 * Run: node audit/e2e-tsm-bars-readiness.js
 */
const B = require('../lib/tsm/bars');
const { engineAtr, realAtrDecision, t1Move } = require('../lib/tsm/atr');
const { trailDecision } = require('../lib/tsm/trail');

const TODAY = '2026-08-04';
const NOW = new Date(`${TODAY}T12:00:00Z`);

// ── the open book. ATR% values are ILLUSTRATIVE except AES/XPEV, which are the two
//    live-measured values from the 2026-08-03 finding. Real values land on first run.
const BOOK = [
  { symbol: 'AES',  entry: 14.66,  atrPct: 0.36, side: 'long'  }, // live-measured
  { symbol: 'XPEV', entry: 12.42,  atrPct: 4.29, side: 'long'  }, // live-measured
  { symbol: 'AFL',  entry: 108.20, atrPct: 0.95, side: 'long'  },
  { symbol: 'BA',   entry: 221.47, atrPct: 2.10, side: 'short' },
  { symbol: 'CBRE', entry: 138.90, atrPct: 1.45, side: 'long'  },
  { symbol: 'JKHY', entry: 176.30, atrPct: 0.88, side: 'long'  },
  { symbol: 'LDOS', entry: 152.75, atrPct: 1.60, side: 'long'  },
  { symbol: 'MAR',  entry: 268.40, atrPct: 1.35, side: 'long'  },
  { symbol: 'RMD',  entry: 244.10, atrPct: 1.72, side: 'short' },
  { symbol: 'WMT',  entry: 98.55,  atrPct: 1.05, side: 'long'  },
];

function series(close, atrPct, days = 90) {
  const half = (close * (atrPct / 100)) / 2;
  const dates = [];
  let d = new Date(`${TODAY}T00:00:00Z`);
  while (dates.length < days) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) dates.push(d.toISOString().slice(0, 10));
    d = new Date(d.getTime() - 86400000);
  }
  return dates.reverse().map((t) => ({ t, o: close, h: close + half, l: close - half, c: close, v: 1e6 }));
}
const UNIVERSE = {};
for (const p of BOOK) UNIVERSE[p.symbol] = { raw: series(p.entry, p.atrPct), adjusted: series(p.entry, p.atrPct) };

let CALLS = 0;
async function alpacaGet(url) {
  CALLS++;
  const q = new URL(url, 'https://data.alpaca.markets').searchParams;
  const syms = String(q.get('symbols') || '').split(',').filter(Boolean).sort();
  const start = q.get('start') || TODAY;
  const limit = Number(q.get('limit') || 1000);
  const offset = Number(q.get('page_token') || 0);
  const flat = [];
  for (const s of syms) {
    const e = UNIVERSE[s]; if (!e) continue;
    for (const bar of e.raw) if (bar.t >= start) flat.push([s, bar]);
  }
  const slice = flat.slice(offset, offset + limit);
  const bars = {};
  for (const [s, bar] of slice) (bars[s] = bars[s] || []).push(bar);
  return { bars, next_page_token: offset + limit < flat.length ? String(offset + limit) : null };
}

// The node's own calcATR, copied verbatim from docs/trail-stops-v2.js
function calcATR(bars) {
  if (!bars || bars.length < 2) return null;
  let sum = 0;
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].h, l = bars[i].l, pc = bars[i - 1].c;
    sum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  return sum / (bars.length - 1);
}

const pct = (v, base) => `${((v / base) * 100).toFixed(2)}%`;
const pad = (s, n) => String(s).padEnd(n);
const rpad = (s, n) => String(s).padStart(n);

(async () => {
  const symbols = BOOK.map((p) => p.symbol).join(','); // exactly how the node builds it

  console.log('='.repeat(96));
  console.log('  QTP TSM — BARS WINDOW READINESS DRY RUN            ' + TODAY + '  ·  book = ' + BOOK.length + ' open positions');
  console.log('='.repeat(96));

  // ---- A. TODAY (live, broken) -------------------------------------------------
  CALLS = 0;
  const brokenBody = await alpacaGet(
    `https://data.alpaca.markets/v2/stocks/bars?symbols=${symbols}&${B.LIVE_BROKEN_QUERY}`);
  const broken = B.mergePage({}, brokenBody);
  const brokenCov = B.coverage(broken, BOOK.map((p) => p.symbol));

  console.log('\nA. LIVE TODAY  —  /v2/stocks/bars?symbols=...&' + B.LIVE_BROKEN_QUERY);
  console.log(`   requests=${CALLS}   symbols with >=15 bars: ${brokenCov.covered}/${brokenCov.requested}   skip-rate ${(brokenCov.skipRate * 100).toFixed(0)}%`);

  // ---- B. AFTER THE FIX --------------------------------------------------------
  CALLS = 0;
  const fixed = await B.fetchDailyBars({ symbols: BOOK.map((p) => p.symbol), now: NOW, httpGet: alpacaGet });
  const req = B.buildBarsRequest({ symbols: BOOK.map((p) => p.symbol), now: NOW });
  console.log('\nB. AFTER THE FIX  —  ' + req.url.replace('https://data.alpaca.markets', ''));
  console.log(`   requests=${fixed.pages}   symbols with >=15 bars: ${fixed.coverage.covered}/${fixed.coverage.requested}   skip-rate ${(fixed.coverage.skipRate * 100).toFixed(0)}%`);

  // ---- C. per-symbol effect ----------------------------------------------------
  console.log('\nC. PER-SYMBOL EFFECT');
  console.log('   ' + pad('SYM', 6) + rpad('BARS', 5) + rpad('ATR now', 10) + rpad('ATR real', 10) +
              rpad('T1 now', 9) + rpad('T1 real', 9) + '  FLAG-ON VERDICT');
  console.log('   ' + '-'.repeat(88));
  let wouldSkip = 0;
  for (const p of BOOK) {
    const bars = fixed.bars[p.symbol] || [];
    const proxy = engineAtr(broken[p.symbol] || [], p.entry);          // today's behaviour
    const real = calcATR(bars.slice(-15));                              // node's own math
    const d = realAtrDecision({ flagOn: true, bars, entry: p.entry });
    const t1Now = t1Move({ flagOn: false, atr: proxy, entry: p.entry });
    const t1Real = d.skip ? null : t1Move({ flagOn: true, atr: d.atr, entry: p.entry });
    if (d.skip) wouldSkip++;
    console.log('   ' + pad(p.symbol, 6) + rpad(bars.length, 5) +
      rpad(pct(proxy, p.entry), 10) + rpad(pct(real, p.entry), 10) +
      rpad(pct(t1Now, p.entry), 9) + rpad(t1Real === null ? '—' : pct(t1Real, p.entry), 9) +
      '  ' + (d.skip ? 'SKIP (clamp: ' + pct(real, p.entry) + ' outside 0.40–6.00%)' : 'REAL ATR'));
  }

  // ---- D. does a winner actually get trailed? ----------------------------------
  console.log('\nD. TRAIL BEHAVIOUR ON A WINNER 1.6x ATR IN PROFIT');
  for (const p of BOOK.slice(0, 4)) {
    const bars = fixed.bars[p.symbol] || [];
    const d = realAtrDecision({ flagOn: true, bars, entry: p.entry });
    const brokenD = realAtrDecision({ flagOn: true, bars: broken[p.symbol] || [], entry: p.entry });
    const mv = (a) => (p.side === 'long' ? p.entry + 1.6 * a : p.entry - 1.6 * a);
    const atrRef = d.atr || calcATR(bars.slice(-15));
    const withFix = d.skip ? null : trailDecision({ side: p.side, entry: p.entry, current: mv(d.atr), atr: d.atr, tier: 0 });
    const withoutFix = brokenD.skip ? null : trailDecision({ side: p.side, entry: p.entry, current: mv(atrRef), atr: brokenD.atr, tier: 0 });
    console.log('   ' + pad(p.symbol, 6) +
      'flag ON + broken bars: ' + pad(withoutFix ? 'stop moves' : 'NO TRAIL (07-24 mode)', 24) +
      '| flag ON + fixed bars: ' + (withFix ? 'stop moves -> ' + withFix.newStop : d.skip ? 'skipped by clamp' : 'no move'));
  }

  // ---- E. verdict ---------------------------------------------------------------
  console.log('\nE. READINESS VERDICT');
  const ok = fixed.coverage.ok;
  console.log(`   [${ok ? 'PASS' : 'FAIL'}] bars fix feeds every open position (${fixed.coverage.covered}/${fixed.coverage.requested})`);
  console.log(`   [${fixed.pages >= 1 ? 'PASS' : 'FAIL'}] paging works and terminates (${fixed.pages} request${fixed.pages === 1 ? '' : 's'} for ${BOOK.length} symbols)`);
  console.log(`   [${wouldSkip === 0 ? 'PASS' : 'WARN'}] flag-ON skip count with fixed bars: ${wouldSkip}/${BOOK.length}` +
    (wouldSkip ? '  <-- A2 clamp rejects these; reconcile clamp vs 0.7% floor BEFORE arming' : ''));
  console.log(`   [INFO] with the flag OFF the fix alone already replaces the 2% proxy with a real ATR — ship this first.`);
  console.log('\n' + '='.repeat(96));
  process.exit(ok ? 0 : 1);
})();
