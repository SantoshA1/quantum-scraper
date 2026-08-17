# gov 223 — a halt you cancelled on 14 August was still first in line

**Date:** 2026-08-17, mid-session · **Change:** one `UPDATE` on one row of
`quantum.entry_pause_control`. No code deployed, no workflow published.
**Verify offline:** `node tests/test-pause-priority-20260817.js` (13/13)
**Live effect:** none — the deployed reader returned `pause_new_entries=false / NOMINAL`
before and after, and ADPT stayed open throughout.

---

## What I got wrong when I flagged this

I called it a corrupted timestamp. It was not. The future-dating was **deliberate and
sanctioned**, and the row says so in its own `reason` text. The Expansion Kill-Switch Monitor
writes the same pattern with an explicit comment:

```sql
-- gov215: checked_at = expires_at so the pause reader (ORDER BY checked_at DESC LIMIT 1)
-- keeps returning this halt for its whole life despite AFTO's 15-min NOMINAL inserts.
CASE WHEN t.cum_trip THEN (now() + interval '30 days') ELSE … END,
```

`qtp_afto_monitor` inserts a NOMINAL row every 15 minutes. A halt written with a real
timestamp would be masked by the next one. So a halt sets **`checked_at = expires_at`**, both
pushed out to the halt's intended life. Priority window and lifetime are the same window.
That is the invariant.

## The actual defect: `checked_at > expires_at`

The gov-214 lift ("reenable trading now", 08-14 09:34 ET) pulled `expires_at` back to
`2026-08-14 13:37:37+00` and **left `checked_at` at `2026-09-12 20:50:52+00`.** The row became
dead and permanently first in line — `checked_at` **29.30 days past its own expiry**, and
ahead of every AFTO row until 12 September.

One row in 3,173 broke the invariant. It was the one that says *stop trading*.

## Why it did not fire, and how thin that was

Every reader of this table, audited across all 72 workflows plus every Postgres
view/matview/function:

| reader | expiry filter | verdict |
|---|---|---|
| main pipeline `Prepare Supabase Pause Guard Query` — **the only one that gates entries** | **`WHERE expires_at > CURRENT_TIMESTAMP`** | safe |
| Sentinel `Run Liveness Checks` | none — but scoped `WHERE source='qtp_afto_monitor'` | immune |
| Kill-switch dedupe | `AND e.expires_at > now()` | safe |
| Daily Summary / Health Monitor | none — `COUNT(*)` only | immune |

Run against the live table before the fix, with and without that one clause:

| query | row selected | `pause_new_entries` |
|---|---|---|
| deployed, with `expires_at > CURRENT_TIMESTAMP` | AFTO 16:15 | **false** |
| same ordering, clause removed | **`po_halt_20260813_entries_off`** | **true** |

**One `WHERE` clause was the entire distance between a working system and a silent halt.**
Two things would have closed it: a new reader written without the expiry filter, or anything
that pushed `expires_at` forward while `checked_at` stayed in September. The second is not
hypothetical — a manual re-arm of that same row is exactly how a PO halt gets reinstated.

## The correction

```sql
update quantum.entry_pause_control
set checked_at = expires_at, reason = reason || ' | gov 223 TIMESTAMP CORRECTION …'
where control_id = 'po_halt_20260813_entries_off' and checked_at > expires_at;
```

`checked_at = expires_at` restores the gov-215 invariant exactly, and it is derived from the
row itself rather than from my arithmetic. The row's priority now ends when its life ended —
which is the true fact about a cancelled halt.

Verified after: **0 invariant violations, 0 future-dated rows, 3,173 rows, governance record
intact, `pause_new_entries=false / NOMINAL` unchanged.** Nothing was deleted; the full gov-213
and gov-214 history including the lift order is still on the row, with the correction appended.

## What I deliberately did NOT do

**No `CHECK (checked_at <= expires_at)` constraint.** It would make this class of bug
impossible, and all three writers satisfy it today. But a constraint that can reject an
`INSERT` can prevent a *halt* from being recorded, and the kill-switch monitor's write is the
mechanism that stops trading after a cumulative loss. A constraint that fails open on a safety
mechanism is worse than the bug it prevents. The invariant is enforced by the suite and by the
rule below, not by the database.

**No change to the reader.** Making the ordering immune (status priority, or `ORDER BY
checked_at DESC` with an expiry-aware tiebreak) is the durable fix, and it is a code change to
the single most safety-critical node in the pipeline. Not on the day trading resumed. It is
now scoped and pinned, and PG-09 already asserts the behavior any such change must preserve.

## The rule this leaves behind

> **A row in `entry_pause_control` may never be dated past its own expiry.** To arm a halt, set
> `checked_at = expires_at` at the intended end. To lift one, move **both** back — or insert a
> superseding row. Moving only `expires_at` leaves a dead row permanently first in line.

## The suite

`tests/test-pause-priority-20260817.js` — 13/13. Executes the real deployed bytes of
`Prepare Supabase Pause Guard Query` (sha `0dc3c8d7…`), `Format Supabase Pause Guard Context`
(sha `fa41e569…`) and `QTP-10FC New Entry Pause Guard` (sha `13345838…`), chained end to end,
against the actual captured table rows.

Row selection is SQL and cannot run offline, so PG-01 pins the two clauses that do the
selecting **and asserts there is no second `WHERE` or `ORDER BY`** — if the query grows a
clause the harness does not model, PG-01 fails before any selection result is trusted.

- **PG-04** is the witness: on the pre-fix rows with the expiry clause removed, ADPT — the
  trade that actually filled at 11:31:05 today — is killed with `BLOCK_NEW_ENTRY_ONLY` by a
  halt the PO cancelled three days earlier.
- **PG-09** is the check that matters most, because this change makes the halt mechanism
  weaker: a halt written the gov-215 way still outranks AFTO and still blocks the entry.
- **PG-10**: an exit is never blocked, even under a live halt.
- **PG-13**: `alwaysOutputData` on the pause-reading Postgres node is still unset. Turning it
  on would make a failed read emit an empty item, the `COALESCE` defaults would read as
  `NO_ACTIVE_PAUSE`, and QTP would trade past a pause table it could not read.

Both negative controls were run, not just written:

| sabotage | result |
|---|---|
| put the September date back in the fixture | **10/13** — PG-02, PG-07, PG-08 fail |
| strip the expiry filter from the deployed query fixture | **10/13** — PG-01, PG-05, PG-06 fail |
| restored | **13/13** |

Full sweep: **80/80** across six suites (`17+14+11+14+11+13`), each run with its exit code
checked, not piped through `tail`.
