// PF_MARGIN Executor v1.0 - Option 2 PF_MARGIN paper bypass
// Inputs: $input.first().json = output of PF_MARGIN Bypass Gate
// Modes:
//   skip                  -> passthrough (no Alpaca, no insert downstream; Trade Insert SQL must no-op)
//   dry_run               -> NO Alpaca call. Build "executor_result" with intended order, no order_id, no fill.
//   test_cancel           -> Submit MARKET order via Alpaca paper API, then CANCEL within 5s. Record everything.
//   panic_live_not_wired  -> Log + emit panic marker. NO Alpaca call. NO insert.
// LIVE branch is intentionally absent: PANIC handled above. Tomorrow's PUT wires LIVE exit handler.

const j = $input.first()?.json || {};

function fail(reason, extra={}) {
  return [{ json: { ...j, _pfm_executor_status: 'fail', _pfm_executor_reason: reason, _pfm_executor_result: null, ...extra } }];
}

// Passthrough: if Bypass Gate already decided skip, just forward (Trade Insert handles no-op).
if (j._pfm_routed !== true) {
  return [{ json: { ...j, _pfm_executor_status: 'noop_skip', _pfm_executor_reason: j._pfm_reason || 'gate_skip', _pfm_executor_result: null } }];
}

const mode = String(j._pfm_route_mode || '').toLowerCase();
const symbol = String(j._pfm_symbol || '').toUpperCase();
const ap = j._pfm_alpaca_payload || {};
const is_test = j._pfm_is_test_injection === true;

// PANIC: LIVE path
if (mode === 'panic_live_not_wired') {
  console.error('[EXP-PFM][PANIC] LIVE branch reached but exit-handler not wired. Aborting. flag_value=' + j._pfm_flag_value);
  return [{ json: { ...j, _pfm_executor_status: 'panic_refuse', _pfm_executor_reason: 'LIVE_branch_unwired_refused', _pfm_executor_result: null } }];
}

// DRY_RUN: build executor_result without any Alpaca side effects
if (mode === 'dry_run') {
  const result = {
    mode: 'dry_run',
    intended_payload: ap,
    alpaca_order_id: null,
    alpaca_status: null,
    submission_intended_price: null,
    filled_avg_price: null,
    submission_ts: new Date().toISOString(),
    exit_reason: 'DRY_RUN_NO_ALPACA',
    notional_filled: 0,
    buying_power_delta: 0
  };
  return [{ json: { ...j, _pfm_executor_status: 'ok', _pfm_executor_reason: 'dry_run_no_alpaca_call', _pfm_executor_result: result } }];
}

