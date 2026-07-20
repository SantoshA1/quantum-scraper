// QTP_CYCLE_007_17_NODE_HARDENED_20260511 — Patch 1: hardened neutral/session suppressor before VC model call.
{
  const __d = $input.first().json || {};
  const execution = String(__d.execution || __d.signal || __d.action || __d.direction || '').toUpperCase();
  const __now = new Date();
  const __et = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short' }).formatToParts(__now).reduce((a,p)=>(a[p.type]=p.value,a),{});
  const __hour = Number(__et.hour);
  const __minute = Number(__et.minute);
  const __weekday = __et.weekday;
  const is_after_hours = ['Sat','Sun'].includes(__weekday) || (__hour < 9 || (__hour === 9 && __minute < 30) || __hour >= 16);
  if (execution === 'STAND ASIDE' && is_after_hours) {
    const output = { ...__d };
    output._vc_stand_aside_neutral = true;
    output._vc_pass = false;
    output._vc_verdict = 'NEUTRAL_SUPPRESSED';
    output.vc_verdict = 'NEUTRAL_SUPPRESSED';
    output.blocked_stage = 'SESSION_OR_NEUTRAL_FILTER';
    output.feedback = 'NEUTRAL_SUPPRESSED: After-hours / neutral refresh suppressed by Cycle 007 session filter.';
    output.vc_feedback = output.feedback;
    output.ai_feedback = output.feedback;
    output.gate_decision = 'NEUTRAL_SUPPRESSED';
    output.parser_version = 'QTP_CYCLE_007_17_NODE_HARDENED_20260511';
    output.qtp_cycle_version = 'QTP_CYCLE_007_17_NODE_HARDENED_20260511';
    output._vc_score_parser_version = 'QTP_CYCLE_007_17_NODE_HARDENED_20260511';
    output._cycle007_suppressed_at = __now.toISOString();
    return [{ json: output }];
  }
  __d.parser_version = 'QTP_CYCLE_007_17_NODE_HARDENED_20260511';
  __d.qtp_cycle_version = 'QTP_CYCLE_007_17_NODE_HARDENED_20260511';
}


// QTP-xAI-EXEC: native xAI/Grok credential fallback and cost-optimized model.
// QTP_ANTHROPIC_MIGRATION_v1_20260720: xAI/Grok -> Anthropic Claude Opus 4.8 (PO-authorized).
const QTP_ANTHROPIC_KEY = String((typeof $vars !== 'undefined' && ($vars.ANTHROPIC_API_KEY || $vars.anthropic_api_key)) || ((($getWorkflowStaticData('global') || {})._credentials || {}).anthropic_api_key) || '').trim();
const QTP_ANTHROPIC_MODEL = String((typeof $vars !== 'undefined' && ($vars.ANTHROPIC_MODEL || $vars.anthropic_model)) || 'claude-opus-4-8').trim();
function qtpAnthropicKeyLooksReal(k) { return typeof k === 'string' && k.startsWith('sk-ant-') && k.length >= 40 && !/PLACEHOLDER|CHANGEME|YOUR[_-]?KEY|EXAMPLE|XXXX/i.test(k); }
function qtpAnthropicText(resp) { if (!resp || !Array.isArray(resp.content)) return ''; let t = ''; for (const b of resp.content) { if (b && b.type === 'text' && b.text) t += b.text; } return t.trim(); }
// VC Agent Gatekeeper v1 — Ruthless Quality Gate
// Sits between Perplexity AI Analysis and Format Telegram / Alpaca
// Reads the full enriched signal + AI analysis, builds a prompt
// for a second Perplexity call that stress-tests the alert.

const NL = String.fromCharCode(10);
// Keep this below n8n's 60s Code-node hard limit so the workflow can fail-closed
// with a JSON VC verdict instead of timing out the whole trading execution.
const VC_HTTP_TIMEOUT_MS = Number((typeof $vars !== 'undefined' && $vars.VC_AGENT_TIMEOUT_MS) || 25000);

