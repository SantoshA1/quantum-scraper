// QTP ALPACA PAPER-ONLY GUARD v4.2.7
// Hard stop against accidental live routing. Does not place/cancel/modify orders.
const out = [];
for (const item of items) {
  const d = item.json || {};
  if (d.test_mode === true || d.test_mode === 'true') {
    out.push({ json: { ...d, alpaca_status: 'SKIPPED', alpaca_reason: 'Synthetic test mode — no paper order placed', qtp_paper_guard_status: 'TEST_SKIP', qtp_paper_guard_version: 'QTP_ALPACA_PAPER_ONLY_GUARD_v4.2.7' } });
    continue;
  }
  const env = String(d.qtp_trading_env || d.alpaca_env || $vars.QTP_TRADING_ENV || $vars.ALPACA_ENV || 'paper').toLowerCase();
  const baseUrl = String($vars.ALPACA_BASE_URL || 'https://paper-api.alpaca.markets').toLowerCase();
  if (env !== 'paper') throw new Error(`QTP PAPER GUARD BLOCKED: env=${env}. This wiring is paper-only.`);
  if (!baseUrl.includes('paper-api.alpaca.markets')) throw new Error('QTP PAPER GUARD BLOCKED: ALPACA_BASE_URL is not paper endpoint.');
  if (d.qtp_live_trading_allowed === true) throw new Error('QTP PAPER GUARD BLOCKED: qtp_live_trading_allowed=true is forbidden in paper wiring.');
  out.push({ json: { ...d, qtp_trading_env: 'paper', alpaca_env: 'paper', qtp_live_trading_allowed: false, qtp_paper_guard_status: 'PASS', qtp_paper_guard_version: 'QTP_ALPACA_PAPER_ONLY_GUARD_v4.2.7' } });
}
return out;