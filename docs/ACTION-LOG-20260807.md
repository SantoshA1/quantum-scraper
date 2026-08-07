# QTP ACTION LOG — 2026-08-07
**Session:** claude-architect + PO · **Governance row:** 194 · **Market open throughout**

## RCA: "no orders executed today" — QTP is not broken, it stopped on purpose

PO reported zero executions. Confirmed: `quantum.order_events` empty for 2026-08-07, and
**zero signals passed all gates** — the first such day in the 21-day window (24 signals in,
0 through; 08-06 had 7, 08-05 had 3, 08-04 had 10).

**Root cause: Gate-K is returning `negative_measured_edge` and refusing every trade,
globally.** Verified by calling the live production function directly, not by replay:

```
public.compute_kelly_gate(...) ->
{ "approved": false, "reason": "negative_measured_edge", "qty": 0, "risk_pct": 0,
  "metrics": { "n_trades": 42, "win_rate": 0.1667, "avg_win_r": 2.937,
               "avg_loss_r": 0.960, "kelly_star": -0.1102 } }
```

**The trigger was yesterday's own H4 exit-sync fix (gov 193).** `compute_kelly_gate` only
enforces the measured-edge verdict at `n >= p_min_trades` (40); below that it falls through
to probation sizing, which always approves. Booking WMT/AEP/WRB/APA took the certified
closed-trade count **38 → 42**, crossing the line:

| | closed trades | kelly★ | verdict |
|---|---|---|---|
| Before gov 193 | 38 | n/a (under threshold) | `probation_sizing_insufficient_sample` → **approved**, 0.50% |
| After gov 193 | 42 | **−0.1102** | `negative_measured_edge` → **rejects everything** |

`negative_measured_edge` appears in `exec_flow_audit` for the **first time ever today**.
Every prior GATE_K block in 21 days was `stop_width_exceeds_sanity` or `stop_out_cooldown` —
narrow, per-signal. This one is global: every symbol, both directions.

The fix did not create the negative edge, it made the sample honest enough for a guard armed
since the 08-05 Conclave unpin (gov 185) to fire. k★ was −0.099 then, −0.110 now — sign-stable
across two independent measurements. **This is the risk system working exactly as designed.**

**It will not self-resolve.** Clearing it needs ~5 winning trades (breakeven win rate at the
current payoff profile is 24.64% vs 16.67% actual) but the gate blocks the trades that would
earn them. Natural relief only when old trades age out of the 90-day lookback: the row that
drops n back to 39 is dated 2026-07-17 19:30Z, so **n < 40 on 2026-10-15** — 69 days out.

**What the negative edge is actually made of** (and why the number may not describe the
system as it now stands):

| Exit | n | wins | avg R | total P&L | avg intended stop width |
|---|---|---|---|---|---|
| **stop** | 24 | **0** | −1.23R | **−$3,496.91** | **3.24%** |
| manual | 11 | 5 | +0.63R | +$1,346.88 | 3.52% |
| time | 4 | 1 | −0.02R | −$44.03 | 3.81% |
| trail | 3 | 1 | +3.21R | +$608.25 | 3.94% |

24 stop-outs, **zero winners**, averaging worse than −1R (slippage through the stop), on stops
averaging 3.24% wide — 57% of the sample and essentially the entire loss. Every other exit
bucket is profitable. That 3.24% is precisely the defect closed yesterday (gov 190: entries
born 3–4% wide against a TSM enforcing 1.2%). The measured edge is real and honestly computed,
but it was measured almost entirely under three now-fixed defects. **The post-fix edge is
unmeasured.** No gate change made or recommended without PO sign-off.

## Deployed: Gate-K stop parity v2.0 — gov 194

Secondary finding from the same RCA, PO-authorized and shipped. **The 1.2% entry clamp (gov
190) never reached Gate-K.** Order of evaluation, proven from the live connection graph:

```
Format Supabase Alpaca Risk Gate Context
  -> QET Gate-K Prep          <- derives __qet_stop        (RAW 1.5*ATR, uncapped)
  -> QET Equity Fetch (Paper) -> QET Kelly SQL Build       <- passes it as p_stop
  -> QET Kelly Gate Check -> QET Gate-K Approved? -> QET Gate-K Restore Context
  -> Alpaca Paper Trade       <- QTP_ENTRY_STOP_CLAMP_v1 lives HERE, downstream
```

