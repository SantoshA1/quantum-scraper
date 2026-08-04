# TSM Daily-Bars Window — Fix Spec + Readiness Read-Out (2026-08-04)

**Status: SPEC'D, TEST-PINNED, NOT YET LIVE.** Executed by architect (Claude). This is
**step 1 of the QTP_TSM_REAL_ATR_v1 arming sequence** — the prerequisite that must ship and
be verified before the real-ATR flag is turned on. Supabase untouched; n8n untouched.
Repo artifacts only, all green through `npm run ci` (19/19 suites).

## Verdict in one line

**The 2% ATR proxy is not an ATR bug — it is a *fetch* bug with three independent causes, and
arming `QTP_TSM_REAL_ATR_v1` before fixing the fetch would convert "every symbol trails on a
fake 2% ATR" into "nothing trails at all", which is precisely the 2026-07-24 failure mode
(−$1,382, worst day on record, TSM never moved a stop).**

## The call, as it stands live

```
/v2/stocks/bars?symbols=${symbols}&timeframe=1Day&limit=20&feed=sip
```
`docs/trail-stops-v2.js:771` — and the identical string also sits at
`trailing-stop-v1.8.js:295` and `trailing-stop-v1.7.js:284`. **This is a copy-paste family,
not a one-off**, the same shape as the nine dormant-`=` nodes from 07-11.

## Findings

**F1 — Three independent defects, any one of which alone starves `calcATR`.**

| | Defect | Consequence |
|---|---|---|
| **D1** | no `start` | Alpaca defaults `start` to the current day → at most ONE daily bar per symbol exists. `calcATR` needs ≥2 → `null` → `entry * 0.02`. |
| **D2** | `limit=20` is shared across ALL symbols, and results are sorted **by symbol** then timestamp | It does *not* mean "~20/N bars each". The alphabetically-first symbols consume the whole budget and **every symbol after the cutoff gets ZERO bars.** |
| **D3** | no `adjustment` (Alpaca defaults to `raw`) | A split inside the lookback window produces one enormous fake true range, which either blows past the A2 clamp (→ SKIP) or, worse, lands inside it and gets **frozen at entry** for the life of the trade. |

D2 is the dangerous one under the flag: it would give the first few names a real ATR and
silently skip the trail for everyone else — a partial failure that looks like it is working.

