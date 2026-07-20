
// QTP Supabase Main Trading Alpaca risk gate query v4.2.1
const d = $json || {};
return [{
  json: {
    ...d,
    __supabase_apt_risk_sql: `
      WITH latest AS (
        SELECT *
        FROM quantum.position_risk_state
        WHERE observed_at = (SELECT MAX(observed_at) FROM quantum.position_risk_state)
      ),
      summary AS (
        SELECT
          COUNT(*) AS open_positions,
          SUM(CASE WHEN protection_status = 'FULLY_PROTECTED' THEN 1 ELSE 0 END) AS fully_protected_positions,
          SUM(CASE WHEN protection_status <> 'FULLY_PROTECTED' OR blocks_phase_2 = true THEN 1 ELSE 0 END) AS phase_2_blockers,
          SUM(CASE WHEN blocks_new_entries = true THEN 1 ELSE 0 END) AS new_entry_blockers,
          SUM(CASE WHEN blocks_new_shorts = true OR blocks_new_entries = true THEN 1 ELSE 0 END) AS short_entry_blockers,
          MAX(observed_at) AS checked_at
        FROM latest
      )
      SELECT
        CASE WHEN COALESCE(phase_2_blockers,0) = 0 THEN 'GO' ELSE 'BLOCK_PHASE_2' END AS phase_2_status,
        CASE WHEN COALESCE(new_entry_blockers,0) = 0 THEN 'ALLOW_WITH_NORMAL_GATES' ELSE 'BLOCK_NEW_ENTRIES' END AS new_entry_status,
        COALESCE(phase_2_blockers,0)::text AS phase_2_blockers,
        COALESCE(new_entry_blockers,0)::text AS new_entry_blockers,
        COALESCE(short_entry_blockers,0)::text AS short_entry_blockers,
        checked_at::text AS checked_at,
        open_positions::text AS open_positions,
        fully_protected_positions::text AS fully_protected_positions
      FROM summary
    `,
    migration_version: 'QTP_SUPABASE_MAIN_TRADING_v4.2.1'
  }
}];
