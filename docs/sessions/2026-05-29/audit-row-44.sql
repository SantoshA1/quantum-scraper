-- Audit row inserted at 2026-05-29 17:24:46 UTC after G22 defensive PUT.
-- This is a record of what was logged, not something to re-run.
--
-- Table: quantum.ssm_workflow_updates
-- Row id: 44
INSERT INTO quantum.ssm_workflow_updates (
    workflow_id,
    event_type,
    triggering_action,
    recovery_ms,
    version_id_before,
    version_id_after,
    caller,
    error_msg,
    metadata
) VALUES (
    'vaqfCaELhOEWnkdo',
    'deploy_success',
    'g22_mtf_threshold_reconcile',
    NULL,                                            -- recovery_ms (n/a; deploy, not recovery)
    '<prior versionId before G22>',                  -- redacted; see local backup
    '3ce6edb0-c0b2-43ac-a98d-472739e044f1',          -- versionId after G22
    'computer_session_g22',
    NULL,
    jsonb_build_object(
        'node_touched',  'QTP Bias Filter',
        'node_id',       '1733e2a2-c812-4007-99ce-d58b37afaedb',
        'line_changed',  140,
        'change',        'removed redundant mtfScore>=65 && aiMtfScore>=65 floor; engine remains authoritative',
        'nodes_total',   99,
        'execution_timeout', 120,
        'active_after',  true
    )
);