So Gate-K judged — and sized off — a stop the pipeline would never place, and rejected
anything past its `p_max_stop_width_pct = 5.0` line.

**Live proof, today 13:35:51Z:** ARE SELL, price 48.48, atr 2.12.
Gate-K saw `48.48 + 1.5×2.12 = 51.66` = **6.559%** → `gatek_reject=stop_width_exceeds_sanity`.
The order would have carried `min(3.18, 0.582)` = **1.196%** — comfortably legal.

**Cost: 18 such rejections in 21 trading days**, 1–3 on almost every day, every one of them a
signal that had already cleared VC, bias, MTF and AI — the expensive gates.

**The silent half:** AMAT BUY 537.27 / atr 17.37 was *not* rejected — it saw 4.849% and slipped
under the 5% line by 0.15pp — while Gate-K sized off a stop **4× wider** than the one that
would be placed. The gap distorted sizing even when it didn't reject.

| Change | Where | Version | Rollback | Proof |
|---|---|---|---|---|
| **Gate-K Prep v2.0** — mirrors the Alpaca node arithmetic exactly (SL_MULT 1.0 vol / 1.5 normal · missing-ATR fallback `price×1.5%` · `min(raw, price×1.2%)`); also closes two latent divergences: v1 gave listed volatiles a flat 3% and **did not have IONQ in its volatile list at all** | main pipeline `vaqfCaELhOEWnkdo`, node "QET Gate-K Prep" | active `e5ca4c98` | `10a5a6a5` | suite **11/11**; deployed byte-identical `aff5743c7d8182ba…`; sibling "Alpaca Paper Trade" still pinned `e9cd909c` (untouched) |

`tests/test-gatek-stop-parity.js` executes the **actual deployed node bytes** and compares them
case-for-case against the independently-maintained clamp mirror: a 240-case parity sweep
(exercising clamped, untouched and missing-ATR legs) asserts the gate stop is byte-identical to
the stop the broker will receive, plus a 240-case sweep proving no signal can ever again be
rejected for stop width. Full gate after: **20 suites, 252 checks.**

**Deliberately NOT changed** — and asserted in the suite so it stays that way:
- the 5% sanity threshold itself (PAR-06 fails if the node so much as mentions a gate parameter)
- the fail-open path: `price <= 0` or an unmappable side still emits stop 0 → the gate SQL's
  `gate_skipped_insufficient_fields` short-circuit behaves byte-for-byte as before (PAR-07)

**Honest note on the ATR-fallback leg.** v1 emitted 0 when ATR was missing, which made the gate
skip the signal entirely; v2 emits the real clamped stop, so the gate now evaluates it. That is
strictly more correct but it *is* a behaviour change, so the blast radius was measured before
shipping, not after: `gate_skipped_insufficient_fields` = **0 rows across all 21 days**. Every
production signal carries an ATR. This closes a latent hole rather than changing live behaviour.

**This fix does not resume trading.** `negative_measured_edge` still rejects everything globally
regardless of stop width. Gate-K stop parity is a correctness fix that matters whenever trading
resumes — it is not a workaround for the halt, and was not treated as one.

## Deployed (afternoon): CONCLAVE RULING — Gate-K R3 → R1 → R2 — gov 195/196/197

**Trading has resumed on the long side.** The Conclave ruled the halt's *sign* correct but its
*permanence and confidence* the defect, and identified the real flaw: Gate-K measured edge
**blind to direction**, so 25 catastrophic shorts vetoed 17 decent longs. Shipped in the
mandated dependency order, verified live between each step.

| | n | win rate | dollar PF | realised P&L | bootstrap P(PF>1) |
|---|---|---|---|---|---|
| **LONGS** | 17 | 29.4% | **1.474** | **+$693.92** | 70.9% |
| **SHORTS** | 25 | 8.0% | **0.280** | **−$2,279.73** | 3.6% |

