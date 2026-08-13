# Continue or shut down — the decision, made decidable
**Date:** 2026-08-12 evening · **For:** PO, and the Conclave for ratification
**Every number below is from `trade_ledger`/`order_events` rows or replay artifacts committed to the repo. Nothing is from memory or hope.**

---

## 0. The direct answer

**Put real money in now? No — that is not a judgment call, it fails hard prerequisites** (§4):
no SIP data (the account still quotes IEX-only, 5–9% of volume), the NBBO guard isn't built,
and the Alpaca account issue that blocks both is unresolved. Real money tonight would trade
blind on a machine with one clean closed trade of track record. Off the table regardless of
conviction.

**Shut everything down tonight? Also not supported — for a colder reason than disappointment.**
The −$2,092 was produced almost entirely by a machine that no longer exists (§2). Shutting
down now decides the question on the *old* machine's data; continuing to real money would
decide it on *no* data. Neither is a decision — both are moods.

> ⚠️ **The recommendation that followed here (a 15-day certification window) was RETRACTED the
> same day** — see `docs/INSTITUTIONAL-REVIEW-20260812.md`. It green-lights real money 41.3% of
> the time in a world with zero edge, because 15 days is ~8 trades and the per-trade Sharpe is
> 0.0308. **§1, §2, §4 and §5 of this document stand and remain accurate**; §3's verdict
> machinery does not. Read the institutional review for what replaces it.

**What I recommended instead (now retracted) was a contract that forces the answer in at most
15 trading days,** with the bleeding capped at $1,500 and a shutdown-by-default clause so hope
cannot stretch it (§3). The intent was right; the statistics were not. I am not a financial
advisor and the real-money call is yours alone — what I can do is make the system tell you the
truth, and then tell you when it can't.

## 1. The bill, verified (all 46 closed trades, 07-17 → 08-12)

| | |
|---|---|
| total realized | **−$2,091.98** (July −796.35, August −1,295.63) |
| cumulative equity curve | **never positive** — peak was −$141.28 on day one |
| win rate / PF / kelly★ (certified longs, n=20, honest field) | 20% / 1.0889 / −0.0996 |
| short book | halted since 08-07 (PF 0.01) — correctly |

Where the loser dollars actually went (the 41-trade measured set, $4,738.80 of losses):

| loss class | measured size | status |
|---|---|---|
| revenge re-entries within 120h of a symbol loss | **−$785.71** (5 trades, 0 winners in any window) | **CLOSED** — K3 v2.9 live (gov 209), replay-proven |
| giveback: up ≥ +1% then lost (14 of 17 never reached the trail bar) | **−$1,842.42** = 38.9% of loser dollars (+ ALGN −168.97 today, same class) | **OPEN** — ratchet backtest pending your word |
| naked overnight (day-TIF bracket children) | $0 lost — caught tonight before it cost anything | **CLOSED** — stops re-armed + v4.9.2 live (gov 211) |
| execution chase (market orders, unbounded slippage) | pre-fix regime | **CLOSED** — cap live since 08-10; slip since: +0.246%, −0.017%, +0.041% |

Union of the two dollar classes (overlap removed): **$2,491 of $4,739 loser dollars — 52.6% —
was mechanical leak, not signal.** One class is closed, one has a designed, precommitted fix.

## 2. Why "the data says shut it down" is not yet a true sentence

The 46 trades were produced by four materially different machines. What changed in just the
last three sessions: market-order entries → capped limits with fill-anchored stops (gov 202);
r_multiple corrupted on 30/42 rows → restored (gov 208); 24h same-direction cooldown → 120h
symbol-wide any-loss (gov 209); day-TIF brackets stripping stops at the close → gtc (gov 211,
tonight). **The machine as it exists tonight has exactly one closed trade (AMAT — clean
execution, a noise stop) and two open protected positions.** There is no track record of the
current system, in either direction. That is the honest reason tonight is not decision night —
and the reason the decision must be *scheduled* rather than deferred.

What has NOT changed, and must be said plainly: the signal itself has never yet shown an
edge (win rate 12–20% at every stop width; the curve never went positive). The contract below
does not assume it will. It forces the question.

## 3. THE CERTIFICATION CONTRACT — ⚠️ RETRACTED 2026-08-12, SAME DAY

> **This section is superseded by `docs/INSTITUTIONAL-REVIEW-20260812.md`. Do not act on it.**
> Simulated 100,000 times against a world with exactly zero edge, the R3 rule below returns
> "CONTINUE → real-money prep" **41.3% of the time**. At the measured 0.52 trades/day a
> 15-day window is ~8 trades, and the observed per-trade Sharpe is 0.0308 (t = 0.14 at n=20),
> so no 15-day window can decide anything. The floor (R2) and the real-money prerequisites
> (§4) stand; the verdict machinery does not. Kept below only as the record of what was
> proposed and why it was killed.

### (retracted) THE CERTIFICATION CONTRACT (proposed for Conclave ratification)

