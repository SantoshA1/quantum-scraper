# OODA — why today was red, what today's fixes do and don't cover, and the P0 found on the way
**Date:** 2026-08-12 post-close · **For:** PO · **Method:** every claim verified from `trade_ledger` / `order_events` rows or the measured excursion set; nothing here is estimated from memory
**Asks at the bottom. One is urgent (tonight).**

---

## 0. Answers first

1. **Why red today:** one trade — ALGN −168.97. A 5-day swing position whose stop **never moved
   off its entry level** (verified: stop 170.39 HELD 08-07 19:35 → FILLED 08-12 13:47, zero
   modifications between), because the price never reached tier-1 so the TSM never engaged.
   It gapped through the static stop at the open at **1.44× planned risk**. This is the
   **giveback class**, and today's shipped fixes do not cover it (ratchet does — pending your
   authorization).
2. **Would today's fixes have prevented today's loss? No — and that's verified, not assumed.**
   K3 v2.9 replay: ALGN had no prior loss (nothing to cool down); this morning's WMB/WMT
   re-entries were 191h/145h after their symbols' last losses — outside the 120h window, so
   v2.9 legitimately allowed them. Today's fixes close a *different*, also-real class (§2).
3. **Will they help tomorrow? Yes, mechanically:** ALGN/AMAT/WSM/WST are embargoed in both
   directions (ALGN's 120h re-armed at today's stop). But the single biggest risk for
   tomorrow morning is the **P0 in §1** — found during this pressure test.
4. **Day trades or swing?** Both — and the mismatch is the recurring loss mechanism (§4).
5. **Can risk plumbing make daily green days? No.** At n=20 certified longs: dollar PF 1.0889,
   kelly★ −0.0996, win rate 20%. The edge is ~breakeven; green *days* come from the signal
   (gov 195/196/197). What plumbing can verifiably do is close the three measured leak
   classes (§5): revenge (closed today), giveback (fix pending), naked-overnight (P0, fix is
   a one-liner).

---

## 1. 🔴 P0 — WMB and WMT are open tonight with NO protective stop

Raw `order_events`, today:

| leg | TIF | placed | died |
|---|---|---|---|
| WMT stop 113.79 | **day** | 14:21:03Z HELD | **20:00:26Z CANCELED** (TP 123.50 day-EXPIRED same second) |
| WMB stop 72.81 | **day** | 14:20:59Z HELD | **20:01:37Z CANCELED** (TP 77.56 day-EXPIRED same second) |

No stop-family order exists for either symbol after 20:01Z. ~$21.1k notional is unprotected
until the TSM's naked-position guard re-arms on its first cycle after tomorrow's open —
leaving the overnight gap plus the opening minutes exposed, which is precisely where ALGN
lost 1.44× planned risk *this morning*.

**Root cause — a v4.9 regression, first exposed today.** The capped-entry bracket submits its
child legs with `time_in_force='day'`. ALGN's pre-v4.9 bracket used **gtc** (its stop survived
five nights; its TP was canceled only at exit). AMAT — the only prior v4.9 entry — stopped out
58 minutes after entry, so the day-TIF never got tested against a close until today. Every
future v4.9 entry that survives its first session will go naked overnight until this is fixed.

**Fixes (both need your word):** (1) tonight, place two GTC protective stops at the intended
levels (WMB 72.81 × 143, WMT 113.79 × 92) via a temp n8n execution, archived after use;
(2) **v4.9.2**: bracket TIF `day` → `gtc` — one line, shipped with the usual hash-verified
deploy, offline suite, and a live probe asserting the stop leg survives 20:00Z.

## 2. What today's shipped fixes DO cover — replay-verified

Independent SQL replay over every trade exited in the last 14 days (22 trades): K3 v2.9
blocks exactly five entries — WST 07-31 (−103.23, gap 72.1h), AVB 08-03 (−107.68, 95.9h),
WMB 08-04 (−341.14, 91.4h), WMT 07-30 (−136.80, 71.2h), WSM 08-10 (−96.86, 114.2h) —
**−$785.71 of realized losses, and zero winners blocked** (AKAM +555 entered at 239.3h,
WSM +485 at 142.4h — both correctly outside the window). Of the current 6-red-day streak,
v2.9-live-earlier would have removed −$233.66 (WMT, WSM legs).

