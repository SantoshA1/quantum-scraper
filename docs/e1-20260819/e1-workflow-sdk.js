import { workflow, node, trigger, expr } from '@n8n/workflow-sdk';

const startE1 = trigger({
  type: 'n8n-nodes-base.manualTrigger',
  version: 1,
  config: { name: 'Start E1', position: [240, 300] },
  output: [{}]
});

const fetchSymbols = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Fetch Symbol List',
    position: [460, 300],
    parameters: { operation: 'executeQuery', query: 'with syms as (\n  select symbol from public.trade_ledger\n  where strategy=\'qtp-main-pipeline\' and mode=\'paper\' and status=\'closed\' and r_multiple is not null\n    and coalesce(lineage_source,\'\') not like \'RECERT_QUARANTINE%\' and risk_amount>0\n    and intended_stop is not null and entry_fill_price is not null\n  union select symbol from quantum.rcf_shadow\n  union select symbol from quantum.exec_flow_audit where blocked_stage=\'GATE_K\' and symbol is not null and symbol not in (\'UNKNOWN\',\'\'))\nselect string_agg(symbol, \',\' order by symbol) as symbols, count(*) as n from (select distinct symbol from syms) s', options: {} },
    credentials: { postgres: { id: 'lnLr649ylxATlCF8', name: 'Postgres account' } }
  },
  output: [{ symbols: 'AAPL,MSFT', n: 2 }]
});

const fetchBars = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Fetch Alpaca Bars',
    position: [680, 300],
    parameters: { jsCode: '\n// QTP_E1_BARS_GAPFILL_v1_gov233_20260819 — one-shot. Fetch daily bars (feed=iex, matching\n// the existing scorer_bars_daily provenance) for every cohort symbol, 2026-06-10 -> yesterday\n// ET. Keys read from n8n Variables BY NAME only. Fail-loud. Emits items of <=500 rows for\n// chunked idempotent upserts (ON CONFLICT DO NOTHING).\nconst base = (typeof $vars !== \'undefined\' && $vars.ALPACA_BASE_URL) || \'https://paper-api.alpaca.markets\';\nconst dataBase = \'https://data.alpaca.markets\';\nconst key = (typeof $vars !== \'undefined\' && ($vars.ALPACA_API_KEY || $vars.ALPACA_KEY_ID)) || \'\';\nconst sec = (typeof $vars !== \'undefined\' && ($vars.ALPACA_SECRET_KEY || $vars.ALPACA_SECRET)) || \'\';\nif (!key || !sec) throw new Error(\'E1_GAPFILL_NO_ALPACA_CRED: ALPACA_API_KEY/SECRET_KEY missing from n8n Variables\');\nconst H = { \'APCA-API-KEY-ID\': key, \'APCA-API-SECRET-KEY\': sec };\nconst symbols = String($input.first().json.symbols || \'\').split(\',\').filter(Boolean);\nif (symbols.length === 0) throw new Error(\'E1_GAPFILL_NO_SYMBOLS\');\nconst yest = new Date(Date.now() - 24*3600*1000);\nconst end = new Intl.DateTimeFormat(\'en-CA\', { timeZone: \'America/New_York\' }).format(yest);\nconst start = \'2026-06-10\';\nconst rows = [];\nfor (let i = 0; i < symbols.length; i += 50) {\n  const chunk = symbols.slice(i, i + 50).join(\',\');\n  let pageToken = null;\n  do {\n    const url = dataBase + \'/v2/stocks/bars?symbols=\' + encodeURIComponent(chunk)\n      + \'&timeframe=1Day&start=\' + start + \'&end=\' + end\n      + \'&limit=10000&adjustment=raw&feed=iex\' + (pageToken ? \'&page_token=\' + encodeURIComponent(pageToken) : \'\');\n    const resp = await this.helpers.httpRequest({ method: \'GET\', url, headers: H, json: true, timeout: 20000 });\n    const bars = (resp && resp.bars) || {};\n    for (const sym of Object.keys(bars)) {\n      for (const b of bars[sym]) {\n        rows.push({ symbol: sym, d: String(b.t).slice(0, 10), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });\n      }\n    }\n    pageToken = resp && resp.next_page_token ? resp.next_page_token : null;\n  } while (pageToken);\n}\nif (rows.length === 0) throw new Error(\'E1_GAPFILL_ZERO_BARS: Alpaca returned no bars for \' + symbols.length + \' symbols\');\nconst out = [];\nfor (let i = 0; i < rows.length; i += 500) out.push({ json: { rows: rows.slice(i, i + 500), chunk_index: out.length } });\nconsole.log(\'[E1 GAPFILL] symbols=\' + symbols.length + \' bars=\' + rows.length + \' chunks=\' + out.length + \' end=\' + end);\nreturn out;\n' }
  },
  output: [{ rows: [{ symbol: 'AAPL', d: '2026-08-14', o: 1, h: 1, l: 1, c: 1, v: 1 }], chunk_index: 0 }]
});

