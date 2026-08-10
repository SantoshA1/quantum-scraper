-- ═══════════════════════════════════════════════════════════════════════════════════════
-- APT v4.9 EXECUTION FIX — POST-DEPLOY VERIFICATION.  Read-only. Safe on production.
-- Governance 202 (Alpaca Paper Trade v4.9) + 203 (QET Ledger H3 SQL v2), 2026-08-10.
--
-- Run this after the first session in which capped entries have fired. Section 1 is the
-- one that decides whether the cap stays as it is.
--
-- REVERT (instant, no republish):  n8n variable QTP_ENTRY_LIMIT_CAP_ACTIVE = 0
-- WIDEN instead of reverting:      n8n variable QTP_ENTRY_LIMIT_CAP_PCT   = 0.40
-- FOOTGUN: this block FAILS CLOSED. DELETING the variable does NOT revert it. Set it to 0.
-- ═══════════════════════════════════════════════════════════════════════════════════════

-- ── 1. FILL RATE — the number the whole pivot is a bet on ────────────────────────────
-- Projection from the 48-entry backtest at a 0.30% cap was 72.9%. Materially below that
-- means the cap is turning away more than the model said: widen to 0.40% BEFORE drawing
-- any conclusion about the strategy. Every skipped row is a decision, not an error.
SELECT date_trunc('day', event_ts AT TIME ZONE 'America/New_York')::date AS et_day,
       count(*) FILTER (WHERE order_status NOT LIKE 'SKIPPED%' AND order_status NOT LIKE 'BLOCKED%'
                          AND order_status NOT LIKE 'ERROR%')                       AS entered,
       count(*) FILTER (WHERE order_status = 'SKIPPED_NO_FILL_WITHIN_CAP')          AS skipped_no_fill,
       count(*) FILTER (WHERE order_status = 'SKIPPED_NO_FILL_CANCEL_FAILED')       AS cancel_failed,
       count(*) FILTER (WHERE order_status = 'ERROR_FILL_STATE_UNKNOWN')            AS state_unknown,
       count(*) FILTER (WHERE order_status = 'BLOCKED_EXEC_CAP')                    AS blocked_no_limit,
       round(100.0 * count(*) FILTER (WHERE order_status NOT LIKE 'SKIPPED%' AND order_status NOT LIKE 'BLOCKED%'
                                        AND order_status NOT LIKE 'ERROR%')
             / NULLIF(count(*), 0), 1)                                              AS fill_rate_pct
FROM quantum.order_events
WHERE raw_payload->>'alpaca_exec_regime' = 'EXEC_V49_LIMIT_CAP'
  AND event_ts >= now() - interval '10 days'
GROUP BY 1 ORDER BY 1 DESC;

-- ── 2. DID THE SLIPPAGE ACTUALLY COLLAPSE ────────────────────────────────────────────
-- The cap makes >0.30% structurally impossible on the entries it fills, so this should
-- read near zero. If it does not, the residual is genuine market impact and the answer is
-- a strategy conclusion, not another plumbing fix.
SELECT sizing_meta->>'exec_regime' AS regime,
       count(*)                                                              AS n,
       round(avg((entry_fill_price - intended_entry) / NULLIF(intended_entry,0)
                 * CASE WHEN side IN ('buy','buy_call','sell_put') THEN 1 ELSE -1 END)::numeric * 100, 4) AS avg_slip_pct,
       round(max(abs(entry_fill_price - intended_entry) / NULLIF(intended_entry,0))::numeric * 100, 4)    AS worst_abs_slip_pct,
       round(sum(abs(entry_fill_price - intended_entry) * qty)::numeric, 2)  AS total_slip_usd,
       count(*) FILTER (WHERE abs(entry_fill_price - intended_entry) / NULLIF(intended_entry,0) > 0.0031) AS breached_the_cap
FROM public.trade_ledger
WHERE mode = 'paper' AND entry_fill_price IS NOT NULL AND intended_entry IS NOT NULL
  AND entry_fill_time >= now() - interval '30 days'
GROUP BY 1 ORDER BY 1 NULLS LAST;
-- breached_the_cap must be 0 for regime EXEC_V49_LIMIT_CAP. Anything else is a P0:
-- it means an order went out without the limit. Revert and investigate before trading on.

-- ── 3. E2 — is the protective stop now inside the TSM's 1.20% bar? ───────────────────
-- >1.20% from the FILL is what makes the TSM cancel the bracket stop and force a 0.9%
-- replacement, which is the chain that noise-killed WST on 08-10.
SELECT symbol, status, sizing_meta->>'exec_regime' AS regime,
       (sizing_meta->>'stop_price_initial')::numeric AS stop_at_submit,
       intended_stop AS stop_now,
       (sizing_meta->>'stop_reanchored')::boolean    AS reanchored,
       entry_fill_price AS fill,
       round(abs(intended_stop - entry_fill_price) / NULLIF(entry_fill_price,0) * 100, 4) AS stop_pct_of_fill,
       (abs(intended_stop - entry_fill_price) / NULLIF(entry_fill_price,0) > 0.012)       AS tsm_would_force_recovery,
       entry_fill_time AT TIME ZONE 'America/New_York' AS entry_et
FROM public.trade_ledger
WHERE mode = 'paper' AND intended_stop IS NOT NULL AND entry_fill_price IS NOT NULL
  AND entry_fill_time >= now() - interval '10 days'
ORDER BY entry_fill_time DESC;
-- Under v4.9, tsm_would_force_recovery must be FALSE on every capped row.