## 3. The giveback class — today's actual killer, measured

From the 41-trade excursion set (minute-bar-derived, through 08-10):

| | |
|---|---|
| losers that had been **up ≥ +1.0%** before losing | **17 of 36 losers** |
| dollars | **−$1,842.42 = 38.9% of all loser dollars** |
| of which the trail **never engaged** (MFE < tier-1 bar) | **14 trades, −$1,534.07** |

Tier-1 sits at 3.3–7.4% on these trades (1.5 × daily ATR); median MFE is ~1%. The trail's
first rung is above where most trades ever go, so "up nicely → full round trip → stop" is
structural. ALGN today is the same shape (verified ≥ +0.81% on 08-10 with the stop still at
its entry level; the +$290 peak seen live on 08-11 is consistent but not reconstructable from
stored events). **The breakeven-ratchet backtest is the pending fix** — half a day, and the
gov 210 precommit already binds it: expectancy must improve AND the frozen-unit tail count
must not drop. Note the five real winners' lifetime max adverse was 0.615%, so the classes
look separable — but ratchet-vs-winner *sequencing* needs the minute bars; that is exactly
what the backtest is for.

## 4. Day trades or swing? Measured: a swing book wearing day-trade plumbing

90 days of closed trades:

| | n | median hold | mean | same-day : overnight |
|---|---|---|---|---|
| losers | 39 | **20.0h** | 30.5h | 19 : 20 |
| winners | 7 | 25.2h | 703h (max 106 days) | **1 : 6** |
| open book now | 7 | **175h (7.3 days)** | 143h | 0 : 7 |

Entries go in like a day system (09:32–10:26 ET after signals); losers resolve within ~a day;
**every payoff lives on swing timeframes** — 6 of 7 winners held overnight, and the entire
current book is multi-day. The plumbing, though, is intraday: day-TIF bracket legs (§1),
a 1.2% stop = 0.41 daily ATR exposed to overnight gaps (ALGN 1.44× today; historical mean
overshoot 1.67×), and a trail that first engages at 1.5 daily ATRs. The system must either
be a day system (flat by close — it demonstrably is not) or get swing-grade protection:
gtc stops, gap-aware stop placement, and an intermediate trail rung. That is the coherent
frame for v4.9.2 + the ratchet.

## 5. What else could be done — tested, including one idea REJECTED on evidence

**Tested and rejected: a "stop trading after N red days" circuit breaker.** Replayed on the
real trade dates: after the 07-30/07-31 red pair, the rule skips 08-03 entries — which removes
AVB −107.68, AEE −107.36, XPEV −94.27 **and WSM +484.65, the month's biggest winner**. Net
effect: **−$175.34 worse.** The best winner arrived the day after two red days; a day-level
breaker is anti-correlated with exactly the snapback this book gets paid on. Not proposed.

**The ranked, verifiable lever list:**

| # | lever | class it closes | measured size | status |
|---|---|---|---|---|
| 1 | GTC stops tonight + v4.9.2 TIF fix | naked overnight | $21.1k unprotected tonight | 🔴 needs your word |
| 2 | Breakeven-ratchet backtest → ship if it passes the gov-210 double bar | giveback | −$1,842 (38.9% of loser $) | needs your word (backtest only) |
| 3 | K3 v2.9 | revenge re-entry | −$785.71, 0 winners lost | ✅ live since today |
| 4 | Execution cap + fill-anchored stops | slippage/chase | slip today −0.017% / +0.041%; 1 chase refused | ✅ live, working |
| 5 | Signal quality (gov 195/196/197) | the actual edge | win rate 12–20% at every stop width | the real bottleneck |

Also verified in passing: the S3 `stop_regime` tag is now live in production (present on both
of today's entries — first tagged rows), and both fills were inside the cap.

## 6. Reproduce

Every table above: the SQL in this session (14-day K3 replay with per-entry gap hours;
holding-time split; ALGN/WMB/WMT `order_events` trails) and
`analysis/excursion-rows-20260810.json` for §3. The five-pack replay is additionally pinned
offline in `tests/test-k3-cooldown.js` CD-20.