const upsertBars = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Upsert Bars',
    position: [900, 300],
    parameters: { operation: 'executeQuery', query: expr('insert into quantum.scorer_bars_daily (symbol, d, o, h, l, c, v, feed, loaded_at)\nselect r.symbol, r.d::date, r.o, r.h, r.l, r.c, r.v, \'iex\', now()\nfrom jsonb_to_recordset(\'{{ JSON.stringify($json.rows).replaceAll("\'","") }}\'::jsonb)\n  as r(symbol text, d text, o numeric, h numeric, l numeric, c numeric, v numeric)\non conflict (symbol, d, feed) do nothing'), options: {} },
    credentials: { postgres: { id: 'lnLr649ylxATlCF8', name: 'Postgres account' } }
  },
  output: [{}]
});

const loadDataset = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Load Dataset',
    position: [1120, 300],
    executeOnce: true,
    parameters: { operation: 'executeQuery', query: 'with a as (\n  select symbol,\n    case when side in (\'buy\',\'buy_call\',\'sell_put\') then \'long\' else \'short\' end as dir,\n    ((entry_fill_time at time zone \'America/New_York\')::date)::text as entry_day,\n    entry_fill_price::float as px\n  from public.trade_ledger\n  where strategy=\'qtp-main-pipeline\' and mode=\'paper\' and status=\'closed\' and r_multiple is not null\n    and coalesce(lineage_source,\'\') not like \'RECERT_QUARANTINE%\' and risk_amount>0\n    and intended_stop is not null and entry_fill_price is not null\n), b as (\n  select symbol, block_day::text as entry_day, block_close::float as px from quantum.rcf_shadow where block_close is not null and block_day is not null\n), cg as (\n  select distinct symbol, ((ts at time zone \'America/New_York\')::date)::text as entry_day\n  from quantum.exec_flow_audit where blocked_stage=\'GATE_K\' and symbol is not null and symbol not in (\'UNKNOWN\',\'\')\n), allsyms as (\n  select symbol from a union select symbol from b union select symbol from cg\n), bars as (\n  select symbol, d::text as d, o::float as o, h::float as h, l::float as l, c::float as cl\n  from quantum.scorer_bars_daily\n  where d >= date \'2026-06-10\' and symbol in (select symbol from allsyms)\n)\nselect\n  (select jsonb_agg(to_jsonb(a)) from a) as trades_a,\n  (select jsonb_agg(to_jsonb(b)) from b) as trades_b,\n  (select jsonb_agg(to_jsonb(cg)) from cg) as trades_c,\n  (select jsonb_agg(jsonb_build_array(symbol, d, o, h, l, cl)) from bars) as bars', options: {} },
    credentials: { postgres: { id: 'lnLr649ylxATlCF8', name: 'Postgres account' } }
  },
  output: [{ trades_a: [], trades_b: [], trades_c: [], bars: [] }]
});

