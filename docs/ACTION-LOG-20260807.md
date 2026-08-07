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

## Verification status
- Deployed jsCode byte-identical to `docs/gatek-stop-parity-20260807/qet-gatek-prep-v2.js` ✔
- Published, pipeline running clean post-deploy (4 webhook executions 15:55Z, zero errors) ✔
- Zero errored n8n executions across the fleet today ✔
- **Not yet observed:** a real signal reaching Gate-K *since* the publish — only ~3/day get
  past VC/bias/MTF/AI. Live telemetry (`__qet_stop_clamped`, `__qet_stop_raw_pct`, and the
  `[GATE-K STOP-PARITY v1]` log line) confirms on the next qualifying signal. Flagged as
  pending rather than claimed.

## Book state (healthy)
4 open positions, all `FULLY_PROTECTED`, zero unprotected qty, +$600.75 unrealized:
AES −731 (−$43.86) · ALLE 64 (+$264.00) · DGX 45 (+$148.95) · XPEV −858 (+$231.66).
Ledger and broker in exact agreement — yesterday's phantom-open desync stays closed.

## Rollback pointers
Gate-K Prep: republish `10a5a6a5` (restores the uncapped 1.5×ATR stop and the
`stop_width_exceeds_sanity` false rejections — not recommended). The gate function
`public.compute_kelly_gate` was **not** modified today; the halt is data-driven, so rolling
back any workflow will not lift it.
