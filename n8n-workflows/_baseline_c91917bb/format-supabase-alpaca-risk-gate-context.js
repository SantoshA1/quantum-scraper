
// QTP Supabase Main Trading Alpaca risk gate formatter v4.2.1
const original = $('Prepare Supabase Alpaca Risk Gate Query').first().json || {};
const row = ($input.first() && $input.first().json) || {};
return [{ json: { ...original, _supabase_risk_gate_status: row, risk_gate_source: 'supabase.position_risk_state' } }];