### R3 — measurement integrity (shipped FIRST, per the Conclave's reordering)
Migration `qtp_gatek_r3_measurement_integrity_20260807` · `GATE_K_v2.6`.
Excludes `RECERT_QUARANTINE%` lineage from the main edge calc (the short leg already filtered
lineage; the main calc did not); bounds the 90-day window on **`entry_fill_time` as well as
`exit_fill_time`**; quarantines rows with no reconstructable risk basis. Adds **dollar profit
factor**, immune to the 170× risk-basis spread ($3.60 → $623) that makes averaged R multiples
meaningless.

**It makes the number worse — which is the point.** kelly★ **−0.1102 → −0.5072**, n 42 → 40.
Live function returned exactly what `analysis/cleaned.py` predicted offline (−0.5072). A change
that deepens the halt cannot be an attempt to manufacture a resume.

Removed: LDOS (quarantined, +10.2174R) and AFL (April entry, $3.60 risk basis, no
`intended_stop`). **Deliberately kept:** 12 rows whose stored `risk_amount` differs >10% from
fill-implied risk — that is ordinary signal-to-fill slippage, and discarding them would be the
over-broad filter the Conclave explicitly forbade.

### R1 — short-side rule escalated from ×0.5 multiplier to BLOCK
Migration `qtp_gatek_r1_short_side_block_20260807` · `GATE_K_v2.7`.
Changes **only the consequence** of a rule the Conclave already ratified in v2.4 — thresholds
(n≥20 AND certified dollar PF>1.0) and release condition unchanged.

**Re-verified on the post-R3 sample before shipping, not assumed** (the Conclave's explicit
requirement). This exposed a further defect: the v2.4 short filter accepts any `RECERT_`
prefix, so the **quarantined row passed it** — that single row was $855.40 of the short book's
$887.26 gross win. R1 applies R3's cleaning, so:

| sample | n | dollar PF | sample bar | PF bar | block holds |
|---|---|---|---|---|---|
| v2.4 filter as-is | 25 | 0.2802 | met | failed | ✔ |
| **R3-cleaned (what R1 uses)** | **24** | **0.0101** | met | failed | ✔ |

Self-releasing at certified short dollar PF > 1.0 over ≥20 trades; the block lifts
automatically but **restoring size requires explicit Conclave re-arm**.

### R2 — direction-scoped edge measurement (HARD-GATED behind verified-live R1)
Migration `qtp_gatek_r2_direction_scoped_edge_20260807` · `GATE_K_v2.8` ·
functiondef md5 `625b111e0ca5ece7bf2ff80b731479bc`.
Scopes `m` to `v_direction` at the **ratified n≥20** bar (the v2.4 number, not one invented to
get an answer). R2 was applied only after R1 was confirmed live in isolation.

```
LONG  -> approved: true,  probation_sizing_insufficient_sample, risk_pct 0.50,
         n=16, dollar_pf 1.4655, sample_scope "direction:bullish"
SHORT -> approved: false, short_side_blocked_pf_below_bar, n=24, dollar_pf 0.0101
```

**Longs resume because the sample is too small to judge (n=16 < 20), NOT because an edge was
proven.** kelly★ is not used for sizing here. Nobody should read this as "the long book is
healthy."

### The failure mode the Conclave called "the single most dangerous" — sealed three ways
Direction-scoping alone would send both sides to probation (both n<40) and silently reopen the
short book. Sealed by: (1) the threshold being 20 not 40, so shorts at n=24 are *judged*, never
probationary; (2) an explicit `short_side_probation_forbidden` guard — a bearish direction can
never be approved via probation sizing; (3) R1's rule-level block firing earlier and
independently (redundancy **kept, not collapsed**, per the ruling).

**Live safety matrix**, every mutation inside a rolled-back transaction:

| scenario | result |
|---|---|
| SHORT, all flags on | `short_side_blocked_pf_below_bar` ✔ |
| SHORT, **R1 OFF** | `negative_measured_edge` ✔ (R2 holds independently) |
| SHORT, **R1 OFF + forced to probation** | `short_side_probation_forbidden` ✔ **← the dangerous mode, dead** |
| LONG, same forced-probation config | approved 0.50% ✔ |
| SHORT, **GATE_K config wiped** | still blocked ✔ (fail-closed) |
| LONG, GATE_K config wiped | approved 0.50% ✔ |