**F2 — This exact bug class was already fixed elsewhere in the codebase and never
back-ported.** Regime Service v2 (gov #136, 2026-07-22) was rebuilt for the *same* root cause:
its daily-bars call had no `start`, so `spyPrev == spyLast` and every `regime_state` row read
`0.00% / CHOP / LOW` since 07-08. `_delta_mkt_context/regime-service-v2-labeler.js:52` now
correctly carries `start=`. The TSM copy was never touched.

**F3 — Paging is mandatory, not optional.** `limit` caps at 10,000. At 30 bars per symbol the
ceiling is ~333 names; `sp500.js` whitelists 503. One request cannot cover a broad universe.

**F4 — The A2 clamp contradicts the trigger floor it was written for.** With a perfect fetch,
AES (real ATR **0.36%** of price) still fails `ra >= entry * 0.004` and SKIPs. The `t1Move`
floor of `max(1.5×ATR, 0.7% of entry)` — added specifically for AES-class names — can
therefore never be reached. `tests/test-tsm-atr.js` FLOOR-01 exercises `t1Move` with an ATR
that `realAtrDecision` will never emit; both functions pass in isolation, the composition does
not. **This must be reconciled before the flag is armed**, or low-vol names silently stop
trailing. Pinned as `CLAMP-01`.

## The fix

`lib/tsm/bars.js` (`QTP_TSM_BARS_WINDOW_v1_20260804`) — pure, dependency-free spec-mirror by
the `lib/` convention, with the transport injected so the suite runs offline:

- `windowStart(now)` — explicit `start`, ~52 calendar days back for 30 trading days (D1)
- `requestLimit(n)` — `min(10000, n × 30)`, scaled to the universe (D2)
- `adjustment=all` in every request (D3)
- `fetchDailyBars()` — follows `next_page_token`; **throws** on a repeated token
  (`QTP_BARS_TOKEN_LOOP`) or a blown page budget (`QTP_BARS_PAGE_LIMIT`) rather than silently
  returning a partial universe
- `coverage()` — the assertion the whole fix exists to satisfy: every requested symbol came
  back with ≥15 usable bars. Under-covered symbols are **reported, never proxied.**

The paste-ready live block is `docs/tsm-bars-patch-block.js`. It replaces the two lines at
`docs/trail-stops-v2.js:771-772` and sets `barsData` directly. Any throw lands in the
existing `catch`, which keeps today's 2% proxy — **strictly no worse than current behavior.**

## Verification

All executed, not asserted:

- `node tests/test-tsm-bars.js` → **24/24 checks passed**
- `node tests/test-tsm-bars-patch-block.js` → **9/9** — executes the *exact* paste-ready block
  inside a replica of the live node scope (`symbols`, `barsData`, `alp.call(this,…)`, same
  try/catch) against a simulator implementing Alpaca's documented paging semantics
- `npm run ci` → **19/19 suites passed** (secret ratchet → syntax → workflow JSON → gate
  provenance → all suites)
- `node audit/e2e-tsm-bars-readiness.js` → readiness dry run, 10-position book:

```
A. LIVE TODAY   1 request   symbols with >=15 bars: 0/10   skip-rate 100%
B. AFTER FIX    2 requests  symbols with >=15 bars: 10/10  skip-rate 0%

SYM    BARS   ATR now  ATR real   T1 now  T1 real  FLAG-ON VERDICT
AES      37     2.00%     0.36%    3.00%        —  SKIP (clamp: 0.36% outside 0.40-6.00%)
XPEV     37     2.00%     4.29%    3.00%    6.43%  REAL ATR
...
D. flag ON + broken bars -> NO TRAIL (07-24 mode) for every name
   flag ON + fixed  bars -> stop moves
```

The suite reproduces the live bug from the live URL string before proving the fix, so it
fails loudly if anyone "cleans up" the query back to its current shape.

## Decisions this forces

**D1 — Ship the bars fix with the flag still OFF.** It is worth shipping on its own:
`engineAtr` then computes a real ATR instead of falling back to 2%, with no change to the
skip/proxy semantics. Verified as `E2E-04`.

**D2 — Do not arm `QTP_TSM_REAL_ATR_v1` in the same change.** Arm it only after a live run
shows the canary at `skip-rate 0%`, and only after F4 is resolved.

**D3 — Reconcile the A2 clamp with the 0.7% t1Move floor** (F4) before arming. Either drop the
clamp floor to ~0.25% or delete the floor as dead code. This is a Conclave call.

**D4 — Back-port or delete the two stale copies** in `trailing-stop-v1.7.js` and
`trailing-stop-v1.8.js` so the family cannot be resurrected.

## Caveats

- **Nothing is live.** n8n was not touched. Today's session will run on the 2% proxy unless
  the block is pasted into the TSM Code node. Publishing is PO-gated, and per
  `docs/CANONICAL-SOURCE.md` the repo is stale against live — this needs a
  reconcile-then-publish, not a publish.
- The readiness dry run's ATR percentages are **illustrative** except AES (0.36%) and XPEV
  (4.29%), which are the live-measured values from the 08-03 finding. Real per-symbol values
  land on the first live execution.
- The 30-bar target and the ~52-day window are chosen for ATR-14 with holiday cushion; they
  have not been tuned against a live calendar.
- The suite proves request *shape* and paging behavior against Alpaca's documented semantics.
  It cannot prove Alpaca honors its own docs — the first live run is that proof, and the
  canary line is where to look.

## Artifacts

`lib/tsm/bars.js` · `tests/test-tsm-bars.js` (24) · `tests/test-tsm-bars-patch-block.js` (9) ·
`docs/tsm-bars-patch-block.js` (paste-ready) · `audit/e2e-tsm-bars-readiness.js` ·
this doc. Gate: `npm run ci` 19/19.
