// QTP Late Exec Flow Audit Builder v4 AUDIT_STATUS_FINALIZE_WITH_V5_15_OBSERVABILITY 20260602 (v5.15)
// CHANGES vs v4_AUDIT_STATUS_FINALIZE_WITH_DET_AI_SCORES_20260602 (v5.14):
//   - Adds THREE more top-level column writes (forward observability only, zero gate-logic change):
//       backtest_pf            ← JS-side regex on item._early_exec_flow_audit_gate_decision_preview
//       kill_stage_attribution ← TRUE late-stage attribution computed in JS from the same blob
//       gate_lineage           ← JSONB array of 6 {stage, verdict, ...} entries
//   - JS-side extraction (not Postgres-side) because:
//       (a) attribution logic needs branching/conditionals, easier in JS than SQL
//       (b) detV/aiV are reused across attribution AND inside gate_lineage payload
//       (c) byte-identical to v5.14's pre-update source (item._early_exec_flow_audit_gate_decision_preview
//           is the same string the Early Audit Builder wrote to gate_decision)
//   - Architect amendment honored: when (detV-aiV)≈20.00, the AI is the hardcoded `det-20` artifact,
//     so attribution is rerouted to MTF_PF_THRESHOLD (the real lever). This prevents the kill_stage
//     column from inheriting the v5.14 finding that AI-Judge was a profit-factor penalty wearing
//     an AI-judge label.
//   - All three new writes are COALESCE-protected (defensive vs future fan-in).
//   - Pure observability. Zero gate-logic change.
// CHANGES vs v4_AUDIT_STATUS_FINALIZE_20260602 (v5.13):
//   - Adds THREE new top-level column writes via Postgres-side regex extraction
//     on the gate_decision text already produced by Early Audit Builder:
//       mtf_confluence_score_det    ← (regexp_match(gate_decision, '(?:^|[^a-z_])mtf_confluence_score=([0-9.]+)'))[1]::float
//       mtf_confluence_score_ai     ← (regexp_match(gate_decision, '(?:^|[^a-z_])ai_mtf_confluence_score=([0-9.]+)'))[1]::float
//       mtf_ai_judge_version        ← (regexp_match(gate_decision, '(?:^|[^a-z_])mtf_ai_judge_v=([^|,;\s)]+)'))[1]
//   - Pure observability. Zero gate-logic change. Zero threshold change.
//   - SQL-side parse chosen over JS-side because:
//       (a) the substrings live in the existing gate_decision column produced by the upstream Early Audit Builder
//           (lines 227/233), not on the JS item.
//       (b) byte-perfect parse against the actual stored value avoids re-stringification drift.
//   - COALESCE-protected: never overwrites a non-NULL value already written (defensive vs future fan-in).
// CHANGES vs v3 (mtf_veto_leg/composite_opposition):
//   - Writes THREE additional columns on PASS-path rows:
//       mtf_veto_leg (always NULL on PASS — by definition), composite_opposition_count, composite_opposition_reasons.
//   - All new writes are COALESCE-protected: Drop SQL Builder v1.3 already populated these on drop-path rows.
// CHANGES vs v2 (QTP_LATE_EXEC_FLOW_AUDIT_BUILDER_v1_20260522):
//   - Now writes FOUR truth columns directly on the existing exec_flow_audit row:
//       blocked_stage, bias_filter_drop_reason, bias_filter_drop_subreason, bias_filter_exception_msg
//   - Truth columns are recomputed from the POST-Bias-Filter state (_bias_filter_pass,
//     _bias_filter_pass_reason, _bias_filter_pass_subreason, _bias_filter_exception_msg).
//   - Existing gate_decision text APPEND behavior is preserved verbatim (back-compat for legacy parsers).
//   - Idempotency guard (version marker in gate_decision + MAX(ts) tie-break) preserved.
//   - Late Audit Builder runs only on the PASS path (fed by Normalize Alpaca Events for Supabase),
//     so under normal flow this node will write blocked_stage='NONE' on every row it touches.
//     Drop-path rows are written by QTP Bias Filter Drop SQL Builder v1.2 in parallel.
//   - Fail-closed: when post-Bias-Filter fields are missing we DO NOT silently write 'NONE';
//     instead we write 'UNKNOWN' to surface the anomaly (never the more permissive default).

