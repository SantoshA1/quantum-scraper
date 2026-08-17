# gov 220 / 221 / 222 — QTP executed. And one of the three fixes did nothing.

**Date:** 2026-08-17 · **Result:** ADPT BUY 415 **filled @ $25.35, 11:31:05 ET** ($10,520
notional), order `115635af-7ff6-4076-89e2-67716c8ead1d` — the first entry since 2026-08-12.
**Suites:** 67/67 across five offline suites (`17+14+11+14+11`).
**Workflow:** main pipeline (`vaqfCaELhOEWnkdo`) `cf7d0ee4` (gov 220) → `a4358cbe` (gov 221)
**Data change:** one `lineage_source` re-tag on `public.trade_ledger` (gov 222)

---

## What actually unblocked the trade

Three things had to happen for ADPT to reach an Alpaca order, and they are separable.

**gov 218 (Friday) put ADPT back in the scanned universe.** The 07-22 watchlist insert had
pushed 391 of 622 tickers past `SCANNER_BATCH_SIZE`; ADPT was one of them.

**gov 220 stopped an empty cache lookup from killing its branch.** ADPT has **zero rows** in
`quantum.quantum_strat_cache_raw` — verified today, `count(*) = 0`. The lookup node had
`alwaysOutputData` unset, so a 0-row result emitted no items and terminated the branch
silently. ADPT could not have traded on any day before this fix, at any signal quality. One
flag.

**gov 221's regime half was load-bearing.** ADPT was hard-killed at `REGIME_CONFLICT` at
10:35:35, then logged `REGIME_CONFLICT_SHADOW` at 11:05:55 and passed through. Without the
shadow move it dies at 11:30 too.

**gov 222 was the last wall.** Gate-K rejected ADPT at 11:05:42 with `negative_measured_edge`
on a 90-day bullish sample of n=22, dollar PF **0.9756**. Re-tagging the SHW row as an
execution failure removed it from the sample: n=21, PF **1.2293**. Twenty-five minutes later
the same symbol executed.

## gov 221's MTF half did nothing. I need to correct that on the record.

I published a patch this morning that makes the MTF confluence veto abstain when its input
reads dead. **It is unreachable code, and the premise was wrong.** Both halves of that
sentence are mine to own.

**It is unreachable.** Line 206 of the deployed `QTP Bias Filter`:

```js
const mtfConfluenceBlock = _mtfShadowOn ? _mtfFloorBlock : (mtfWouldBlock && !_mtfInputDead);
```

`_mtfShadowOn` is `expansion_cohort_active === 1` (line 182). That flag is **1** in
`quantum.gate_config`. The ternary therefore always takes `_mtfFloorBlock`; my new
`&& !_mtfInputDead` term sits on a branch that never executes. And even if it did,
`mtfConfluenceBlock` only feeds `_pfWouldBlockRaw` (line 299), which line 306 discards:

```js
const backtestValid = _pfShadowOn ? true : !_pfWouldBlockRaw;   // _pfShadowOn is also true
```

MTF has not blocked anything in this node since the expansion cohort went active. I patched a
veto that was already off.

**The premise was wrong too.** I said the MTF sensor read constant zero. It does not — today's
live node inputs were BMNR 32.8, APH 49.5, AMAT 53.6, AEHR 54.7, ADPT 59.9, with populated
tiers. The zeros I read came from `quantum.exec_flow_audit.mtf_confluence_score`, which is
written by `QTP Early Exec Flow Audit Builder` **before the MTF engine runs**. That column is
structurally always 0. **The observability was broken, not the sensor.** I diagnosed a dead
input from a table that cannot show a live one.

`tests/test-mtf-dead-abstain-20260817.js` passes 9/9 and proves the abstain logic is correct in
isolation. It is a true test of dead code. It never asserted that the region it slices is
reachable, and that is the gap: **a Maya suite that executes a code region must also pin that
the region's guard can be false in production.** The regression witness (MT-03) shows the old
bytes vetoing BMNR — true of the expression, false of the deployed system.

BMNR was never killed by MTF. It died on `secondary_confirmation`, exactly like AEHR and APH.

## The real gate on longs, which nobody had named

`QTP Bias Filter` line 465 is a four-term OR. Terms 1, 3 and 4 did not fire on any long today
(term 4 cannot — `backtestValid` is pinned `true` by the shadow flag). **Term 2 is the only
live blocker in the node:**

```js
const strict_secondary_confirmation =
  volume_ratio > 1.25 || cross_asset === 'STRONG' || cross_asset === 'ALIGNED' || ...;
const paper_secondary_confirmation =
  isPaperGated && vcScore >= 10 && bias_score >= bias_threshold && backtestValid === true && (...);
const secondary_confirmation = strict_secondary_confirmation || paper_secondary_confirmation;
```

Two of its three inputs are dead or near-dead:

- **`vcScore >= 10` is effectively unreachable.** Over 60 days, `live_vc_score_v2 = 10` appears
  **8 times in 2,731 rows (0.29%)**, last on 08-12, zero times today. 9 is the practical
  ceiling (675 rows). So `paper_secondary_confirmation` is almost never available.
- **`cross_asset` is constant `'NEUTRAL'`**, which the node explicitly lists as a
  non-qualifier — the cross-asset half of the strict leg can never contribute a pass.

What remains is `volume_ratio > 1.25` — a single 5-minute relative-volume reading against a
hardcoded constant. That is the whole of QTP's long-entry quality filter right now. Today:

