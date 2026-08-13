# Why no orders executed today — 2026-08-13

**For:** PO · **Question:** *"check why no orders are executed today in QTP"*
**Answered at:** 14:36 ET, market still open · **Every number below is a live row, not an inference**

---

## The one-line answer

**Nothing is broken.** One order *did* execute today. Zero *entries* is the filter stack
doing exactly what it is configured to do — 66 signals arrived, all 66 were declined by a
named, working rule.

## 1. The day, end to end

| | |
|---|---|
| signals ingested (14:36 ET) | **66** across 25 symbols |
| distinct symbols reaching the audit stage | **24 of 25** |
| **entries opened** | **0** |
| **exits filled** | **1 — ALLE** |
| open positions | 6 (AES, XPEV, DGX, ZBRA, WMB, WMT) |
| pipeline errors today | **0** |

**The order that did execute:** ALLE, long 64 shares, entered 08-05 09:36, **exited today
10:30 ET on the trailing stop at −$104.32 (−0.21R)**. The trail worked; the trade was a loser.
That is why the book went 7 → 6.

## 2. Every rejection, by name

The 26 audit rows for today (one per symbol-direction that reached the gate stack):

| kill stage | n | symbols |
|---|---|---|
| REGIME_CONFLICT_CONTRA_BOTH | 8 | ABBV, ACN, AJG, AMD, AME, ASML, ZBH |
| BROAD_SCANNER_BIAS_PATH | 4 | ALB, ALLE, AMAT, XPEV |
| MTF_CONFLUENCE | 3 | ALB, APP, YUM |
| AI_CONFLICT | 3 | WSM, WY, ZBRA |
| BIAS_FILTER | 3 | ADSK, WTW, ZETA |
| NONE (already held, correct skip) | 2 | WMB, WMT |
| TICKER_BLOCKLIST | 2 | ABNB, ADBE |
| GATE_K (`short_side_blocked_pf_below_bar`) | 1 | AOS |

66 signals → 26 audits is **intra-day repeat suppression**, not loss: ALB alone fired 9 times,
ADSK 7, ALLE 6, AMD 6, WTW 6, YUM 6. Same name, same day, one decision.

**Worth naming:** `MTF_CONFLUENCE` killed 3 candidates today on a score that has been
**constant zero since June** (gov-212 finding). That filter is not filtering — it is rejecting
at random.

## 3. The one signal that vanished — traced and explained

ARM signalled at 14:05 and 14:35 ET at confidence 100 (4.0% gap) and has **no audit row**. I
pulled the n8n execution. It was killed upstream of the audit write:

```
_sm_route: "SKIP"
_sm_kill_stage_attribution: "Extreme volatility: ATR 8.2% of price (> 8% — untradeable)"
```

**The kill is correct** — an 8.2%-of-price ATR is genuinely untradeable at this sizing. But it
fires at the Signal State Machine, *before* `quantum.exec_flow_audit` is written, so it is
**invisible in the audit table**. That is an observability gap, not a trading defect.

Scope check: over the last 10 sessions this pre-audit kill hid 1 symbol today, 1 on 08-07 and
4 on 08-03 — rare, so the audit table's kill counts are close to complete but not exact.

## 4. Stack health — green

| check | result |
|---|---|
| Broad Scanner | **62 runs** since 09:30 ET, every 5 min, **all success**, latest 14:35 |
| main pipeline (`vaqfCaELhOEWnkdo`) | receiving webhooks continuously, **0 errors / crashes today** |
| kill switch | **not tripped** |
| `entry_pause_control` | **NOMINAL** — `pause_new_entries=false`, `trading_blocked=false` |
| dead letters | **0** |
| unprotected positions | **0** (the gov-211 GTC stops are holding) |

## 5. A real defect found — `signal_ts` is exactly 4 hours wrong

| | |
|---|---|
| rows checked (7 days) | **562** |
| offset `ingested_at − signal_ts` | avg **4.0003 h**, min 4.0001, max 4.0006 |
| rows exactly 4 h off | **562 / 562** |

The scanner writes the **ET wall clock into a UTC column**. Live example right now:
`ingested_at` = 14:35:13 ET, `signal_ts` = 10:35:12 ET.

**Correction to something I said earlier:** I read the last `signal_ts` as 10:25 and called it
a four-hour signal outage. That was wrong — signals were flowing normally the whole time. The
outage was in the column, not the feed.

Blast radius: anything reading `signal_ts` as a real time — latency dashboards, session-window
logic, time-of-day analysis — is off by four hours. The gov-212 scorer used `signal_date`
(date only), so its verdict is unaffected except possibly at a day boundary. **Not fixed — no
production change without your word.**

## 6. The money question you actually care about

Realized P&L by session (paper), last 21 days:

| date | exits | realized |
|---|---|---|
| **08-13** | 1 | **−104.32** |
| 08-12 | 1 | −168.97 |
| 08-11 | 2 | −229.26 |
| 08-10 | 1 | −107.94 |
| 08-06 | 4 | −449.96 |
| 08-05 | 1 | −112.98 |
| 08-04 | 3 | +36.15 |
| 08-03 | 4 | −262.67 |
| 07-31 | 3 | −151.45 |
| 07-30 | 3 | −472.42 |
| 07-29 | 3 | +351.90 |
| 07-28 | 3 | +405.34 |
| 07-27 | 1 | −97.00 |
| 07-24 | 6 | +353.63 |

**21-day total: −$1,009.95.** Seven consecutive sessions with an exit have all been losses. The
book peaked at +$1,014 on 07-29 and has given back **≈$2,024** since.

## 7. What today actually is

Today is the gov-212 verdict playing out live. The scorer measured a **99.5% rejection rate**
and showed the survivors were *worse at 5 days* than the candidates thrown away. A day with 66
signals and 0 entries is not a malfunction — **it is that funnel running normally.**

So the honest framing: today's zero costs nothing. What costs money is the six positions still
open, exiting one at a time into a signal that gov 212 measured as a coin flip.

## 8. Open decisions (unchanged — nothing was touched today)

1. **The §6 fork in `SIGNAL-SOURCE-TRUTH-20260813.md`** — was the Broad Scanner meant to
   *replace* the Pine strategy or *reimplement* it? Every consumer fix waits on that.
2. **Score the Pine strategy** — you chose this as the next action. Route 1 (TradingView-side)
   needs you at your desk. Nothing else blocks it.
3. **Fix or disable `MTF_CONFLUENCE`** — it killed 3 real candidates today on a constant.
4. **`signal_ts` timezone fix** — one-line, but it touches the production scanner.