const LATE_AUDIT_VERSION = 'QTP_LATE_EXEC_FLOW_AUDIT_BUILDER_v4_AUDIT_STATUS_FINALIZE_WITH_V5_15_OBSERVABILITY_20260602';
const item = $input.first().json || {};

const symbol = String(item.ticker || item.symbol || 'UNKNOWN').toUpperCase();
const signal_id = item.signal_id || item._signal_id || item.execution_id || null;
const ts_now = new Date().toISOString();

// Downstream gate outcomes — capture whatever is present on the item
const alpaca_order_id = item.alpaca_order_id || item.broker_order_id || item._alpaca_order_id || null;
const alpaca_status = item.alpaca_status || item._alpaca_response_status || item._alpaca_status || null;
const risk_gate_decision = item.risk_gate_decision || item._risk_gate_decision || item.risk_status || 'RISK_UNKNOWN';
const risk_status = item.risk_status || item._risk_status || 'UNKNOWN';
const pause_guard_decision = item.pause_guard_decision || item._pause_guard_decision || null;
const bias_filter_decision = item.bias_filter_decision || item._bias_filter_decision || null;
const idempotency_status = item.idempotency_status || item._idempotency_status || null;
const vc_shadow_gate = item.vc_shadow_gate_decision || item._vc_shadow_gate || null;
const paper_only_guard = item.paper_only_guard_decision || item._paper_only_guard || null;

// ── POST-BIAS-FILTER TRUTH FIELDS ──
// These come from the Bias Filter Code node (its items.map output, after the v5.12 try/catch wraps it).
// On the PASS path through Normalize Alpaca → here, _bias_filter_pass should be true.
// We never fail-open: if the field is missing we write 'UNKNOWN', not 'NONE'.
const biasPassRaw = item._bias_filter_pass;
const biasPassKnown = (biasPassRaw === true || biasPassRaw === false);
const biasPass = biasPassRaw === true;
const biasReason = item._bias_filter_pass_reason ? String(item._bias_filter_pass_reason) : null;
const biasSubreason = item._bias_filter_pass_subreason ? String(item._bias_filter_pass_subreason) : null;
const biasExceptionMsgRaw = item._bias_filter_exception_msg;
const biasExceptionMsg = (biasExceptionMsgRaw === null || biasExceptionMsgRaw === undefined || biasExceptionMsgRaw === '')
  ? null
  : String(biasExceptionMsgRaw).slice(0, 240);

// ── v3: composite opposition observability on PASS rows ──
// mtf_veto_leg is intentionally NULL on PASS path (no MTF veto by definition).
// composite_* are populated by Bias Filter on every item, so propagate them through.
const compositeOppositionCountRaw = item._composite_opposition_count;
const compositeOppositionCount = (compositeOppositionCountRaw === null || compositeOppositionCountRaw === undefined || compositeOppositionCountRaw === '')
  ? null
  : Math.max(0, Math.min(7, Number(compositeOppositionCountRaw) | 0));
const compositeOppositionReasonsRaw = item._composite_opposition_reasons;
const compositeOppositionReasons = (compositeOppositionReasonsRaw === null || compositeOppositionReasonsRaw === undefined || compositeOppositionReasonsRaw === '')
  ? null
  : String(compositeOppositionReasonsRaw).slice(0, 1024);

