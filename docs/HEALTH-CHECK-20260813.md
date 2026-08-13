# QTP health check, 2026-08-13 10:00 ET — the stack is up, and a 10-week-old dead input surfaced
**For:** PO · **Trigger:** "zero tickers executed so far" · **Every line verified from live rows**

---

## 1. Zero executions is the system working, not broken

11 signals arrived between 09:30 and 09:46 ET. Every one has a named, legitimate disposition:

| ET | symbol | side | outcome |
|---|---|---|---|
| 09:30:48 | WMB | BUY | **SKIPPED** — already held, same direction (bought yesterday) |
| 09:30:51 | WSM | SELL | AI_CONFLICT |
| 09:30:53 | WMT | BUY | **SKIPPED** — already held, same direction |
| 09:30:53 | WY | SELL | AI_CONFLICT |
| 09:35:33 | AJG | BUY | REGIME_CONFLICT_CONTRA_BOTH |
| 09:35:34 | AME | BUY | REGIME_CONFLICT_CONTRA_BOTH |
| 09:35:49 | AOS | SELL | **GATE_K** — `short_side_blocked_pf_below_bar` (short halt, correct) |
| 09:40:46 | ZBRA | SELL | AI_CONFLICT |
| 09:40:46 | YUM | BUY | MTF_CONFLUENCE |
| 09:45:36 | ABBV | BUY | REGIME_CONFLICT_CONTRA_BOTH |
| 09:45:46 | ALB | BUY | MTF_CONFLUENCE |

Note WMB and WMT: the pipeline re-signalled the two names bought yesterday and correctly
declined to double up. Nothing errored, nothing hung.

## 2. Stack health — all green

| check | result |
|---|---|
| TSM heartbeat | **10:00 ET**, `feed_shadow 7/7 understates, maxT1delta 0.43pp, clampFlips none` |
| **GTC stops from last night** | **ALIVE — re-armed 04:00 ET** (WMB 72.81, WMT 113.79). The gov 211 P0 fix survived its first overnight. |
| error statuses (24h) | **0** — no ERROR_FILL_STATE_UNKNOWN, no CANCEL_FAILED, no BLOCKED |
| r_multiple violations | **0** |
| Gate-K live | `GATE_K_v2.9_K3_EXTENDED_20260812`, flags 120/1/1 |
| open positions | 7 |
| pipeline latency | signal → audit within ~1s; last audit 09:45:46 |

## 3. NEW DEFECT — ADX and MTF have been exactly zero for ten weeks

Parsed from the raw TradingView payload in `quantum.strategy_signals`:

| week | signals | max ADX | max MTF_Bull |
|---|---|---|---|
| 2026-04-20 | 3,794 | **74.10** | 4.00 |
| 2026-05-11 | 4,747 | **83.60** | 4.00 |
| 2026-05-25 | 675 | **80.30** | 4.00 |
| **2026-06-01** | 175 | **25.00** ← degrading | 0.00 |
| **2026-06-08 → 08-13** | ~4,700 | **0.00** | **0.00** |

**Both fields died in the week of 2026-06-01 and have been 100% zero ever since** — verified in
the source payload, so this is upstream of QTP, at the TradingView alert. Today's ALB signal
arrives literally as `{"ADX": 0, "MTF_Bull": 0, "MTF_Bear": 0, ...}`.

Two live consequences:

1. **Every signal permanently fails the "ADX > 20" criterion.** That is why all 11 today read
   `Cap 8 (9/10 gate failed: ADX 0 ≤ 20, ...)` — confidence is capped by a dead field.
2. **MTF_CONFLUENCE rejects candidates using a score that is always 0.** It has killed 913+
   candidates since June, including 2 today. A filter running on a constant is not filtering.

## 4. I tested the hopeful explanation. It failed. Reporting that plainly.

The obvious hypothesis: *maybe the strategy worked before the indicators broke.* If true, that
would materially soften yesterday's KILL verdict. Two tests:

**Era split** (scorer sample straddles the break):

| era | days | signals | 1d | 3d | 5d |
|---|---|---|---|---|---|
| indicators ALIVE (pre 06-01) | 28 | 4,161 | +0.196% (t 1.03) | +0.392% (t 0.82) | +0.422% (t 0.83) |
| indicators DEAD (post 06-01) | 50 | 4,128 | +0.040% (t 0.62) | +0.044% (t 0.28) | −0.127% (t −0.73) |

Directionally suggestive — 5–9× larger, positive at every horizon — **but nothing clears t = 2,
so this proves nothing.** 28 day-clusters cannot confirm an edge.

**The decisive test — does a LIVE ADX carry signal?** Within the pre-break era, comparing
signals whose ADX was actually populated against those already reading zero:

| bucket | signals | 1d | 3d | 5d |
|---|---|---|---|---|
| **ADX ≥ 20 (trend confirmed)** | 205 | **−0.454%** (t −0.71) | +0.484% (t 0.31) | +0.335% (t 0.15) |
| ADX = 0 (already dead) | 4,105 | +0.042% (t 0.60) | −0.060% (t −0.44) | −0.073% (t −0.45) |

**Signals with a working ADX did not outperform — they were negative at 1 day.** The pre-break
era's better numbers were carried by the 4,105 ADX-zero signals inside it, not by the 205 with a
live indicator. So the era difference is most likely market regime (April–May vs June–August),
not indicator health.

**Yesterday's KILL verdict stands, and is if anything strengthened.** Fixing ADX would restore a
field the evidence says was not carrying predictive weight even when it worked.

**One thing I retract:** I initially flagged the RSI values as fabricated after comparing them
to daily RSI-14 (WSM claimed 100 vs real 71.6). The payload shows `Timeframe: "5"` — it is a
5-minute RSI, so the daily comparison was invalid. RSI has spanned 0–100 since April, unchanged
across the break. Not a defect. Withdrawn.

## 5. What I recommend

1. **Nothing is broken operationally. No action needed today.** The zero is the filters and the
   duplicate-position guard doing their jobs.
2. **The ADX/MTF break is real, dated, and fixable at the TradingView alert** — but fix it only
   if you decide to continue, and do not mistake it for a fix to the strategy. §4 says the
   indicator was not carrying weight.
3. **MTF_CONFLUENCE should be switched off or repaired** regardless of the wider decision: it is
   rejecting real candidates on a constant-zero input. (Yesterday's funnel test already showed
   the filter stack is not selecting winners; this is a mechanism for that finding.)
4. The shutdown-vs-continue decision from `SCORER-VERDICT-20260813.md` is unchanged. This
   check found a genuine defect and a genuine explanation attempt — and the explanation did not
   survive contact with the data.
