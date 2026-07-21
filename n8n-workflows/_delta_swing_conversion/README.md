# Delta: Swing-Book Conversion (2026-07-20)

QTP converted scalp -> SWING book (PO decision). Hold protected/intact positions
overnight; flatten only when it doesn't make sense to hold.

## Changes (all LIVE in n8n; snapshots here for the git record)

1. **Scalp Exit Watcher** (IzTXfM9G0TM2wt0U, live 2968be9d, gov #132)
   - `scalp-exit-watcher-SWING_MODE_v1.js` — added `SWING_MODE` (default on,
     reversible via $vars.QTP_SWING_MODE=false); gates the two scalp TIME-STOPS
     (60m-losing, 90m-flat/red) behind !SWING_MODE. All protective exits kept.

2. **Trailing Stop Manager v2.0** (vFnPjyx8srnzcYgV) — the confirmed Friday killer.
   Disabled its two time-of-day flatteners via n8n Variables (no code change):
   - `QTP_SCALP_EOD_CLOSE_ENABLED = false`   (was flattening today-entered
     positions 15:30-15:59 ET; audit_trail proof: CBRE/JKHY/MAR/RMD 07-17 15:30)
   - `QTP_SCALP_CARRYOVER_CLOSE_ENABLED = false`
   Kept: orphan/naked-position flatten (safety), price trailing stops, GTC stops.

3. **v_swing_hold_decision** view — read-only dashboard HOLD/FLATTEN decision layer.

## Verified live (2026-07-20 15:59 ET)
EOD window ran, ZERO SCALP_EOD_CLOSE. 6 positions carried overnight, all
FULLY_PROTECTED, ~+$1,176 unrealized (incl. FDX/HD, today's entries that the
old scalp regime would have flattened at 15:30).

Governance rows: quantum.ssm_workflow_updates #132.
