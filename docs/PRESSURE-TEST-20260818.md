# gov 225 — Pressure test, two live fixes, and the honest distance to real money

**Date:** 2026-08-18, ~12:25 ET · **Deployed:** reconcile cron `17d7404c` (gov 225a), AFTO
telegram escape `38268709` (gov 225b) · **Data changes:** none
**Fleet:** 30+ active workflows, 24h sweep: **one** failed execution (the Telegram bug, now
fixed), zero crashes, zero schedule gaps on the critical five, Sentinel 12/12 OK.

---

## 1 · How QTP is doing today

**gov 224 is verified live.** By 12:20 ET the scanner had swept A → P:

| | distinct symbols | first letters |
|---|---|---|
| yesterday (pre-fix) | 35 | 2 — {A, B} |
| **today by 11:45** | **84** | **13 — A…N** |

And the funnel converted immediately — three fills plus one honest cancel in the first
25 minutes of scanning, all first-time mid-alphabet names:

| time | symbol | result |
|---|---|---|
| 09:32 | AES (old short) | stopped, **−$87.72** — clean exit at stop |
| 09:45:57 | **DASH** BUY 48 @ 219.91 | open |
| 09:46:03 | **DDOG** BUY 42 @ 251.22 | stopped 10:10:52, **−$104.12**, clean exit |
| 09:55:45 | ECL BUY | limit 281.91 (0.30% cap) unfilled in 12s → **cancelled, no position** |
| 09:55:55 | **DUK** BUY 84 @ 125.66 | open |

Book now: DASH, DUK, DGX, WMT, WMB long + XPEV short = 6 open. Realized today −$191.84.

Three stop exits in two sessions (ADPT, AES, DDOG) all executed *at* the stop, no
gap-throughs — the risk mechanics that carried 59% of historical losses are, on current
evidence, holding intraday.

**Why nothing has entered since 09:56:** regime flipped to `RISK_OFF` at 10:00 ET and Gate-K
enforces counter-regime on longs (`counter_regime_bullish_in_downtrend` — MNST, MTCH, MSI…).
Shorts are halted by gov 219. So QTP is entry-frozen **by deliberate filters**, not by a
defect. That is the system working.

**Gate-K margin after DDOG:** bullish sample n=23, gross win $2,145.27 vs gross loss
$1,950.11 → **dollar PF 1.1001**. Headroom before `negative_measured_edge` shuts longs off
again: **$195.16** of gross loss — roughly two more DDOG-sized stops.

## 2 · What the pressure test found (and what was fixed live)

### Fixed today

**Ghost positions were eating entry slots (gov 225a).** Gate-K's `concurrent_open` counts
the latest `position_risk_state` row per symbol within 2h. Nothing wrote a zero row on close,
so this morning's two stop-outs haunted the count: AES + DDOG ghosts held it at **8 = cap**
and rejected **nine** first-ever quality longs (FIS, FISV, GEHC, GILD, GTLB, JNJ, KMI, KO,
LC, LLY, MAR) between 10:20 and 11:21 with `EXPANSION_CONCURRENT_CAP` — while true exposure
was 6. The reconcile workflow that writes `CLOSED_NO_POSITION` zero rows existed all along
but its cron was authored in UTC on an ET instance: it **never ran 09:30–13:00 ET, any day**.
One expression fix (`*/15 13-21` → `*/15 9-16`). Verified end to end: fired 12:15:00 ET,
wrote `AES qty=0` and `DDOG qty=0`, `concurrent_open` now reads a truthful 6. Ghost lifetime
falls from 2h to ≤15 min.

