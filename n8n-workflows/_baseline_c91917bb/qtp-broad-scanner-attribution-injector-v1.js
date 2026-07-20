// QTP Broad Scanner Attribution Injector v1 20260522
// Adds missing strategy attribution fields for TradingView alert() payloads
// whose JSON is generated inside Pine and is not editable in the TradingView UI.
// Additive only: does not overwrite real incoming strategy_id/name/setup fields.

const ATTRIBUTION_INJECTOR_VERSION = 'QTP_BROAD_SCANNER_ATTRIBUTION_INJECTOR_v1_20260522';
const item = $input.first().json || {};
const body = item.body && typeof item.body === 'object' ? item.body : {};
const root = { ...item };

const clean = (v) => {
  if (v === undefined || v === null) return '';
  return String(v).trim();
};
const present = (v) => {
  const s = clean(v);
  return s !== '' && s.toUpperCase() !== 'N/A' && s.toUpperCase() !== 'UNKNOWN';
};
const pick = (...vals) => {
  for (const v of vals) if (present(v)) return clean(v);
  return '';
};

const sourceText = [
  root.alert_name, body.alert_name,
  root.signal_source, body.signal_source,
  root.qtp_source, body.qtp_source,
  root.source, body.source,
  root.script_name, body.script_name,
  root.indicator_name, body.indicator_name,
  root.strategy_name, body.strategy_name,
  root.strategy, body.strategy,
  root.order_intent, body.order_intent,
  root.qtp_go_live_version, body.qtp_go_live_version
].map(clean).join('|').toUpperCase();

const isQtpPayload = /QTP|QUANTUM|BROAD_SCANNER|BROAD SCANNER|SCALP|SWING/.test(sourceText)
  || present(root.qtp_source) || present(body.qtp_source)
  || present(root.qtp_go_live_version) || present(body.qtp_go_live_version)
  || present(root.signal_source) || present(body.signal_source);

if (!isQtpPayload) {
  return [{
    json: {
      ...root,
      _strategy_attribution_injector_checked: true,
      _strategy_attribution_injector_applied: false,
      _strategy_attribution_injector_version: ATTRIBUTION_INJECTOR_VERSION
    }
  }];
}

const timeframe = pick(root.timeframe, body.timeframe, root.interval, body.interval, root.tf, body.tf) || 'N/A';
const existingStrategyId = pick(root.strategy_id, body.strategy_id, root.strategy, body.strategy, root.strategy_name, body.strategy_name);
const existingStrategyName = pick(root.strategy_name, body.strategy_name, root.strategyName, body.strategyName, root.strategy, body.strategy);
const existingSetupType = pick(root.setup_type, body.setup_type, root.setupType, body.setupType, root.signal_type, body.signal_type, root.module, body.module);
const existingAlertName = pick(root.alert_name, body.alert_name, root.alertName, body.alertName, root.signal_name, body.signal_name, root.source, body.source, root.signal_source, body.signal_source);

const injected = {
  strategy_id: existingStrategyId || 'BROAD_SCANNER',
  strategy_name: existingStrategyName || 'Broad Scanner',
  setup_type: existingSetupType || timeframe,
  alert_name: existingAlertName || 'BROAD_SCANNER',
  _strategy_attribution_injector_checked: true,
  _strategy_attribution_injector_applied: true,
  _strategy_attribution_injector_version: ATTRIBUTION_INJECTOR_VERSION
};

const patchedBody = Object.keys(body).length
  ? {
      ...body,
      strategy_id: present(body.strategy_id) ? body.strategy_id : injected.strategy_id,
      strategy_name: present(body.strategy_name) ? body.strategy_name : injected.strategy_name,
      setup_type: present(body.setup_type) ? body.setup_type : injected.setup_type,
      alert_name: present(body.alert_name) ? body.alert_name : injected.alert_name,
      _strategy_attribution_injector_checked: true,
      _strategy_attribution_injector_applied: true,
      _strategy_attribution_injector_version: ATTRIBUTION_INJECTOR_VERSION
    }
  : body;

return [{
  json: {
    ...root,
    body: Object.keys(body).length ? patchedBody : root.body,
    strategy_id: present(root.strategy_id) ? root.strategy_id : injected.strategy_id,
    strategy_name: present(root.strategy_name) ? root.strategy_name : injected.strategy_name,
    setup_type: present(root.setup_type) ? root.setup_type : injected.setup_type,
    alert_name: present(root.alert_name) ? root.alert_name : injected.alert_name,
    _strategy_attribution_injector_checked: true,
    _strategy_attribution_injector_applied: true,
    _strategy_attribution_injector_version: ATTRIBUTION_INJECTOR_VERSION
  }
}];