-- ── 4. E2 corroborated from the broker side — no new forced-stop recoveries ──────────
-- The TSM stamps its forced replacements with a client_order_id prefix. If E2 works, no
-- NEW qtp_widestop_* should appear for entries taken under the cap.
SELECT substring(coalesce(raw_payload->>'client_order_id','') from '^qtp_[a-z_]+') AS recovery_kind,
       symbol, count(*) AS n,
       max(event_ts AT TIME ZONE 'America/New_York') AS last_et
FROM quantum.order_events
WHERE event_ts >= now() - interval '10 days'
  AND coalesce(raw_payload->>'client_order_id','') ~ '^qtp_(widestop|sl_recovery|naked_flatten)'
GROUP BY 1,2 ORDER BY last_et DESC;
-- Baseline before the fix: 13 events across 12 symbols in 10 days, 12 of them predating
-- the 08-06 entry-stop clamp; WST 08-10 11:25 ET was the only clearly post-clamp one.

-- ── 5. WHAT THE CAP TURNED AWAY, and whether that was the right call ─────────────────
-- No ledger row exists for a skipped signal (by design — H3 v2 refuses to stage one), so
-- this reads order_events. There is no P&L here to compare against, and that is the point:
-- a limit that does not fill earns zero, not the counterfactual. This is for eyeballing
-- WHICH names and WHICH times of day are being refused.
SELECT symbol,
       to_char(event_ts AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH24:MI') AS et,
       (raw_payload->>'alpaca_limit_price')::numeric  AS limit_offered,
       (raw_payload->>'alpaca_signal_price')::numeric AS signal_price,
       raw_payload->>'alpaca_poll_outcome'            AS poll_outcome,
       raw_payload->>'alpaca_reason'                  AS reason
FROM quantum.order_events
WHERE order_status LIKE 'SKIPPED_NO_FILL%' AND event_ts >= now() - interval '10 days'
ORDER BY event_ts DESC LIMIT 100;

-- ── 6. THINGS THAT MUST BE INVESTIGATED BY HAND IF THEY APPEAR ──────────────────────
SELECT order_status, symbol,
       to_char(event_ts AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH24:MI') AS et,
       raw_payload->>'alpaca_entry_id'   AS entry_order_id,
       raw_payload->>'alpaca_reason'     AS reason,
       raw_payload->>'alpaca_poll_error' AS poll_error
FROM quantum.order_events
WHERE event_ts >= now() - interval '10 days'
  AND order_status IN ('ERROR_FILL_STATE_UNKNOWN','SKIPPED_NO_FILL_CANCEL_FAILED','BLOCKED_EXEC_CAP')
ORDER BY event_ts DESC;
-- ERROR_FILL_STATE_UNKNOWN        -> the order MAY have filled. Check Alpaca directly.
--                                    No ledger row was staged, deliberately.
-- SKIPPED_NO_FILL_CANCEL_FAILED   -> the entry may still be working. Check and cancel.
-- BLOCKED_EXEC_CAP                -> no order was placed; the signal had no usable price.

-- ── 7. E3 — is the regime actually landing in the ledger? ───────────────────────────
-- If this returns zero rows for EXEC_V49_LIMIT_CAP after a capped entry has filled, then
-- H3 v2 is not doing its job and the pre/post comparison cannot be made.
SELECT coalesce(sizing_meta->>'exec_regime','(pre-v4.9)') AS regime,
       count(*) AS n_entries,
       min(created_at AT TIME ZONE 'America/New_York') AS first_et,
       max(created_at AT TIME ZONE 'America/New_York') AS last_et,
       count(*) FILTER (WHERE (sizing_meta->>'stop_reanchored')::boolean) AS stops_reanchored,
       count(*) FILTER (WHERE (sizing_meta->>'partial_fill')::boolean)    AS partial_fills
FROM public.trade_ledger
WHERE mode = 'paper' AND strategy = 'qtp-main-pipeline' AND created_at >= now() - interval '30 days'
GROUP BY 1 ORDER BY 1;

-- ── 8. THE HEADLINE — dollar PF, split pre- vs post-fix ─────────────────────────────
-- Do NOT read this before there are at least 15 closed post-fix trades. It is here so the
-- comparison is defined in advance rather than constructed after the fact.
SELECT coalesce(sizing_meta->>'exec_regime','(pre-v4.9)') AS regime,
       count(*) AS n_closed,
       round(sum(net_pnl)::numeric, 2) AS realized,
       round((coalesce(sum(net_pnl) FILTER (WHERE net_pnl > 0), 0)
              / NULLIF(abs(sum(net_pnl) FILTER (WHERE net_pnl <= 0)), 0))::numeric, 4) AS dollar_pf,
       round(100.0 * count(*) FILTER (WHERE net_pnl > 0) / NULLIF(count(*), 0), 1)     AS win_rate_pct
FROM public.trade_ledger
WHERE mode = 'paper' AND strategy = 'qtp-main-pipeline' AND status = 'closed'
  AND r_multiple IS NOT NULL
  AND exit_fill_time  >= now() - interval '90 days'
  AND entry_fill_time >= now() - interval '90 days'
  AND coalesce(lineage_source,'') NOT LIKE 'RECERT_QUARANTINE%'
  AND risk_amount IS NOT NULL AND risk_amount > 0
  AND intended_stop IS NOT NULL AND entry_fill_price IS NOT NULL
GROUP BY 1 ORDER BY 1;
