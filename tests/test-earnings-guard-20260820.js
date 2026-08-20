#!/usr/bin/env node
'use strict';
/**
 * Maya regression guard — E3 earnings-calendar guard library (gov 235, 2026-08-20).
 *
 * Maya asks: "This morning WMT gapped 8.8% through a 1.15% stop on an earnings print
 * nobody was watching, and this guard is the fix. Before it runs a single night: (a) the
 * CSV parser must survive the real world — quoted company names with commas, CRLF, junk
 * rows — and must SKIP garbage, never invent a date; (b) a poisoned or half-empty feed
 * must be REFUSED upstream, because a silently empty calendar is exactly the blindness we
 * had yesterday; (c) the advisory must go loud when the calendar goes stale — the guard
 * fails OPEN by design, so staleness is the one alarm that must never be quiet; (d) HTML
 * escaping, because a company named 'AT&T <T>' must not break Telegram; and (e) silence
 * when there is nothing to say — no daily noise, or the owner stops reading."
 *
 * Deterministic + offline. The functions under test are the committed
 * lib/guards/earnings_calendar.js — the SAME sentinel region embedded in the nightly
 * workflow's Code nodes (byte-verified at deploy).
 */
const assert = require('assert');
const path = require('path');
const G = require(path.join(__dirname, '..', 'lib', 'guards', 'earnings_calendar.js'));

let passed = 0, failed = 0;
async function check(id, name, fn) {
  try { await fn(); console.log(`  ✅ ${id}  ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${id}  ${name}\n        ${e.message}`); failed++; }
}

const CSV = [
  'symbol,name,reportDate,fiscalDateEnding,estimate,currency',
  'XPEV,XPeng Inc,2026-08-24,2026-06-30,-0.21,USD',
  'DGX,"Quest Diagnostics, Inc.",2026-10-15,2026-09-30,2.41,USD',
  'BADDATE,Broken Co,not-a-date,2026-09-30,1.00,USD',
  ',"No Symbol Co",2026-09-01,2026-06-30,,USD',
  'NOEST,"Quote""Name"" Co",2026-09-02,,,USD',
  'lower,Lower Case Co,2026-09-03,2026-06-30,0.5,USD',
].join('\r\n');

