// QTP_BIAS_FILTER_DROP_SQL_BUILDER_v1.4_20260720 — observability-only, drop-branch
// v1.4 (AUDIT_STATUS_FINALIZE): drop-branch rows never reach the Late Audit finalizer,
//   so audit_status stayed PENDING forever despite a real blocked_stage (console/funnel
//   under-counted rejects). Now flips PENDING->REJECTED at the drop write. Never downgrades
//   an EXECUTED row. No trading-logic effect (Kelly caps count EXECUTED only).
// v1.3: ADDITIVE — persists mtf_veto_leg (P0.1) + composite_opposition_count + composite_opposition_reasons.
//        mtf_veto_leg is NULL except for MTF_CONFLUENCE drops. composite_* populated whenever Bias Filter computed them.
// v1.2: persists blocked_stage (mirrors drop_reason) + bias_filter_exception_msg (from v5.12 try/catch).
//        Invariant: every drop-path row in exec_flow_audit gets blocked_stage = bias_filter_drop_reason.
// v1.1: persists optional _bias_filter_pass_subreason into bias_filter_drop_subreason column.
// Idempotent: targets the most recent matching exec_flow_audit row whose drop_reason is still NULL.
const out = [];
for (const it of items) {
  const j = it.json || {};
  const ticker = String(j.ticker || j.symbol || '').toUpperCase().replace(/'/g, "''").slice(0, 16);
  const side   = String(j.execution || j._sm_route || j.signal || '').toUpperCase().replace(/'/g, "''").slice(0, 8);
  const reason = String(j._bias_filter_pass_reason || 'UNKNOWN').replace(/'/g, "''").slice(0, 64);
  const subraw = j._bias_filter_pass_subreason;
  const subSql = (subraw === null || subraw === undefined || subraw === '')
      ? 'NULL'
      : `'${String(subraw).replace(/'/g, "''").slice(0, 64)}'`;
  // v1.2: blocked_stage mirrors drop_reason (drop-path truth column).
  // Special case 'UNKNOWN' → still write it so blocked_stage is never NULL when drop_reason is set
  // (invariant: bias_filter_drop_reason IS NOT NULL ⇒ blocked_stage IS NOT NULL AND <> 'NONE').
  const blockedStageSql = `'${reason}'`;
  // v1.2: bias_filter_exception_msg — only populated on EXCEPTION-path rows from v5.12 try/catch.
  // For non-EXCEPTION drops, write NULL (column stays NULL → "no exception" semantics).
  const excRaw = j._bias_filter_exception_msg;
  const exceptionMsgSql = (excRaw === null || excRaw === undefined || excRaw === '')
      ? 'NULL'
      : `'${String(excRaw).replace(/'/g, "''").slice(0, 240)}'`;
  // v1.3: mtf_veto_leg (P0.1) — NULL except on MTF_CONFLUENCE drops.
  const mtfVetoLegRaw = j._mtf_veto_leg;
  const mtfVetoLegSql = (mtfVetoLegRaw === null || mtfVetoLegRaw === undefined || mtfVetoLegRaw === '')
      ? 'NULL'
      : `'${String(mtfVetoLegRaw).replace(/'/g, "''").slice(0, 32)}'`;
  // v1.3: composite_opposition_count + composite_opposition_reasons — populated on every drop row.
  const compCntRaw = j._composite_opposition_count;
  const compCntSql = (compCntRaw === null || compCntRaw === undefined || compCntRaw === '')
      ? 'NULL'
      : String(Math.max(0, Math.min(7, Number(compCntRaw) | 0)));
  const compReasonsRaw = j._composite_opposition_reasons;
  const compReasonsSql = (compReasonsRaw === null || compReasonsRaw === undefined || compReasonsRaw === '')
      ? 'NULL'
      : `'${String(compReasonsRaw).replace(/'/g, "''").slice(0, 1024)}'`;
  if (!ticker || !side) continue;
  const sql = `
    WITH target AS (
      SELECT ctid FROM quantum.exec_flow_audit
      WHERE symbol = '${ticker}'
        AND side   = '${side}'
        AND ts >= now() - interval '3 minutes'
        AND bias_filter_drop_reason IS NULL
      ORDER BY ts DESC LIMIT 1
    )
    UPDATE quantum.exec_flow_audit
       SET bias_filter_drop_reason       = '${reason}',
           bias_filter_drop_subreason    = ${subSql},
           bias_filter_drop_at           = now(),
           blocked_stage                 = ${blockedStageSql},
           bias_filter_exception_msg     = ${exceptionMsgSql},
           mtf_veto_leg                  = ${mtfVetoLegSql},
           composite_opposition_count    = ${compCntSql},
           composite_opposition_reasons  = ${compReasonsSql},
           audit_status                  = (CASE WHEN audit_status = 'EXECUTED' THEN audit_status ELSE 'REJECTED' END)::quantum.audit_status_enum
     WHERE ctid IN (SELECT ctid FROM target)
    RETURNING ts, symbol, side, bias_filter_drop_reason, bias_filter_drop_subreason, blocked_stage, bias_filter_exception_msg, mtf_veto_leg, composite_opposition_count, composite_opposition_reasons;
  `.trim();
  out.push({ json: { ...j, __bias_drop_sql: sql } });
}
return out;