const runGrid = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Run Exit Grid',
    position: [1340, 300],
    executeOnce: true,
    parameters: { jsCode: '\n// QTP_E1_EXIT_GRID_RUNNER_v1_gov233_20260819 — one-shot. Consumes the single Load Dataset\n// item, runs the byte-verified engine (sentinel region identical to the committed\n// lib/analysis/exit_grid.js), emits one item {cells:[...]} for the results upsert.\n// Cohorts: A_long / A_short (executed certified, actual entry px), B_blocked_buy\n// (rcf_shadow, entry at block close), C_gatek (GATE_K blocks, entry at block-day close\n// resolved from bars; missing entry bar -> excluded).\nconst RUN_ID = \'e1_20260819\';\nconst ENGINE_VERSION = \'QTP_E1_EXIT_GRID_ENGINE_v1_20260819\';\nconst src = $input.first().json;\n\n// ENGINE_START gov233_e1 — everything between the sentinels is embedded VERBATIM in the\n// one-shot n8n runner node and byte-verified at deploy (region diff must be exit 0).\nfunction splitBars(bars, entryDay) {\n  const pre = [], post = [];\n  for (const b of bars) {\n    if (b.d < entryDay) pre.push(b);\n    else if (b.d > entryDay) post.push(b);\n  }\n  return { pre, post };\n}\n\nfunction atr14(preBars) {\n  if (!preBars || preBars.length < 15) return null;\n  const w = preBars.slice(-15);\n  let sum = 0;\n  for (let i = 1; i < w.length; i++) {\n    const prevC = w[i - 1].c;\n    const tr = Math.max(w[i].h - w[i].l, Math.abs(w[i].h - prevC), Math.abs(w[i].l - prevC));\n    sum += tr;\n  }\n  return sum / 14;\n}\n\nfunction stopPrice(entry, stopSpec, atr) {\n  if (stopSpec.kind === \'none\') return null;\n  if (stopSpec.kind === \'pct\') {\n    const off = entry.entryPx * (stopSpec.v / 100);\n    return entry.dir === \'long\' ? entry.entryPx - off : entry.entryPx + off;\n  }\n  if (stopSpec.kind === \'atr\') {\n    if (atr === null) return undefined; // excluded from this cell\n    const off = stopSpec.v * atr;\n    return entry.dir === \'long\' ? entry.entryPx - off : entry.entryPx + off;\n  }\n  throw new Error(\'unknown stopSpec \' + JSON.stringify(stopSpec));\n}\n\nfunction retPct(entry, exitPx) {\n  return entry.dir === \'long\'\n    ? (exitPx / entry.entryPx - 1) * 100\n    : (entry.entryPx - exitPx) / entry.entryPx * 100;\n}\n\nfunction simulate(entry, bars, stopSpec, exitSpec) {\n  const { pre, post } = splitBars(bars, entry.entryDay);\n  const days = exitSpec.days;\n  if (!Number.isInteger(days) || days < 1) return { excluded: \'bad_exit_spec\' };\n  if (post.length < days) return { excluded: \'immature_window\' };\n\n  const atr = atr14(pre);\n  const stopPx = stopPrice(entry, stopSpec, atr);\n  if (stopPx === undefined) return { excluded: \'no_atr\' };\n\n  let targetPx = null;\n  if (exitSpec.kind === \'target2R\') {\n    if (stopPx === null) return { excluded: \'target_needs_stop\' };\n    const r = Math.abs(entry.entryPx - stopPx);\n    targetPx = entry.dir === \'long\' ? entry.entryPx + 2 * r : entry.entryPx - 2 * r;\n  }\n\n  const long = entry.dir === \'long\';\n  for (let i = 1; i <= days; i++) {\n    const b = post[i - 1];\n    // 1) gap through stop at the open\n    if (stopPx !== null && (long ? b.o <= stopPx : b.o >= stopPx)) {\n      return { ret_pct: retPct(entry, b.o), exit_kind: \'stop\', exit_day_index: i, gap_through: true };\n    }\n    // 2) gap through target at the open\n    if (targetPx !== null && (long ? b.o >= targetPx : b.o <= targetPx)) {\n      return { ret_pct: retPct(entry, b.o), exit_kind: \'target\', exit_day_index: i, gap_through: true };\n    }\n    // 3) intraday stop (stop-first, conservative)\n    if (stopPx !== null && (long ? b.l <= stopPx : b.h >= stopPx)) {\n      return { ret_pct: retPct(entry, stopPx), exit_kind: \'stop\', exit_day_index: i, gap_through: false };\n    }\n    // 4) intraday target\n    if (targetPx !== null && (long ? b.h >= targetPx : b.l <= targetPx)) {\n      return { ret_pct: retPct(entry, targetPx), exit_kind: \'target\', exit_day_index: i, gap_through: false };\n    }\n    // 5) time exit on the last day\n    if (i === days) {\n      return { ret_pct: retPct(entry, b.c), exit_kind: \'time\', exit_day_index: i, gap_through: false };\n    }\n  }\n  /* istanbul ignore next */ throw new Error(\'unreachable\');\n}\n\nfunction aggregate(results) {\n  const inc = results.filter((r) => !r.excluded);\n  const n = inc.length;\n  const wins = inc.filter((r) => r.ret_pct > 0).length;\n  let pos = 0, neg = 0;\n  for (const r of inc) { if (r.ret_pct > 0) pos += r.ret_pct; else neg += -r.ret_pct; }\n  const round = (x, k = 4) => Math.round(x * 10 ** k) / 10 ** k;\n  return {\n    n,\n    excluded: results.length - n,\n    wins,\n    win_rate: n ? round(wins / n) : null,\n    sum_pos_pct: round(pos),\n    sum_neg_pct: round(neg),\n    pf: neg > 0 ? round(pos / neg) : (pos > 0 ? 999.9999 : null),\n    expectancy_pct: n ? round((pos - neg) / n) : null,\n    stop_rate: n ? round(inc.filter((r) => r.exit_kind === \'stop\').length / n) : null,\n    target_rate: n ? round(inc.filter((r) => r.exit_kind === \'target\').length / n) : null,\n    time_rate: n ? round(inc.filter((r) => r.exit_kind === \'time\').length / n) : null,\n    gap_through_stops: inc.filter((r) => r.exit_kind === \'stop\' && r.gap_through).length,\n  };\n}\n\nconst DEFAULT_STOPS = [\n  { key: \'pct_1.0\', kind: \'pct\', v: 1.0 },\n  { key: \'pct_2.0\', kind: \'pct\', v: 2.0 },\n  { key: \'pct_2.5\', kind: \'pct\', v: 2.5 },\n  { key: \'pct_3.0\', kind: \'pct\', v: 3.0 },\n  { key: \'atr_1.5\', kind: \'atr\', v: 1.5 },\n  { key: \'atr_2.5\', kind: \'atr\', v: 2.5 },\n  { key: \'none\', kind: \'none\' },\n];\nconst DEFAULT_EXITS = [\n  { key: \'time_1d\', kind: \'time\', days: 1 },\n  { key: \'time_2d\', kind: \'time\', days: 2 },\n  { key: \'time_3d\', kind: \'time\', days: 3 },\n  { key: \'time_5d\', kind: \'time\', days: 5 },\n  { key: \'target2R_5d\', kind: \'target2R\', days: 5 },\n];\n\nfunction runGrid(trades, barsBySymbol, stops = DEFAULT_STOPS, exits = DEFAULT_EXITS) {\n  const cells = [];\n  for (const stop of stops) {\n    for (const exit of exits) {\n      if (exit.kind === \'target2R\' && stop.kind === \'none\') continue; // R undefined\n      const results = trades.map((t) => {\n        const bars = barsBySymbol[t.symbol];\n        if (!bars || bars.length === 0) return { excluded: \'no_bars\' };\n        return simulate(t, bars, stop, exit);\n      });\n      cells.push({ stop_key: stop.key, exit_key: exit.key, ...aggregate(results) });\n    }\n  }\n  return cells;\n}\n\n// ENGINE_END gov233_e1\n\nconst barsBySymbol = {};\nfor (const a of (src.bars || [])) {\n  const [sym, d, o, h, l, c] = a;\n  (barsBySymbol[sym] = barsBySymbol[sym] || []).push({ d, o, h, l, c });\n}\nfor (const sym of Object.keys(barsBySymbol)) barsBySymbol[sym].sort((x, y) => x.d < y.d ? -1 : 1);\n\nfunction mkTrades(list, fixedDir) {\n  return (list || []).map((t) => ({ symbol: t.symbol, dir: fixedDir || t.dir, entryDay: t.entry_day, entryPx: t.px }));\n}\nconst A = mkTrades(src.trades_a);\nconst cohorts = {\n  A_long: A.filter((t) => t.dir === \'long\'),\n  A_short: A.filter((t) => t.dir === \'short\'),\n  B_blocked_buy: mkTrades(src.trades_b, \'long\'),\n  C_gatek: mkTrades(src.trades_c, \'long\').map((t) => {\n    const bars = barsBySymbol[t.symbol] || [];\n    const eb = bars.find((b) => b.d === t.entryDay);\n    return eb ? { ...t, entryPx: eb.c } : { ...t, entryPx: null };\n  }).filter((t) => t.entryPx !== null && t.entryPx > 0),\n};\nconst cells = [];\nfor (const [cohort, trades] of Object.entries(cohorts)) {\n  for (const cell of runGrid(trades, barsBySymbol)) {\n    cells.push({ run_id: RUN_ID, cohort, engine_version: ENGINE_VERSION, ...cell });\n  }\n}\nconsole.log(\'[E1 GRID] cohort sizes: \' + Object.entries(cohorts).map(([k, v]) => k + \'=\' + v.length).join(\', \') + \' cells=\' + cells.length);\nreturn [{ json: { cells, cohort_sizes: Object.fromEntries(Object.entries(cohorts).map(([k, v]) => [k, v.length])) } }];\n' }
  },
  output: [{ cells: [], cohort_sizes: {} }]
});

