const raw = $input.first().json;
const d = raw.body && raw.body.ticker ? raw.body : raw;
  // Skip sheet append for admin/kill-only actions (schema mismatch)
  const _shadowAction2 = (d._sm_action || '').toUpperCase();
  if (_shadowAction2 === 'ADMIN_CLEAR' || _shadowAction2 === 'TICKER_KILLED' || _shadowAction2 === 'COOLDOWN_BLOCK') {
    console.log('[SHADOW] Skip sheet for admin action: ' + _shadowAction2);
    return [];
  }
const state = $getWorkflowStaticData('global');

if (!state.shadowLog) {
  state.shadowLog = { lastLogTime: {}, lastScores: {}, todayCount: 0, lastDate: '' };
}
const sl = state.shadowLog;
const now = new Date();
const dateET = now.toLocaleDateString('en-US', { timeZone: 'America/New_York' });
const timeET = now.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false });
const timestampET = now.toLocaleString('en-US', { timeZone: 'America/New_York' });

if (sl.lastDate !== dateET) { sl.todayCount = 0; sl.lastDate = dateET; }

const ticker = (d.ticker || '').toString().toUpperCase();
const price = parseFloat(d.price) || 0;
const execution = (d.execution || 'STAND ASIDE').toString().toUpperCase();
const signal = (d.signal || 'NEUTRAL').toString().toUpperCase();
const timeframe = (d.timeframe || '5').toString();
const bullScore = parseFloat(d.bull_score) || 0;
const bearScore = parseFloat(d.bear_score) || 0;
const biasScore = parseFloat(d.bias_score) || 0;
const rsi = parseFloat(d.rsi) || 0;
const adx = parseFloat(d.adx) || 0;
const volRatio = parseFloat(d.volume_ratio) || 0;
const vix = parseFloat(d.vix) || 0;
const atr = parseFloat(d.atr) || 0;
const regime = (d.regime || '').toString();
const spyStatus = (d.spy_status || '').toString();
const qqqStatus = (d.qqq_status || '').toString();
const crossStatus = (d.cross_asset_status || '').toString();
const mtfBullCount = parseInt(d.mtf_bull_count) || 0;
const mtfBearCount = parseInt(d.mtf_bear_count) || 0;
const momEngine = (d.momentum_engine || '').toString().toLowerCase() === 'true';
const gapPct = parseFloat(d.gap_pct) || 0;
const eventType = (d._event_type || raw._event_type || 'NONE').toString();
const eventConf = parseFloat(d._event_confidence || raw._event_confidence) || 0;

const atrPct = price > 0 ? (atr / price) * 100 : 2.0;
const effMinScore = atrPct >= 3.0 ? 48 : atrPct >= 1.5 ? 45 : 42;
const bullScoreGap = Math.round((bullScore - effMinScore) * 10) / 10;
const bearScoreGap = Math.round((bearScore - effMinScore) * 10) / 10;
const mtfBullGap = mtfBullCount - 2;
const mtfBearGap = mtfBearCount - 2;
const hypSL = atrPct >= 3.0 ? atr * 1.5 : atrPct >= 1.5 ? atr * 1.3 : atr * 1.1;
const hypTP = hypSL * 2.0;

let shadowDir = 'NEUTRAL';
let shadowConf = 0;
if (bullScore > bearScore + 3) { shadowDir = 'BULLISH'; shadowConf = Math.min(100, Math.round(bullScore)); }
else if (bearScore > bullScore + 3) { shadowDir = 'BEARISH'; shadowConf = Math.min(100, Math.round(bearScore)); }

const dedupKey = ticker + '_' + timeframe;
const lastTime = sl.lastLogTime[dedupKey] || '';
const lastScores = sl.lastScores[dedupKey] || { bull: 0, bear: 0 };
const timeSince = lastTime ? (now.getTime() - new Date(lastTime).getTime()) : 999999;
const scoreDelta = Math.abs(bullScore - lastScores.bull) + Math.abs(bearScore - lastScores.bear);
const isNewSignal = execution !== 'STAND ASIDE';
const shouldLog = isNewSignal || timeSince >= 300000 || scoreDelta >= 5;

let logReason = 'SKIPPED';
if (shouldLog && ticker) {
  sl.lastLogTime[dedupKey] = now.toISOString();
  sl.lastScores[dedupKey] = { bull: bullScore, bear: bearScore };
  sl.todayCount += 1;
  logReason = isNewSignal ? 'NEW_SIGNAL' : scoreDelta >= 5 ? 'SCORE_CHANGE' : 'PERIODIC';
}

if (!shouldLog || !ticker) return [];

return [{ json: {
  Timestamp: timestampET,
  Shadow_ID: ticker + '_' + timeframe + '_' + now.toISOString().replace(/[^0-9]/g, '').slice(0, 14),
  Backfill_Status: 'PENDING',Date: dateET, Time_ET: timeET, Ticker: ticker, Timeframe: timeframe, Price: price,
  Actual_Execution: execution, Actual_Signal: signal,
  Bull_Score: bullScore, Bear_Score: bearScore, Score_Spread: Math.round((bullScore - bearScore) * 10) / 10,
  Bull_Score_Gap: bullScoreGap, Bear_Score_Gap: bearScoreGap,
  MTF_Bull_Gap: mtfBullGap, MTF_Bear_Gap: mtfBearGap,
  ADX_Gap: Math.round((adx - 15) * 10) / 10, Vol_Gap: Math.round((volRatio - 0.5) * 100) / 100,
  Min_Score: effMinScore, RSI: rsi, ADX: adx, VIX: vix, Vol_Ratio: volRatio,
  Regime: regime, SPY_Status: spyStatus, Cross_Status: crossStatus,
  MTF_Bull: mtfBullCount, MTF_Bear: mtfBearCount,
  Momentum: momEngine, Event_Type: eventType, Gap_Pct: gapPct,
  Shadow_Dir: shadowDir, Shadow_Conf: shadowConf,
  Hyp_Entry: price,
  Hyp_SL_Long: Math.round((price - hypSL) * 100) / 100,
  Hyp_TP_Long: Math.round((price + hypTP) * 100) / 100,
  Hyp_SL_Short: Math.round((price + hypSL) * 100) / 100,
  Hyp_TP_Short: Math.round((price - hypTP) * 100) / 100,
  Out_1h: '', Out_4h: '', Out_EOD: '', Dir_Correct: '', SL_Hit_L: '', TP_Hit_L: '', SL_Hit_S: '', TP_Hit_S: '',
  Log_Reason: logReason, Log_Num: sl.todayCount
}}];