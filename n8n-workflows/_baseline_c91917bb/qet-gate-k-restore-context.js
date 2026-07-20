// Phase 2 (2026-07-10): restores the original pipeline item AND applies gate-driven sizing.
// APT honors prev.order_qty when > 0, so the override is the entire sizing handoff.
// Skipped/unsized verdicts leave legacy sizing untouched (fail-open consistency).
const orig = $('QET Gate-K Prep').first().json;
const v = $input.first().json.verdict || {};
const useQty = v.approved === true && v.skipped !== true && Number(v.qty) > 0;
const out = { ...orig, __qet_gate: {
  approved: true,
  skipped: v.skipped === true,
  reason: v.reason || null,
  qty: v.qty == null ? null : Number(v.qty),
  risk_pct: v.risk_pct == null ? null : Number(v.risk_pct),
  risk_dollars: v.risk_dollars == null ? null : Number(v.risk_dollars),
  concentration: v.concentration || null,
  regime: v.regime || null,
  gate_version: v.gate_version || null,
  sized_by_gate: useQty
} };
if (useQty) { out.order_qty = Number(v.qty); }
return [{ json: out }];