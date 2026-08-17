# gov 224 — QTP was trading the letter A

**Date:** 2026-08-17, 15:47 ET · **Published:** Broad Scanner `975pZZEtxeUbzI22`
`9763ba13` → **`b9249fc3`** · byte-verified pre-publish (sha + `diff` exit 0), 1 of 23 nodes
changed, 0 other parameters touched
**Verify offline:** `node tests/test-scanner-cursor-20260817.js` (14/14)

---

## The measurement

In a full 6.5-hour session QTP touched **35 distinct symbols out of 624**. First letters:
**A and B**, where B is one name.

| era | distinct symbols/session | distinct first letters |
|---|---|---|
| healthy, 07-14 → 07-22 | 63–98 | **19–23** |
| broken (gov 218's collapse), 07-23 → 08-14 | 21–38 | 4–7 — `A` + `W X Y Z` |
| **2026-08-17, after gov 218 "fixed" it** | **35** | **2** |

**Today was the narrowest coverage in 40 days — narrower than the collapse gov 218 repaired.**

## The mechanism, and it is mine

Two pieces of code that had never met. The evaluate loop, unchanged since v3.2:

```js
for (const ticker of tickers) {
  if (newEntriesThisCycle >= MAX_NEW_ENTRIES_PER_CYCLE) break;   // 4
```

It walks from index 0 and **stops** at 4 signals — which it finds within the first ~30 names.
The only thing that had ever moved its starting point was the batch rotation above it. gov 218
did this:

```js
const SCANNER_BATCH_COUNT = Math.max(1, Math.ceil(FULL_WATCHLIST_COUNT / SCANNER_MAX_PER_CYCLE));
if (SCANNER_BATCH_COUNT === 1 || …) { state.quantumWatchlistBatchOffset = 0; }
```

624 ≤ 1000 → one batch → **offset pinned to 0 on every cycle, permanently.** From 2026-08-14
the walk restarted at index 0 and never advanced.

The degenerate 600 + 22 split I removed was, by accident, the only thing producing diversity:
the 600-head broke early inside the A's, and the 22-name tail got a whole cycle to itself.
That is exactly why the broken era's letter set was `A W X Y Z`. **gov 218 made every name
reachable and simultaneously deleted the mechanism that reached them.** I wrote both halves,
and I called the residual risk LOW in my own backlog:
*"`MAX_NEW_ENTRIES_PER_CYCLE` breaks an alphabetically-ordered loop."* It was not LOW. It was
the binding constraint on the entire opportunity set.

It is also why `SSM_KILL` dominates the funnel — 58 rows since 13:30, nearly all
`Duplicate: ADI_5 already BUY/BULLISH (3604s ago)`. The same 35 names on a loop produce almost
nothing new, so duplicate suppression eats the stream.

Everything that reached Gate-K today was an A: AMAT, ADPT. Everything that reached the bias
filter was an A or BMNR.

## The fix — a resume cursor

Three additive edits. The walk starts where it stopped last cycle and wraps:

```js
let _entryCursor = Math.floor(Number(state.quantumScanEntryCursor));  // floor: a fractional cursor would compound
if (!Number.isFinite(_entryCursor) || _entryCursor < 0 || _entryCursor >= tickers.length) _entryCursor = 0;
const _cursorActive = SCANNER_BATCH_COUNT === 1;
if (!_cursorActive) _entryCursor = 0;
if (_entryCursor > 0) tickers = tickers.slice(_entryCursor).concat(tickers.slice(0, _entryCursor));
```
```js
state.quantumScanEntryCursor = (_cursorActive && tickers.length)
  ? (state.quantumScanEntryCursorStart + _walked) % tickers.length : 0;
```

**`MAX_NEW_ENTRIES_PER_CYCLE` is untouched at 4.** It is a risk limit on how much may be
*opened* per cycle, not a coverage limit, and nothing here changes it. SC-08 and SC-09 pin
that: the fix changes *which* names are looked at, never *how many* are opened.

Above 1000 names the cursor **disarms** — the batch offset already advances the walk there, so
the two mechanisms never fight. SC-13 proves the >1000 path is byte-for-byte the behaviour that
shipped today.

Measured in the suite: a full 624-name sweep completes in **≤78 cycles**, so the whole universe
is seen at least once per session, and the starting point moves every cycle.

## The suite caught a real bug before it shipped

`tests/test-scanner-cursor-20260817.js` — 14/14, executing the real deployed bytes of
`Scan All Tickers` (live sha `7e453413…`, patched sha `a0e26137…`).

SC-10 feeds garbage into the saved cursor. On the first draft, `623.7` passed the finite/range
check, `slice(623.7)` silently truncated, and `(623.7 + walked) % 624` **persisted a fractional
cursor that compounds every cycle**. `Math.floor` was added because SC-10 failed. That check
existed before the deploy did.

- **SC-03** is the witness: over 78 simulated cycles the live bytes reveal *not one name* that
  cycle 1 had not already seen, and every cycle restarts at index 0.
- **SC-04** ties the model to the field — it must land in the 20–45 band and under 8% coverage,
  because production measured 35 and 5.6%. A model that merely says "fewer than all" would pass
  a weaker check and tell you nothing.
- **SC-02** proves the patch *deletes* exactly one line (the `[DONE]` log, which gained a cursor
  readout) and every added line belongs to the cursor.

Negative controls run, not just written:

| sabotage | result |
|---|---|
| revert the patched fixture to the live bytes | **9 checks fail** |
| remove the `Math.floor` guard | **SC-10 fails**, 12/14 |
| restored | **14/14** |

## Also today: ADPT stopped out

**−$100.85, −0.81R.** Entry 25.35 at 11:31:05, exit 25.107 at 14:43:55 against a 25.08 stop —
held 3h13m and **exited at the stop with no gap-through**, which is the first clean stop in a
while given that five of 46 prior trades blew through theirs.

Gate-K after it: `n=22, dollar_pf 1.1621, kelly_star −0.0978, approved: true`. Longs still
allowed at 0.50% probation sizing. **Headroom before `negative_measured_edge` returns is now
$299.28 of gross loss**, down from $400.12.

## What this does and does not promise

It does not create an edge. It restores the opportunity set to what the strategy was always
supposed to be measured on. Note the honest counterweight from `NEXT-SESSION-FORECAST`: entries
per session were **2.06 in the narrow-universe era and 0.271 in the diverse era** — repeat
exposure to the same names converts *better*, just not *profitably*. Expect **fewer** entries
per session on a genuinely diverse universe, drawn from a far larger and more honest sample.

The point is that the next measurement will finally be of the strategy rather than of the
first thirty tickers in the alphabet.

## Ledger

- **Live-verify at tomorrow's open**: distinct symbols should climb well past 35 and the letter
  set past `{A,B}`. The `[DONE]` log now prints `cursor N -> M (walked W of 624, first=XXX)`.
  If `first=` is `AAOI` on consecutive cycles, the cursor is not persisting.
- **Sentinel gap**: `scanner_universe_coverage` alarms only when *zero* mid-index symbols
  signal in 5 days. It did not alarm on 35-of-624 because the A's are in the index range it
  samples. It needs a distinct-symbol floor, not just a non-zero test.
- **Open question for the PO**: the loop takes the *first* 4 signals it finds, not the *best* 4
  in the universe. Best-of-universe would be better selection, but it is a strategy change and
  a 60s-ceiling risk. Not done, not recommended without a measurement.
- Stale n8n node `notes` on `Scan All Tickers` still describe the 2026-04-30 batch-size-125
  patch. Cosmetic, misleads anyone reading the editor.