// Get Perplexity AI response (raw analysis text)
const pplxInput = $input.first().json;
let rawAnalysis = '';
try {
  rawAnalysis = pplxInput.choices[0].message.content || '';
} catch (e) {
  rawAnalysis = 'AI analysis unavailable';
}

// Get the full enriched signal from Cross-Asset Engine
const ceItem = $('Cross-Asset Engine').first();
const signal = (ceItem && ceItem.json) ? ceItem.json : {};

const ticker = signal.ticker || 'UNKNOWN';
const execution = signal.execution || 'UNKNOWN';
const signalDir = signal.signal || 'UNKNOWN';
const price = signal.price || '0';
const sma50 = signal.sma50 || '0';
const ema200 = signal.ema200 || '0';
const tf = signal.timeframe || '?';
const bullScore = signal.bull_score || '0';
const bearScore = signal.bear_score || '0';
const rsi = signal.rsi || '0';
const adx = signal.adx || '0';
const vix = signal.vix || '0';
const regime = signal.regime || 'UNKNOWN';
const dailyTrend = signal.daily_trend || 'UNKNOWN';
const spyStatus = signal.spy_status || 'UNKNOWN';
const qqqStatus = signal.qqq_status || 'UNKNOWN';

// Backtest stats
const stratNet = signal.strat_net_pct || '0';
const stratWR = signal.strat_win_rate || '0';
const stratPF = signal.strat_profit_factor || '0';
const stratDD = signal.strat_max_dd || '0';
const stratTrades = signal.strat_total_trades || '0';

// v5 risk fields
const ddHalt = signal.daily_dd_halt || 'false';
const vixSizeMult = signal.vix_size_mult || '1.0';
const effSize = signal.eff_position_size || '10';

// Options flow
const optRegime = signal.opt_regime || 'UNAVAILABLE';
const optConfidence = signal.opt_regime_confidence || 'NONE';

// Dark pool
const dpRegime = signal.dp_regime || 'UNAVAILABLE';
const dpShortRatio = signal.dp_short_ratio || '0';

// Cross-asset
const caRegime = signal.ca_regime || 'UNAVAILABLE';
const caScore = signal.ca_composite_score || '50';
const caAlignment = signal.ca_signal_alignment || 'NEUTRAL';

// SM fields
const smRoute = signal._sm_route || 'FULL';
const smConfidence = signal._sm_confidence || '?';
const smMaxConf = signal._sm_max_confidence || '?';

const isScalp = (tf === '5' || tf === '15' || tf === '5m' || tf === '15m');
const stratLabel = isScalp ? 'Scalp' : 'Swing';
const priceBelowSMA50 = parseFloat(price) < parseFloat(sma50);
const sma50Status = priceBelowSMA50 ? "BELOW SMA50 (bearish)" : "ABOVE SMA50 (bullish)";
const priceBelowEMA200 = parseFloat(price) < parseFloat(ema200);
const ema200Status = priceBelowEMA200 ? "BELOW EMA200 (bearish)" : "ABOVE EMA200 (bullish)";

