
// QTP Supabase Candidate Trace result formatter v4.2.1
const original = $('QTP-10FC Candidate Trace Logger').first().json || {};
const result = ($input.first() && $input.first().json) || {};
return [{ json: { ...original, _10fc_trace_v2_persisted: true, _candidate_trace_insert_status: result.candidate_trace_status || 'INSERTED_SUPABASE', _candidate_trace_insert_source: 'supabase' } }];
