
// QTP Supabase Telegram recovery context formatter v4.2.1
const original = $('Prepare Supabase Telegram Recovery Query').first().json || {};
const row = ($input.first() && $input.first().json) || {};
const recovery = row && row.order_status ? row : null;
return [{ json: { ...original, _supabase_tg_recovery_order: recovery, _telegram_recovery_source: 'supabase.order_events' } }];
