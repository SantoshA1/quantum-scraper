// QTP Terminal Audit Write-Back Builder v1.2 — gov 217, 2026-08-14
// ---------------------------------------------------------------------------
// WHY: quantum.exec_flow_audit rows were left stuck at PENDING (or never written
// at all) whenever a candidate died on a terminal branch that had no audit writer:
//   (a) QTP-10FC Pause Guard Gate out[1] — entry-pause blocks AND the bias<65 leg
//       bundled into the same IF. The Early Audit Builder has already written a
//       PENDING row upstream, so nothing terminal was ever recorded.  7 rows stuck
//       on 2026-08-14 alone (WRB/WMB/WSM/WRD 09:30, ACGL/AMAT/AME 09:35).
//   (b) Route Fast Only out[1] — _sm_route='SKIP' (SSM kills, e.g. ARM's ATR>8%
//       kill on 2026-08-13) fell off the end of the graph. No row at ALL: the kill
//       was invisible to the audit table rather than merely unattributed.
// The audit table therefore UNDER-STATED kill attribution. This node closes both.
//
// DESIGN: ONE body, deployed unchanged at BOTH attach points. Stage attribution is
// derived from the item, not from where the node sits, so the two instances are
// byte-identical and a single offline suite pins both paths.
//
// SAFETY: observability only. Writes to quantum.exec_flow_audit and nothing else.
// No routing, no order, no gate decision is read or altered by this node. Both
// executor nodes carry onError=continueRegularOutput so an audit write can never
// break the trading pipeline.
//
// IDEMPOTENCE: one atomic statement, update-then-insert-if-absent, keyed on
// idempotency_key. Never downgrades an already-finalized row (the UPDATE only
// touches audit_status='PENDING'); never double-inserts (the INSERT's NOT EXISTS
// sees the pre-statement snapshot, so a row that the CTE just updated blocks it).
// COALESCE on every column: an attribution written by an earlier stage always wins.
//
// MULTI-ITEM: reads $input.all() and emits one item per input. The pre-existing
// SKIP-branch builder reads $json only and therefore attributes just the first
// item of a multi-candidate batch — this node deliberately does not repeat that.
//
// v1.1: a MISSING bias score is UNROUTED_TERMINAL, not a fabricated score kill.
// The version constant is bumped with the body so two generations of rows are never
// indistinguishable in the audit table.
const VERSION = 'QTP_AUDIT_WRITEBACK_v1.2_gov217_20260814';

