
// QTP Supabase Main Trading pause guard context formatter v4.2.1
const original = $('Prepare Supabase Pause Guard Query').first().json || {};
const row = ($input.first() && $input.first().json) || {};
return [{ json: { ...original, _supabase_pause_control: row, _pause_guard_source: 'supabase.entry_pause_control' } }];