(async () => {
  console.log('\n═══ (a) the parser survives the real world ═══\n');

  await check('EC-01', 'happy rows parse exactly: XPEV 08-24 (the live Monday print), DGX 10-15', () => {
    const { rows, skipped, headerOk } = G.parseEarningsCsv(CSV);
    assert.ok(headerOk);
    const xpev = rows.find((r) => r.symbol === 'XPEV');
    assert.deepStrictEqual(xpev, { symbol: 'XPEV', report_date: '2026-08-24', fiscal_date_ending: '2026-06-30', estimate: -0.21 });
    const dgx = rows.find((r) => r.symbol === 'DGX');
    assert.strictEqual(dgx.report_date, '2026-10-15', 'quoted "Quest Diagnostics, Inc." comma must not shift columns');
    assert.strictEqual(dgx.estimate, 2.41);
    assert.strictEqual(skipped, 2, 'BADDATE and the empty-symbol row are skipped, never guessed');
  });

  await check('EC-02', 'escaped quotes inside quoted fields; missing estimate → null; lowercase symbol uppercased', () => {
    const { rows } = G.parseEarningsCsv(CSV);
    const noest = rows.find((r) => r.symbol === 'NOEST');
    assert.strictEqual(noest.estimate, null);
    assert.strictEqual(noest.fiscal_date_ending, null, 'blank fiscal date must be null, not ""');
    assert.ok(rows.find((r) => r.symbol === 'LOWER'), 'symbols are normalized uppercase');
  });

  await check('EC-03', 'garbage inputs refuse cleanly: empty, headerless, HTML error page', () => {
    assert.deepStrictEqual(G.parseEarningsCsv(''), { rows: [], skipped: 0, headerOk: false });
    assert.strictEqual(G.parseEarningsCsv('a,b,c\n1,2,3').headerOk, false);
    assert.strictEqual(G.parseEarningsCsv('<html>rate limited</html>').headerOk, false);
  });

  console.log('\n═══ (c) staleness goes LOUD — the fail-open guard\'s one mandatory alarm ═══\n');

  await check('EC-04', 'stale calendar → send, kind=stale, says the guard is NOT blocking', () => {
    const a = G.buildEarningsAdvisory({ hits: [], staleDays: 4.2, staleLimit: 3, forwardRows: 900, todayEt: '2026-08-20' });
    assert.strictEqual(a.send, true);
    assert.strictEqual(a.kind, 'stale');
    assert.match(a.text, /FAILS OPEN/);
    assert.match(a.text, /4\.2d ago/);
  });

  await check('EC-05', 'zero forward rows → stale alarm even if fetched_at is recent', () => {
    const a = G.buildEarningsAdvisory({ hits: [], staleDays: 0.1, staleLimit: 3, forwardRows: 0, todayEt: '2026-08-20' });
    assert.strictEqual(a.kind, 'stale');
    assert.match(a.text, /ZERO forward rows/);
  });

  console.log('\n═══ (d)+(e) the advisory itself ═══\n');

  await check('EC-06', 'position hits: one line per position, today-print flagged, WMT lesson cited', () => {
    const a = G.buildEarningsAdvisory({
      hits: [
        { symbol: 'XPEV', side: 'short', report_date: '2026-08-24', days_until: 2 },
        { symbol: 'ZZZ', side: 'long', report_date: '2026-08-20', days_until: 0 },
      ],
      staleDays: 0.2, staleLimit: 3, forwardRows: 1200, todayEt: '2026-08-20',
    });
    assert.strictEqual(a.send, true);
    assert.strictEqual(a.kind, 'hits');
    assert.match(a.text, /XPEV<\/b> \(short\) reports 2026-08-24 — in 2/);
    assert.match(a.text, /TODAY\/tonight/);
    assert.match(a.text, /WMT 08-20 lost 7\.9R/);
  });

  await check('EC-07', 'HTML escaping: a hostile symbol/side cannot break the Telegram payload', () => {
    const a = G.buildEarningsAdvisory({
      hits: [{ symbol: 'A&T<B>', side: '<i>long</i>', report_date: '2026-09-01', days_until: 1 }],
      staleDays: 0.1, staleLimit: 3, forwardRows: 10, todayEt: '2026-08-20',
    });
    assert.ok(a.text.includes('A&amp;T&lt;B&gt;'));
    assert.ok(!a.text.includes('<i>'), 'injected tags must be escaped');
  });

  await check('EC-08', 'silence when healthy and no hits — no daily noise', () => {
    const a = G.buildEarningsAdvisory({ hits: [], staleDays: 0.3, staleLimit: 3, forwardRows: 1500, todayEt: '2026-08-20' });
    assert.deepStrictEqual({ send: a.send, kind: a.kind }, { send: false, kind: 'none' });
  });

  await check('EC-09', 'NEGATIVE CONTROL: sabotaged parser behaviors would fail this suite', () => {
    // If the parser guessed dates, EC-01's skipped-count assert breaks; prove the guards exist:
    assert.ok(!G.parseEarningsCsv('symbol,name,reportDate\nAAPL,Apple,tomorrow').rows.length, 'non-ISO date must not parse');
    const long = G.parseEarningsCsv('symbol,name,reportDate,f,e,c\nTOOLONGSYMBOL,X,2026-09-01,,,USD');
    assert.strictEqual(long.rows.length, 0, 'an 11+ char symbol must be rejected by the SYM regex');
  });

  console.log(`\n  ${passed}/${passed + failed} checks passed\n`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('HARNESS FAILURE:', e); process.exit(1); });
