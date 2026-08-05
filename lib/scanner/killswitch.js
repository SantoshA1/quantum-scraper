'use strict';
/**
 * QTP_KS_MARGIN_PROXY_v1_20260805 — spec-mirror of the Broad Scanner's GLOBAL KILL SWITCH
 * (workflow 975pZZEtxeUbzI22, "Scan All Tickers" Code node, v3.4 guard block).
 *
 * RCA (2026-08-05). THE SCANNER FROZE ITSELF AT 09:40 ET AND STAYED SILENT ALL SESSION:
 *
 *   The margin guard computes _marginPct = alpaca.initial_margin / equity and returns []
 *   (no scan, no signals) when it exceeds 35%. At 09:32–09:36 three fills (WSM, ALLE, DGX)
 *   doubled the book to 6 positions / $63.8k gross — half of it two sub-$17 shorts
 *   (XPEV $12.42, AES $14.66) that carry ELEVATED short initial-margin requirements.
 *   initial_margin/equity crossed 35% and every 5-min cycle from 09:40 onward returned []
 *   after ~1.0–1.2s (portfolio fetch only; successful scans run ~3s). All other guards
 *   were clear the whole time: positions 6/20, gross $63.8k/$150k, day P&L −$20 (−0.02%).
 *   Precedent: 2026-07-23, same guard froze the book all day on glitched initial_margin;
 *   that patch (reg-T proxy) only engages when last_equity<=0 — too narrow.
 *
 *   The freeze was INVISIBLE: executions "success", no pause row, audit pause_guard says
 *   PAUSE_UNKNOWN. 3h20m of no trading with every dashboard green.
 *
 * THE FIX (PO-authorized 2026-08-05, deployed as scanner v3.5):
 *   F1 — margin guard ALWAYS uses the reg-T proxy: gross_exposure * 0.5 / equity.
 *        One formula, no dependence on Alpaca's glitch-prone initial_margin (still logged).
 *        Today's book under the proxy: 63,760*0.5/106,980 = 29.8% -> no trip, no freeze.
 *   F2 — a tripped cycle is no longer silent: it emits ONE marker item routed to a
 *        Postgres node that writes an OBSERVATIONAL quantum.entry_pause_control row
 *        (pause_new_entries=false, trading_blocked=false, status=SCANNER_KILLSWITCH_ACTIVE,
 *        source=broad_scanner_killswitch, expires 10min). Telemetry only — the scanner
 *        itself is the control; no coupling into the pipeline's pause guard.
 *   All four guards, the manual halt, the once-a-day Telegram alert, and the fetch-error
 *   fail-open are UNCHANGED.
 *
 * Variants: 'live' = v3.4 (initial_margin, suspect-proxy only when last_equity<=0);
 *           'proposed' = v3.5 (always proxy + marker) — THE DEPLOYED SCANNER.
 */

const MAX_POSITIONS = 20;
const MAX_EXPOSURE = 150000;
/**
 * QTP_KS_CAPACITY_v1_20260805 (PO, scanner v3.6): 0.35 -> 0.50.
 * At 0.35 the margin guard bound at gross = 0.70x equity (~$75k / 7 positions) while
 * MAX_POSITIONS=20 and MAX_EXPOSURE=$150k were structurally unreachable — the book hit
 * "full" the same afternoon the guard was fixed (7 pos / $74.3k / 34.7% on 08-05).
 * 0.50 = gross <= 1.0x equity (~$107k, ~10 concurrent $10k positions): half of what the
 * 2x paper account permits, margin still binds FIRST (ordering margin -> exposure ->
 * positions preserved), day-loss guard untouched.
 */
const MAX_MARGIN_PCT = 0.50;
const LIVE_MAX_MARGIN_PCT = 0.35;  // the v3.4/v3.5 cap — kept so the 'live' regression reference stays historical
const MAX_DAILY_LOSS_PCT = -2.5;
const EST_POSITION_SIZE = 10000;
/**
 * Pre-entry sim coherence (same change): a new $10k position adds 0.5 x $10k = $5k of
 * reg-T proxy margin, but the sim was adding 0.25 x EST — underestimating by half, so
 * emissions could land the book PAST the cap and trip the global switch a cycle later.
 * v3.6 projects with the same 0.5 factor the guard itself uses: candidates stop BEFORE
 * the breach, visibly ([REJECTED] log), never after it.
 */
