#!/usr/bin/env node
'use strict';
/**
  * Executes the EXACT paste-ready block from docs/tsm-bars-patch-block.js inside a replica of the live
 * node's scope (`symbols`, `barsData`, `alp.call(this,...)`, wrapped in the same try/catch)
 * against an Alpaca simulator. Proves the snippet runs before it is pasted into n8n.
 */
const fs = require('fs');
const path = require('path');
const BLOCK = fs.readFileSync(path.join(__dirname, '..', 'docs', 'tsm-bars-patch-block.js'), 'utf8');

const TODAY = new Date().toISOString().slice(0, 10);
const SYMS = ['AES', 'XPEV', 'AFL', 'BA', 'CBRE', 'JKHY', 'LDOS', 'MAR', 'RMD', 'WMT'];

function series(close, days = 90) {
  const half = close * 0.01;
  const out = []; let d = new Date(`${TODAY}T00:00:00Z`);
  while (out.length < days) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push({ t: d.toISOString().slice(0, 10), h: close + half, l: close - half, c: close });
    d = new Date(d.getTime() - 86400000);
  }
  return out.reverse();
}
const UNIVERSE = {}; SYMS.forEach((s, i) => { UNIVERSE[s] = series(50 + i * 10); });

let requests = 0; const seenPaths = [];
const alp = async function (method, p) {
  requests++; seenPaths.push(p);
  const q = new URL(p, 'https://x').searchParams;
  const syms = String(q.get('symbols') || '').split(',').filter(Boolean).sort();
  const start = q.get('start') || TODAY;
  const limit = Math.min(Number(q.get('limit') || 1000), 400); // force paging
  const offset = Number(q.get('page_token') || 0);
  const flat = [];
  for (const s of syms) for (const b of (UNIVERSE[s] || [])) if (b.t >= start) flat.push([s, b]);
  const slice = flat.slice(offset, offset + limit);
  const bars = {};
  for (const [s, b] of slice) (bars[s] = bars[s] || []).push(b);
  return { bars, next_page_token: offset + limit < flat.length ? String(offset + limit) : null };
};

const runner = new Function('symbols', 'alp', `
  return (async function () {
    let barsData = {};
    try {
${BLOCK.split('\n').map(l => '      ' + l).join('\n')}
    } catch (e) { console.warn('[TRAIL] Bars fetch failed, using 2% proxy ATR:', e.message); }
    return barsData;
  }).call(this);
`);

(async () => {
  const barsData = await runner(SYMS.join(','), alp);
  const short = SYMS.filter((s) => (barsData[s] || []).length < 15);
  const first = seenPaths[0] || '';
  const checks = [
    ['block executes and returns bars', Object.keys(barsData).length === SYMS.length],
    ['every symbol has >=15 bars', short.length === 0],
    ['request carries an explicit start', /[?&]start=\d{4}-\d{2}-\d{2}/.test(first)],
    ['request carries adjustment=all', first.includes('adjustment=all')],
    ['limit scaled to universe (>20)', Number((first.match(/[?&]limit=(\d+)/) || [])[1]) > 20],
    ['feed=sip preserved from live', first.includes('feed=sip')],
    ['timeframe=1Day preserved from live', first.includes('timeframe=1Day')],
    ['paging actually engaged', requests > 1],
    ['loop terminated', requests < 64],
  ];
  let bad = 0;
  console.log('  PASTE-READY BLOCK VERIFICATION');
  for (const [name, ok] of checks) { console.log(`  ${ok ? '✅' : '❌'} ${name}`); if (!ok) bad++; }
  console.log(`\n  first request: ${first}`);
  console.log(`  requests: ${requests}   symbols fed: ${SYMS.length - short.length}/${SYMS.length}`);
  console.log(`\n  ${checks.length - bad}/${checks.length} checks passed`);
  process.exit(bad === 0 ? 0 : 1);
})();
