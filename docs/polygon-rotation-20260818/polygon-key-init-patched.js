// QTP_POLYGON_KEY_INJECT_v2_gov227_20260818 — key rotation support.
// v1 seeded a HARDCODED key literal into staticData, and only when absent — so a rotated key
// could never propagate, and the literal lived in every export and version snapshot. v2: the
// key comes from n8n Variables BY NAME ($vars.POLYGON_API_KEY, fallback $vars.POLYGON_KEY)
// and ALWAYS overwrites staticData on drift, so rotating = edit the Variable once; the next
// 10-min run propagates it here and Watchlist and Config picks it up unchanged.
// Deploy-safe BEFORE the Variable exists: if staticData already holds a key (seeded by v1),
// keep running on it and WARN. Once the Variable exists it wins, permanently.
const state = $getWorkflowStaticData('global');
state._credentials = state._credentials || {};
let _pk = null;
try { if (typeof $vars !== 'undefined' && $vars) { _pk = $vars.POLYGON_API_KEY || $vars.POLYGON_KEY || null; } } catch (e) {}
_pk = _pk ? String(_pk).trim() : null;
if (!_pk) {
  if (state._credentials.polygon_api_key) {
    console.log('[POLYGON KEY INIT v2] WARN: $vars.POLYGON_API_KEY missing - still running on the staticData key. Seed the Variable to complete rotation.');
    return $input.all();
  }
  throw new Error('POLYGON_KEY_INIT_v2: n8n variable POLYGON_API_KEY missing and no staticData fallback. Seed it under n8n -> Variables.');
}
if (state._credentials.polygon_api_key !== _pk) {
  state._credentials.polygon_api_key = _pk;
  console.log('[POLYGON KEY INIT v2] staticData key updated from $vars (len=' + _pk.length + ')');
} else {
  console.log('[POLYGON KEY INIT v2] staticData matches $vars (len=' + _pk.length + ')');
}
// Pass-through: forward $input items unchanged so downstream is unaffected.
return $input.all();
