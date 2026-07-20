// F1-B: persist gate_config snapshot to workflow staticData (read by QTP Bias Filter next execution).
// Only overwrites when rows actually loaded — on query failure/empty, last-known config is kept
// and the Bias Filter's defaults are fail-closed (cohort off = enforce as before).
const sd = $getWorkflowStaticData('global');
const cfg = {};
for (const item of $input.all()) {
  const j = item.json || {};
  if (j.constant_name != null && j.live_value != null && Number.isFinite(Number(j.live_value))) {
    cfg[j.constant_name] = Number(j.live_value);
  }
}
if (Object.keys(cfg).length > 0) {
  sd._gateConfig = cfg;
  sd._gateConfigSyncedAt = new Date().toISOString();
}
return [{ json: { synced: Object.keys(cfg).length, at: sd._gateConfigSyncedAt || null, cohort_active: cfg.expansion_cohort_active ?? null, mtf_hard_floor: cfg.mtf_hard_floor ?? null } }];