// Build the VC prompt
const alertType = signal.alert_type || 'UNKNOWN';
const vcPrompt = `You are an elite, ruthless VC partner who has killed 100+ quant startups and reviewed 500+ algorithmic trading systems. You have zero tolerance for BS, overconfidence, or insufficient evidence.

Your job: brutally stress-test this trading alert before it reaches paying subscribers. Their money is on the line.

=== SIGNAL SUMMARY ===
Ticker: ${ticker} | Timeframe: ${tf} (${stratLabel})
Execution: ${execution} | Signal: ${signalDir}
Price: $${price} | SMA50: $${sma50} | ${sma50Status} | EMA200: $${ema200} | ${ema200Status} | Regime: ${regime}
Bull Score: ${bullScore} | Bear Score: ${bearScore}
RSI: ${rsi} | ADX: ${adx} | VIX: ${vix}
Daily Trend: ${dailyTrend}
SPY: ${spyStatus} | QQQ: ${qqqStatus}

=== STRATEGY BACKTEST ===
Net P&L: ${stratNet}% | Win Rate: ${stratWR}% | Profit Factor: ${stratPF}
Max Drawdown: ${stratDD}% | Total Trades: ${stratTrades}

=== DATA QUALITY ===
Market Status: ${signal._dq_market_status || 'UNKNOWN'}
Data Timestamp: ${signal._dq_data_timestamp || 'unknown'}
Data Live: ${signal._dq_data_is_live ? 'YES' : 'NO — STALE'}
Quality Score: ${signal._dq_quality_score || '?'}/100
Missing Fields: ${signal._dq_missing_fields || 'none'}
${signal._dq_staleness_note ? 'WARNING: ' + signal._dq_staleness_note : ''}

IMPORTANT DATA CONTEXT FOR BROAD_SCANNER signals:
RSI, ADX, MACD, SMA50, EMA200 showing as N/A is EXPECTED AND NORMAL — scanner signals use price/volume/regime momentum only, NOT lagging indicators.
Stale timestamp and UNKNOWN market status are expected for intraday scanner data — do NOT flag these as quality issues.
Confidence score missing is expected — scanner signals do not use Pine Script confidence scoring.
Judge scanner signals ONLY on: regime, bias_score, volume_ratio, cross-asset alignment.
Do NOT penalise a scanner signal for missing indicator data that it was never designed to have.

=== RISK MANAGEMENT ===
Daily DD Halt: ${ddHalt} | VIX Size Mult: ${vixSizeMult}x
Effective Position Size: ${effSize}%

=== OPTIONS FLOW ===
Regime: ${optRegime} (${optConfidence})

=== DARK POOL ===
Regime: ${dpRegime} | Short Ratio: ${dpShortRatio}%

=== CROSS-ASSET ===
Regime: ${caRegime} | Composite Score: ${caScore}/100
Signal Alignment: ${caAlignment}

=== STATE MACHINE ===
Route: ${smRoute} | Confidence: ${smConfidence}/${smMaxConf}

=== AI ANALYSIS (from Perplexity) ===
${rawAnalysis.substring(0, 1200)}

=== YOUR EVALUATION CRITERIA (60% direction, 40% risk/sizing) ===

DIRECTION QUALITY (60% weight):
1. SIGNAL CONTRADICTIONS: Does the execution direction conflict with any indicators (RSI, MACD, trend, cross-asset)?
2. MARKET REGIME: Is this signal appropriate for the current VIX/SPY/QQQ regime?
3. DATA QUALITY: Are any critical fields missing, zero, or suspicious?
4. OVERCONFIDENCE: Is the confidence score justified by the evidence?
5. RISK/REWARD: Would a professional risk manager approve this position size in this regime?
6. EDGE EVIDENCE: Is there a clear, non-contradicted edge, or is this noise?

RISK & SIZING QUALITY (40% weight):
8. VOLATILITY APPROPRIATENESS: Is position size correct for current ATR/VIX? Would you risk 1% of $100K here?
9. STOP PLACEMENT: Is the stop-loss logical (below support for longs, above resistance for shorts)?
10. COST EFFICIENCY: Does the expected move (1.5-2.5R) justify transaction costs (0.15% slippage)?
11. REGIME-SIZE MATCH: Is the position scaled correctly for the current regime (BEAR=25%, CHOP=50%, BULL=100%)?

Output ONLY valid JSON (no markdown, no code blocks, no explanation outside the JSON):
{
  "pass": true or false,
  "vc_score": 0 to 10,
  "brutal_feedback": "one ruthless paragraph explaining your decision",
  "red_flags": ["list of specific problems found"],
  "suggested_fixes": ["list of actionable fixes"],
  "final_verdict": "PASS or WEAK or REJECT or KILL"
}

Rules:
R3.2 (hard-opposite-kill):
  The OPTIONS FLOW regime and DARK POOL regime represent the actions of
  informed money. When informed flow points the opposite direction from the
  execution, the signal is structurally broken — no other indicator can
  overcome this rule.

  HOW TO READ THE DATA: look at the Regime value under "=== OPTIONS FLOW ==="
  (call it OPTIONS_REGIME below) and the Regime value under "=== DARK POOL ==="
  (call it DP_REGIME below). Apply substring matching: a value of
  MODERATE_DISTRIBUTION matches "DISTRIBUTION"; CONTRARIAN_SHORT matches
  exactly. Case-insensitive.

  Hard-opposite triggers (ANY ONE → score = 0, final_verdict = KILL,
  rule_ids_fired must include "R3.2"):

  For BUY / LONG execution:
    - OPTIONS_REGIME equals or contains any of:
        CONTRARIAN_SHORT, GAMMA_SQUEEZE_DOWN, BEARISH, PUT_HEAVY,
        DISTRIBUTION, MODERATE_DISTRIBUTION
    - DP_REGIME equals or contains any of:
        DISTRIBUTION, MODERATE_DISTRIBUTION, EXTREME_SHORT_PRESSURE, BEARISH

  For SELL / SHORT execution:
    - OPTIONS_REGIME equals or contains any of:
        CONTRARIAN_LONG, GAMMA_SQUEEZE_UP, BULLISH, CALL_HEAVY,
        ACCUMULATION, MODERATE_ACCUMULATION
    - DP_REGIME equals or contains any of:
        ACCUMULATION, MODERATE_ACCUMULATION, BULLISH, LOW_SHORT_PRESSURE

  EXAMPLES (these MUST kill; if you see any of these patterns, output
  vc_score = 0, final_verdict = "KILL", rule_ids_fired = ["R3.2"]):

  - Execution = BUY and OPTIONS FLOW Regime = CONTRARIAN_SHORT → KILL
    (e.g. FE 2026-05-19, FTV/GBTC/KHC/REG/STE 2026-05-20)
  - Execution = BUY and OPTIONS FLOW Regime = GAMMA_SQUEEZE_DOWN → KILL
    (e.g. MAA 2026-05-20)
  - Execution = BUY and DARK POOL Regime = MODERATE_DISTRIBUTION → KILL
    (e.g. KHC 2026-05-20)
  - Execution = SELL and DARK POOL Regime = MODERATE_ACCUMULATION → KILL
    (e.g. FIS 2026-05-20)

  No exceptions. Not for high bias, not for high volume, not for strong RSI,
  not for aligned cross-asset, not for a credible backtest. The kill is
  structural: informed money is going the other way, so the trade is wrong.
  Cite R3.2 in rule_ids_fired with the specific regime value that triggered
  the kill (e.g. "R3.2 (OPTIONS_REGIME=CONTRARIAN_SHORT)").

R7 — HIGH-SCORE SAFETY FLOORS (no PASS-at-10 with structural problems):
  To score ≥8 (PASS verdict), ALL of the following must be true. If any fails,
  cap final score at 7 regardless of other positives.
  R7.1 (bias-floor-for-pass):
    bias_score ≥ 55. A signal cannot earn PASS with sub-neutral conviction.
    If bias_score < 55: cap at 7. Cite R7.1.
    Examples from audit: FDS SELL (bias 40), EMR SELL (bias 44), QQQ SELL (bias 36)
    should NEVER score above 7 given those bias values, no matter how strong
    other layers appear.
  R7.2 (volume-floor-for-pass):
    volume_ratio ≥ 1.0 (or BROAD_SCANNER exempt).
    A scalp with below-average volume lacks the participation needed for clean
    execution. If volume_ratio < 1.0 and alert_type ≠ BROAD_SCANNER: cap at 7.
    Cite R7.2.
    Examples from audit: FE BUY (vol_ratio 0.93), FDS SELL (vol_ratio 0.97).
  R7.3 (no-hard-opposite-for-pass):
    R3.2 must not have fired. If R3.2 fired, final score must be 0 per R3.2 —
    R7.3 is a structural reminder that hard-opposite kills PASS unconditionally.
    Canonical case: FE BUY with options_regime = CONTRARIAN_SHORT. This is the
    exact pattern R3.2 must catch. CONTRARIAN_SHORT options + BUY execution
    = score 0, full stop, no exceptions for high bias or other positives.
  R7.4 (coherence-floor-for-pass):
    coherence_score ≥ 60. If coherence_score < 60: cap at 7. Cite R7.4.
    Rationale: PASS implies "subscribers should act on this," and that requires
    multiple independent layers agreeing. coherence_score < 60 means at least
    two of {technical, options, dark pool, cross-asset, AI action} oppose or
    are neutral — that is not a PASS-grade signal.
- Score 0-3: KILL (dangerous, would lose money)
- Score 4-6: REJECT (insufficient evidence or contradictions)
- Score 7: WEAK (marginal, proceed with caution — but STILL routes to execution)
- Score 8-10: PASS (strong evidence supports the signal)
- Standard signals: If backtest has <30 trades, cap score at 6 maximum
R1.2 (profit-factor-ladder):
  Profit factor is the single strongest indicator of strategy viability. Apply the
  ladder below as a HARD CAP (final score cannot exceed the cap regardless of any
  other positive signal). The ladder is non-linear because PF compounds — a PF of
  0.4 loses 60¢ per $1 won, which is structurally worse than a PF of 1.1 which
  barely breaks even after costs.
    PF < 0.5:        cap score at 1.    Cite R1.2 (anti-edge: strategy loses money
                                        in expectation; system should never route).
    0.5 ≤ PF < 0.7:  cap score at 2.    Cite R1.2 (severe negative edge).
    0.7 ≤ PF < 0.9:  cap score at 3.    Cite R1.2 (negative edge after costs).
    0.9 ≤ PF < 1.0:  cap score at 4.    Cite R1.2 (sub-breakeven).
    1.0 ≤ PF < 1.1:  cap score at 5.    Cite R1.2 (marginal, slippage-sensitive).
    1.1 ≤ PF < 1.2:  cap score at 5.5.  Cite R1.2 (below production threshold).
    1.2 ≤ PF < 1.3:  cap score at 6.    Cite R1.2 (weak edge).
    1.3 ≤ PF < 1.5:  cap score at 7.    Cite R1.2 (acceptable edge, route as WEAK).
    PF ≥ 1.5:        no PF cap. Full scoring applies (R3, R4 still gate the high end).
  Note on fat tails and serial correlation: published PF figures often overstate
  edge for intraday strategies because returns are non-iid (signal clustering on
  trending days). When backtest n < 100, treat the displayed PF as the upper bound
  of the true PF — the lower bound of a stationary block bootstrap is typically
  0.10–0.15 lower. The ladder above already accounts for this conservatively.
  BROAD_SCANNER alert type: R1.2 still applies if PF is reported. If PF is absent
  by design (scanner never had backtest data), R1.2 is a no-op and R1.4 applies.
- If execution is STAND ASIDE, auto-PASS with score 7 (neutral signals are safe)

CRITICAL: For BROAD_SCANNER alert type — do NOT apply backtest cap:
- Scanner signals have no backtest data by design (they scan real-time momentum)
- TRENDING + bias > 60%: can score 7-9
- TRENDING + bias 50-60%: can score 6-7
- NEUTRAL + bias > 70%: can score 7 only when at least two ticker-level confirmations align (daily trend, volume ratio, options, dark pool, cross-asset alignment, or clean RSI)
- NEUTRAL + bias < 60%: cap at 6
- Volume ratio > 1.5x adds +1 to score
- SPY+QQQ both WEAK reduces score by 1 (but do not KILL trending signals because of this alone)

QTP_VC_PROMPT_v6.1.1_20260520:
- Do not compress every uncertain setup to 5/10. Use the full 0-10 range.
- Separate HARD rejects (stale data, missing price, broker/risk block, direct direction contradiction, VIX extreme, unprotected position risk) from SOFT cautions (neutral SPY/QQQ, mixed cross-asset, small scanner sample, RSI extension).
- Neutral macro is a caution, not an automatic rejection, when ticker-level momentum is strong and at least two independent confirmations align.
- If evidence is genuinely conflicting, score 4-5 and reject. If evidence is absent/stale, score 0-3 and kill. If evidence is aligned but macro is neutral, score 6-7 instead of defaulting to 5.
- Never recommend bypassing VC Gate, Risk Gate, or position protection.
Current alert type: ${alertType}
- Be rigorous but fair. A scanner TRENDING SELL with bias 70%+ in a risk-off market is a VALID short.
- Be merciless. If this would waste a subscriber's money, REJECT it.`;

