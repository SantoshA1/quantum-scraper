# QET Edge-Ledger n8n Audit Hooks — Spec (Gate K extension)

Five hook points inserted into the canonical QET pipeline shape. They do not
replace any of the six safety gates — H2 hardens Gate 1, and all hooks inherit
Gate 6 (retry ×3 exponential backoff, audit_log write, alert on error).

```
[Trigger] → [Mode-Toggle] → [Signal stage]
                                  │
                        ┌── H2: Kelly Gate RPC ──┐  reject/halt → audit_log → alert
                        ▼                         │
                  [Approval gate (live only)]     │
                        ▼                         │
                  [Execution: Alpaca order] ── H3: ledger INSERT on entry fill
                        ▼
                  [Exit logic fires]       ── H4: ledger UPDATE on exit fill
                        ▼
                  [Audit log → GitHub commit → Alert]

[Nightly Schedule 02:00 ET] ── H5: broker reconciliation
[Signal stage, all signals] ── H1: signals row (existing) + strategy tag
```

All ledger writes use the **service-role** Supabase credential (n8n only —
never the anon key). All HTTP nodes: `retryOnFail: true, maxTries: 3,
waitBetweenTries: 1000`.

---

## H1 — Signal capture (existing, one addition)

The Signal stage already inserts into `signals`. Addition: `metadata.strategy`
is now **required** — the ledger and the Kelly gate attribute edge per
strategy. A signal without a strategy tag is `rejected` with reason
`"missing strategy attribution"` before the risk gate.

## H2 — Kelly Gate RPC (replaces the size computation inside Gate 1)

HTTP Request node `Kelly-Gate`, placed where Gate 1 computes shares. Gate 1's
equity fetch (`GET /v2/account`) stays — its `equity` feeds the RPC.

```
POST {SUPABASE_URL}/rest/v1/rpc/compute_kelly_gate
Headers: apikey: {service_role}, Authorization: Bearer {service_role},
         Content-Type: application/json
Body:
{
  "p_user_id":      "{{ $json.user_id }}",
  "p_portfolio_id": "{{ $json.portfolio_id }}",
  "p_strategy":     "{{ $json.signal.metadata.strategy }}",
  "p_mode":         "{{ $json.MODE }}",
  "p_equity":       {{ $json.alpaca_account.equity }},
  "p_entry":        {{ $json.signal.entry }},
  "p_stop":         {{ $json.signal.stop }},
  "p_confidence":   {{ $json.signal.confidence }}
}
```

IF node after it:

| Verdict | Route |
|---|---|
| `approved: true` | forward; carry `qty`, `risk_dollars`, `risk_pct`, and the **full response** (→ `sizing_meta`) |
| `approved: false, halted: true` | audit_log `rejected / drawdown_halt` → **alert channel with @here severity** → also mark signal `skipped`. Halt is portfolio-wide: n8n sets a `HALTED` flag in its data table so subsequent runs short-circuit until manually cleared. |
| `approved: false` (other) | audit_log `rejected` with `reason` → standard alert |

Note: the gate can only *shrink* Gate-1 size. If the RPC errors after retries,
**fail closed** — reject the trade (reason `kelly_gate_unreachable`), never
fall back to naive 1% sizing.

## H3 — Entry-fill ledger INSERT

After order submission, poll `GET /v2/orders/{id}` (Wait 2s loop, max 30
tries) until `status = filled` (partial fills: use `filled_avg_price` and
`filled_qty` once terminal). Then:

```
POST {SUPABASE_URL}/rest/v1/trade_ledger
Prefer: return=representation
{
  "user_id": ..., "portfolio_id": ..., "signal_id": ..., "position_id": ...,
  "strategy": signal.metadata.strategy, "mode": MODE,
  "symbol": ..., "side": ..., "qty": order.filled_qty,
  "contract_multiplier": 1 (100 for options),
  "confidence": signal.confidence,
  "signal_time": signal.generated_at,
  "intended_entry": signal.entry, "intended_stop": signal.stop,
  "intended_target": signal.target,
  "risk_amount": kelly.risk_dollars, "risk_pct_applied": kelly.risk_pct,
  "sizing_meta": <full H2 response>, "equity_at_entry": alpaca_account.equity,
  "entry_order_id": order.id,
  "entry_fill_price": order.filled_avg_price,
  "entry_fill_time": order.filled_at
}
```

