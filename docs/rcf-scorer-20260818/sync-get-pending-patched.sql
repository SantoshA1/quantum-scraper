INSERT INTO quantum.rcf_shadow (symbol, side, conflict, blocked_at, block_day, opt_label, dp_label, exec_id, src_stage)
SELECT e.symbol,'BUY','CONTRA_BOTH',e.ts,(e.ts AT TIME ZONE 'America/New_York')::date,
 substring(e.gate_decision from 'opt=([A-Z_]+)'),
 substring(e.gate_decision from 'dp=([A-Z_]+)'),
 substring(e.gate_decision from 'exec_id=([0-9]+)'),
 e.blocked_stage
FROM quantum.exec_flow_audit e
WHERE e.side='BUY'
 AND e.blocked_stage IN ('REGIME_CONFLICT','REGIME_CONFLICT_SHADOW')
 AND e.kill_stage_attribution='REGIME_CONFLICT_CONTRA_BOTH'
 AND e.ts >= now() - interval '30 days'
ON CONFLICT (symbol, blocked_at) DO NOTHING;
SELECT id, symbol, to_char(block_day,'YYYY-MM-DD') AS block_day, block_close, fwd2_close
FROM quantum.rcf_shadow
WHERE (block_close IS NULL OR fwd2_close IS NULL OR ss_ret_10 IS NULL OR mfe_pct IS NULL
       OR fwd6_close IS NULL OR ss6_ret_10 IS NULL)
 AND block_day >= (now() AT TIME ZONE 'America/New_York')::date - interval '45 days'
ORDER BY block_day;