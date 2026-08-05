# CONCLAVE BRIEF — Kelly Activation at n=40
**Date:** 2026-08-05 · **Author:** claude-architect (PO-requested) · **Status:** DECISION REQUIRED
**Decision due:** before `qtp-main-pipeline` closes its 40th qualifying trade — **n = 37 today, closing ~2/day → ETA 1–2 sessions.**

---

## The question

When `qtp-main-pipeline` reaches 40 closed trades with `r_multiple`, `public.compute_kelly_gate`
(GATE_K v2.3) automatically exits probation and sizes every new entry from measured edge:

```
k* = (wins/n)/avg_loss_r − (1 − wins/n)/avg_win_r
risk_pct = min(0.25 × k* × 100, gate1_cap = 1.0%)
```

**Do we let it?** The default — no decision — is that trade #40 makes the decision for us.

## What happens by default at n=40

Current sample (90d lookback, the gate's own metric): n=37, win rate **0.19**, avg win **3.01R**, avg loss **0.51R**.

```
k* = 0.19/0.51 − 0.81/3.01 = 0.3725 − 0.2691 = +0.1034
risk_pct = min(0.25 × 10.34, 1.0) = 1.00%
```

**Per-trade risk doubles from 0.50% → 1.00% on autopilot** — from ~$535 to ~$1,070 at current equity.

## Why the Conclave should not let the default stand: the loss column is not real

### E1 — The sample's exit labels come almost entirely from writers we have already convicted

| Lineage of the 37 | n | Share | Trustworthiness |
|---|---|---|---|
| `backfill_symbol_time_v1` (H5-class heal/backfill) | 22 | 59% | Hard-codes `'stop'`/`'time'` — the writer behind the AKAM winner-as-'stop' label that made K3 wrongly block on 08-04 |
| `(null)` — unknown writer | 11 | 30% | No provenance at all |
| `H4_GAP_REPAIR_20260804` (classifyExitReason, v2) | 3 | 8% | The only labels produced by the certified attribution path |
| manual orphan reconcile | 1 | 3% | — |

**92% of the sample Kelly would trust was written by uncertified or unknown writers.**

### E2 — The loss distribution is physically impossible under the system's own stop discipline

30 losses in the sample. Stops are placed at ~1R by construction, so real losses must cluster near −1R.

| Bucket | n | Expected under honest 1R stops |
|---|---|---|
| loss < 0.5R | **22** | rare (early time-exits only) |
| loss in [0.9R, 1.1R] — where stops actually fire | **0** | **the mode** |
| loss > 1.5R | 4 | rare (gap-throughs) |

An empty −1R bucket in a stop-based book is not a market outcome; it is measurement failure.
The headline `avg_loss_r = 0.51` is an artifact of this distribution.

### E3 — Label pollution is present inside this exact sample

- **3 winners wearing `'stop'` labels** (max +2.05R) — a real stop exit cannot be +2R. Same class as AKAM (+$555 "stop") that K3 v2.1 wrongly punished.
- 25 of 37 rows are labeled `'stop'` yet average **−0.13R to −0.27R** — stops that barely lose are relabeled somethings, not stops.

### E4 — The corruption doesn't just missize; it flips the verdict

Recompute k* holding everything constant except an honest loss assumption (avg loss ≈ 1.0R):

```
k*(reported losses, 0.51R) = +0.103  →  risk_pct 1.00% (cap) — "double the risk"
k*(honest losses, ~1.0R)  = 0.19/1.0 − 0.81/3.01 = −0.079 → NEGATIVE EDGE
                            → gate returns negative_measured_edge — "reject every trade"
```

**The same 37 trades support "double per-trade risk" or "halt the strategy" depending entirely
on whether the loss column is believed.** A number that unstable must not size money unattended.
(Note the gate's fail-safes still stand either way: Gate-1 caps at 1.0%, drawdown de-lever and
12% halt unchanged. The dispute is about letting a corrupted estimator steer within that cap.)

### E5 — The blend hides a side asymmetry (→ agenda item 2)

Within the same 37: **longs 14 trades, +$1,010 · shorts 23 trades, −$2,033.** Kelly computes one
risk number for a strategy whose majority side is its losing side. Platform-wide today:
sells 1-for-22, PF 0.01; score-9 sells −$2,218 vs score-9 buys +$1,029.

---

## Options

**A — Certify, then engage (RECOMMENDED).**
Pin probation now; fix the measurement; let Kelly engage only on certified data.
1. H5 heal adopts `classifyExitReason` (already written & suite-pinned in `docs/h4-build-exit-updates-v2.js`; H4 live since 08-04 — this closes the last uncertified writer).
2. Backfill relabel the 90d window + recompute `r_multiple` from actual entry/stop/exit fills; stamp `lineage_source` on every row.
3. Acceptance gate to unpin: −1R bucket is the loss mode; zero winners labeled `'stop'`; ≥90% of sample carries certified lineage. Then Kelly engages on whatever the honest numbers say — including `negative_measured_edge` if that's the verdict.
- Cost: probation (0.50%) persists days-to-weeks. Risk: none new — this is today's behavior.

**B — Pin probation indefinitely (min_trades bump only).**
One-parameter change (`p_min_trades` 40 → 200 or ∞). Buys time without fixing anything.
- Risk: the measurement debt compounds; every downstream learner (G17 slippage model, weekly edge report) keeps consuming the same corrupted column.

**C — Let it engage at the cap.**
Accept 1.00% sizing; treat Gate-1 + drawdown ladder as sufficient guardrails.
- Risk: doubles risk precisely when honest math plausibly says the edge is **negative**; institutionalizes trust in a loss column with an empty −1R bucket. Not defensible to Maya.

## Agenda item 2 — side-asymmetric sizing (decide in the same session)

Evidence above (E5). Options: (i) half-size bearish entries until rolling short-side PF > 1.0 over ≥20 trades; (ii) K1-style hard block on shorts outside RISK_OFF; (iii) status quo (K1 v2.3 already blocks counter-regime shorts in RISK_ON/RISK_OFF — CHOP shorts still size fully).
Recommendation: **(i)**, implemented as a Gate-K multiplier so it is governed, visible in verdict JSON, and reversible.

## If no decision is reached

Trade #40 closes (ETA 1–2 sessions), probation ends, per-trade risk doubles on data this brief
documents as unfit. That outcome should be chosen, not defaulted into.

---

## Appendix — reproduction queries (qtp_prod, run 2026-08-05 ~19:00 UTC)

```sql
-- The sample the gate will use (mirrors compute_kelly_gate's own SELECT)
SELECT count(*) n, count(*) FILTER (WHERE net_pnl>0)::numeric/count(*) win_rate,
       avg(r_multiple) FILTER (WHERE r_multiple>0) avg_win_r,
       abs(avg(r_multiple) FILTER (WHERE r_multiple<=0)) avg_loss_r
FROM public.trade_ledger
WHERE mode='paper' AND status='closed' AND r_multiple IS NOT NULL
  AND strategy='qtp-main-pipeline' AND exit_fill_time >= now()-interval '90 days';

-- Provenance × label × outcome (E1/E3)
SELECT exit_reason, coalesce(lineage_source,'(null)') lineage, count(*) n,
       count(*) FILTER (WHERE net_pnl>0) wins, round(avg(r_multiple),2) avg_r
FROM public.trade_ledger
WHERE mode='paper' AND status='closed' AND r_multiple IS NOT NULL
  AND strategy='qtp-main-pipeline' AND exit_fill_time >= now()-interval '90 days'
GROUP BY 1,2 ORDER BY n DESC;

-- Loss distribution (E2): the empty −1R bucket
SELECT count(*) FILTER (WHERE r_multiple<=0 AND r_multiple>-0.5)  under_half_r,
       count(*) FILTER (WHERE r_multiple<=-0.9 AND r_multiple>=-1.1) near_1r,
       count(*) FILTER (WHERE r_multiple<-1.5) worse_than_1_5r
FROM public.trade_ledger
WHERE mode='paper' AND status='closed' AND r_multiple IS NOT NULL
  AND strategy='qtp-main-pipeline' AND exit_fill_time >= now()-interval '90 days';
```

**Cross-references:** K3 v2.2 (winner-as-'stop' evidence, governance 176–177) · H4 v2 exit resolution
(governance 173) · K1 v2.3 (governance 178) · scanner v3.5/v3.6 (governance 179–180) ·
`tests/test-k3-cooldown.js` CD-04/05 (label fragility, live receipts).