const SIM_MARGIN_FACTOR = 0.5;   // v3.5 and earlier: 0.25 (incoherent with the proxy)

/** Mirror of the in-loop pre-entry simulation for the margin dimension. */
function simNextEntryMarginPct(grossExposure, equity, estPositionSize) {
  const est = estPositionSize || EST_POSITION_SIZE;
  return ((Number(grossExposure) * 0.5) + est * SIM_MARGIN_FACTOR) / Number(equity);
}

/**
 * input = {posCount, grossExposure, equity, lastEquity, alpacaInitialMargin,
 *          manualHalt, manualHaltDate, today, fetchFailed, alertAlreadySentToday}
 * variant = 'live' | 'proposed'
 * Returns {tripped, reason, triggers, marginPct, marginSource, brokerDataSuspect,
 *          dailyPnLPct, sendTelegram, marker} — marker only for proposed trips.
 */
function killSwitchDecision(input, variant) {
  const v = variant || 'live';
  const out = { tripped: false, reason: null, triggers: [], marginPct: 0, marginSource: null,
    brokerDataSuspect: false, dailyPnLPct: 0, sendTelegram: false, marker: null };

  if (input.manualHalt && input.manualHaltDate === input.today) {
    out.tripped = true; out.reason = 'manual_halt'; return out;
  }
  if (input.fetchFailed) return out; // live catch{}: logs, proceeds with defaults -> no trip

  const equity = Number(input.equity) || 100000;
  const rawLastEq = Number(input.lastEquity);
  const lastEquity = rawLastEq > 0 ? rawLastEq : equity;    // mirrors `|| _equity` fallback
  const gross = Number(input.grossExposure) || 0;
  const initMargin = Number(input.alpacaInitialMargin) || 0;

  out.brokerDataSuspect = !(rawLastEq > 0);
  if (v === 'proposed') {
    out.marginPct = (gross * 0.5) / equity;                 // F1: one formula, always
    out.marginSource = 'regt_proxy';
  } else {
    out.marginPct = out.brokerDataSuspect ? ((gross * 0.5) / equity) : (initMargin / equity);
    out.marginSource = out.brokerDataSuspect ? 'regt_proxy_suspect_only' : 'alpaca_initial_margin';
  }
  out.dailyPnLPct = (equity - lastEquity) / lastEquity * 100;

  const marginCap = v === 'proposed' ? MAX_MARGIN_PCT : LIVE_MAX_MARGIN_PCT;
  if (out.dailyPnLPct < MAX_DAILY_LOSS_PCT) out.triggers.push('Daily Loss ' + out.dailyPnLPct.toFixed(1) + '%');
  if (out.marginPct > marginCap) out.triggers.push('Margin ' + (out.marginPct * 100).toFixed(0) + '%/' + (marginCap * 100) + '%');
  if (input.posCount >= MAX_POSITIONS) out.triggers.push('Positions ' + input.posCount + '/' + MAX_POSITIONS);
  if (gross > MAX_EXPOSURE) out.triggers.push('Exposure $' + (gross / 1000).toFixed(0) + 'K/$' + (MAX_EXPOSURE / 1000) + 'K');

  if (out.triggers.length > 0) {
    out.tripped = true;
    out.reason = out.triggers.join(' | ');
    out.sendTelegram = !input.alertAlreadySentToday;
    if (v === 'proposed') {
      out.marker = {                                        // F2: the freeze is visible
        __qtp_killswitch: true,
        reason: out.reason,
        pos_count: input.posCount,
        gross_exposure: Math.round(gross),
        equity: Math.round(equity),
        margin_pct: Number((out.marginPct * 100).toFixed(1)),
        day_pnl_pct: Number(out.dailyPnLPct.toFixed(2)),
        pause_row: {
          pause_new_entries: false,                          // telemetry, NOT a control row
          trading_blocked: false,
          status: 'SCANNER_KILLSWITCH_ACTIVE',
          source: 'broad_scanner_killswitch',
          expires_minutes: 10,
        },
      };
    }
  }
  return out;
}

module.exports = { MAX_POSITIONS, MAX_EXPOSURE, MAX_MARGIN_PCT, LIVE_MAX_MARGIN_PCT, MAX_DAILY_LOSS_PCT,
  EST_POSITION_SIZE, SIM_MARGIN_FACTOR, simNextEntryMarginPct, killSwitchDecision };
