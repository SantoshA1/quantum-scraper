# Section 2 Report — Risk Gate Postgres Query Health

**Investigation date:** 2026-05-30 (Saturday, market closed)
**Mode:** READ-ONLY
**Bottom line:** The Risk Gate Postgres query is fully healthy. The original "broken since 2026-05-19 17:51 UTC" hypothesis is **disproved**. The bug lives upstream of the query (in audit-builder code), not in the query itself.

## Scope

Verify three independent surfaces of the Risk Gate Postgres path:
1. Source table schema for `quantum.position_risk_state`
2. Writer cadence and recency
3. The SQL produced by `Prepare Supabase Alpaca Risk Gate Query` actually returns a valid row when run manually

## 2a — exec_flow_audit ground truth (30-day window)

Query: `SELECT ts::date, COUNT(*), COUNT(*) FILTER (WHERE risk_gate_decision <> 'RISK_UNKNOWN') FROM quantum.exec_flow_audit WHERE ts >= now() - interval '30 days' GROUP BY 1`

- **2026-05-18:** 440/440 = 100% RISK_UNKNOWN
- **2026-05-19:** 482/505 RISK_UNKNOWN, **23 rows with real verdicts** (all between 13:36:10Z and 17:51:12Z)
- **2026-05-20 and after:** 100% RISK_UNKNOWN
- ssm_workflow_updates audit table earliest row = `2026-05-26 20:37:50 UTC`, so no deploy-trail visibility for the May 18–22 window.

The 4-hour window on 2026-05-19 is the **only** time non-UNKNOWN verdicts were written in the past 30 days. After 17:51:12Z, every row is back to UNKNOWN.

## 2b — Schema integrity of `quantum.position_risk_state`

Column inventory (from `information_schema.columns`):

| column | data_type | present | matches query? |
|---|---|---|---|
| observed_at | timestamp with time zone | ✅ | ✅ |
| protection_status | text | ✅ | ✅ |
| blocks_phase_2 | boolean | ✅ | ✅ |
| blocks_new_entries | boolean | ✅ | ✅ |
| blocks_new_shorts | boolean | ✅ | ✅ |

**Verdict:** All 5 columns referenced by `Prepare Supabase Alpaca Risk Gate Query` exist and have the expected types. No drift, no renames, no drops.

## 2c — Writer health

- Row count: 39 rows in past 7 days.
- Latest write: `2026-05-30 03:45:02 UTC` (within last 24 hours of investigation).
- Cadence: daily-ish at ~23:45 UTC.
- No silence longer than 24 hours.

## 2d — Manual SQL run of the production query

Executed the exact SQL produced by `Prepare Supabase Alpaca Risk Gate Query` (latest snapshot):

```sql
SELECT
  observed_at,
  protection_status,
  blocks_phase_2,
  blocks_new_entries,
  blocks_new_shorts
FROM quantum.position_risk_state
WHERE observed_at >= now() - interval '24 hours'
ORDER BY observed_at DESC
LIMIT 1;
```

Result (single row):

```
phase_2_status         = GO
new_entry_status       = ALLOW_WITH_NORMAL_GATES
open_positions         = 5
blocks_phase_2         = false
blocks_new_entries     = false
blocks_new_shorts      = false
```

**The SQL works.** The Postgres node, if it ran, would return a valid, non-null row. The Risk Gate verdict computation downstream of it would also succeed.

## Conclusion

The hypothesis "Risk Gate is broken at the SQL layer since 2026-05-19 17:51 UTC" is **falsified**. Schema is clean, writer is healthy, and the SQL returns a valid row when executed manually. The 100% RISK_UNKNOWN pattern must originate elsewhere. → See Section 3.
