# S1-a pressure-tested: the question as posed is moot — but its substance survives in two roles
**Date:** 2026-08-12 · **For:** PO (asked: "do we still need it? does it make sense? pressure test")
**Bears on:** the 2026-08-11 Conclave ruling (kill metric), gov 206/208, `docs/S1A-METRIC-CHOICE-20260811.md`, `docs/CONCLAVE-S1-ANSWER-20260811.md`, the pending breakeven-ratchet backtest

> **STATUS: RATIFIED AND CLOSED — gov 210.** The PO signed off the same day ("one-line signing
> off to close S1-a as posed"). Executed as scoped in §5: S1-a closed; the kill metric is
> redefined in the frozen unit (certified longs capturing ≥ 3.6% realized move — baseline
> **4 of 20**, verified live at ratification); the ratchet backtest is precommitted to passing
> on BOTH numbers. Monitoring homes: `verify-gatek.sql` §4 and the 10:15 ET daily check
> (prompt updated and byte-verified; its stale §6 — "r_multiple unfixed, n=20 pending" — was
> repaired in the same edit). No gate, workflow, or trading change was made.

---

## 0. Verdict up front

1. **S1-a as posed — "which metric governs stop width" — no longer needs deciding.** The stop
   is frozen (S4), expectancy is negative at every width (so no width decision is pending), and
   nothing on the roadmap moves the clamp. Deciding a governor for a parameter nobody is
   changing decides nothing.
2. **But I pressure-tested my own "the ≥3R count achieves nothing" and it took real damage.**
   Measured on current data, the count — in a *frozen unit* — is the **fastest detector we have**
   of the one failure that kills this strategy (harvest destruction): it flags in **~14 trades**
   what expectancy cannot statistically see in **~68**.
3. **What still dies, permanently, is the count as a *governor* in a floating unit.** That
   critique is arithmetic and survives every test below.
4. **One decision is still needed — smaller than S1-a:** pin the standing kill metric's unit
   (raw captured move ≥3.6%, not ledger-R), because the ruling's metric currently reads **zero**
   and is inert, and because the ratchet backtest — the next exit-path change on the table — is
   exactly the kind of change that can buy expectancy by selling the tail. That is when the
   tail canary earns its keep.

---

## 1. What changed since I wrote the recommendation

Three of my original arguments needed re-testing because the ground moved:

| original argument (08-11) | status today |
|---|---|
| "The count is denominated in a corrupted field (30/42 wrong)" | **MOOT — retracted.** Gov 208 fixed `r_multiple`; re-verified today: 0 violations. This argument may not be used again. |
| "Adopting the count changes no trade" | Still true — and now stronger: the stop is frozen and no width decision exists. |
| "The count installs a perverse gradient (R = move/W)" | **Still true and load-bearing** — see §2. |

## 2. Pressure test of the ≥3R count as GOVERNOR — it still fails, on live data

Recounted today on the **corrected** ledger, certified long book, n=20, same 20 trades:

| unit | ≥3R / ≥bar count |
|---|---|
| ledger R (corrected, honest) | **0** — max R is 2.05 |
| raw move ≥ 3.6% (= 3R at the live 1.2% unit) | **4** |
| raw move ≥ 9.66% (= 3R at the historical 3.22% unit) | **0** |

Same book, same dollars — the count is 0, 4, or 0 purely by choice of denominator. And note
the subtle version: the ruling said "frozen **dollar**-R", meaning risk frozen at entry — but
because sizing is risk-based (`qty = risk$/(W×entry)`), dollar-R ≥ 3 is *still* `move ≥ 3W`.
Freezing the risk basis does not freeze the width out of the metric. **The only real freeze is
pinning the width in the unit — i.e., defining the bar as a raw captured move.**

Two further hits on the count-as-governor:

- **It is inert right now.** The standing kill metric ("long book's ≥3R count must not
  degrade") reads **zero** on the honest field. A tripwire at zero cannot trip. In ledger-R
  terms it can only ever rise from here by clamp-era winners — or by someone tightening the
  clamp, which is the perverse gradient again.
- **Win rate is untouchable by any of this** (12.2% at every width on the 41-trade replay;
  20% on the certified 20). The PO's stated goals — accuracy and win rate — live in signal
  quality (gov 195/196/197), not in this metric choice. No metric choice here moves them.

## 3. Pressure test of MY side — three honest hits

I re-ran the S1 sweep's headline numbers with a paired bootstrap (20,000 resamples,
deterministic seed; `analysis/s1a-bootstrap-20260812.js`):

| quantity | point | 95% CI |
|---|---|---|
| expectancy, as traded | −0.213R | **[−0.443, +0.031]** |
| expectancy at 1.2% (overshoot 1.67) | −0.436R | [−0.882, +0.099] |
| paired difference (wider better) | +0.223R | [−0.108, +0.504] · **P(wider better) = 91.6%** |

**Hit 1 — my "wider is monotonically better" was a point-estimate claim.** The monotone
ordering is mechanical inside the model, but against sampling noise the wider-beats-1.2%
conclusion carries ~92% confidence, not certainty. It stays my read; it does not deserve the
word "clearly".

**Hit 2 — expectancy is a SLOW detector of the one fatal failure.** Kill the five winners
(the harvest) and the mean moves by only **0.184R — smaller than the CI half-width (0.237R)**.
At this sample size, expectancy literally cannot distinguish "the tail is dead" from noise in
one measurement window; it needs ≈68 trades. The count canary — "no ≥3.6%-move winner in N
consecutive trades" — rejects "tail alive" at 95% after **14 trades** at the observed 20%
winner rate. **~5× faster on exactly the failure mode the Conclave's kill metric was built
for.** My 08-11 brief's framing ("what adopting the count achieves: nothing") was too strong:
it conflated the floating-unit *governor* (worthless, §2) with the frozen-unit *tripwire*
(the fastest guard we have).

**Hit 3 — the overshoot calibration is regime-stale by construction.** The 1.67× was measured
on market-order entries with pre-E2 stops. The only regime-(c) lifecycle so far (AMAT) came
in at 1.078. n=1 proves nothing, but every expectancy counterfactual leans on that constant,
and it will drift as fill-anchored stops accrue. (Checked today: WSM and ALGN's exits were
old-regime entries — 08-10 and 08-07 — so AMAT remains the only clean data point. The
`stop_regime` tag will first appear on the next new fill; H3 v3 published after AMAT's entry.
No S3 defect.)

## 4. Where that leaves the two metrics — roles, not a winner

The pressure test dissolves the "conflict": the two metrics guard **different failure modes**
and neither substitutes for the other.

- **Expectancy (frozen dollar-R, paired on the same trades)** governs *parameter comparisons* —
  it is the only number that answers "is A better than B" on observed paths, and pairing
  cancels most sampling noise. Caveat now attached: always report the CI, never the point alone.
- **The tail count (frozen unit: raw captured move ≥ 3.6%)** is the *kill tripwire* — the fast
  canary for harvest destruction. It governs nothing and compares nothing; it only screams.

The concrete case where this matters is already scheduled: the **breakeven-ratchet backtest**.
A ratchet mechanically trims losses (expectancy ↑) and mechanically risks choking winners
before they run (tail ↓). Judged by expectancy alone, a tail-killing ratchet could pass.
Judged with the canary attached, it cannot. This is the decision S1-a actually needs to
protect — not the stop width.

## 5. Recommendation (nothing ships without your word)

1. **Close S1-a as posed.** No stop-width governor is needed; no width decision is pending.
2. **Redefine the standing kill metric's unit** — one line for Conclave/PO ratification:
   *"the long book's tail count is the number of closed longs capturing ≥ 3.6% favorable move
   (= 3R at the live 1.2% clamp), a unit no future width change can move."* Current honest
   reading: **4 of 20**. It becomes a real tripwire the moment it can degrade.
3. **Bind the ratchet backtest to both numbers in advance:** it must improve expectancy
   *without* reducing the frozen-unit tail count on replay. Precommitted, so the backtest
   cannot be argued into passing on one metric after the fact.
4. Implementation, once ratified, is a monitoring query only (10:15 check + verify-gatek §3) —
   no gate change, no workflow change, ~15 minutes. I have made **no** changes now.

## 6. Reproduce

- `analysis/s1a-bootstrap-20260812.js` → `analysis/s1a-bootstrap-result-20260812.json`
- Ledger recounts: certified-long filter, corrected `r_multiple` (gov 208), n=20 — §2 table
- `lib/analysis/stop_sweep.js` + `tests/test-stop-sweep.js` (18/18, SWP-01 back-check)
- Prior briefs superseded in part by this one: `S1A-METRIC-CHOICE-20260811.md` §1–2
