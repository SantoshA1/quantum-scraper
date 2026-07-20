
// QTP Supabase Main Trading pause guard query v4.2.1
const d = $json || {};
return [{
  json: {
    ...d,
    __supabase_pause_sql: `
      WITH ctrl AS (
        SELECT pause_new_entries, reason, status, checked_at, expires_at
        FROM quantum.entry_pause_control
        WHERE expires_at > CURRENT_TIMESTAMP
        ORDER BY checked_at DESC
        LIMIT 1
      )
      SELECT
        COALESCE((SELECT pause_new_entries FROM ctrl), false) AS pause_new_entries,
        COALESCE((SELECT reason FROM ctrl), 'no active pause control') AS reason,
        COALESCE((SELECT status FROM ctrl), 'NO_ACTIVE_PAUSE') AS status,
        (SELECT checked_at::text FROM ctrl) AS checked_at,
        (SELECT expires_at::text FROM ctrl) AS expires_at
    `,
    migration_version: 'QTP_SUPABASE_MAIN_TRADING_v4.2.1'
  }
}];