// === VC GROK CALL (v3 — resilience, retries, circuit breaker, fail-closed) ===
const _creds_VC = ($getWorkflowStaticData('global')._credentials) || {};
const VC_API_KEY = QTP_ANTHROPIC_KEY;
if (!VC_API_KEY) throw new Error('SE-C2: xai_api_key missing from staticData._credentials');
const VC_MAX_RETRIES = Number((typeof $vars !== 'undefined' && $vars.VC_AGENT_MAX_RETRIES) || 1);
const VC_RETRY_BASE_MS = Number((typeof $vars !== 'undefined' && $vars.VC_AGENT_RETRY_BASE_MS) || 1200);
const VC_CIRCUIT_WINDOW_MS = Number((typeof $vars !== 'undefined' && $vars.VC_CIRCUIT_WINDOW_MS) || 120000);
const VC_CIRCUIT_OPEN_MS = Number((typeof $vars !== 'undefined' && $vars.VC_CIRCUIT_OPEN_MS) || 90000);
const VC_CIRCUIT_FAIL_THRESHOLD = Number((typeof $vars !== 'undefined' && $vars.VC_CIRCUIT_FAIL_THRESHOLD) || 3);
const VC_PER_ATTEMPT_TIMEOUT_MS = Number((typeof $vars !== 'undefined' && $vars.VC_AGENT_PER_ATTEMPT_TIMEOUT_MS) || Math.min(Math.max(VC_HTTP_TIMEOUT_MS, 50000), 55000));
const _vcState = $getWorkflowStaticData('global');
if (!_vcState.qtpVcApiCircuit) _vcState.qtpVcApiCircuit = { failures: [], open_until: 0 };
const _circuit = _vcState.qtpVcApiCircuit;
const _now = Date.now();
_circuit.failures = (_circuit.failures || []).filter(t => _now - t < VC_CIRCUIT_WINDOW_MS);

