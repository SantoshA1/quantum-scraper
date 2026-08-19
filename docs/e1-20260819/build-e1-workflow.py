#!/usr/bin/env python3
# Assemble the E1 one-shot workflow SDK code with the engine embedded verbatim.
import re, hashlib

lib = open('lib/analysis/exit_grid.js').read()
m = re.search(r'(// ENGINE_START gov233_e1.*?// ENGINE_END gov233_e1)', lib, re.S)
assert m, 'sentinels missing'
engine = m.group(1)
print('engine region bytes:', len(engine), 'sha:', hashlib.sha256(engine.encode()).hexdigest()[:16])

FETCH_CODE = r'''
// QTP_E1_BARS_GAPFILL_v1_gov233_20260819 — one-shot. Fetch daily bars (feed=iex, matching
// the existing scorer_bars_daily provenance) for every cohort symbol, 2026-06-10 -> yesterday
// ET. Keys read from n8n Variables BY NAME only. Fail-loud. Emits items of <=500 rows for
// chunked idempotent upserts (ON CONFLICT DO NOTHING).
const base = (typeof $vars !== 'undefined' && $vars.ALPACA_BASE_URL) || 'https://paper-api.alpaca.markets';
const dataBase = 'https://data.alpaca.markets';
const key = (typeof $vars !== 'undefined' && ($vars.ALPACA_API_KEY || $vars.ALPACA_KEY_ID)) || '';
const sec = (typeof $vars !== 'undefined' && ($vars.ALPACA_SECRET_KEY || $vars.ALPACA_SECRET)) || '';
if (!key || !sec) throw new Error('E1_GAPFILL_NO_ALPACA_CRED: ALPACA_API_KEY/SECRET_KEY missing from n8n Variables');
const H = { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': sec };
const symbols = String($input.first().json.symbols || '').split(',').filter(Boolean);
if (symbols.length === 0) throw new Error('E1_GAPFILL_NO_SYMBOLS');
const yest = new Date(Date.now() - 24*3600*1000);
const end = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(yest);
const start = '2026-06-10';
const rows = [];
for (let i = 0; i < symbols.length; i += 50) {
  const chunk = symbols.slice(i, i + 50).join(',');
  let pageToken = null;
  do {
    const url = dataBase + '/v2/stocks/bars?symbols=' + encodeURIComponent(chunk)
      + '&timeframe=1Day&start=' + start + '&end=' + end
      + '&limit=10000&adjustment=raw&feed=iex' + (pageToken ? '&page_token=' + encodeURIComponent(pageToken) : '');
    const resp = await this.helpers.httpRequest({ method: 'GET', url, headers: H, json: true, timeout: 20000 });
    const bars = (resp && resp.bars) || {};
    for (const sym of Object.keys(bars)) {
      for (const b of bars[sym]) {
        rows.push({ symbol: sym, d: String(b.t).slice(0, 10), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
      }
    }
    pageToken = resp && resp.next_page_token ? resp.next_page_token : null;
  } while (pageToken);
}
if (rows.length === 0) throw new Error('E1_GAPFILL_ZERO_BARS: Alpaca returned no bars for ' + symbols.length + ' symbols');
const out = [];
for (let i = 0; i < rows.length; i += 500) out.push({ json: { rows: rows.slice(i, i + 500), chunk_index: out.length } });
console.log('[E1 GAPFILL] symbols=' + symbols.length + ' bars=' + rows.length + ' chunks=' + out.length + ' end=' + end);
return out;
'''

RUN_CODE_HEAD = r'''
// QTP_E1_EXIT_GRID_RUNNER_v1_gov233_20260819 — one-shot. Consumes the single Load Dataset
// item, runs the byte-verified engine (sentinel region identical to the committed
// lib/analysis/exit_grid.js), emits one item {cells:[...]} for the results upsert.
// Cohorts: A_long / A_short (executed certified, actual entry px), B_blocked_buy
// (rcf_shadow, entry at block close), C_gatek (GATE_K blocks, entry at block-day close
// resolved from bars; missing entry bar -> excluded).
const RUN_ID = 'e1_20260819';
const ENGINE_VERSION = 'QTP_E1_EXIT_GRID_ENGINE_v1_20260819';
const src = $input.first().json;
'''