### Reversibility (Conclave: "flag-gated, reversible without republish")
`quantum.gate_config` gate_id `GATE_K`: `short_side_block_active=1`,
`direction_scoped_edge_active=1`, `direction_min_trades=20`. Revert is a **single UPDATE** — no
migration, no redeploy. Both blocks **fail closed**: a missing or unreadable row coalesces to
active, so losing the config table can never silently reopen the short book (verified by
deleting it in a rolled-back transaction).

Suite `tests/test-gatek-conclave.js` **16/16**, including three explicit BLOCKED tests for the
reopening modes and a fail-closed test. Re-runnable live verification archived at
`docs/gatek-conclave-20260807/verify-gatek.sql`. Full gate: **21 suites, 268 checks.**

### RATIFIED — the four-quadrant truth table — gov 198
The Conclave confirmed the conservative reading was the intended one and directed that the
truth table be pinned so "release metric vs. secondary" is never re-litigated by
interpretation. **No code change** — the gate function is byte-identical to the R2 deploy
(md5 `625b111e0ca5ece7bf2ff80b731479bc`); gov 198 pins semantics and coverage only.

**PF BLOCKS · kelly★ only DOWNGRADES SIZING · kelly★ NEVER VETOES.**

| # | dollar PF | kelly★ | n | outcome | live-verified |
|---|---|---|---|---|---|
| 1 | ≤ 1.0 | any | ≥20 | **BLOCK** `negative_measured_edge` | PF 0.3333, kelly −0.1250 ✔ |
| 2 | > 1.0 | < 0 | ≥20 | **APPROVE**, probation 0.50% — never kelly | PF 1.0588, kelly −2.0250 ✔ |
| 3 | > 1.0 | > 0 | <20 | **APPROVE**, probation 0.50% | PF 2.0000, n=16 ✔ |
| 4 | > 1.0 | > 0 | ≥20 | **APPROVE**, fractional kelly ← only one | PF 2.0000, kelly +0.2500 → 1.0000% ✔ |

Every row was tested against the **live plpgsql**, not just the JS mirror
(`docs/gatek-conclave-20260807/quadrant-truth-table.sql`, re-runnable, rolls back).

**Quadrant 2 is load-bearing.** kelly★ of −2.0250 did *not* veto a PF of 1.0588. Rationale:
kelly★ is corrupted by the R-comparability defect (risk bases spanning 170×), and a corrupted
estimator holding veto power is the specific failure that welded the profitable long book to
the catastrophic short book. **P0 tripwire: if quadrant 2 ever returns
`negative_measured_edge`, kelly★ has been restored to blocking authority.**

### Quadrant 5 — the cell the ruling's table does not cover (disclosed, not fixed)
`PF ≤ 1.0` with `n < 20` **still approves at probation 0.50%** — verified live at PF 0.2500,
n=10. The `n<20` check short-circuits before PF is consulted, so a direction can be losing
money and still trade at small size until it reaches 20 trades.

This is **deliberate and must not be "fixed" casually**: making PF block at any n would mean a
fresh direction whose first trade loses (PF = 0) is blocked forever — recreating the exact
self-locking deadlock this whole ruling exists to remove.

Its safety net is **not in the function**. It is the Conclave's monitored revert ("long-side
cleaned dollar PF < 1.0 over ≥15 certified trades → halt the long side"), which nothing was
computing. It is now computed in `verify-gatek.sql` §2b. **Current state: n=16, trigger ARMED
(≥15), dollar PF 1.4655 → `ok - long side may continue`.** Bounded exposure while unguarded:
at most (20 − n) trades at 0.50% risk.

Coverage: `tests/test-gatek-conclave.js` **22/22** — CK-17..CK-20 one per quadrant, CK-21 the
bootstrap corner, CK-22 a structural-ordering test proving n is consulted before PF and PF
before kelly★, including that a *positive* kelly★ cannot rescue a failing PF.

## Verification status — what is proven vs. what is not

**Proven (evidence in hand):**
- Gate-K Prep v2 deployed byte-identical to `docs/gatek-stop-parity-20260807/qet-gatek-prep-v2.js`
  (`aff5743c7d8182ba`), published; sibling "Alpaca Paper Trade" still pinned `e9cd909c` ✔
