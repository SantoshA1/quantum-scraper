
// QTP Supabase VC API health result formatter v4.2.1
const original = $('VC API Health Logger').first().json || {};
const row = ($input.first() && $input.first().json) || {};
return [{ json: { ...original, _vc_api_health_log_status: row.vc_health_status || 'INSERTED_SUPABASE' } }];
