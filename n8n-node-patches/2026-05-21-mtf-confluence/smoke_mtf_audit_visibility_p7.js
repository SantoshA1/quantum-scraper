const fs = require('fs');
const path = '/home/user/workspace/outputs/merge_mtf_ai_verdict_patched_audit_visibility_20260521T021854Z.js';
const code = fs.readFileSync(path, 'utf8');

function runOne(json) {
  const items = [{ json }];
  const $input = { all: () => items };
  return Function('items', '$input', code)(items, $input)[0].json;
}

const tests = [
  {
    name: 'Smoke 1 MTF block visible',
    input: {
      ticker: 'JCI',
      execution: 'BUY',
      _vc_verdict: 'PASS',
      blocked_stage: 'NONE',
      mtf_confluence_decision: 'MTF_CONFLUENCE_BLOCK',
      mtf_confluence_score: 62.2,
      ai_mtf_decision: 'PASS',
      ai_mtf_confluence_score: 62.2,
      scalp_confluence_score: 61,
      swing_confluence_score: 82,
      long_term_confluence_score: 27,
      mtf_confluence_reasons: ['long_term floor failed', 'weighted score below threshold'],
      timeframe_profile: 'SCALP'
    },
    expectBlockedStage: 'MTF_CONFLUENCE_BLOCK'
  },
  {
    name: 'Smoke 2 KILL non-interference',
    input: {
      ticker: 'TEST',
      execution: 'BUY',
      _vc_verdict: 'KILL',
      _vc_kill_preserved: true,
      _vc_kill_reason: 'R3.2 hard-opposite-kill',
      blocked_stage: 'VC_HARD_KILL',
      mtf_confluence_decision: 'MTF_CONFLUENCE_BLOCK',
      mtf_confluence_score: 20,
      ai_mtf_decision: 'KILL',
      ai_mtf_confluence_score: 0,
      scalp_confluence_score: 20,
      swing_confluence_score: 20,
      long_term_confluence_score: 20
    },
    expectBlockedStage: 'VC_HARD_KILL'
  },
  {
    name: 'Smoke 3 BROAD_SCANNER non-interference',
    input: {
      ticker: 'LOWBIAS',
      execution: 'BUY',
      alert_type: 'BROAD_SCANNER',
      _vc_verdict: 'REJECT',
      blocked_stage: 'BROAD_SCANNER_BIAS_PATH',
      mtf_confluence_decision: 'MTF_CONFLUENCE_BLOCK',
      mtf_confluence_score: 30,
      ai_mtf_decision: 'REJECT',
      ai_mtf_confluence_score: 30,
      scalp_confluence_score: 30,
      swing_confluence_score: 30,
      long_term_confluence_score: 30
    },
    expectBlockedStage: 'BROAD_SCANNER_BIAS_PATH'
  }
];

const results = [];
let ok = true;
for (const t of tests) {
  const out = runOne(t.input);
  const pass = out.blocked_stage === t.expectBlockedStage;
  ok = ok && pass;
  results.push({
    name: t.name,
    pass,
    blocked_stage: out.blocked_stage,
    expected_blocked_stage: t.expectBlockedStage,
    final_mtf_confluence_decision: out.final_mtf_confluence_decision,
    final_mtf_confluence_pass: out.final_mtf_confluence_pass,
    _mtf_block_reason: out._mtf_block_reason,
    _mtf_scalp_score: out._mtf_scalp_score,
    _mtf_swing_score: out._mtf_swing_score,
    _mtf_long_term_score: out._mtf_long_term_score,
    _mtf_deterministic_score: out._mtf_deterministic_score,
    _mtf_ai_score: out._mtf_ai_score,
    _mtf_profile: out._mtf_profile,
    _mtf_block_version: out._mtf_block_version,
    _vc_verdict: out._vc_verdict,
    _vc_kill_preserved: out._vc_kill_preserved,
    _vc_kill_reason: out._vc_kill_reason
  });
}

console.log(JSON.stringify({ ok, results }, null, 2));
if (!ok) process.exit(1);