// TEST_CANCEL (Step F): real Alpaca paper, submit then cancel
if (mode === 'test_cancel') {
  // Resolve credentials & base URL — mirror Alpaca Paper Trade pattern
  const _creds = $getWorkflowStaticData('global');
  const _credsStore = (_creds && _creds._credentials) || {};
  const ALPACA_KEY = $vars?.ALPACA_API_KEY || $vars?.ALPACA_KEY_ID || _credsStore.alpaca_api_key || '';
  const ALPACA_SEC = $vars?.ALPACA_SECRET_KEY || $vars?.ALPACA_SECRET || _credsStore.alpaca_secret_key || '';
  if (!ALPACA_KEY || !ALPACA_SEC) {
    return fail('alpaca_creds_missing_failclosed');
  }
  const BASE = $vars?.ALPACA_BASE_URL || _credsStore.alpaca_base || 'https://paper-api.alpaca.markets';
  if (!String(BASE).toLowerCase().includes('paper')) {
    return fail('alpaca_base_not_paper_endpoint_refused', { _pfm_executor_base: BASE });
  }
  const HDR = {
    'APCA-API-KEY-ID': ALPACA_KEY,
    'APCA-API-SECRET-KEY': ALPACA_SEC,
    'Content-Type': 'application/json'
  };

  // PRE-CHECK: capture buying_power baseline (architect ask)
  let baseline_buying_power = null;
  try {
    const acct = await $helpers.httpRequest({
      method: 'GET', url: BASE + '/v2/account', headers: HDR, json: true, timeout: 5000
    });
    baseline_buying_power = Number(acct?.buying_power ?? acct?.cash ?? NaN);
  } catch (e) {
    return fail('account_read_failed:' + (e.message || e).toString().slice(0,200));
  }

  // SUBMIT
  let order = null, order_err = null;
  const submission_ts = new Date().toISOString();
  try {
    order = await $helpers.httpRequest({
      method: 'POST', url: BASE + '/v2/orders', headers: HDR,
      body: ap, json: true, timeout: 8000
    });
  } catch (e) {
    order_err = (e.message || String(e)).slice(0, 400);
    return fail('alpaca_submit_failed:' + order_err, { _pfm_executor_baseline_buying_power: baseline_buying_power });
  }
  const order_id = order?.id || null;
  if (!order_id) return fail('alpaca_submit_no_order_id', { _pfm_executor_baseline_buying_power: baseline_buying_power, _pfm_executor_submit_response: order });

  // CANCEL immediately (within 5s requirement)
  const cancel_ts = new Date().toISOString();
  let cancel_status = 'unknown';
  let cancel_err = null;
  try {
    await $helpers.httpRequest({
      method: 'DELETE', url: BASE + '/v2/orders/' + encodeURIComponent(order_id), headers: HDR, json: true, timeout: 5000
    });
    cancel_status = 'requested';
  } catch (e) {
    cancel_err = (e.message || String(e)).slice(0,400);
    cancel_status = 'cancel_error:' + cancel_err;
  }

  // VERIFY: re-read order to confirm status
  let final_order = null;
  try {
    final_order = await $helpers.httpRequest({
      method: 'GET', url: BASE + '/v2/orders/' + encodeURIComponent(order_id), headers: HDR, json: true, timeout: 5000
    });
  } catch (_) {}

  // POST-CHECK: re-read buying_power
  let post_buying_power = null;
  try {
    const acct2 = await $helpers.httpRequest({
      method: 'GET', url: BASE + '/v2/account', headers: HDR, json: true, timeout: 5000
    });
    post_buying_power = Number(acct2?.buying_power ?? acct2?.cash ?? NaN);
  } catch (_) {}

  const buying_power_delta = (Number.isFinite(baseline_buying_power) && Number.isFinite(post_buying_power))
    ? Math.abs(post_buying_power - baseline_buying_power)
    : null;

  const result = {
    mode: 'test_cancel',
    intended_payload: ap,
    alpaca_order_id: order_id,
    alpaca_status: String(final_order?.status || order?.status || 'unknown'),
    cancel_requested_at: cancel_ts,
    cancel_status: cancel_status,
    submission_ts: submission_ts,
    submission_intended_price: null,  // market order, no intended limit; brief Q5: use filled_avg_price first
    filled_avg_price: final_order?.filled_avg_price != null ? Number(final_order.filled_avg_price) : null,
    exit_reason: 'TEST_CANCEL',
    notional_filled: Number(final_order?.filled_qty || 0) * Number(final_order?.filled_avg_price || 0),
    baseline_buying_power: baseline_buying_power,
    post_buying_power: post_buying_power,
    buying_power_delta: buying_power_delta,
    raw_submit_response: order,
    raw_final_order: final_order
  };

  // Architect ask: assert |delta| < $0.50
  if (buying_power_delta != null && buying_power_delta >= 0.50) {
    return [{ json: { ...j, _pfm_executor_status: 'warn', _pfm_executor_reason: 'buying_power_delta_exceeds_threshold:' + buying_power_delta.toFixed(4), _pfm_executor_result: result } }];
  }

  return [{ json: { ...j, _pfm_executor_status: 'ok', _pfm_executor_reason: 'submit_then_cancel_ok', _pfm_executor_result: result } }];
}