function esc(v) {
  if (v === undefined || v === null || v === '') return 'NULL';
  return "'" + String(v).replace(/'/g, "''").slice(0, 20000) + "'";
}
function clean(v, fallback = 'N/A') {
  if (v === undefined || v === null || v === '') return fallback;
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, 240) : fallback;
}
function pickFirst(...vals) {
  for (const v of vals) {
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return '';
}

const COLS =
  '(ts, symbol, side, gate_decision, parser_version, pause_guard_decision, pause_status,\n' +
  '   signal_id, idempotency_key, gate_lineage, kill_stage_attribution, blocked_stage, audit_status)';

const execId = ($execution && $execution.id) ? String($execution.id).slice(0, 12) : 'no-exec-id';

return $input.all().map((it) => {
  const d = (it && it.json) || {};

  const symbol = String(d.symbol || d.ticker || d.sym || d.asset || 'UNKNOWN').toUpperCase();
  const side = String(d.side || d.execution || d.signal || d.action || d.direction || 'UNKNOWN').toUpperCase();

  // Correlation keys — the exact fields the Early / SKIP builders write.
  const sid = d._sm_signal_id || d.signal_id || null;
  const key = d._sm_idempotency_key || d._sm_signal_id || d.idempotency_key || null;
  const lineage = (() => {
    const gl = d._sm_gate_lineage;
    if (gl === undefined || gl === null) return null;
    try { return (typeof gl === 'string') ? gl : JSON.stringify(gl); } catch (e) { return null; }
  })();

  // The bias leg is ANDed into the pause gate's IF, so out[1] carries two distinct
  // causes. Attribute them separately or the audit table blames the pause for a
  // score kill (and vice-versa) — the exact ambiguity this fix exists to remove.
  // hasScore matters: the gate's leg-2 expression defaults a MISSING score to 0, so a
  // dead/renamed score field is killed exactly like a real low score. Recording that
  // as "PAUSE_GATE_SCORE, bias_score=0" would be the same fail-open silence gov 216
  // exists to end — a missing input must be visible AS a missing input.
  const rawScore = d.bias_score ?? d.ai_super_score ?? d.composite_score ?? d.bull_score ?? d.bear_score ?? d.score;
  const hasScore = rawScore !== undefined && rawScore !== null && String(rawScore).trim() !== '';
  const score = Number(hasScore ? rawScore : 0);
  // v1.2 (gov 219): a permanent strategy-side halt is NOT the same fact as a temporary
  // manual entry pause. Checked first, or the short-side halt would be filed under
  // ENTRY_PAUSE and a blocked_stage rollup would conflate the two forever.
  const shortHalted = d._pause_guard_action === 'BLOCK_SHORT_ENTRY_ONLY';
  const pauseBlocked =
    d._pause_guard_action === 'BLOCK_NEW_ENTRY_ONLY' || d._pause_guard_live_order_allowed === false;
  const ssmKilled = d._sm_route === 'SKIP' || d._sm_action === 'KILLED';

  let stage, kill;
  if (shortHalted) {
    stage = 'SHORT_SIDE_HALT';
    kill = 'SHORT_SIDE_HALT: ' + clean(d._pause_guard_reason, 'short entries disabled by gov 219');
  } else if (pauseBlocked) {
    stage = 'ENTRY_PAUSE';
    kill = 'ENTRY_PAUSE: ' + clean(d._pause_guard_reason || d._sm_reason, 'pause_new_entries=true');
  } else if (ssmKilled) {
    // Checked BEFORE the score leg: an SSM kill arriving at Route Fast Only out[1]
    // may carry any bias_score, and blaming a score gate it never reached would be
    // a new lie in place of the old silence.
    stage = 'SSM_KILL';
    kill = 'SSM_KILL: ' + clean(pickFirst(d._sm_kill_stage_attribution, d._sm_reason, d.reason), 'unattributed');
  } else if (hasScore && Number.isFinite(score) && score < 65) {
    stage = 'PAUSE_GATE_SCORE';
    kill = 'PAUSE_GATE_SCORE: bias_score=' + score + ' < 65 (QTP-10FC Pause Guard Gate leg 2)';
  } else {
    // Catch-all: a terminal branch with no recognised cause is still recorded, never
    // dropped. A row reading UNROUTED_TERMINAL means this classifier needs a new leg.
    stage = 'UNROUTED_TERMINAL';
    kill = 'UNROUTED_TERMINAL: sm_route=' + clean(d._sm_route, 'N/A') +
           ' sm_action=' + clean(d._sm_action, 'N/A') +
           ' pause_guard_action=' + clean(d._pause_guard_action, 'N/A') +
           ' score=' + (hasScore ? score : 'ABSENT');
  }

  const token = VERSION + ':' + stage;
  const gateDecision = [
    'branch=TERMINAL_WRITEBACK',
    'blocked_stage=' + stage,
    'kill_stage_attribution=' + kill,
    'sm_route=' + clean(d._sm_route, 'N/A'),
    'sm_action=' + clean(d._sm_action, 'N/A'),
    'pause_guard_action=' + clean(d._pause_guard_action, 'N/A'),
    'bias_score=' + (hasScore ? score : 'ABSENT'),
    'audit_builder_v=' + VERSION,
    'exec_id=' + execId
  ].join(' | ').slice(0, 20000);

  const pgDecision = clean(pickFirst(d._pause_guard_decision, d._pause_guard_action), 'PAUSE_N/A');
  const pauseStatus = clean(pickFirst(d._pause_status_struct, d._pause_guard_reason), 'N/A');

  const insertSelect =
    'SELECT CURRENT_TIMESTAMP, ' + esc(symbol) + ', ' + esc(side) + ', ' + esc(gateDecision) + ', ' +
    esc(VERSION) + ', ' + esc(pgDecision) + ', ' + esc(pauseStatus) + ', ' + esc(sid) + ', ' + esc(key) + ', ' +
    (lineage == null ? 'NULL' : esc(lineage) + '::jsonb') + ', ' + esc(kill) + ', ' + esc(stage) + ", " +
    "'REJECTED'::quantum.audit_status_enum";

  let stmt;
  if (key) {
    // Keyed path: finalize the Early Audit Builder's PENDING row if it exists,
    // otherwise insert a terminal row. Exactly one of the two happens, atomically.
    stmt =
      'WITH tgt AS (\n' +
      '  SELECT a.ctid FROM quantum.exec_flow_audit a\n' +
      '   WHERE a.idempotency_key = ' + esc(key) + " AND a.audit_status = 'PENDING'\n" +
      '   ORDER BY a.ts DESC LIMIT 1\n' +
      '), upd AS (\n' +
      '  UPDATE quantum.exec_flow_audit a\n' +
      "     SET audit_status = 'REJECTED'::quantum.audit_status_enum,\n" +
      '         blocked_stage = COALESCE(a.blocked_stage, ' + esc(stage) + '),\n' +
      '         kill_stage_attribution = COALESCE(a.kill_stage_attribution, ' + esc(kill) + '),\n' +
      "         gate_decision = COALESCE(a.gate_decision, '') || " + esc('|' + token) + '\n' +
      '    FROM tgt WHERE a.ctid = tgt.ctid\n' +
      '  RETURNING 1\n' +
      ')\n' +
      'INSERT INTO quantum.exec_flow_audit\n  ' + COLS + '\n' + insertSelect + '\n' +
      'WHERE NOT EXISTS (SELECT 1 FROM quantum.exec_flow_audit a2 WHERE a2.idempotency_key = ' + esc(key) + ')';
  } else {
    // Unkeyed fallback: no correlation key was minted, so dedupe on
    // symbol + identical attribution inside a short window.
    stmt =
      'INSERT INTO quantum.exec_flow_audit\n  ' + COLS + '\n' + insertSelect + '\n' +
      'WHERE NOT EXISTS (SELECT 1 FROM quantum.exec_flow_audit a2\n' +
      '   WHERE a2.symbol = ' + esc(symbol) + " AND a2.ts >= NOW() - INTERVAL '10 minutes'\n" +
      '     AND a2.kill_stage_attribution = ' + esc(kill) + ')';
  }

  return {
    json: {
      ...d,
      __audit_writeback_sql: stmt + "; SELECT 'WRITTEN_BACK' AS audit_writeback_status;",
      _audit_writeback_stage: stage,
      _audit_writeback_kill: kill,
      _audit_writeback_key: key,
      _audit_writeback_mode: key ? 'UPSERT_BY_IDEMPOTENCY_KEY' : 'INSERT_DEDUPE_BY_SYMBOL_WINDOW',
      _audit_writeback_version: VERSION
    }
  };
});
