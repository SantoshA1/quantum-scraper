// QTP_EXT_HOURS_SESSION_CLOCK_v1_20260527
// Additive session classifier for extended-hours support. Does not execute
// orders or bypass any existing VC/MTF/Risk gates.

const item = $input.first().json || {};
const now = item._test_now_et ? new Date(item._test_now_et) : new Date();
const parts = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour12: false,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  weekday: 'short'
}).formatToParts(now).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});

const hh = Number(parts.hour);
const mm = Number(parts.minute);
const minuteOfDay = hh * 60 + mm;
const weekday = parts.weekday;
const isWeekend = weekday === 'Sat' || weekday === 'Sun';

const PRE_OPEN = 4 * 60;
const REG_OPEN = 9 * 60 + 30;
const REG_CLOSE = 16 * 60;
const POST_CLOSE = 20 * 60;

let market_session = 'CLOSED';
let is_extended_hours = false;
let session_tradable_clock = false;
let next_transition = 'N/A';

if (isWeekend) {
  market_session = 'HOLIDAY';
  next_transition = 'NEXT_REGULAR_TRADING_DAY';
} else if (minuteOfDay >= PRE_OPEN && minuteOfDay < REG_OPEN) {
  market_session = 'PRE_MARKET';
  is_extended_hours = true;
  session_tradable_clock = true;
  next_transition = 'REGULAR_OPEN_09_30_ET';
} else if (minuteOfDay >= REG_OPEN && minuteOfDay < REG_CLOSE) {
  market_session = 'REGULAR';
  session_tradable_clock = true;
  next_transition = 'POST_MARKET_START_16_00_ET';
} else if (minuteOfDay >= REG_CLOSE && minuteOfDay < POST_CLOSE) {
  market_session = 'POST_MARKET';
  is_extended_hours = true;
  session_tradable_clock = true;
  next_transition = 'MARKET_CLOSED_20_00_ET';
}

return [{
  json: {
    ...item,
    market_session,
    is_extended_hours,
    session_tradable_clock,
    session_transition_reason: next_transition,
    session_clock_v: 'QTP_EXT_HOURS_SESSION_CLOCK_v1_20260527',
    _session_clock_checked_at: now.toISOString()
  }
}];