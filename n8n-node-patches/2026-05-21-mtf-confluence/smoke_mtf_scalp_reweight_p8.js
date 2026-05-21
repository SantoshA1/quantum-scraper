const fs = require('fs');

const engineCode = fs.readFileSync('/home/user/workspace/outputs/mtf_confluence_engine_deployed_scalp_reweight_v62_20260521T023005Z.js', 'utf8');
const aiCode = fs.readFileSync('/home/user/workspace/outputs/mtf_ai_judge_node.txt', 'utf8');
const mergeCode = fs.readFileSync('/home/user/workspace/outputs/merge_mtf_ai_verdict_patched_audit_visibility_20260521T021854Z.js', 'utf8');

function runCode(code, items) {
  const $input = { all: () => items, first: () => items[0] };
  return Function('items', '$input', code)(items, $input);
}

function runChain(json) {
  let items = [{ json: { ...json } }];
  items = runCode(engineCode, items);
  items = runCode(aiCode, items);
  items = runCode(mergeCode, items);
  return items[0].json;
}

function pick(j) {
  return {
    ticker: j.ticker,
    execution: j.execution,
    alert_type: j.alert_type,
    strategy: j.strategy,
    _vc_verdict: j._vc_verdict,
    _vc_kill_preserved: j._vc_kill_preserved,
    _vc_kill_reason: j._vc_kill_reason,
    blocked_stage: j.blocked_stage,
    version: j.mtf_confluence_engine_v,
    profile: j.timeframe_profile,
    scalp: j.scalp_confluence_score,
    swing: j.swing_confluence_score,
    long_term: j.long_term_confluence_score,
    mtf_confluence_score: j.mtf_confluence_score,
    mtf_confluence_decision: j.mtf_confluence_decision,
    ai_mtf_confluence_score: j.ai_mtf_confluence_score,
    ai_mtf_decision: j.ai_mtf_decision,
    final_mtf_confluence_decision: j.final_mtf_confluence_decision,
    final_mtf_confluence_pass: j.final_mtf_confluence_pass,
    _mtf_block_reason: j._mtf_block_reason,
    _mtf_block_version: j._mtf_block_version
  };
}

const baseStrong = {
  execution: 'BUY',
  signal: 'BUY',
  side: 'BUY',
  action: 'BUY',
  price: 85,
  timeframe: '5',
  alert_type: 'STANDARD',
  strategy: 'SCALP',
  bias_score: 70,
  rsi: 55,
  macd: 0,
  volume_ratio: 1.4,
  vwap: 85,
  sma50: 80,
  ema200: 80,
  strat_total_trades: 180,
  strat_profit_factor: 1.5,
  strat_win_rate: 55,
  options_regime: 'BULLISH',
  dark_pool_regime: 'ACCUMULATION',
  cross_asset: 'ALIGNED',
  weekly_regime: 'TREND_PASS',
  vix_regime: 'NORMAL',
  vc_score: 8.5,
  _dq_data_is_live: true,
  _dq_market_status: 'OPEN'
};

const tests = [
  {
    name: 'Test 1 JCI replay must now PASS',
    input: {
      execution: 'BUY',
      signal: 'BUY',
      side: 'BUY',
      action: 'BUY',
      ticker: 'JCI',
      price: 85,
      timeframe: '5',
      alert_type: 'STANDARD',
      strategy: 'SCALP',
      bias_score: 70,
      rsi: 55,
      macd: 0,
      volume_ratio: 1.0,
      vwap: 85,
      sma50: 80,
      ema200: 80,
      strat_total_trades: 180,
      strat_profit_factor: 1.5,
      strat_win_rate: 55,
      options_regime: 'BULLISH',
      cross_asset: 'ALIGNED',
      sector_regime: 'SECTOR_LAGGING',
      weekly_regime: 'TREND_PASS',
      vix_regime: 'NORMAL',
      _dq_data_is_live: true,
      _dq_market_status: 'OPEN'
    },
    check: (o) => o.final_mtf_confluence_decision === 'FINAL_MTF_CONFLUENCE_PASS' && o.mtf_confluence_score >= 65 && o.blocked_stage !== 'MTF_CONFLUENCE_BLOCK'
  },
  {
    name: 'Test 2 weak SCALP must still BLOCK',
    input: {
      ...baseStrong,
      ticker: 'WEAKSCALP',
      bias_score: 35,
      volume_ratio: 0.7,
      rsi: 50,
      strat_profit_factor: 0.8,
      strat_win_rate: 45,
      vc_score: 6,
      options_regime: 'NEUTRAL',
      dark_pool_regime: 'NEUTRAL',
      cross_asset: 'MIXED',
      weekly_regime: 'NEUTRAL',
      sma50: 90,
      ema200: 95
    },
    check: (o) => o.final_mtf_confluence_decision === 'FINAL_MTF_CONFLUENCE_BLOCK' && o.mtf_confluence_score < 65
  },
  {
    name: 'Test 3 KILL signal must still die',
    input: {
      ...baseStrong,
      ticker: 'TEST',
      bias_score: 45,
      options_regime: 'CONTRARIAN_SHORT',
      dark_pool_regime: 'MODERATE_DISTRIBUTION',
      _vc_verdict: 'KILL',
      _vc_kill_preserved: true,
      _vc_kill_reason: 'R3.2 hard-opposite-kill',
      blocked_stage: 'VC_HARD_KILL'
    },
    check: (o) => o._vc_verdict === 'KILL' && o._vc_kill_preserved === true && String(o._vc_kill_reason).includes('R3.2') && o.blocked_stage === 'VC_HARD_KILL'
  },
  {
    name: 'Test 4 SWING profile unchanged',
    input: {
      ...baseStrong,
      ticker: 'SWING1',
      strategy: 'SWING',
      alert_type: 'SWING_MOMENTUM',
      quality_score: 60,
      value_score: 60,
      earnings_trend: 'POSITIVE'
    },
    check: (o) => o.timeframe_profile === 'SWING' && Math.abs(o.mtf_confluence_score - ((o.scalp_confluence_score * 0.20) + (o.swing_confluence_score * 0.55) + (o.long_term_confluence_score * 0.25))) < 0.02
  },
  {
    name: 'Test 5 BROAD_SCANNER unaffected',
    input: {
      ...baseStrong,
      ticker: 'BROAD1',
      alert_type: 'BROAD_SCANNER',
      strategy: 'BROAD_SCANNER',
      bias_score: 70,
      blocked_stage: 'BROAD_SCANNER_BIAS_PATH_ALLOW'
    },
    check: (o) => o.blocked_stage === 'BROAD_SCANNER_BIAS_PATH_ALLOW'
  }
];

const results = tests.map(t => {
  const out = runChain(t.input);
  return { name: t.name, pass: t.check(out), output: pick(out) };
});
const ok = results.every(r => r.pass);
console.log(JSON.stringify({ ok, results }, null, 2));
if (!ok) process.exit(1);
