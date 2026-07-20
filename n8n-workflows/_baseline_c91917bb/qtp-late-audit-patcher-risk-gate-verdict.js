// === QTP Late Audit Patcher v4.2.21 — Risk + Pause Visibility (single-signal fix) ===
// Drop-in replacement for jsCode of node "QTP Late Audit Patcher (Risk Gate Verdict)"
// id: qtp-late-audit-patcher-v4-2-17 in workflow vaqfCaELhOEWnkdo
// Keeps ORDER BY ts DESC LIMIT 1 to prevent cross-signal verdict smearing.
// Keeps substring matching for composite QTP statuses like "BLOCKED_RISK_GATE".
// CHANGE FROM v4.2.20: also patches pause_guard_decision + pause_status from QTP-10FC.
// Safety: audit-only UPDATE; no order placement, cancel, replace, routing, or Alpaca side effects.

const d = $input.first().json || {};

function clean(v, fallback = '') {
  if (v === undefined || v === null || v === '') return fallback;
  return String(v).replace(/\s+/g, ' ').trim();
}

function upper(v, fallback = '') {
  return clean(v, fallback).toUpperCase();
}

function escSql(s) {
  return String(s ?? '').replace(/'/g, "''").slice(0, 5000);
}

function boolish(v) {
  if (v === true) return true;
  if (v === false) return false;
  const s = String(v ?? '').trim().toLowerCase();
  if (['true', '1', 'yes', 'pass', 'passed', 'allowed', 'allow', 'go'].includes(s)) return true;
  if (['false', '0', 'no', 'block', 'blocked', 'deny', 'denied', 'kill', 'killed'].includes(s)) return false;
  return null;
}

function firstJsonFromNode(nodeName) {
  try {
    const ref = $(nodeName);
    if (ref && ref.first && ref.first().json) return ref.first().json || {};
  } catch (e) {}
  return {};
}

function pickFirst(...vals) {
  for (const v of vals) {
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return '';
}

const symbol = upper(
  d.symbol ||
  d.ticker ||
  d.asset ||
  d.raw_alpaca_fill_activity?.symbol ||
  ''
);

const side = upper(
  d.side ||
  d.execution ||
  d.raw_alpaca_fill_activity?.side ||
  ''
);

// QTP_H2_REKEY_ON_IDEMPOTENCY_KEY_20260617
// Prefer the SSM-minted correlation key (== signal_id) to target the EXACT FULL-branch
// exec_flow_audit row, eliminating the symbol+side+20min-window smear. Falls back to the
// legacy symbol/side/time window when the key is absent (never regress to zero-match).
const idempotencyKey = String(
  d._sm_idempotency_key ||
  d._sm_signal_id ||
  d.idempotency_key ||
  ''
).trim();
const hasIdemKey = idempotencyKey.length > 0;

const alpacaStatus = upper(
  d.alpaca_status ||
  d._alpaca_status ||
  d.order_status ||
  d.status ||
  d.raw_alpaca_fill_activity?.status ||
  ''
);

const alpacaReason = clean(
  d.alpaca_reason ||
  d._alpaca_reason ||
  d.rejection_reason ||
  d.raw_alpaca_fill_activity?.reason ||
  'N/A'
).slice(0, 200);

const accountId = upper(d.account_id || d.account || '');
const env = upper(d.qtp_trading_env || d.alpaca_env || d.environment || 'PAPER');

// === Substring decision logic — composite QTP statuses supported ===
// Order matters: BLOCK-family checked first so "BLOCKED_RISK_GATE" wins over PASS/GO substrings.
const isBlock = [
  'BLOCK', 'BLOCKED', 'NO_GO', 'DENY', 'DENIED', 'REJECT', 'REJECTED',
  'EXPIRED', 'CANCELED', 'CANCELLED', 'KILL'
].some(x => alpacaStatus.includes(x));

const isHold = !isBlock && [
  'SKIPPED', 'NO_POSITION', 'STAND_ASIDE', 'STAND ASIDE', 'STAND', 'HOLD'
].some(x => alpacaStatus.includes(x));

const isPass = !isBlock && !isHold && [
  'FILLED', 'ACCEPTED', 'NEW', 'SUBMITTED', 'PARTIALLY_FILLED',
  'PENDING_NEW', 'ALLOW', 'GO', 'PASS', 'PLACED'
].some(x => alpacaStatus.includes(x));

// PUT1 (Story 1.1): never leave RISK_UNKNOWN. Default to a definite ERROR verdict so I-RGW->0;
// concrete PASS/BLOCK/HOLD below overrides this when alpaca status is recognized.
let risk_gate_decision = 'RISK_ERROR';
let risk_status = 'ERROR';

if (isBlock) {
  risk_gate_decision = 'RISK_BLOCK';
  risk_status = 'CRITICAL';
} else if (isPass) {
  risk_gate_decision = 'RISK_PASS';
  risk_status = 'OK';
} else if (isHold) {
  risk_gate_decision = 'RISK_HOLD';
  risk_status = 'WARN';
}

const pauseGuardNode = firstJsonFromNode('QTP-10FC New Entry Pause Guard');
const pauseContextNode = firstJsonFromNode('Format Supabase Pause Guard Context');
const earlyAuditNode = firstJsonFromNode('QTP Early Exec Flow Audit Builder');
const inputFirst = (() => { try { return ($input.first() && $input.first().json) || {}; } catch (e) { return {}; } })();

const pgAction = upper(pickFirst(
  d._pause_guard_action,
  d.pause_guard_action,
  d.entry_pause_action,
  d.pause_action,
  inputFirst._pause_guard_action,
  inputFirst.pause_guard_action,
  pauseGuardNode._pause_guard_action,
  pauseGuardNode.pause_guard_action,
  pauseGuardNode.entry_pause_action,
  pauseGuardNode.pause_action,
  pauseContextNode._pause_guard_action,
  pauseContextNode.pause_guard_action,
  earlyAuditNode._pause_guard_action,
  earlyAuditNode.pause_guard_action,
  earlyAuditNode._pause_guard_decision
), '');

const pgDecisionRaw = upper(pickFirst(
  d.pause_guard_decision,
  d._pause_guard_decision,
  inputFirst.pause_guard_decision,
  inputFirst._pause_guard_decision,
  earlyAuditNode.pause_guard_decision,
  earlyAuditNode._pause_guard_decision
), '');

const pgChecked = boolish(pickFirst(
  d._pause_guard_checked,
  inputFirst._pause_guard_checked,
  pauseGuardNode._pause_guard_checked,
  earlyAuditNode._pause_guard_checked
));

const pgAllowed = boolish(pickFirst(
  d._pause_guard_live_order_allowed,
  d.pause_guard_live_order_allowed,
  inputFirst._pause_guard_live_order_allowed,
  pauseGuardNode._pause_guard_live_order_allowed,
  earlyAuditNode._pause_guard_live_order_allowed
));

let pause_guard_decision = 'PAUSE_UNKNOWN';
let pause_status = 'UNKNOWN';
if (pgDecisionRaw === 'PAUSE_ALLOW') {
  pause_guard_decision = 'PAUSE_ALLOW';
  pause_status = 'NOMINAL';
} else if (pgDecisionRaw === 'PAUSE_BLOCK') {
  pause_guard_decision = 'PAUSE_BLOCK';
  pause_status = 'PAUSED';
} else if (pgDecisionRaw === 'PAUSE_BYPASS') {
  pause_guard_decision = 'PAUSE_BYPASS';
  pause_status = 'BYPASS';
} else if (pgAction === 'ALLOW_NEW_ENTRY') {
  pause_guard_decision = 'PAUSE_ALLOW';
  pause_status = 'NOMINAL';
} else if (pgAction === 'BLOCK_NEW_ENTRY_ONLY') {
  pause_guard_decision = 'PAUSE_BLOCK';
  pause_status = 'PAUSED';
} else if (pgAction === 'BYPASS_PROTECTIVE_OR_CLOSING') {
  pause_guard_decision = 'PAUSE_BYPASS';
  pause_status = 'BYPASS';
} else if (pgChecked === true && pgAllowed === true) {
  pause_guard_decision = 'PAUSE_ALLOW';
  pause_status = 'NOMINAL';
} else if (pgChecked === true && pgAllowed === false) {
  pause_guard_decision = 'PAUSE_BLOCK';
  pause_status = 'PAUSED';
}

// Paper-gated constraint. If payload explicitly says live is allowed or account is live, do not patch.
const explicitLive =
  d.qtp_live_trading_allowed === true ||
  env === 'LIVE' ||
  accountId === 'ALPACA_LIVE';

const canPatch = Boolean(
  symbol &&
  side &&
  !explicitLive
  // PUT1: always patch when symbol+side known & paper-safe. risk_gate_decision is now always
  // a definite verdict (PASS/BLOCK/HOLD/ERROR), never RISK_UNKNOWN, so we always write it.
);

let updateSql = `
SELECT
  'SKIPPED_NO_PATCH' AS late_audit_patch_status,
  '${escSql(symbol)}' AS symbol,
  '${escSql(side)}' AS side,
  '${escSql(alpacaStatus)}' AS alpaca_status,
  '${escSql(risk_gate_decision)}' AS risk_gate_decision,
  '${escSql(pause_guard_decision)}' AS pause_guard_decision;
`;

if (canPatch) {
  // Update only the most recent matching unknown audit row for this signal.
  // ORDER BY ts DESC LIMIT 1 intentionally prevents cross-signal verdict smearing.
  updateSql = `
WITH target AS (
  SELECT ctid
    FROM quantum.exec_flow_audit
   WHERE ${hasIdemKey
        ? `idempotency_key = '${escSql(idempotencyKey)}'`
        : `symbol = '${escSql(symbol)}'
     AND side   = '${escSql(side)}'
     AND ts > NOW() - INTERVAL '20 minutes'`}
     AND (
       risk_gate_decision IS NULL
       OR risk_gate_decision IN ('RISK_UNKNOWN','UNKNOWN','')
       OR risk_status IS NULL
       OR risk_status IN ('UNKNOWN','')
       OR gate_decision ILIKE '%risk_gate=RISK_UNKNOWN%'
       OR gate_decision ILIKE '%risk_status=UNKNOWN%'
       OR pause_guard_decision IS NULL
       OR pause_guard_decision IN ('PAUSE_UNKNOWN','UNKNOWN','')
       OR pause_status IS NULL
       OR pause_status IN ('UNKNOWN','')
       OR gate_decision ILIKE '%pause_guard=PAUSE_UNKNOWN%'
       OR gate_decision ILIKE '%pause_action=UNKNOWN%'
     )
   ORDER BY ts DESC
   LIMIT 1
)
UPDATE quantum.exec_flow_audit a
   SET risk_gate_decision = '${escSql(risk_gate_decision)}',
       risk_status        = '${escSql(risk_status)}',
       pause_guard_decision = CASE
         WHEN '${escSql(pause_guard_decision)}' = 'PAUSE_UNKNOWN' THEN a.pause_guard_decision
         ELSE '${escSql(pause_guard_decision)}'
       END,
       pause_status = CASE
         WHEN '${escSql(pause_status)}' = 'UNKNOWN' THEN a.pause_status
         ELSE '${escSql(pause_status)}'
       END,
       gate_decision      =
         CASE
           WHEN a.gate_decision IS NULL THEN a.gate_decision
           ELSE regexp_replace(
                  regexp_replace(
                    regexp_replace(
                      regexp_replace(
                        regexp_replace(
                          regexp_replace(
                            a.gate_decision,
                            'risk_gate=[^|]*',
                            'risk_gate=${escSql(risk_gate_decision)}',
                            'g'
                          ),
                          'risk_status=[^|]*',
                          'risk_status=${escSql(risk_status)}',
                          'g'
                        ),
                        'pause_guard=[^|]*',
                        CASE
                          WHEN '${escSql(pause_guard_decision)}' = 'PAUSE_UNKNOWN' THEN 'pause_guard=' || COALESCE(a.pause_guard_decision, 'PAUSE_UNKNOWN')
                          ELSE 'pause_guard=${escSql(pause_guard_decision)}'
                        END,
                        'g'
                      ),
                      'pause_action=[^|]*',
                      CASE
                        WHEN '${escSql(pause_status)}' = 'UNKNOWN' THEN 'pause_action=' || COALESCE(a.pause_status, 'UNKNOWN')
                        ELSE 'pause_action=${escSql(pause_status)}'
                      END,
                      'g'
                    ),
                    'alpaca_status=[^|]*',
                    'alpaca_status=${escSql(alpacaStatus)}',
                    'g'
                  ),
                  'alpaca_reason=[^|]*',
                  'alpaca_reason=${escSql(alpacaReason)}',
                  'g'
                )
         END
  FROM target
 WHERE a.ctid = target.ctid
 RETURNING
   'PATCHED_RISK_VISIBILITY_MOST_RECENT_ROW' AS late_audit_patch_status,
   a.ts,
   a.symbol,
   a.side,
   a.risk_gate_decision,
   a.risk_status,
   a.pause_guard_decision,
   a.pause_status;
`;
}

return [{
  json: {
    ...d,
    __supabase_late_audit_sql: updateSql,
    _late_audit_intent: 'RISK_GATE_PATCH_MOST_RECENT_ROW',
    _late_audit_risk_gate_decision: risk_gate_decision,
    _late_audit_risk_status: risk_status,
    _late_audit_pause_guard_decision: pause_guard_decision,
    _late_audit_pause_status: pause_status,
    _late_audit_alpaca_status_observed: alpacaStatus,
    _late_audit_symbol_observed: symbol,
    _late_audit_side_observed: side,
    _late_audit_can_patch: canPatch,
    _late_audit_version: 'QTP-LATE-AUDIT_v4.2.22_ALWAYS_VERDICT_NO_RISK_UNKNOWN_20260602',
    _late_audit_risk_gate_decision_default_applied: (risk_gate_decision === 'RISK_ERROR')
  }
}];
