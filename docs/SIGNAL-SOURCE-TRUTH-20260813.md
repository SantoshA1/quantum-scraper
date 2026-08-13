# The TradingView webhooks were decommissioned. The downstream consumers were never told.
**Date:** 2026-08-13 · **For:** PO · **Triggered by:** "zero tickers executed" → "TradingView webhooks are decommissioned"
**Status:** diagnosis complete. **No changes made.** The fix depends on one question only you can answer (§6).

> **Correction, 2026-08-13:** an earlier version of this document framed the TradingView
> disconnection as an accident ("the alert was never created or was deleted"). **That was wrong.**
> The PO decommissioned the TradingView webhook path deliberately. The finding below is not
> "you forgot to wire something" — it is that **the migration was completed at the source and
> never completed at the consumers.** Everything downstream still gates on fields the new
> source does not send.

---

## 1. What is actually generating trades

TradingView alerts: **`alert_count = 0`** (verified against TradingView's internal API on your
Mac) — consistent with the decommissioning.

The live source is n8n workflow `975pZZEtxeUbzI22`, **"Broad Scanner (Real-Time Agent)"**,
active, firing every 5 minutes, posting to `/webhook/tradingview-signal` (an n8n endpoint whose
*name* is now a historical artifact). Incoming header: `user-agent: n8n`,
`signal_source: "server_side"`.

Its entire decision logic:

```js
if (changePct <= -0.7 && volRatio >= 0.25) signal = 'SELL';
else if (changePct >= 0.7 && volRatio >= 0.25 && vix < 30) signal = 'BUY';
else if (volRatio >= 1.8 && changePct < -0.8) signal = 'SELL';
```

Percent change from yesterday's close plus a volume ratio, on Alpaca IEX snapshots. And the
score every ledger row carries:

```js
const conf = Math.min(100, Math.round(Math.abs(changePct) * 25 + volRatio * 15));
// copied verbatim into bias_score, score, raw_score, composite_score AND ai_super_score
```

That is a coherent, defensible momentum screener. **As a design choice it is fine.** The
problem is what sits downstream of it.

## 2. The actual defect: an incomplete migration

The new source emits every technical field as the literal string `'N/A'`:

```js
adx: 'N/A', rsi: 'N/A', macd_hist: 'N/A', tv_recommendation: 'N/A',
sma50: 'N/A', ema200: 'N/A', sma200: 'N/A', bb_upper: 'N/A', bb_lower: 'N/A',
stoch_k: 'N/A', stoch_d: 'N/A', cci: 'N/A', momentum: 'N/A', pivot_classic: 'N/A', psar: 'N/A',
```

`'N/A'` coerces to `0` downstream. **But the consumers were built for the old TradingView payload
and still enforce rules against those fields.** Live consequences, all measured:

| consumer | what it does now | evidence |
|---|---|---|
| **ADX > 20 gate** | Can **never** pass. Every signal is capped at 8/9 confidence by a field that is structurally 0. | 100% of signals since 2026-06-08 read `Cap 8 (9/10 gate failed: ADX 0 ≤ 20…)` |
| **MTF_CONFLUENCE** | Rejects candidates on a score that is **always 0**. | **913+ kills since June**, 2 today (YUM, ALB) |
| **`ai_super_score`** | Name now means `\|gap%\|×25 + volRatio×15`. Anything reading it as an AI score reads a misnomer. | scanner source, line ~595 |
| **Backtest enforcement** | Cache newest run `2026-05-27` = **78 days stale** vs a 60-day limit → every signal ships `NO_BACKTEST_DATA`. | `quantum.backtest_symbol_metrics_latest` |
| **PF filter meant to catch that** | **Dead code.** Comment says block when `PF < 1.0`; code says `if (_pf !== null && _pf < 0.0)`. Cannot fire. | scanner source |

Timeline confirms the cutover, not a fault: max ADX in payload was **74–83 through May**, **25**
in the week of 2026-06-01, **0.00 every week since 06-08**. Payload stamp:
`QTP_GO_LIVE_SERVER_SIDE_PAYLOAD_v5.5_20260516`.

**One thing to reconcile:** the scanner's payload advertises
`shadow_parity_promoted: true`, `shadow_parity_mode: "PROMOTED_TO_PRODUCTION_PAPER_GATED"` and
`shadow_modules: ['super_score_pro_v25','ensemble_engine_v1','webhook_bridge_v8','quantum_scalp_v5']`
— but the workflow implements none of those modules; they are static strings. If "promotion"
was meant to mean the server side had *reimplemented* those modules, that did not happen. If it
was only a provenance label, it is harmless but misleading. **Which of those two you intended is
the question in §6.**

## 3. Three further live defects in the scanner

1. **Universe rotation** — 624 tickers, `SCANNER_BATCH_SIZE = 600`, rotating offset → cycles
   alternate **600 names, then 24**. Half of all scans cover 4% of the universe.
2. **SPY/QQQ/XLY are not in the watchlist**, so `spy_change` and `qqq_change` are permanently
   `0` and **`vix` is a hardcoded constant 24** — every market-context field is inert, including
   the `vix < 30` term inside the BUY rule.
3. **IEX-only volume** (~2–3% of the tape), so `volume_ratio` — half the signal — is an
   IEX-internal ratio, not true relative volume.

## 4. What this does to yesterday's KILL verdict: it strengthens it

Yesterday's scorer measured 8,289 live signals and found no detectable edge. An hour ago I
suggested that might be excusable because "the real strategy wasn't connected." **With the
decommissioning confirmed as intentional, that excuse is gone.**

The Broad Scanner *is* the production system by design. So yesterday's verdict measured exactly
what you intended to be running, over 78 trading days, with controls proving the instrument
works (oracle t = 26.9, random t = −0.69). **KILL stands, and it now applies to the current
architecture rather than to an accident.**

The one caveat worth keeping: the Pine strategies (AI Super Score Pro v2.5 — 611 lines, real
ADX/RSI/MACD, structural gates, composite scoring) are fully built and now shelved. They have
never been measured. That is not an argument that they work; it is an argument that **you own an
untested asset and a tested instrument to test it with.**

## 5. Nothing is broken operationally

Zero executions today is correct behaviour: 2 duplicate-position skips (WMB, WMT), 3 AI_CONFLICT,
3 REGIME_CONFLICT, 2 MTF_CONFLUENCE, 1 Gate-K short block. Stack is green — TSM heartbeat live,
0 error statuses, 0 r_multiple violations, Gate-K v2.9 correct, and the GTC stops from Tuesday
survived their first overnight.

## 6. The one question that determines the fix

**Was the Broad Scanner meant to *replace* the strategy, or to *reimplement* it server-side?**

- **If replace** (it is your strategy now): the fix is to finish the migration — strip or repair
  the consumers still gating on dead fields. Concretely: retire the ADX > 20 criterion, disable
  or rebuild MTF_CONFLUENCE (it is rejecting real candidates on a constant), rename
  `ai_super_score` to what it is, repair the dead PF filter, refresh or disable the stale
  backtest gate, and fix the 600/24 rotation. Roughly half a day, all mechanical, all verifiable.

- **If reimplement**: it was not done. ADX, RSI, MACD, the moving-average stack and the
  structural gates are all absent. That is a substantial build, and — given yesterday's verdict —
  I would score the Pine strategy offline **before** building it.

**My recommendation either way: score the Pine strategy first.** Export AI Super Score v2.5's
historical signals from TradingView and run them through the scorer built yesterday. One day,
no production change, no risk — and it answers whether the shelved asset is worth reconnecting
before you spend a week reconnecting it. That is exactly the sequence the last four months were
missing.
