# QTP Batch — 2026-07-07 (TSM protection ladder, AFTO v4.3.2, lifecycle ingestor, gate registry, arch v5.9)

## Shipped
1. **TSM v4.3.0→v4.3.2** (active 1e790e21; chain b876d429→860cc8cc→c41e30cf→1e790e21): stop-width sanity (held legs >1.2% → cancel/replace 0.9% GTC), naked-position recovery (UNPROTECTED_AUDIT_ONLY → GTC stop; verified live: F buy-stop 13.86, order 7422286b), EOD leg-cancel + 403 retry + 15:30 window, orphan-carryover flatten (recovery-stop-only carryovers flattened; organic-stop swings exempt; kill switch QTP_ORPHAN_FLATTEN_ENABLED).
2. **AFTO v4.3.2** (active 9c2bc8fd): after-hours pause-advisory spam fixed (zero-signal leg session-gated 09:40–16:00 ET).
3. **NEW: QTP Order Lifecycle Ingestor** (n31KzRDp6wR5BlFb, active ba2ecc0c): polls Alpaca orders (all states + nested legs) every 10 min → quantum.order_events with NOT-EXISTS dedup. First run: 500 rows incl. 262 CANCELED / 4 NEW / 1 EXPIRED / 1 REJECTED previously invisible. Closes G22.
4. **Gate registry** (migration qtp_gate_registry_and_evidence_runs_20260707): quantum.gate_registry + gate_evidence_runs; 24 gates chartered — 12 FILTERS (on 60-day expectancy trial: MTF, VC, BIAS, RCF, L1/L2/L4/L5-F/L6/L9-F/L13-F/EQ), 8 GUARDS (scenario+fire-drill: L3/L5-G/L7/L10/L11/L13-G/RISK/TSM), 4 GUARD_OPERATIONAL (L8/L9-G/L12/L14). Mixed layers split per Conclave. Rule: unclassified gates may not block live.
5. **Cost-model self-validation v0** (docs/): 19 fills Jul 6–7 vs 1-min reference → mean −13.2bp/side (median −9.2), ≈ −20bp+ round trip under all-market-order execution. The zero-cost assumption consumed the entire +15bp Phase-0 gross edge — measured, not assumed, per Conclave Q6.

## Incidents closed (Jul 7)
Frozen book: naked F short (v4.3.0 coverage hole) tripped Risk Gate blocks_new_entries → 0 entries until v4.3.1 protected F at 18:15Z; book unfroze and traded (incl. pipeline BUY entry CBRE 19:01Z — first gate-passed BUY). Risk Gate behaved CORRECTLY (chartered as GUARD).

## Architecture v5.9 — Conclave-ratified with amendments (docs/)
Filter/Guard doctrine; Discovery air-gapped; Regime Service added; G14-lite staging NOW; D5 milestone = statistical gate (day-block bootstrap, regime coverage, cost floor); cost model self-validates before gating.

## Next: G14-lite shadow clone → Regime Service → ATR bracket re-fit → 07-20 first calibration-gated promotion.
