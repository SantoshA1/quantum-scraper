// QTP_EXT_HOURS_MODE_GATE_v1_20260527
// Operational toggle. Default is regular-hours-only. Paper-only extended-hours
// can be enabled by setting qtp_full_extended_hours_mode=true upstream.

const item = $input.first().json || {};
// QTP_EXT_HOURS_PAPER_ENABLE_v2_20260527: default paper-only extended-hours mode enabled.
const fullExtended = item.qtp_full_extended_hours_mode === false || String(item.qtp_full_extended_hours_mode || '').toLowerCase() === 'false' ? false : true;
const liveAllowed = item.qtp_extended_hours_live_allowed === true || String(item.qtp_extended_hours_live_allowed || '').toLowerCase() === 'true';
const isExt = item.is_extended_hours === true || String(item.is_extended_hours || '').toLowerCase() === 'true';

let extended_hours_mode = fullExtended ? 'FULL_EXTENDED_HOURS_PAPER' : 'REGULAR_HOURS_ONLY';
let extended_hours_execution_allowed = true;

if (isExt && !fullExtended) {
  extended_hours_execution_allowed = false;
}

if (isExt && liveAllowed) {
  // Hard safety default. A future live authorization patch must explicitly
  // remove this block and should not be bundled with session support.
  extended_hours_execution_allowed = false;
  extended_hours_mode = 'EXTENDED_HOURS_LIVE_BLOCKED';
}

if (!item.session_tradable_clock) {
  extended_hours_execution_allowed = false;
}

return [{
  json: {
    ...item,
    qtp_full_extended_hours_mode: fullExtended,
    qtp_extended_hours_live_allowed: false,
    qtp_extended_hours_paper_only: true,
    extended_hours_mode,
    extended_hours_execution_allowed,
    extended_hours_mode_gate_v: 'QTP_EXT_HOURS_MODE_GATE_v1_20260527'
  }
}];