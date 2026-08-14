# Gov 217 — The audit table stops lying by omission: every kill now has a name

**Date:** 2026-08-14 13:00 ET · **Authorized:** PO ("Fix the late-path kills like ASTS today leave audit rows stuck `PENDING`")
**Workflow:** main pipeline (`vaqfCaELhOEWnkdo`), version `8ddf1775` published, ACTIVE
**Verify offline:** `node tests/test-audit-writeback-20260814.js` (16/16) · builder pinned sha256 `884e3042…` in `docs/audit-writeback-20260814/`

---

## What was broken

`quantum.exec_flow_audit` is the table every attribution number is computed from. Two
terminal branches of the pipeline had **no audit writer at all**, so the table
under-stated kill attribution in two different ways:

1. **`QTP-10FC Pause Guard Gate` out[1] → stuck at `PENDING`.** The Early Audit Builder
   writes its row upstream of this gate, so a kill here left that row frozen mid-flight
   forever. 7 rows today (WRB/WMB/WSM/WRD 09:30, ACGL/AMAT/AME 09:35), 120 across 30
   sessions. Worse, this one IF carries **two** unrelated conditions ANDed together —
   the entry pause *and* a `bias_score ≥ 65` leg — so even where a cause was guessed it
   could be the wrong one of the two.
2. **`Route Fast Only` out[1] → no row at all.** `_sm_route='SKIP'` fell off the end of
   the graph into an empty output. ARM's ATR>8% kill on 08-13 produced **nothing**. This
   is the worse failure: an unattributed row is visible as a gap; a missing row is not.

The ASTS case that prompted this was neither — its finalizer simply landed late (it
finished as `GATE_K` minutes after the snapshot). Chasing it found the two real holes.

## What the first fire showed

Within three minutes of publishing, the SKIP path recorded four kills of a class that
had **never once appeared in `exec_flow_audit`**:

```
12:50:10  WMB  SSM_KILL: Duplicate: WMB_5 already BUY/BULLISH (3599s ago)
12:50:12  XOM  SSM_KILL: Duplicate: XOM_5 already BUY/BULLISH (8999s ago)
12:55:08  AMD  SSM_KILL: Duplicate: AMD_5 already BUY/BULLISH (7195s ago)
12:55:13  BKR  SSM_KILL: Duplicate: BKR_5 already BUY/BULLISH (1799s ago)
```

Yesterday's funnel note recorded "42 signals → 22 distinct candidates" and moved on.
Those ~20 suppressed signals were the SSM's duplicate guard firing — a real gate, with a
real 60-minute-plus repeat window, that no report has ever counted because it wrote no
row. It is now on the ledger alongside REGIME_CONFLICT and the rest.

## What was deployed

One builder body, deployed **byte-identical at both attach points** (so a single offline
suite pins both), plus two Postgres executors:

- **One atomic statement per item**: finalize the `PENDING` row if one exists, else
  insert a terminal row — keyed on `idempotency_key`. Never double-writes, never
  downgrades a row a real stage already finalized, `COALESCE` on every column so an
  earlier attribution always wins. Proven against live data in a rolled-back transaction
  on all three cases before deploy.
- **Attribution, not a label**: `ENTRY_PAUSE` / `PAUSE_GATE_SCORE` / `SSM_KILL` /
  `UNROUTED_TERMINAL`. The pause and score legs of that one IF are told apart; an SSM
  kill is never blamed on a score gate it never reached.
- **`$input.all()`**: a 4-candidate batch produces 4 attributions. The pre-existing
  SKIP-branch builder reads `$json` and attributes only item 0 — a latent gap left
  documented, not copied.
- **Fail-soft by construction**: all four nodes `onError=continueRegularOutput`. An
  audit write can never break the trading pipeline. Nothing on the execution path is
  read or altered — the input item is passed through unmutated (asserted, AW-16).

**v1.1, caught by the suite before it could mislead:** the gate's score expression
defaults a *missing* score to 0, so a dead or renamed score field is killed exactly like
a real low score. v1.0 would have written "PAUSE_GATE_SCORE, bias_score=0" — the same
fail-open silence gov 216 exists to end. v1.1 records `score=ABSENT` under
`UNROUTED_TERMINAL` instead. A real 0 is still a score kill.