Slippage is derived by the DB trigger — do not compute it in n8n.
Store the returned `id` as `ledger_id` alongside the position record.

## H4 — Exit-fill ledger UPDATE

In the exit workflow (bracket-fill webhook, trailing-stop poll, or
signal-flip exit), after the closing order fills:

```
PATCH {SUPABASE_URL}/rest/v1/trade_ledger?id=eq.{ledger_id}
{
  "exit_reason": "stop" | "target" | "trail" | "signal_flip" | "time" | "manual",
  "exit_order_id": ..., "intended_exit": <stop/target price that triggered>,
  "exit_fill_price": order.filled_avg_price, "exit_fill_time": order.filled_at,
  "fees": <sum of entry+exit fees from /v2/account/activities>,
  "status": "closed"
}
```

Trigger derives exit slippage, gross/net P&L, and `r_multiple`. For multi-leg
options, compute `gross_pnl` in n8n and include it — the trigger is
fill-if-null and won't overwrite.

## H5 — Nightly reconciliation (new Schedule workflow, 02:00 ET)

1. `GET /v2/account/activities?activity_types=FILL&date=<yesterday>` (paper and live separately).
2. Compare fills to ledger rows (`entry_order_id` / `exit_order_id`, qty, price).
3. Any mismatch or broker fill with no ledger row → set row `status = 'busted'`
   (or insert a `busted` stub), audit_log `errored / reconciliation_mismatch`,
   alert. `busted` rows are excluded from all edge metrics by the view.
4. Weekly summary (Sunday run): post `edge_metrics_by_strategy` snapshot to the
   alert channel — n_trades, win rate, expectancy R, PF, t-stat, annualized
   Sharpe, kelly_star, avg slippage. **The ratchet rule reads from this:** no
   sizing-parameter change except in response to these numbers.

---

## Done criteria (regression gate for this build)

- Every executed trade produces exactly one ledger row; every closed trade has
  `r_multiple` populated. (SELECT count mismatch vs positions = 0.)
- Kelly gate returns probation sizing (0.50%) for a fresh strategy, rejects on
  synthetic negative-edge history, halts at a synthetic 12% drawdown. (Three
  pinned tests, below.)
- RPC failure path rejects the trade — verified by pointing the node at a bad
  URL in paper mode.
- Reconciliation flags a deliberately deleted fee value within one run.

## Pinned test payloads (paper mode only)

1. **Probation**: fresh strategy name, valid signal → expect `approved: true, probation: true, risk_pct: 0.5`.
2. **Negative edge**: seed 45 closed ledger rows with W=0.35, avg_win 0.8R, avg_loss 1.1R → expect `negative_measured_edge`.
3. **DD halt**: seed pnl_snapshots peak 100000, call with p_equity 87500 → expect `drawdown_halt`.

## Credentials needed

- `Supabase-QET-ServiceRole` (HTTP Header Auth: apikey + Bearer, service role) — n8n only
- Existing `Alpaca-PAPER` / `Alpaca-LIVE` (unchanged, separate entries)

## Sequencing

1. Apply canonical bootstrap to `qtp_prod` (public schema is currently **empty**)
2. Apply `202607091500_qet_edge_ledger.sql`, then `202607091510_qet_kelly_gate.sql`
3. Wire H2 into the existing risk gate; H3/H4 into entry/exit workflows
4. Build H5 reconciliation workflow
5. Run the three pinned tests in paper; then let it run ≥40 trades per strategy
   before Kelly sizing activates itself — that's by design.