// PAPER_FILL_V1: submit a bounded WHOLE-SHARE market order and HOLD (no cancel). Exit via T+60m sweep.
//   Whole-share (not notional) because Alpaca rejects fractional SHORT sales; sized <= notional cap.
if (mode === 'paper_fill') {
  if (!symbol) return fail('empty_symbol_failclosed');
  const _creds = $getWorkflowStaticData('global');
  const _credsStore = (_creds && _creds._credentials) || {};
  const ALPACA_KEY = $vars?.ALPACA_API_KEY || $vars?.ALPACA_KEY_ID || _credsStore.alpaca_api_key || '';
  const ALPACA_SEC = $vars?.ALPACA_SECRET_KEY || $vars?.ALPACA_SECRET || _credsStore.alpaca_secret_key || '';
  if (!ALPACA_KEY || !ALPACA_SEC) return fail('alpaca_creds_missing_failclosed');
  const BASE = $vars?.ALPACA_BASE_URL || _credsStore.alpaca_base || 'https://paper-api.alpaca.markets';
  if (!String(BASE).toLowerCase().includes('paper')) {
    return fail('alpaca_base_not_paper_endpoint_refused', { _pfm_executor_base: BASE });
  }
  const HDR = { 'APCA-API-KEY-ID': ALPACA_KEY, 'APCA-API-SECRET-KEY': ALPACA_SEC, 'Content-Type': 'application/json' };
  const NOTIONAL_CAP = (Number(j._pfm_notional_cap) > 0) ? Number(j._pfm_notional_cap) : 50.0;
  const _sideRaw = String(j._pfm_side || '').toUpperCase();
  let sideLc;
  if (_sideRaw === 'BUY' || _sideRaw === 'LONG') sideLc = 'buy';
  else if (_sideRaw === 'SELL' || _sideRaw === 'SHORT') sideLc = 'sell';
  else return fail('invalid_side_failclosed:' + _sideRaw);
  // PRICE: latest trade (IEX free feed) to size whole shares
  let refPrice = null;
  try {
    const q = await $helpers.httpRequest({ method: 'GET', url: 'https://data.alpaca.markets/v2/stocks/' + encodeURIComponent(symbol) + '/trades/latest?feed=iex', headers: HDR, json: true, timeout: 5000 });
    refPrice = Number(q?.trade?.p ?? NaN);
  } catch (e) { return fail('price_fetch_failed:' + (e.message || e).toString().slice(0,200)); }
  if (!Number.isFinite(refPrice) || refPrice <= 0) return fail('price_unavailable_failclosed');
  const qty = Math.floor(NOTIONAL_CAP / refPrice);
  if (qty < 1) return [{ json: { ...j, _pfm_executor_status: 'noop_skip', _pfm_executor_reason: 'price_over_notional_cap:' + refPrice.toFixed(2), _pfm_executor_result: null } }];
  // baseline buying power
  let baseline_buying_power = null;
  try {
    const acct = await $helpers.httpRequest({ method: 'GET', url: BASE + '/v2/account', headers: HDR, json: true, timeout: 5000 });
    baseline_buying_power = Number(acct?.buying_power ?? acct?.cash ?? NaN);
  } catch (e) { return fail('account_read_failed:' + (e.message || e).toString().slice(0,200)); }
  // SUBMIT whole-share market order, then HOLD (no DELETE)
  const order_payload = { symbol: symbol, qty: String(qty), side: sideLc, type: 'market', time_in_force: 'day', client_order_id: 'EXP-PFM-FILL-' + Date.now() + '-' + Math.random().toString(36).slice(2,8) };
  const submission_ts = new Date().toISOString();
  let order = null;
  try {
    order = await $helpers.httpRequest({ method: 'POST', url: BASE + '/v2/orders', headers: HDR, body: order_payload, json: true, timeout: 8000 });
  } catch (e) { return fail('alpaca_paper_fill_submit_failed:' + (e.message || String(e)).slice(0,300), { _pfm_executor_baseline_buying_power: baseline_buying_power }); }
  const order_id = order?.id || null;
  if (!order_id) return fail('alpaca_paper_fill_no_order_id', { _pfm_executor_submit_response: order });
  // poll once for fill (NO cancel)
  let final_order = null;
  try { final_order = await $helpers.httpRequest({ method: 'GET', url: BASE + '/v2/orders/' + encodeURIComponent(order_id), headers: HDR, json: true, timeout: 5000 }); } catch (_) {}
  const filled_avg_price = (final_order?.filled_avg_price != null) ? Number(final_order.filled_avg_price) : null;
  const filled_qty = Number(final_order?.filled_qty || 0);
  const result = {
    mode: 'paper_fill', intended_payload: order_payload, ref_price: refPrice, qty: qty,
    alpaca_order_id: order_id, alpaca_status: String(final_order?.status || order?.status || 'unknown'),
    submission_ts: submission_ts, submission_intended_price: refPrice,
    filled_avg_price: filled_avg_price, exit_reason: 'HELD_AWAITING_EXIT',
    pending_fill: filled_qty < 1,
    notional_filled: (filled_qty > 0 ? filled_qty * Number(filled_avg_price || refPrice) : qty * refPrice),
    baseline_buying_power: baseline_buying_power, raw_submit_response: order, raw_final_order: final_order
  };
  return [{ json: { ...j, _pfm_executor_status: 'ok', _pfm_executor_reason: 'paper_fill_held', _pfm_executor_result: result } }];
}

// Unknown mode → fail closed
return fail('unknown_route_mode:' + mode);