- `compute_kelly_gate` live at `GATE_K_v2.8_R2_DIRECTION_SCOPED_20260807`,
  functiondef md5 `625b111e0ca5ece7bf2ff80b731479bc` ✔
- LONG → `approved:true`, `probation_sizing_insufficient_sample`, 0.50%, n=16, PF 1.4655,
  `sample_scope: direction:bullish` — **by direct call to the live function** ✔
- SHORT → `short_side_blocked_pf_below_bar`, n=24, PF 0.0101 — verified in isolation with
  `p_regime_mode='off'` after the first attempt was blocked by the regime leg instead ✔
- Six-scenario safety matrix incl. R1-off, forced-probation, and config-wiped — all shorts
  refused, all longs approved; every mutation inside a rolled-back transaction ✔
- Suites: `test-gatek-conclave.js` 16/16, `test-gatek-stop-parity.js` 11/11; full gate
  **38/38 suites green on the PO's machine** ✔
- Pipeline healthy after all deploys: webhook executions every ~5 min, **zero errored
  executions fleet-wide today** ✔

**NOT proven — flagged rather than claimed:**
- **No real signal has reached Gate-K since either deploy.** Last audited signal was WSM
  16:50:41Z, one minute before the R3/R1/R2 package went live. Everything above is verified
  by direct function calls, not by a routed trade.
- The Gate-K stop-parity telemetry (`__qet_stop_clamped`, `__qet_stop_raw_pct`, the
  `[GATE-K STOP-PARITY v1]` log line) has not yet been observed firing in production.
- Correction to an earlier draft of this log: the market was **open** at deploy time
  (16:51Z = 12:51 ET), not closed. First live confirmation is possible this afternoon;
  otherwise Monday.

## Recommended posture: HOLD — change nothing else until there is live evidence

Gate-K has been materially rewritten today and currently has **zero live evidence** behind it.
Any further change from here confounds attribution: if something misbehaves on Monday, it will
be impossible to say cleanly whether it was R3, R1, R2, the gov 194 stop-parity fix, or
something unrelated. The highest-value thing available right now is a clean observation window.

Also worth knowing before anyone reaches for another lever: the long book is at n=16 and needs
n≥20 before the gate will even *judge* it. The next four long trades are at 0.50% probation
sizing no matter what anyone changes.

**Open question that should be settled before any further gate work:** the kelly★ co-blocking
interpretation flagged above.

## Watch list (monitoring, not changes)
The Conclave's precommitted reverts need something actually computing them:
- long-side cleaned dollar PF over the next ≥15 certified trades — drops below 1.0 → long side
  returns to halt
- long ≥3R-exit count in frozen dollar-R — must not collapse vs. baseline (the edge is
  right-tail asymmetry; a book of small scratches is a failure mode, not a success)
- any quarantined or out-of-window row reappearing in the main edge calc → re-pin and re-audit
- R2 ever observed sending a short to probation → immediate full revert
Re-run `docs/gatek-conclave-20260807/verify-gatek.sql` after any change to the gate or config.

## Book state (healthy)
4 open positions, all `FULLY_PROTECTED`, zero unprotected qty, +$600.75 unrealized:
AES −731 (−$43.86) · ALLE 64 (+$264.00) · DGX 45 (+$148.95) · XPEV −858 (+$231.66).
Ledger and broker in exact agreement — yesterday's phantom-open desync stays closed.

## Rollback pointers
| what | how |
|---|---|
| **R1 short block** | `UPDATE quantum.gate_config SET live_value=0 WHERE gate_id='GATE_K' AND constant_name='short_side_block_active'` |
| **R2 direction scoping** | same, `constant_name='direction_scoped_edge_active'` |
| **Whole Gate-K package** | restore `GATE_K_v2.5`, functiondef md5 `0303bc25e50d77aee86eee74cbce2dc0` (returns the total halt) |
| **Gate-K Prep v2** | republish n8n `10a5a6a5` (restores the uncapped 1.5×ATR stop and the false `stop_width_exceeds_sanity` rejections — not recommended) |

Flag reverts need **no migration and no redeploy**. Note both flags **fail closed** — deleting
the config rows does *not* revert anything; it leaves the short block ACTIVE. To actually
revert, set the value to 0; do not delete the row.