**R1 — the window.** 15 trading days, 2026-08-13 → 2026-09-03. Paper only. Current gates,
probation sizing (already forced by Quadrant 2). No parameter changes inside the window except
items already authorized or listed in R4 — measurement discipline, not tinkering.

**R2 — the hard floor.** If realized P&L inside the window reaches **−$1,500, trading halts
immediately** and the shutdown review happens early. (Context: worst recent week was −$786;
this is ~2.5 sigma of the observed run-rate. The account-level 12% drawdown halt remains
underneath as the absolute backstop.) This is the number that answers "I cannot keep losing
money every day": the maximum further paper bleed before a forced decision is $1,500.

**R3 — the verdict, precommitted now so it cannot be argued later:**

| outcome at window end | verdict |
|---|---|
| Certified long dollar **PF ≥ 1.15** AND **kelly★ > 0** AND tail count above baseline (≥5, i.e. a fresh ≥3.6% winner appeared) AND zero new P0s | **CONTINUE** → begin real-money prep (§4), Conclave sets sizing |
| Q5 fires (cleaned long PF < 1.0 over ≥15 certified trades — already armed, automatic), OR the tail canary fires (14 straight closes, no ≥3.6% winner), OR the R2 floor is hit, OR a new unguarded loss class > $400 appears | **SHUTDOWN** — with the specific measured reason in the governance log |
| Neither set fires (the ambiguous middle) | **One extension of 10 days maximum.** A second ambiguous window = **shutdown by default.** This clause exists so hope has a deadline. |

**R4 — inside the window, in order:** (1) ratchet backtest in week 1 — half a day; ships only
if expectancy improves AND the frozen tail count doesn't drop on replay (the gov 210 double
bar — this attacks the largest open leak, the $1,842 giveback class); (2) task 68, remove
`feed=iex` from the TSM bars calls — already shadow-cleared for 2 unanimous sessions, makes
the trail bars honest; (3) M3 writer-side r_multiple invariant — cheap insurance that the
scoreboard stays honest while we read it.

**Also for PO judgment (not automated):** five open positions predate the current risk regime —
AES short (12 days old) and XPEV short (9 days) sit on a *halted* short book; ALLE/DGX/ZBRA
carry pre-clamp economics. Current stop-distance risk on the whole 7-position book is ~$678
ex-gap, so this is contained — but flattening the two legacy shorts manually would make the
window's book purely current-regime. Your call; the TSM manages them either way.

## 4. Real-money prerequisites (all must hold BEFORE the first live dollar, even on CONTINUE)

1. SIP market data + NBBO guard + spread-aware cap (task 67) — **blocked on the Alpaca
   "legal entity" support ticket; chasing that ticket is the one action only you can take.**
2. A CONTINUE verdict from R3 — the strategy must have demonstrated, not promised.
3. Live-mode dry run: every gate, stop, and recovery path re-proven with `mode='live'` flags
   on minimum size, plus the 10:15 check extended to the live book.
4. Conclave sizing ruling: real-money starts at a fraction of paper sizing with its own
   drawdown halt; never Kelly on day one.

## 5. Open items — complete inventory, ranked

| rank | item | why it matters | status |
|---|---|---|---|
| 🔴 do in window | Ratchet backtest → ship if double-bar passes | −$1,842 measured class + today's ALGN | needs your one word |
| 🔴 do in window | task 68: drop `feed=iex` (4 TSM bars calls) | trail bars understate ATR ~7.5%; shadow cleared 2 sessions | needs your one word |
| 🟠 do in window | M3: writer-side r_multiple invariant | the gate reads this field at every n=20 boundary | recommended |
| 🟠 PO action | Chase Alpaca support (legal-entity ticket) | blocks SIP → blocks every real-money path | with you |
| 🟡 judgment | Flatten legacy AES/XPEV shorts? | halted book, 9–12 day stale exposure | your call |
| 🟢 parked | AES clamp-floor, orphan classification, C4 regime seed, VC C1–C3/C5, RCF exemption, G17 slippage study, 6 MED + 5 LOW SQL findings, `VaUQ4J95wyc5CAVP` unreachable, `exec_flow_audit.blocked_stage` cosmetic, stale v4.2.1 label | none block the window or the verdict | tracked |

**Closed today alone:** K3 v2.9 (gov 209) · S1-a + frozen tail canary (gov 210) · naked-overnight
P0: stops re-armed live + v4.9.2 deployed byte-verified (gov 211) · daily check upgraded to
watch all of it (checks 3b, 6, 7, 8).

## 6. What tomorrow looks like under the contract

ALGN, AMAT, WSM, WST are cooldown-embargoed in both directions. WMB/WMT wake up protected
(GTC stops 72.81 / 113.79, verified live on Alpaca tonight). Every new entry gets a capped
fill, a fill-anchored stop that survives closes, the honest ledger, and the tail canary
watching the only thing that can ever make this profitable — the winners. The 10:15 check
reports all of it against hard thresholds, daily, without me or you having to remember.

**Day 1 of 15 starts at the open. The system now has to earn the next decision.**