RUN_CODE_TAIL = r'''
const barsBySymbol = {};
for (const a of (src.bars || [])) {
  const [sym, d, o, h, l, c] = a;
  (barsBySymbol[sym] = barsBySymbol[sym] || []).push({ d, o, h, l, c });
}
for (const sym of Object.keys(barsBySymbol)) barsBySymbol[sym].sort((x, y) => x.d < y.d ? -1 : 1);

function mkTrades(list, fixedDir) {
  return (list || []).map((t) => ({ symbol: t.symbol, dir: fixedDir || t.dir, entryDay: t.entry_day, entryPx: t.px }));
}
const A = mkTrades(src.trades_a);
const cohorts = {
  A_long: A.filter((t) => t.dir === 'long'),
  A_short: A.filter((t) => t.dir === 'short'),
  B_blocked_buy: mkTrades(src.trades_b, 'long'),
  C_gatek: mkTrades(src.trades_c, 'long').map((t) => {
    const bars = barsBySymbol[t.symbol] || [];
    const eb = bars.find((b) => b.d === t.entryDay);
    return eb ? { ...t, entryPx: eb.c } : { ...t, entryPx: null };
  }).filter((t) => t.entryPx !== null && t.entryPx > 0),
};
const cells = [];
for (const [cohort, trades] of Object.entries(cohorts)) {
  for (const cell of runGrid(trades, barsBySymbol)) {
    cells.push({ run_id: RUN_ID, cohort, engine_version: ENGINE_VERSION, ...cell });
  }
}
console.log('[E1 GRID] cohort sizes: ' + Object.entries(cohorts).map(([k, v]) => k + '=' + v.length).join(', ') + ' cells=' + cells.length);
return [{ json: { cells, cohort_sizes: Object.fromEntries(Object.entries(cohorts).map(([k, v]) => [k, v.length])) } }];
'''

run_code = RUN_CODE_HEAD + '\n' + engine + '\n' + RUN_CODE_TAIL

SYMBOLS_SQL = """with syms as (
  select symbol from public.trade_ledger
  where strategy='qtp-main-pipeline' and mode='paper' and status='closed' and r_multiple is not null
    and coalesce(lineage_source,'') not like 'RECERT_QUARANTINE%' and risk_amount>0
    and intended_stop is not null and entry_fill_price is not null
  union select symbol from quantum.rcf_shadow
  union select symbol from quantum.exec_flow_audit where blocked_stage='GATE_K' and symbol is not null and symbol not in ('UNKNOWN',''))
select string_agg(symbol, ',' order by symbol) as symbols, count(*) as n from (select distinct symbol from syms) s"""

UPSERT_SQL = """insert into quantum.scorer_bars_daily (symbol, d, o, h, l, c, v, feed, loaded_at)
select r.symbol, r.d::date, r.o, r.h, r.l, r.c, r.v, 'iex', now()
from jsonb_to_recordset('{{ JSON.stringify($json.rows).replaceAll(\"'\",\"\") }}'::jsonb)
  as r(symbol text, d text, o numeric, h numeric, l numeric, c numeric, v numeric)
on conflict (symbol, d, feed) do nothing"""

LOAD_SQL = """with a as (
  select symbol,
    case when side in ('buy','buy_call','sell_put') then 'long' else 'short' end as dir,
    ((entry_fill_time at time zone 'America/New_York')::date)::text as entry_day,
    entry_fill_price::float as px
  from public.trade_ledger
  where strategy='qtp-main-pipeline' and mode='paper' and status='closed' and r_multiple is not null
    and coalesce(lineage_source,'') not like 'RECERT_QUARANTINE%' and risk_amount>0
    and intended_stop is not null and entry_fill_price is not null
), b as (
  select symbol, block_day::text as entry_day, block_close::float as px from quantum.rcf_shadow where block_close is not null and block_day is not null
), cg as (
  select distinct symbol, ((ts at time zone 'America/New_York')::date)::text as entry_day
  from quantum.exec_flow_audit where blocked_stage='GATE_K' and symbol is not null and symbol not in ('UNKNOWN','')
), allsyms as (
  select symbol from a union select symbol from b union select symbol from cg
), bars as (
  select symbol, d::text as d, o::float as o, h::float as h, l::float as l, c::float as cl
  from quantum.scorer_bars_daily
  where d >= date '2026-06-10' and symbol in (select symbol from allsyms)
)
select
  (select jsonb_agg(to_jsonb(a)) from a) as trades_a,
  (select jsonb_agg(to_jsonb(b)) from b) as trades_b,
  (select jsonb_agg(to_jsonb(cg)) from cg) as trades_c,
  (select jsonb_agg(jsonb_build_array(symbol, d, o, h, l, cl)) from bars) as bars"""

