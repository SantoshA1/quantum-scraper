# QTP Fix Batch — 2026-07-02/03 (vision 400, Grok AIJSON, heartbeat, AFTO migration)

Four production fixes shipped to `tradenextgen.app.n8n.cloud`, exported here as DR backups. All were architect-shipped with user PO auth, market closed (Jul 3 = NYSE holiday), each with one-step rollback.

## 1. Chart-vision HTTP 400 — `store: false` (SM workflow, v4.3.0)

**Workflow:** TradingView AI Super Score → Perplexity → Telegram (`vaqfCaELhOEWnkdo`), node `Indicator Enrichment`.
**Symptom:** every grok-4.3 chart-vision call to `api.x.ai/v1/responses` returned HTTP 400 → `chart_vision_status='ERROR_FAIL_OPEN'`, silently, for weeks.
**Root cause:** xAI docs — image requests via /v1/responses may fail unless server-side request/response storage is disabled. Payload never sent `store: false`.
**Fix (`QTP_CHART_VISION_REALTIME_v4.3.0_STOREFALSE_CCFALLBACK_20260702`):** `store:false` added; one-shot fallback to `/v1/chat/completions` chat-vision shape; error body now JSON.stringified (was a useless status-code string); `chart_vision_api` + `chart_vision_fail_open_alert` telemetry.
**Versions:** fffbeb70 → **8c2689b3**. Verify: first entry-candidate execution Mon 2026-07-06 → `chart_vision_status=ANALYZED_REALTIME_WIDGET_SCREENSHOT`.

## 2. Grok AI Analysis structured output (SM workflow, AIJSON v1.0)

**Node:** `Grok AI Analysis` (034627eb). Prose was decorative — no gate or table ever parsed it.
**Fix (`QTP_GROK_AI_STRUCT_v1.0_20260702`):** prompt now demands a trailing `AIJSON:{"action","confidence","bull_score","bear_score","risk_note"}` line; parser fills advisory-only fields `ai_action/ai_confidence/ai_bull_score/ai_bear_score/ai_risk_note/ai_json_parsed`. Fail-soft; NOT wired into any gate (gating decisions deferred to MTF v8 + Conclave review per Phase 0 findings).
**Versions:** 8c2689b3 → **a67e2239** (current active). Rollback = republish 8c2689b3.

## 3. Daily heartbeat writer (QTP-10FC, v4.2.2)

**Workflow:** Telegram Grok Native Heartbeat (`THo2K0rZAVesy0Sl`), daily 13:00Z.
**Root cause:** `quantum.telegram_grok_heartbeat` NEVER had an n8n writer (its single row was from a one-off manual script); this workflow only wrote `alert_route_verification_10fc`.
**Fix:** second INSERT added to `__supabase_insert_sql` — a status row into `quantum.telegram_grok_heartbeat` per run.
**Versions:** aeeb08de → **ec6640cf**.
**Related non-bug:** `vc_api_health_events_10o` silence since 06-11 is healthy behavior (error-only logging; Grok text calls have been clean). Known blind spot: the vision leg has no health-event setter (proposed, not shipped).

## 4. QTP-AFTO 15-min monitor — Databricks→Supabase migration (v4.3.1)

**Workflow:** Quantum Coherence Heartbeat & Preopen Monitor (`AaaQOrBVEXwJkOyz`).
**Root cause:** silent no-op since creation — `$env` access denied on n8n cloud (cfg() threw instantly), `continueOnFail:true` masked every failure as success, and the SQL sink was Databricks `trading_prod.quantum`, missed in the Databricks→Supabase migration (user-confirmed).
**Fix:** rebuilt 2→6 nodes: Fetch Quantum Metrics (Postgres) → Read Alpaca + Log Coherence v4.3.1 (`onError: stopWorkflow`) → Write Supabase Telemetry (Postgres) → If Pause Advisory → Telegram. Writes per-run rows to `quantum.telegram_grok_heartbeat`, `quantum.infra_telemetry_15m`, `quantum.entry_pause_control` (append-only advisory, 30-min expiry; verified no live consumer). NYSE-2026 holiday guard suppresses the zero-signals pause leg on closed days.
**Known degradations (flagged in every row):** Alpaca creds absent (`alpaca_status='UNAVAILABLE_NO_CRED'`); `v_risk_gate_status`/`v_current_position_risk_state` views never migrated → `unprotected_positions='UNKNOWN'` (cannot trigger pause).
**Versions:** 5da2066d → **8234aa35**. VERIFIED live: exec 349690 wrote all 3 tables; holiday guard engaged correctly on Jul 3.

## Same-day platform work (docs in `docs/`)

- Phase 0 reject-backtest read-out (rejects NOT losers; MTF score anti-predictive; bracket geometry destroys edge) — `docs/PHASE0-REJECT-BACKTEST-READOUT-20260702.md` + episode CSV
- MTF Score v8 design draft (swing/LT weight→0; shadow candidates A/B/C; awaiting Quantlys Conclave) — `docs/MTF-SCORE-V8-DESIGN-DRAFT-20260702.md`
- RLS enabled on all 56 `quantum.*` tables (migration `enable_rls_quantum_all_tables_20260702`; verified non-breaking: no anon/authenticated grants, owner=postgres)

## Monday 2026-07-06 verification checklist

1. v7 green check: first scalp 50–59 → `FINAL_MTF_CONFLUENCE_PASS` → fill
2. Vision: `chart_vision_status=ANALYZED_REALTIME_WIDGET_SCREENSHOT`, `chart_vision_api=responses_store_false`
3. AIJSON: `ai_json_parsed=true` on Grok AI Analysis outputs
4. Heartbeats: daily 13:00Z row (10FC) + 15-min rows (AFTO) accumulating