const writeResults = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Write Results',
    position: [1560, 300],
    parameters: { operation: 'executeQuery', query: expr('insert into quantum.e1_exit_grid_results\n  (run_id, cohort, stop_key, exit_key, n, excluded, wins, win_rate, sum_pos_pct, sum_neg_pct, pf, expectancy_pct, stop_rate, target_rate, time_rate, gap_through_stops, engine_version)\nselect r.run_id, r.cohort, r.stop_key, r.exit_key, r.n, r.excluded, r.wins, r.win_rate, r.sum_pos_pct, r.sum_neg_pct, r.pf, r.expectancy_pct, r.stop_rate, r.target_rate, r.time_rate, r.gap_through_stops, r.engine_version\nfrom jsonb_to_recordset(\'{{ JSON.stringify($json.cells) }}\'::jsonb)\n  as r(run_id text, cohort text, stop_key text, exit_key text, n int, excluded int, wins int, win_rate numeric, sum_pos_pct numeric, sum_neg_pct numeric, pf numeric, expectancy_pct numeric, stop_rate numeric, target_rate numeric, time_rate numeric, gap_through_stops int, engine_version text)\non conflict (run_id, cohort, stop_key, exit_key) do update set\n  n=excluded.n, excluded=excluded.excluded, wins=excluded.wins, win_rate=excluded.win_rate,\n  sum_pos_pct=excluded.sum_pos_pct, sum_neg_pct=excluded.sum_neg_pct, pf=excluded.pf,\n  expectancy_pct=excluded.expectancy_pct, stop_rate=excluded.stop_rate, target_rate=excluded.target_rate,\n  time_rate=excluded.time_rate, gap_through_stops=excluded.gap_through_stops,\n  engine_version=excluded.engine_version, computed_at=now()'), options: {} },
    credentials: { postgres: { id: 'lnLr649ylxATlCF8', name: 'Postgres account' } }
  },
  output: [{}]
});

export default workflow('qtp-e1-exit-grid', 'QTP E1 Exit Grid (one-shot, gov 233)')
  .add(startE1)
  .to(fetchSymbols)
  .to(fetchBars)
  .to(upsertBars)
  .to(loadDataset)
  .to(runGrid)
  .to(writeResults);
