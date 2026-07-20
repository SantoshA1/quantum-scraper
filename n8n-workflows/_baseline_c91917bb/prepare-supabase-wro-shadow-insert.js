
// QTP Supabase WRO Shadow + Optimization Recommendation Insert prep v4.2.1
const d = $json || {};
const statements = [];
if (d._wro_shadow_debug_sql) statements.push(d._wro_shadow_debug_sql);
if (d._optimization_recommendation_sql) statements.push(d._optimization_recommendation_sql);
const sql = statements.length
  ? statements.join(';\n') + `;\nSELECT 'INSERTED' AS wro_insert_status, ${statements.length}::int AS statement_count;`
  : `SELECT 'SKIPPED_NO_SQL' AS wro_insert_status, 0::int AS statement_count;`;
return [{ json: { ...d, __supabase_wro_sql: sql, _qtp_wro_insert_version: 'QTP_WRO_INSERT_PLUS_RECOMMENDER_SUPABASE_v4.2.1_20260515' } }];