**Pause advisories never reached you (gov 225b).** Every AFTO pause advisory died with
Telegram 400 `can't parse entities` — the text contains `pause_advisory:` and the node
defaults to Markdown, so the underscore at byte 36 kills it (proven executions 592165,
577947). The DB writes succeeded; only the human alert vanished. The text expression now
escapes `_ * ` [`. **You have not been receiving pause alerts; now you will.**

### Found, logged, not yet fixed

1. **A cancelled order burned a daily-cap slot.** `exec_today` counts `audit_status='EXECUTED'`
   audit rows; ECL's cancelled entry counts as one of 4/5 despite zero fill. The audit label
   `EXECUTED` for a `SKIPPED_NO_FILL_WITHIN_CAP` order is the same lie in a second place.
   Fix: count fills (ledger) or exclude skip statuses. Small, needs the usual discipline.
2. **Five active workflows are MCP-blocked** (Risk State Monitor, SSM Watchdog, WRO Monitor,
   Backtest Audit API, Shadow Logger) — unauditable from here. One of them writes
   `position_risk_state`. Enable MCP on the workflow cards.
3. **Strat-cache synthetic defaults are now trading.** The 85 tickers added 07-22 carry
   fabricated `sample=150, pf=1.45` backtest metrics into live decisions; today's D/E-name
   fills are in that risk set. The backfill is still the highest-value data-integrity job.
4. Sentinel's `scanner_universe_coverage` needs a distinct-symbol floor (it stayed green
   through yesterday's 35-symbol famine; today reads 74/622 and climbing).
5. Carried: `signal_ts` ET-as-UTC (+4h, sentinel-tracked), `scraped_at` NULL, Polygon key in
   signal payload (needs your word), `vc_paper_secondary_bar` config row wired to nothing,
   volume_ratio>1.25 as the sole live long-quality gate, stale scanner node notes, dead
   `EXPANSION_SELL_CAP` branch (`'sell' ≠ 'SELL'`).

## 3 · Distance to real money — the honest gates

Alpaca live trading is a config change (`ALPACA_BASE_URL` + real keys). That is not the
distance. The distance is evidence:

| gate | requirement | where QTP is today |
|---|---|---|
| **G1 Edge, measured** | full-universe bullish sample **n ≥ 60**, dollar PF **≥ 1.3** sustained over 20+ sessions, positive expectancy after slippage | n=23, PF **1.10**, buffer $195; the first honest full-universe session is **today** |
| **G2 Data integrity** | no fabricated inputs in live decisions | 85 tickers on synthetic backtest defaults; signal_ts defect; cancelled orders counted as executions |
| **G3 Risk mechanics** | stops hold; overnight-gap exposure measured and bounded; shorts stay off until earned back (PF>1.0 over ≥20) | intraday stops 3/3 clean since Friday; **overnight gap unmeasured** (authorized, not built); shorts correctly dead |
| **G4 Ops** | every monitor auditable, alerts deliverable, kill-switch drilled | ghosts fixed, reconcile RTH, telegram fixed today; 5 workflows unauditable; kill-switch never live-drilled |
| **G5 Go-live protocol** | written sizing ladder, daily loss cap, halt runbook, capital tranche plan | does not exist |

**Verdict: 4–6 weeks minimum, and only if the edge shows.** The gating item is G1 and it
cannot be accelerated by code — at the current entry rate the sample needs weeks to reach
n≥60. If the diverse-universe PF settles ≥1.2–1.3, transition a small tranche ($5–10k) at
0.25–0.50% risk with a hard daily stop. If PF stays ≤1.1, the honest answer is that QTP has
no edge yet and the machine is correctly refusing to bet — putting real money behind a 1.10
PF with a $195 buffer is a coin flip with fees.

## 4 · On "better than Citadel and Renaissance"

Medallion's legendary run is ~66% gross a year. The 5%/month target is ~80% a year —
**above the best fund in recorded history**, which runs thousands of researchers on decades
of proprietary data. I won't pretend a 622-ticker momentum scanner beats that, and you should
distrust anyone who does.

What is actually stealable from those firms is not their alpha — it's their discipline, and
QTP now has the skeleton of it: an honest kill ledger (gov 217), an honest universe (218/224),
losers cut dead (219), edge measured before sizing (Gate-K), fabricated data quarantined
(222), and every fix pinned by a suite that executes the deployed bytes (80+94 checks green).
The realistic ladder: **prove PF > 1.2 on honest data → live small → compound → then raise
the target.** Rung one is in progress as of 09:45 this morning.

## 5 · Next moves, ranked

1. **Touch nothing for two weeks; let the honest sample accumulate.** Every gate change now
   contaminates the first clean measurement QTP has ever run. Watch: distinct symbols/day
   (expect 200+ by Friday as the cursor completes sweeps), fills/day, PF trajectory.
2. **Backfill real backtest metrics for the 85 tickers** (removes fabricated inputs from live
   trades — G2's biggest item).
3. **Fix `exec_today` to count fills, not submissions**, and stop labelling cancels `EXECUTED`.
4. **Build the two authorized measurements:** REGIME_CONFLICT shadow scorer (23 shadow rows
   today alone — the data is pouring in) and overnight-gap exposure.
5. **Sentinel distinct-symbol floor**; MCP access for the 5 blocked workflows; then a
   kill-switch live drill.
6. Then, evidence in hand: the volume_ratio/vc-bar question, `&feed=iex`, and the go-live
   protocol document.
