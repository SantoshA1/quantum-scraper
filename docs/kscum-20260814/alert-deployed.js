const j = $input.first().json;
const prev = $('Fetch Alpaca Day PnL').first().json;
const tripped = j.pnl_trip === true || j.stop_trip === true || j.cum_trip === true;
const blind = prev.account_ok !== true;
const t = (typeof $vars !== 'undefined' && $vars.TELEGRAM_BOT_TOKEN) || '';
if ((tripped || blind) && t) {
  let text;
  if (j.cum_trip === true) {
    text = '🛑🛑 EXPANSION CUMULATIVE HALT — cohort NET ' + j.cohort_cum_net + ' USD over ' + j.cohort_trades + ' trades breached -2500. New entries paused 30d; Conclave RECONVENE required before resume.';
  } else if (tripped) {
    text = '🛑 EXPANSION KILL-SWITCH TRIPPED — new entries paused until 16:30 ET. day_pnl=' + j.day_pnl + ' USD, stop_fills_today=' + j.stop_fills_today + ', pause_rows_written=' + j.pause_rows_written;
  } else {
    text = '⚠️ [KS-MON] Alpaca account unreadable this cycle — kill-switch P&L leg blind: ' + (prev.account_error || '?');
  }
  try {
    await this.helpers.httpRequest({ method: 'POST', url: 'https://api.telegram.org/bot' + t + '/sendMessage', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: 6648680513, text }), timeout: 6000 });
  } catch (_) { /* fail-soft */ }
}
return [{ json: { ...j, alerted: (tripped || blind) } }];