
// QTP Supabase WRO result formatter v4.2.1
const original = $('Prepare Supabase WRO Shadow Insert').first().json || {};
const row = ($input.first() && $input.first().json) || {};
const { __supabase_wro_sql, ...safe } = original;
return [{
  json: {
    ...safe,
    _wro_shadow_debug_insert_status: row.wro_insert_status || 'INSERTED',
    _optimization_recommendation_insert_status: Number(row.statement_count || 0) > 1 ? 'INSERTED' : 'NOT_REQUESTED',
    _wro_shadow_debug_sink: 'supabase.wro_shadow_entry_quality_421',
    _optimization_recommendation_sink: 'supabase.optimization_recommendations',
    _qtp_wro_insert_version: 'QTP_WRO_INSERT_PLUS_RECOMMENDER_SUPABASE_v4.2.1_20260515'
  }
}];