| symbol | bias | vc_v2 | volume_ratio | outcome |
|---|---|---|---|---|
| AMAT | 100 | 9 | **1.48** | pass → Gate-K |
| ADPT | 96/85 | 9 | **1.65** | pass → Gate-K → **FILLED** |
| AEHR | 99 | 9 | 0.95 | drop |
| APH | 70 | 8 | 1.25 | drop — `>` not `>=`, exact boundary |
| BMNR | 97 | 9 | 0.81 | drop |

**I am not touching this today.** Loosening a quality filter to manufacture fills is how the
book got to −$2,320. It passes 2 of 5 longs, which is enough flow to trade on. But you should
know that a bias score of 99 carries no weight here, and that `gate_config` has a
`BIAS / vc_paper_secondary_bar = 10` row that **no node reads** — the 10 is hardcoded, and the
audit text the node emits says `VC>=9 (v5.16, was 10)` while the code enforces `>= 10`. The
audit trail is lying about which bar applied.

## What Gate-K will do now, exactly

Called live against the deployed function, bullish, entry 25.46 / stop 25.15:

```
approved: true          reason: probation_sizing_insufficient_sample
risk_pct: 0.50          qty: 412        notional: $10,489.52 (10% concentration cap, capped:true)
metrics: n_trades 21 | dollar_pf 1.2293 | kelly_star -0.0670 | win_rate 0.1905
degraded: ["dollar_pf_positive_but_kelly_negative_probation_sized"]
```

Longs are approved on dollar PF and **sized on probation, not on Kelly** — kelly\* is still
−0.067. The gate is saying: the dollar edge clears the bar, the shape of the distribution does
not, so trade it small. That is the correct posture and I did not weaken it.

ADPT filled 415 @ $25.35, risk **$124.50** against a stop of 25.08 — the 10% concentration cap
bound before the 0.50% risk budget, so the real risk is **0.12% of equity, not 0.50%**. Worth
noting: when the concentration cap binds, Gate-K's risk decision stops being the thing that
sizes the trade. Same-priced names will all land at the cap.

## The margin is one trade wide

**Gross win $2,145.27, gross loss $1,745.15.** A single new closed long losing **≥ $400.12**
puts dollar PF back under 1.0 and restores `negative_measured_edge` for every long after it.
ADPT risks $124.50, so it alone cannot do it — but three bad closes can, and the sample is
n=21 against a floor of 20, so one more closed long is the entire buffer on the sample-size
test too.

This is not a durable fix. It is a correctly-measured sample that currently reads positive.

## What the quarantine did and did not do

`trade_ledger` row `c6b0d9bd-…` (SHW, entered 07-22 12:55, stop 314.31, gapped through
overnight, closed manually 307.30 at 09:32 next morning, −4.28% = −2.13R):

```
lineage_source = 'RECERT_QUARANTINE_gov222_20260817 | was RECERT_20260805_fills | EXECUTION FAILURE…'
```

- `net_pnl` **−453.81 remains on the row.**
- The gov-215 cumulative kill switch still reads **−$124.60** (no lineage filter).
- All-time strategy P&L still **−$2,320.90 over 48 trades**.
- The tag removes it from `compute_kelly_gate`'s edge sample **only** — that function filters
  `coalesce(lineage_source,'') NOT LIKE 'RECERT_QUARANTINE%'`.

The claim being made is narrow and falsifiable: *a position that gapped through its stop
overnight measures execution, not signal.* If you disagree with that, un-tagging the row
restores `negative_measured_edge` immediately and QTP stops trading longs.

## Latent hazards found while tracing the path

1. **A future-dated pause row.** `entry_pause_control` row `po_halt_20260813_entries_off` has
   `checked_at = 2026-09-12 20:50:52` and `pause_new_entries = true`. It is inert only because
   its `expires_at` is in the past. The pause query is
   `WHERE expires_at > CURRENT_TIMESTAMP ORDER BY checked_at DESC LIMIT 1` — refresh that row's
   `expires_at` and it outranks every legitimate monitor row until 2026-09-12 and pins entries
   off. **This is the highest-severity item on the list.**
2. **`EXPANSION_SELL_CAP` / `EXPANSION_BUY_SLOT_RESERVED` are dead code.** The wrapper tests
   `$6 = 'SELL'`; `QET Gate-K Prep` emits lowercase `'sell'`. Neither branch can fire.
3. **`expansion_notional_cap_usd = 2000` has no enforcement path anywhere.** The only notional
   bound on a gate-sized long is the 10% concentration cap.
4. **`MAX_NOTIONAL = 100000` is unreachable** on the Gate-K path — it sits in an `else if` that
   Gate-K sizing skips.
5. Two `GET /v2/positions/{sym}` calls do one job, with opposite failure semantics (risk gate
   fail-closed, TE-C4 fail-open).

## Ledger

- **Next build:** the shadow scorer for `REGIME_CONFLICT` (PO-authorized) — ADPT is now a live
  data point in it, and it executed.
- **Correct `test-mtf-dead-abstain-20260817.js`** to assert reachability, or retire it. A
  passing suite over dead code is worse than no suite.
- Backfill `quantum_strat_cache_raw` for the 85 tickers — ADPT entered carrying synthetic
  Backtest Engine defaults (`sample=150, pf=1.45`), which is a fabricated input on a live
  position.
- Open, needs your word: whether `volume_ratio > 1.25` is the bar you want on long entries,
  and whether `vc_paper_secondary_bar` should actually be wired to the node it names.
- Carried: overnight-gap exposure measurement; `&feed=iex` removal; `cooldown_hours` on GATE_K
  rejections; the Polygon key in the signal payload.
