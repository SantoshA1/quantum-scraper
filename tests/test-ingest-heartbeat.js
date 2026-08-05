#!/usr/bin/env node
'use strict';
/**
 * Maya regression guard — order-lifecycle ingestor heartbeat (QTP_INGEST_HEARTBEAT_v1_20260805).
 *
 * Maya asks: "You told me the ingestor was dead for 18 hours. It wasn't — the market was just
 * quiet and the health check was reading the wrong clock. Prove the new version writes a
 * heartbeat EVERY run so quiet and dead can never be confused again, prove the insert is still
 * idempotent, and prove the health verdict flips DEAD only when it should."
 *
 * Deterministic + offline. Executes the SQL-builder logic of the live "Fetch Order Lifecycle"
 * node (v1.2) in a replica of the n8n Code-node scope, and pins the v_order_ingest_health
 * CASE semantics in a JS mirror.
 */
const assert = require('assert');

let passed = 0, failed = 0;
function check(id, name, fn) {
  try { fn(); console.log(`  ✅ ${id}  ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${id}  ${name}  — ${e.message}`); failed++; }
}

// ── replica of the live node's SQL builder (v1.2, deployed 2026-08-05, wf n31KzRDp6wR5BlFb,
//    version 68d6a224). Kept in lockstep by this suite: if the live builder changes shape,
//    update BOTH and re-run.
function buildSql(orders) {
  const WF_ID = 'n31KzRDp6wR5BlFb';
  const WF_NAME = 'QTP Order Lifecycle Ingestor';
  orders = (orders || []).filter(o => o && o.id);
  const esc = (v) => String(v).replace(/'/g, "''").replace(/\$(\d)/g, 'USD $1');
  const txt = (v) => (v === null || v === undefined || v === '') ? 'NULL' : "'" + esc(v) + "'";
  const num = (v) => { if (v === null || v === undefined || v === '') return 'NULL::numeric'; const n = Number(v); return isFinite(n) ? "'" + n + "'::numeric" : 'NULL::numeric'; };
  function toRow(o) {
    const ts = o.updated_at || o.submitted_at || o.created_at || '';
    if (!o.id || !ts) return null;
    const eventId = o.id + ':' + o.status + ':' + ts;
    let rp = JSON.stringify(o) || '{}';
    if (rp.length > 8000) rp = JSON.stringify({ _truncated: true, id: o.id, status: o.status, symbol: o.symbol, order_type: o.type, updated_at: o.updated_at });
    const side = o.position_intent ? String(o.side || '') + ':' + o.position_intent : String(o.side || 'unknown');
    const vals = [txt(eventId), txt(o.id), txt(o.id), "'alpaca_paper'", txt(ts) + '::timestamptz', txt(String(ts).slice(0, 10)) + '::date',
      txt(o.symbol || 'UNKNOWN'), txt(side), txt(o.type), txt(o.time_in_force), txt(String(o.status || 'unknown').toUpperCase()),
      num(o.qty), num(o.filled_qty), num(o.limit_price), num(o.stop_price), num(o.filled_avg_price), txt(rp) + '::jsonb', txt(eventId), 'now()'];
    return { eventId, sql: '(' + vals.join(', ') + ')' };
  }
  const rows = []; const seen = {};
  for (const o of orders) for (const ord of [o].concat(Array.isArray(o.legs) ? o.legs : [])) {
    const r = toRow(ord); if (r && !seen[r.eventId]) { seen[r.eventId] = true; rows.push(r.sql); }
  }
  const heartbeatSql = (inserted, note) =>
    'INSERT INTO quantum.ingest_heartbeat (workflow_id, workflow_name, orders_seen, candidate_rows, rows_inserted, note) ' +
    "SELECT '" + WF_ID + "', '" + esc(WF_NAME) + "', " + orders.length + ', ' + rows.length + ', ' + inserted + ", '" + esc(note) + "'";
  if (rows.length === 0) return heartbeatSql('0', orders.length === 0 ? 'v1.2 no orders returned' : 'v1.2 no stampable rows');
  const cols = 'order_event_id, order_id, broker_order_id, account_id, event_ts, event_date, symbol, side, order_type, time_in_force, order_status, requested_quantity, filled_quantity, limit_price, stop_price, avg_fill_price, raw_payload, idempotency_key, ingested_at';
  return 'WITH ins AS (INSERT INTO quantum.order_events (' + cols + ') SELECT * FROM (VALUES ' + rows.join(', ') + ') AS v(' + cols + ') ' +
    'WHERE NOT EXISTS (SELECT 1 FROM quantum.order_events oe WHERE oe.order_event_id = v.order_event_id) RETURNING 1) ' +
    heartbeatSql('(SELECT count(*) FROM ins)', 'v1.2');
}

// ── mirror of quantum.v_order_ingest_health status CASE ────────────────────────
function healthStatus({ missingEntries = 0, missingExits = 0, lastRunAgeMin = null, inWindow = true }) {
  if (missingEntries > 0 || missingExits > 0) return 'INGEST_GAP';
  if (lastRunAgeMin === null) return 'NO_HEARTBEAT_YET';
  if (inWindow && lastRunAgeMin > 25) return 'DEAD';
  if (!inWindow) return 'IDLE_OUT_OF_WINDOW';
  return 'HEALTHY';
}

const ORDER = { id: 'ord1', status: 'filled', updated_at: '2026-08-05T13:31:00Z', symbol: 'XPEV', side: 'sell',
  type: 'stop', time_in_force: 'gtc', qty: '858', filled_qty: '858', stop_price: '12.10', filled_avg_price: '12.09',
  legs: [{ id: 'leg1', status: 'canceled', updated_at: '2026-08-05T13:30:00Z', symbol: 'XPEV', side: 'sell', type: 'limit', qty: '858', filled_qty: '0' }] };

// ── THE FALSE ALARM, pinned ───────────────────────────────────────────────────
check('ALARM-01', 'quiet market + fresh heartbeat = HEALTHY, no matter how stale the newest event is', () => {
  assert.strictEqual(healthStatus({ lastRunAgeMin: 5, inWindow: true }), 'HEALTHY');
  // the newest_market_event age plays NO role in the verdict — that was the broken clock
});
check('ALARM-02', 'overnight (out of window) = IDLE, never DEAD', () => {
  assert.strictEqual(healthStatus({ lastRunAgeMin: 900, inWindow: false }), 'IDLE_OUT_OF_WINDOW');
});
check('ALARM-03', 'in-window heartbeat older than 25 min = DEAD (two missed 10-min cycles + slack)', () => {
  assert.strictEqual(healthStatus({ lastRunAgeMin: 26, inWindow: true }), 'DEAD');
  assert.strictEqual(healthStatus({ lastRunAgeMin: 24, inWindow: true }), 'HEALTHY');
});
check('ALARM-04', 'a ledger order id missing from order_events beats everything: INGEST_GAP', () => {
  assert.strictEqual(healthStatus({ missingExits: 1, lastRunAgeMin: 2, inWindow: true }), 'INGEST_GAP');
});
check('ALARM-05', 'no heartbeat rows at all = NO_HEARTBEAT_YET (bootstrap state, not DEAD)', () => {
  assert.strictEqual(healthStatus({ lastRunAgeMin: null }), 'NO_HEARTBEAT_YET');
});

// ── THE FIX: every run emits SQL — [] is no longer a possible output ──────────
check('HB-01', 'zero orders returned -> heartbeat-only SQL, never an empty return', () => {
  const sql = buildSql([]);
  assert.ok(sql.startsWith('INSERT INTO quantum.ingest_heartbeat'), sql.slice(0, 80));
  assert.ok(sql.includes(' 0, 0, 0,'), 'orders_seen=0, candidate_rows=0, rows_inserted=0');
  assert.ok(sql.includes('no orders returned'));
});
check('HB-02', 'orders with rows -> ONE atomic statement: CTE insert + heartbeat with real count', () => {
  const sql = buildSql([ORDER]);
  assert.ok(sql.startsWith('WITH ins AS (INSERT INTO quantum.order_events'), sql.slice(0, 60));
  assert.ok(sql.includes('WHERE NOT EXISTS'), 'idempotency guard preserved');
  assert.ok(sql.includes('RETURNING 1)'), 'CTE returns inserted rows');
  assert.ok(sql.includes('(SELECT count(*) FROM ins)'), 'heartbeat records the REAL inserted count');
  assert.strictEqual(sql.split(';').length, 1, 'single statement — no multi-statement risk');
});
check('HB-03', 'nested legs still expand into their own candidate rows', () => {
  const sql = buildSql([ORDER]);
  assert.ok(sql.includes("'leg1:canceled:"), 'leg event id present');
  assert.ok(sql.includes("'ord1:filled:"), 'parent event id present');
  assert.ok(sql.includes(' 1, 2, '), 'orders_seen=1, candidate_rows=2');
});
check('HB-04', 'unstampable orders (no timestamps) -> heartbeat-only, flagged as such', () => {
  const sql = buildSql([{ id: 'x', status: 'new' }]);
  assert.ok(sql.startsWith('INSERT INTO quantum.ingest_heartbeat'));
  assert.ok(sql.includes('no stampable rows'));
  assert.ok(sql.includes(' 1, 0, 0,'), 'orders_seen=1 but zero candidates');
});
check('HB-05', 'idempotency semantics: same orders twice -> identical VALUES, NOT EXISTS dedups server-side', () => {
  assert.strictEqual(buildSql([ORDER]), buildSql([ORDER]),
    'builder is pure; dedup lives in the NOT EXISTS guard (proven live: execs 516311/516312, 5324 rows unchanged, 2 heartbeats)');
});

// ── HYGIENE ───────────────────────────────────────────────────────────────────
check('SQL-01', 'a quote in a symbol cannot break out of the statement', () => {
  const sql = buildSql([{ ...ORDER, legs: [], symbol: "XP'EV" }]);
  assert.ok(sql.includes("'XP''EV'"), 'quote doubled');
});
check('SQL-02', 'dollar-digit sequences are defanged (n8n expression-injection guard preserved from v1.1)', () => {
  const sql = buildSql([{ ...ORDER, legs: [], symbol: 'A$1B' }]);
  assert.ok(!/\$\d/.test(sql.replace(/\$\{/g, '')), 'no $<digit> survives');
});
check('SQL-03', 'oversized raw payload is truncated to a summary object', () => {
  const sql = buildSql([{ ...ORDER, legs: [], client_order_id: 'x'.repeat(9000) }]);
  assert.ok(sql.includes('_truncated'), 'payload replaced with summary');
});

console.log(`\n  ${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