let vcGrokResponse = null;
let vcGrokError = null;
let vcAttempts = 0;
let vcLatencyMs = 0;
let vcCircuitState = _circuit.open_until && _now < _circuit.open_until ? 'OPEN' : 'CLOSED';
let vcHealthReason = '';

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function makeHealthId() {
  return ['vcapi', ticker, execution, Date.now(), Math.random().toString(16).slice(2,8)].join('_');
}

const vcBody = {
  model: QTP_ANTHROPIC_MODEL,
  max_tokens: 520,
  temperature: 0.2,
  system: "You are an elite, ruthless VC partner and quant fund evaluator. Output ONLY valid JSON. No markdown, no code blocks, no explanation outside the JSON object.",
  messages: [
    { role: "user", content: vcPrompt }
  ]
};

if (!qtpAnthropicKeyLooksReal(VC_API_KEY)) {
  vcGrokError = 'anthropic key missing/placeholder — fail-closed without API call';
  vcHealthReason = 'vc_anthropic_key_missing_fail_closed';
  console.error('[VC CLAUDE] ANTHROPIC_API_KEY missing/placeholder; fail-closed without API call');
} else if (vcCircuitState === 'OPEN') {
  vcGrokError = 'VC circuit breaker open after repeated API failures';
  vcHealthReason = 'vc_circuit_open_fail_closed';
  console.error('[VC CLAUDE] circuit open; fail-closed without API call');
} else {
  const started = Date.now();
  for (let attempt = 1; attempt <= VC_MAX_RETRIES; attempt++) {
    vcAttempts = attempt;
    try {
      vcGrokResponse = await this.helpers.httpRequest({
        method: 'POST',
        url: 'https://api.anthropic.com/v1/messages',
        headers: {
          'x-api-key': VC_API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(vcBody),
        timeout: VC_PER_ATTEMPT_TIMEOUT_MS
      });
      vcGrokError = null;
      vcHealthReason = 'vc_api_recovered_or_ok';
      break;
    } catch (e) {
      vcGrokError = e.message || String(e);
      vcHealthReason = 'vc_api_down_or_timeout';
      console.error(`[VC GROK] attempt ${attempt}/${VC_MAX_RETRIES} failed:`, vcGrokError);
      if (attempt < VC_MAX_RETRIES) {
        await sleep(VC_RETRY_BASE_MS * Math.pow(2, attempt - 1));
      }
    }
  }
  vcLatencyMs = Date.now() - started;
}

if (!vcGrokResponse) {
  _circuit.failures.push(Date.now());
  if (_circuit.failures.length >= VC_CIRCUIT_FAIL_THRESHOLD) {
    _circuit.open_until = Date.now() + VC_CIRCUIT_OPEN_MS;
    vcCircuitState = 'OPEN';
  }
}
const vcApiHealthEvent = !vcGrokResponse || vcAttempts > 1;
const vcApiHealthAlert = !vcGrokResponse || vcCircuitState === 'OPEN';
const vcHealthEventId = makeHealthId();

// Parse response — VC Score Parser expects choices[0].message.content
let vcChoices = [{ message: { content: '{"pass":false,"vc_score":0,"brutal_feedback":"VC API unavailable or timed out — fail-closed KILL without blocking workflow (SE-C7)","red_flags":["vc_api_down_or_timeout"],"suggested_fixes":[],"final_verdict":"KILL"}' } }];
try {
  const _vcParsed = vcGrokResponse
    ? (typeof vcGrokResponse === 'string' ? JSON.parse(vcGrokResponse) : vcGrokResponse)
    : null;
  const _vcText = qtpAnthropicText(_vcParsed);
  if (_vcText) {
    vcChoices = [{ message: { content: _vcText.replace(/```json|```/g, '').trim() } }];
  }
} catch (e) {
  console.error('[VC CLAUDE] Parse failed:', e.message);
}

// Pass through ALL signal data + the VC prompt + the Grok VC response

// QTP_VC_FEEDBACK_PROMPT_20260506
if (typeof out !== 'undefined' && out._vc_prompt && !String(out._vc_prompt).includes('Never output "No feedback"')) { out._vc_prompt += `

Return a strict JSON object with these fields:
{
  "score": number from 0 to 10,
  "verdict": "PASS" or "REJECT",
  "feedback": "3-5 sentence detailed reasoning. Never empty. Never say No feedback.",
  "red_flags": ["short bullet", "short bullet"],
  "subscriber_summary": "1-2 sentence plain-English summary"
}
Rules:
- If score >= 7, verdict must be PASS and feedback must explain why it passed.
- If score < 7, verdict must be REJECT and feedback must explain why it failed.
- Never use reject-style language for PASS.
- Never output "No feedback".`; }
return [{
  json: {
    ...signal,
    _vc_prompt: vcPrompt,
    _vc_raw_analysis: rawAnalysis,
    _pplx_response: pplxInput,
    choices: vcChoices,
    _vc_grok_error: vcGrokError || null,
    _vc_provider: 'xai_grok_native',
    _vc_model: QTP_ANTHROPIC_MODEL,
    _vc_api_attempts: vcAttempts,
    _vc_api_latency_ms: vcLatencyMs,
    _vc_circuit_state: vcCircuitState,
    _vc_health_reason: vcHealthReason,
    _vc_api_health_event: vcApiHealthEvent,
    _vc_api_health_alert: vcApiHealthAlert,
    _vc_health_event_id: vcHealthEventId
  }
}];
