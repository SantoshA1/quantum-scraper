# QTP Fix Batch — 2026-07-03/06 (trace SQL, crash incident, RCF observability+shadow, vision v4.4.0, research crew)

Continuation of the 07-02 batch. All architect-shipped with user auth, one-step rollbacks.

## Main pipeline `vaqfCaELhOEWnkdo` (export = draft f0c0a21a, publishes 16:15 ET 07-06; active at export ce6472d7)
1. **Trace-SQL fix v4.2.2 (published 07-03, ce6472d7):** `$<digit>` in Grok prompt text corrupted the Candidate Trace INSERT (pg param token) and an audit-only node aborted live signals (exec 351240). esc() now rewrites `$(\d)`→`USD `, `${`→`USD{`; trace insert node onError=continueRegularOutput. Marker QTP_TRACE_SQL_DOLLAR_SANITIZE_v1_20260703.
2. **07-03 auto-deactivation incident (resolved, no code change):** 4 concurrent webhook executions → one n8n worker OOM killed all 4 in-flight → auto-deactivate 14:10:53Z. NOT caused by patches (18 clean runs prior). Reactivated; Dead-Man's Switch wfs verified active. OPEN: OOM concurrency hardening (needs enrichment field-usage analysis).
3. **RCF observability v1 + shadow v2 (in f0c0a21a):** Regime Conflict Filter drops were fully invisible (no audit writer downstream — root cause of historical attribution blindness). Now: [RCF_OBS] console log per drop with verbatim reason + _rcf_drop_log on survivors + shadow_both_required_pass (would-pass if veto required BOTH options AND dark-pool opposition). Zero decision changes. Marker QTP_RCF_OBS_SHADOW_v2_20260706.
4. **Chart-vision v4.4.0 CC-primary (in f0c0a21a):** /v1/responses 400s persisted despite store:false; chat/completions (proven working since 07-06 open) promoted to primary, responses demoted to secondary. Marker QTP_CHART_VISION_REALTIME_v4.4.0_CCPRIMARY_20260706.

## New workflow: `pvSiSm1JxsCLH4Qm` Daily Research Thesis — Pre-Market (QTP_DRT_CREW_v1.0)
Slow-path Equity Research crew (per docs/LLM_ANALYST_DECISION_MEMO_20260706.md): weekdays 08:30 ET, holiday-guarded; Bull/Bear analysts (grok-3-mini) → Judge (grok-3) → structured thesis row into `quantum.daily_research_thesis` (migration create_daily_research_thesis_20260706, RLS on, TTL 16:30 ET). Verified: test exec wrote drt_20260706_1351 (RISK_ON 0.58, 8 names). v1.1 backlog: judge all-long uniformity watch, stance vocab normalization, VIX sourcing. Hot-path consumption deferred until table proves stable.

## Key findings this batch (docs/)
- **Mechanism correction:** Grok-HOLD-as-opposition + 5-AND soft-allow live in `QTP Bias Filter` (composite opposition v6.0), NOT in RCF (options/dark-pool regime veto only). Bias Filter HOLD→neutral + 3-of-5 shadow is next, evidence-gated on the new RCF drop logs.
- **Afternoon dry spells are baseline, not incidents:** afternoon MTF passes over prior 6 sessions: 0,0,0,1,0,0. Morning-heavy fills are the system's current signature pending MTF v8.
- Conclave brief (RCF BUY policy) + architect decision memo (Grok stays 30d w/ bake-off + kill criterion; Teams crew = slow path; pre-registered promotion quorum) in docs/.

## Verification (Tue 07-07)
1. 08:30 ET thesis run #2 (uniformity watch). 2. chart_vision_api=chat_completions_primary. 3. [RCF_OBS] drop lines w/ shadow_both_required_pass. 4. No trace errors. 5. Heartbeat rows accumulating.