RESULTS_SQL = """insert into quantum.e1_exit_grid_results
  (run_id, cohort, stop_key, exit_key, n, excluded, wins, win_rate, sum_pos_pct, sum_neg_pct, pf, expectancy_pct, stop_rate, target_rate, time_rate, gap_through_stops, engine_version)
select r.run_id, r.cohort, r.stop_key, r.exit_key, r.n, r.excluded, r.wins, r.win_rate, r.sum_pos_pct, r.sum_neg_pct, r.pf, r.expectancy_pct, r.stop_rate, r.target_rate, r.time_rate, r.gap_through_stops, r.engine_version
from jsonb_to_recordset('{{ JSON.stringify($json.cells) }}'::jsonb)
  as r(run_id text, cohort text, stop_key text, exit_key text, n int, excluded int, wins int, win_rate numeric, sum_pos_pct numeric, sum_neg_pct numeric, pf numeric, expectancy_pct numeric, stop_rate numeric, target_rate numeric, time_rate numeric, gap_through_stops int, engine_version text)
on conflict (run_id, cohort, stop_key, exit_key) do update set
  n=excluded.n, excluded=excluded.excluded, wins=excluded.wins, win_rate=excluded.win_rate,
  sum_pos_pct=excluded.sum_pos_pct, sum_neg_pct=excluded.sum_neg_pct, pf=excluded.pf,
  expectancy_pct=excluded.expectancy_pct, stop_rate=excluded.stop_rate, target_rate=excluded.target_rate,
  time_rate=excluded.time_rate, gap_through_stops=excluded.gap_through_stops,
  engine_version=excluded.engine_version, computed_at=now()"""

def js_str(s):
    return "'" + s.replace('\\', '\\\\').replace("'", "\\'").replace('\n', '\\n') + "'"

sdk = f"""import {{ workflow, node, trigger }} from '@n8n/workflow-sdk';

const startE1 = trigger({{
  type: 'n8n-nodes-base.manualTrigger',
  version: 1,
  config: {{ name: 'Start E1', position: [240, 300] }},
  output: [{{}}]
}});

const fetchSymbols = node({{
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {{
    name: 'Fetch Symbol List',
    position: [460, 300],
    parameters: {{ operation: 'executeQuery', query: {js_str(SYMBOLS_SQL)}, options: {{}} }},
    credentials: {{ postgres: {{ id: 'lnLr649ylxATlCF8', name: 'Postgres account' }} }}
  }},
  output: [{{ symbols: 'AAPL,MSFT', n: 2 }}]
}});

const fetchBars = node({{
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {{
    name: 'Fetch Alpaca Bars',
    position: [680, 300],
    parameters: {{ jsCode: {js_str(FETCH_CODE)} }}
  }},
  output: [{{ rows: [{{ symbol: 'AAPL', d: '2026-08-14', o: 1, h: 1, l: 1, c: 1, v: 1 }}], chunk_index: 0 }}]
}});

const upsertBars = node({{
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {{
    name: 'Upsert Bars',
    position: [900, 300],
    parameters: {{ operation: 'executeQuery', query: {js_str(UPSERT_SQL)}, options: {{}} }},
    credentials: {{ postgres: {{ id: 'lnLr649ylxATlCF8', name: 'Postgres account' }} }}
  }},
  output: [{{}}]
}});

const loadDataset = node({{
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {{
    name: 'Load Dataset',
    position: [1120, 300],
    executeOnce: true,
    parameters: {{ operation: 'executeQuery', query: {js_str(LOAD_SQL)}, options: {{}} }},
    credentials: {{ postgres: {{ id: 'lnLr649ylxATlCF8', name: 'Postgres account' }} }}
  }},
  output: [{{ trades_a: [], trades_b: [], trades_c: [], bars: [] }}]
}});

const runGrid = node({{
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {{
    name: 'Run Exit Grid',
    position: [1340, 300],
    executeOnce: true,
    parameters: {{ jsCode: {js_str(run_code)} }}
  }},
  output: [{{ cells: [], cohort_sizes: {{}} }}]
}});

const writeResults = node({{
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {{
    name: 'Write Results',
    position: [1560, 300],
    parameters: {{ operation: 'executeQuery', query: {js_str(RESULTS_SQL)}, options: {{}} }},
    credentials: {{ postgres: {{ id: 'lnLr649ylxATlCF8', name: 'Postgres account' }} }}
  }},
  output: [{{}}]
}});

export default workflow('qtp-e1-exit-grid', 'QTP E1 Exit Grid (one-shot, gov 233)')
  .add(startE1)
  .to(fetchSymbols)
  .to(fetchBars)
  .to(upsertBars)
  .to(loadDataset)
  .to(runGrid)
  .to(writeResults);
"""

open('/tmp/e1-workflow-sdk.js', 'w').write(sdk)
open('docs/e1-20260819/run-exit-grid-node.js', 'w').write(run_code)
print('sdk bytes:', len(sdk))
print('run node bytes:', len(run_code), 'sha:', hashlib.sha256(run_code.encode()).hexdigest()[:16])