## The landmine found on the way in

The draft of the main pipeline had diverged from the deployed version in **23 nodes**: a
UI autosave on 08-13 02:59 had stripped the leading `=` expression prefix from **20
Postgres `query` fields**, including the early audit insert, the bias-filter drop update
and the RCF audit insert. Nothing had published it yet. Anyone pressing Publish in the
n8n UI — for any reason — would have shipped all 20 at once.

The draft was restored from the active version first (0 differing nodes verified) and
the patch applied on top, so the published change is only these 4 nodes. *Note for the
record: 7 Postgres nodes have always run without the `=` and work fine — the Late Audit
Update among them, which demonstrably fires daily — so the prefix appears optional here.
The restore was hygiene, not a rescue.*

## Verification chain

1. SQL semantics proven against **live** data inside `BEGIN … ROLLBACK`: PENDING row →
   updated in place, no duplicate; absent row → exactly one insert, and a second run is
   a no-op; already-`REJECTED` row (ASTS) → untouched, not poisoned, not duplicated.
   Rollback confirmed after each.
2. Patch scope verified before publish: exactly 4 nodes added, **0 pre-existing nodes
   changed** on any field, exactly 4 connections added and 0 removed, all pre-existing
   targets on both branch points intact.
3. Both deployed bodies verified sha256-identical to each other and to the repo fixture
   (`884e3042…`) — checked again after the v1.1 push.
4. **Live-fired in production** at 12:50 ET, 3 minutes after publish.
5. Maya suite 16/16 — the deployed bytes are *executed* offline: each cause under its own
   name; an SSM kill with a low score never blamed on the score gate; a scoreless item
   surfaced as `ABSENT`; a 5-item batch → 5 attributions with 5 distinct keys; the
   statement's UPDATE touches only `PENDING`; a hostile payload proven to sit inside a
   string literal by scanning the SQL the way Postgres does.

## Backfill

120 stranded rows were finalized, every one stamped `…BACKFILL_gov217…` in
`gate_decision` so a backfill can never be mistaken for an observation:

| rows | attribution | basis |
|---|---|---|
| 7 | `ENTRY_PAUSE` | today 09:30–09:35, inside the gov-213 halt (lifted 09:37:37 ET); all carried `bias_score` 93–100, so they had cleared the gate's score leg — the pause is the only remaining cause |
| 113 | `UNATTRIBUTED_PRE_GOV217` | older than today; the true cause is not recoverable from the row, and saying so is better than guessing |

**`quantum.exec_flow_audit` now contains zero `PENDING` rows.** Every audit row in the
table carries a terminal status.

One row corrected the record on its own along the way: BMNR (12:45, `bias_score` 54) was
`PENDING` when the backfill was written and finalized itself as `BROAD_SCANNER_BIAS_PATH`
before it ran. The `audit_status='PENDING'` guard left it alone — some `PENDING` rows are
genuinely in flight, which is why the backfill floor was 15 minutes.

## What this does and does not change

It changes **nothing about what QTP trades**. Not one routing decision, order, or gate
threshold moved. What changed is that the record of *why* nothing traded is now complete:
every kill has a name, no kill is invisible, and the funnel table can finally be trusted
to sum to the signals that entered it.

That matters for the open question, not the closed one. Gov 212 found that the funnel's
survivors historically did not beat its rejects. Testing that claim properly needs an
honest denominator — including the ~20 duplicate-suppression kills a day that until today
were not in the data at all.

## Ledger

- **Open (MEDIUM, needs PO word):** the `Indicator Enrichment` node embeds the Polygon API
  key as `_polygon_key` in every signal item, so it rides through every downstream node
  and into n8n execution logs. Verified NOT persisted to Supabase. ~15-minute fix.
- **Open (LOW, found today):** `QTP SKIP-Branch Exec Flow Audit Builder` reads `$json`,
  so on a multi-candidate FAST_ONLY batch it attributes only the first item. Same class
  of bug as the one just fixed, smaller blast radius.
- **Open (LOW, found today):** the n8n UI autosaves drafts that strip `=` prefixes. The
  draft is clean now, but it will happen again the next time the workflow is opened in
  the browser. Worth a pre-publish diff every time, which is now convention here.
