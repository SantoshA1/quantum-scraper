# QTP Rollback Notes

Use these instructions if the paper-gated production deployment fails validation.

## Immediate safety action

Pause new entries:

```text
entry_pause_control = BLOCK_NEW_ENTRIES
```

## Restore n8n workflows

Restore Broad Scanner from:

```text
n8n_workflows/backups/Broad Scanner Real-Time Agent — before_payload_GO_LIVE_patch_retry_20260516_215102.json
```

Restore Main Trading from:

```text
n8n_workflows/backups/Main Trading — before_alpaca_smoke_skip_patch_20260516_215415.json
```

If needed, restore Supabase Health Monitor from:

```text
n8n_workflows/backups/QTP Supabase Health Monitor — pre_schedule_8am_weekdays_patch_20260517_162037.json
```

## Restart workflows

Restart:

```text
Broad Scanner
Main Trading
Risk Monitor
Trailing Stop Manager
Telegram Heartbeat
```

## Verify protection

Run:

```sql
SELECT
  COUNT(*) AS open_positions,
  SUM(CASE WHEN protection_status = 'FULLY_PROTECTED' THEN 1 ELSE 0 END) AS fully_protected,
  SUM(CASE WHEN blocks_new_entries = true THEN 1 ELSE 0 END) AS blockers
FROM quantum.position_risk_state
WHERE observed_at = (
  SELECT MAX(observed_at)
  FROM quantum.position_risk_state
);
```

Expected:

```text
fully_protected = open_positions
blockers = 0 unless intentionally paused
```

## Paper-only invariant

Do not enable live brokerage mode during rollback.

```text
Alpaca mode = paper only
Live brokerage = disabled
```

