// QTP_POLYGON_KEY_INJECT_v1_20260527  [FIXTURE REDACTED-RECONSTRUCTED 2026-08-18:
// byte-identical in structure to the deployed node; the real 32-char key literal is replaced
// by a same-shape dummy so no secret enters the repo. The live sha is verified at deploy time.]
const state = $getWorkflowStaticData('global');
state._credentials = state._credentials || {};
if (!state._credentials.polygon_api_key) {
  state._credentials.polygon_api_key = "REDACTED0REDACTED0REDACTED0REDA0";
  console.log('[POLYGON KEY INIT] re-seeded staticData');
} else {
  console.log('[POLYGON KEY INIT] already present (len=' + state._credentials.polygon_api_key.length + ')');
}
// Pass-through: forward $input items unchanged so downstream is unaffected.
return $input.all();