// Recompute blocked_stage from late state.
// Priority (matches user's invariant for drop-path rows):
//   - PASS-path here  → 'NONE'
//   - !biasPassKnown  → 'UNKNOWN' (defensive; never NULL, never 'NONE')
//   - !biasPass with reason 'EXCEPTION'         → 'EXCEPTION'
//   - !biasPass with reason 'MTF_CONFLUENCE'    → 'MTF_CONFLUENCE'
//   - !biasPass with any other reason           → biasReason (BACKTEST_ENFORCEMENT / AI_CONFLICT / etc.)
//   - !biasPass with no reason                  → 'BIAS_FILTER'
const blockedStageLate = (() => {
  if (!biasPassKnown) return 'UNKNOWN';
  if (biasPass) return 'NONE';
  if (biasReason) return biasReason;
  return 'BIAS_FILTER';
})();

// final_outcome retained for backward-compat append token only — NOT written to a column.
const final_outcome = alpaca_order_id
  ? 'FILLED_OR_NEW'
  : (item.blocked_stage || item._blocked_stage || 'BLOCKED_OR_REJECTED');

// SQL escape helpers
// - esc():     for non-NULL text values (single-quoted in SQL)
// - sqlText(): emits 'value' OR NULL with no quotes
const esc = (v) => (v === null || v === undefined) ? 'N/A' : String(v).replace(/'/g, "''").replace(/\|/g, '_');
const sqlText = (v) => {
  if (v === null || v === undefined || v === '') return 'NULL';
  return `'${String(v).replace(/'/g, "''")}'`;
};
const sqlNum = (v) => {
  if (v === null || v === undefined || v === '' || Number.isNaN(v)) return 'NULL';
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : 'NULL';
};
const sqlJsonb = (v) => {
  if (v === null || v === undefined || v === '') return 'NULL';
  return `'${String(v).replace(/'/g, "''")}'::jsonb`;
};

// ── v5.15: forward observability — backtest_pf + kill_stage_attribution + gate_lineage ──
// Source the gate_decision text from the upstream Early Audit Builder's item field
// (`_early_exec_flow_audit_gate_decision_preview`, line 275 of that node). This is the same
// string the Early Audit Builder wrote to the gate_decision column — byte-identical to what
// Postgres regex sees on the SET RHS in v5.14's mtf_confluence_score_det/_ai extraction.
const gate_decision = String(item._early_exec_flow_audit_gate_decision_preview || '');

// (1) backtest_pf — JS-side regex. AMENDED 2026-06-02 PM: upstream emits `backtest_pf=NN.NN`
// (not `pf=...`) — confirmed 500/500 rows in Perplexity pre-flight ground-truth check.
// Prefix (?:^|[^a-z_]) is here for forward-compat against future `_pf` siblings (e.g. shadow_pf).
const pfMatch = gate_decision.match(/(?:^|[^a-z_])backtest_pf=([-0-9.eE+]+)/);
const _pf = pfMatch ? parseFloat(pfMatch[1]) : null;
const backtestPf = (_pf !== null && !Number.isNaN(_pf) && Number.isFinite(_pf)) ? _pf : null;

// (2) detV / aiV — JS-side mirror of v5.14's Postgres regex, byte-identical patterns.
// We re-extract in JS (rather than depending on v5.14's column write committing first)
// because the Late Audit Builder UPDATE writes mtf_confluence_score_det/_ai AND
// kill_stage_attribution in the same SET — RHS of SET sees pre-update values, so we cannot
// reference the v5.14 columns here. Mirror the regex exactly so JS-derived detV equals
// what Postgres extracts.
const detMatch = gate_decision.match(/(?:^|[^a-z_])mtf_confluence_score=([0-9.]+)/);
const aiMatch  = gate_decision.match(/(?:^|[^a-z_])ai_mtf_confluence_score=([0-9.]+)/);
const detV = detMatch ? parseFloat(detMatch[1]) : null;
const aiV  = aiMatch  ? parseFloat(aiMatch[1])  : null;

// (3) Other gate state tokens. AMENDED 2026-06-02 PM:
//   - risk_gate / alpaca_status broadened to [A-Za-z_/]+ to capture `null` and `N/A` literals.
//   - bias_filter_drop_reason is NOT in gate_decision (confirmed 0/200 rows). Read it from the
//     item's top-level field instead (populated by Bias Filter Code node upstream). If absent,
//     leave empty — attribution falls through to BIAS_FILTER (loses COMPOSITE sub-class but
//     functionally correct).
const vc      = (gate_decision.match(/(?:^|[^a-z])vc=([A-Z_]+)/) || [])[1] || '';
const bias    = (gate_decision.match(/(?:^|[^a-z])bias=([A-Z_]+)/) || [])[1] || '';
const finalMtf = (gate_decision.match(/final_mtf_confluence_decision=([A-Z_]+)/) || [])[1] || '';
const rg      = (gate_decision.match(/risk_gate=([A-Za-z_/]+)/) || [])[1] || '';
const pg      = (gate_decision.match(/pause_guard=([A-Z_]+)/) || [])[1] || '';
const ap      = (gate_decision.match(/alpaca_status=([A-Za-z_/]+)/) || [])[1] || '';
const biasRsn = item.bias_filter_drop_reason
              ? String(item.bias_filter_drop_reason)
              : (item._bias_filter_pass_reason ? String(item._bias_filter_pass_reason) : '');

// (4) kill_stage_attribution — walk in pipeline order; FIRST hard block wins.
let killStage = 'NONE';
if (vc === 'KILL') {
  killStage = 'VC_PARSER';
} else if (bias === 'BIAS_BLOCK' && biasRsn === 'COMPOSITE_OPPOSITION') {
  killStage = 'BIAS_FILTER_COMPOSITE';
} else if (bias === 'BIAS_BLOCK') {
  killStage = 'BIAS_FILTER';
} else if (finalMtf && finalMtf !== 'FINAL_MTF_CONFLUENCE_PASS' && finalMtf !== 'N/A') {
  // ARCHITECT AMENDMENT: detect the hardcoded `det - 20` artifact and reroute to MTF_PF_THRESHOLD.
  // The pre-6/01 "AI Judge" was a profit-factor penalty wearing an AI label (Perplexity verified
  // this earlier tonight: 100% of pre-6/01 'AI-only kills' had aiV = detV − 20.00 exactly).
  // Our attribution column must not propagate that lie.
  const isHardcodedArtifact = (detV !== null && aiV !== null && Math.abs((detV - aiV) - 20.00) < 0.01);
  if (backtestPf !== null && backtestPf < 1.20)                     killStage = 'MTF_PF_THRESHOLD';
  else if (isHardcodedArtifact)                                      killStage = 'MTF_PF_THRESHOLD';
  else if (aiV !== null && aiV < 65 && detV !== null && detV >= 65) killStage = 'MTF_AI_JUDGE';
  else if (detV !== null && detV < 65)                              killStage = 'MTF_DET';
  else                                                              killStage = 'MTF_UNKNOWN';
} else if (rg === 'RISK_BLOCK') {
  killStage = 'RISK_GATE';
} else if (pg === 'PAUSE_BLOCK') {
  killStage = 'PAUSE_GUARD';
} else if (ap && ap !== 'N/A' && ap !== 'PASS') {
  killStage = 'ALPACA';
}

// (5) gate_lineage — JSONB array (always 6 entries — acceptance gate requires this exact shape).
const gateLineageObj = [
  { stage: 'VC_PARSER',    verdict: vc || 'N/A' },
  { stage: 'BIAS_FILTER',  verdict: bias || 'N/A', reason: biasRsn || null },
  { stage: 'MTF_ENGINE',   verdict: finalMtf || 'N/A', det: detV, ai: aiV, pf: backtestPf },
  { stage: 'RISK_GATE',    verdict: rg || 'N/A' },
  { stage: 'PAUSE_GUARD',  verdict: pg || 'N/A' },
  { stage: 'ALPACA',       verdict: ap || 'N/A' }
];
const gateLineage = JSON.stringify(gateLineageObj);

// ── Append-only audit token (back-compat, written to gate_decision text column) ──
const lateAuditToken = [
  `late_audit_v=${LATE_AUDIT_VERSION}`,
  `risk_gate=${esc(risk_gate_decision)}`,
  `risk_status=${esc(risk_status)}`,
  `pause_guard=${esc(pause_guard_decision)}`,
  `bias_filter=${esc(bias_filter_decision)}`,
  `bias_pass=${biasPassKnown ? String(biasPass) : 'UNKNOWN'}`,
  `bias_reason=${esc(biasReason)}`,
  `bias_subreason=${esc(biasSubreason)}`,
  `bias_exception=${biasExceptionMsg ? 'YES' : 'NO'}`,
  `blocked_stage=${esc(blockedStageLate)}`,
  `idempotency=${esc(idempotency_status)}`,
  `vc_shadow=${esc(vc_shadow_gate)}`,
  `paper_only=${esc(paper_only_guard)}`,
  `alpaca_order_id=${esc(alpaca_order_id)}`,
  `alpaca_status=${esc(alpaca_status)}`,
  `final_outcome=${esc(final_outcome)}`,
  `late_audit_ts=${ts_now}`
].join('|');

// ── UPDATE ──
// Idempotent: only the most recent row for this symbol within 5 minutes that does NOT
// already carry the v4 marker. Updates:
//   - gate_decision (append-only token)
//   - blocked_stage              (truth column, never overwrites a non-NULL value already written by Drop SQL Builder)
//   - bias_filter_drop_reason    (truth column, COALESCE-protected)
//   - bias_filter_drop_subreason (truth column, COALESCE-protected)
//   - bias_filter_exception_msg  (truth column, COALESCE-protected)
//   - composite_opposition_count / _reasons (COALESCE-protected; v3 fields)
//   - audit_status (PUT4 finalize)
//   - mtf_confluence_score_det / _ai / mtf_ai_judge_version (v5.14 — parsed Postgres-side from gate_decision)
//
// COALESCE pattern: if Drop SQL Builder already wrote a value for a drop-path row (cannot happen
// under current wiring, but defensive against future fan-in topologies), Late Audit Builder will
// NOT overwrite it. For pass-path rows, the columns are NULL pre-update, so the new value lands.
//
// v5.14 SQL-side regex extraction notes:
//   - We parse from the gate_decision text AS STORED PRE-UPDATE (before the append below) using a
//     subquery against the same row, because the UPDATE's SET runs against the OLD value of
//     gate_decision when referenced on the right-hand side (Postgres semantics — all SET RHS
//     reference the pre-update row). So `gate_decision` in regexp_match below sees the upstream
//     Early Audit Builder's output without our appended token.
//   - The (?:^|[^a-z_]) prefix guards against ai_mtf_confluence_score matching mtf_confluence_score.
//   - regexp_match returns NULL when no match → COALESCE keeps any pre-existing value, otherwise NULL.
const sql = `
UPDATE quantum.exec_flow_audit
SET gate_decision                  = gate_decision || '|${lateAuditToken}',
    blocked_stage                  = COALESCE(blocked_stage, ${sqlText(blockedStageLate)}),
    bias_filter_drop_reason        = COALESCE(bias_filter_drop_reason, ${biasPass ? 'NULL' : sqlText(biasReason)}),
    bias_filter_drop_subreason     = COALESCE(bias_filter_drop_subreason, ${biasPass ? 'NULL' : sqlText(biasSubreason)}),
    bias_filter_exception_msg      = COALESCE(bias_filter_exception_msg, ${sqlText(biasExceptionMsg)}),
    composite_opposition_count     = COALESCE(composite_opposition_count, ${compositeOppositionCount === null ? 'NULL' : String(compositeOppositionCount)}),
    composite_opposition_reasons   = COALESCE(composite_opposition_reasons, ${sqlText(compositeOppositionReasons)}),
    -- PUT4 (Story 1.1): finalize audit_status. REJECTED when a real blocking stage is set; EXECUTED otherwise.
    -- Never downgrade an already-finalized REJECTED row. blocked_stage 'NONE'/'UNKNOWN' are not blocking.
    audit_status                   = (
      CASE
        WHEN audit_status = 'REJECTED' THEN 'REJECTED'
        WHEN COALESCE(blocked_stage, '${esc(blockedStageLate)}') NOT IN ('NONE','UNKNOWN','') THEN 'REJECTED'
        -- FIX 2026-07-17: a RISK_HOLD/BLOCK/ERROR outcome (e.g. index monitor-only SKIP) is NOT an execution.
        WHEN '${esc(risk_gate_decision)}' IN ('RISK_HOLD','RISK_BLOCK','RISK_ERROR') THEN 'REJECTED'
        ELSE 'EXECUTED'
      END
    )::quantum.audit_status_enum,
    -- v5.14: DET vs AI score split (Story B Step 2 enabler). Parsed Postgres-side from the
    -- pre-update gate_decision text. Pure observability — no gate-logic effect.
    mtf_confluence_score_det       = COALESCE(mtf_confluence_score_det,
                                       NULLIF((regexp_match(gate_decision, '(?:^|[^a-z_])mtf_confluence_score=([0-9.]+)'))[1], '')::double precision),
    mtf_confluence_score_ai        = COALESCE(mtf_confluence_score_ai,
                                       NULLIF((regexp_match(gate_decision, '(?:^|[^a-z_])ai_mtf_confluence_score=([0-9.]+)'))[1], '')::double precision),
    mtf_ai_judge_version           = COALESCE(mtf_ai_judge_version,
                                       NULLIF((regexp_match(gate_decision, '(?:^|[^a-z_])mtf_ai_judge_v=([^|,;\\s)]+)'))[1], '')),
    -- v5.15: forward observability. backtest_pf parsed from upstream gate_decision blob,
    -- kill_stage_attribution and gate_lineage computed JS-side from the same blob.
    -- All COALESCE-protected: never overwrites a non-NULL value already on the row.
    backtest_pf                    = COALESCE(backtest_pf, ${sqlNum(backtestPf)}),
    kill_stage_attribution         = COALESCE(kill_stage_attribution, ${sqlText(killStage)}),
    gate_lineage                   = COALESCE(gate_lineage, ${sqlJsonb(gateLineage)})
WHERE symbol = '${esc(symbol)}'
  AND ts >= NOW() - INTERVAL '5 minutes'
  AND gate_decision NOT ILIKE '%${LATE_AUDIT_VERSION}%'
  AND ts = (
    SELECT MAX(ts) FROM quantum.exec_flow_audit
    WHERE symbol = '${esc(symbol)}'
      AND ts >= NOW() - INTERVAL '5 minutes'
  );
`.trim();

return [{
  json: {
    ...item,
    _late_audit_sql: sql,
    _late_audit_token: lateAuditToken,
    _late_audit_version: LATE_AUDIT_VERSION,
    _late_audit_final_outcome: final_outcome,
    _late_audit_blocked_stage: blockedStageLate,
    _late_audit_bias_pass_known: biasPassKnown,
    _late_audit_bias_pass: biasPass,
    _late_audit_bias_reason: biasReason,
    _late_audit_bias_subreason: biasSubreason,
    _late_audit_bias_exception_msg: biasExceptionMsg,
    _late_audit_ts: ts_now,
    _late_audit_composite_opposition_count: compositeOppositionCount,
    _late_audit_composite_opposition_reasons: compositeOppositionReasons,
    _late_audit_backtest_pf: backtestPf,
    _late_audit_kill_stage_attribution: killStage,
    _late_audit_gate_lineage: gateLineageObj,
    _late_audit_det_v: detV,
    _late_audit_ai_v: aiV
  }
}];
