# Pine source patches — expose required drift columns

For each indicator below, open the script in TradingView's **Pine Editor**, scroll to the very bottom, and paste the corresponding code block. Then click **Save** → **Add to chart** (or reload the chart if it's already applied). After re-applying, the new columns will appear in the Data Window and in any new "Export chart data" CSV.

All patches use `display=display.data_window` so they don't clutter the visible chart. They also use `editable=false` to keep them stable.

---

## 1. AI Super Score Pro v2.5 Universal — append 15 plots

This is the most consequential patch — it exposes all 15 currently-missing required columns.

```pinescript
//==================== DRIFT PARITY EXPORTS (appended by QTP) ====================//
// Per-bar values needed by drift_report. display=display.data_window keeps these
// off the visible chart but available in Data Window + Export chart data CSV.
plot(atr,              "ATR",                 display=display.data_window, editable=false)
plot(rsiVal,           "RSI",                 display=display.data_window, editable=false)
plot(rocVal,           "ROC",                 display=display.data_window, editable=false)
plot(macdLine,         "MACD",                display=display.data_window, editable=false)
plot(signalLine,       "MACD Signal",         display=display.data_window, editable=false)
plot(macdHist,         "MACD Histogram",      display=display.data_window, editable=false)
plot(adx,              "ADX",                 display=display.data_window, editable=false)
plot(plusDI,           "+DI",                 display=display.data_window, editable=false)
plot(minusDI,          "-DI",                 display=display.data_window, editable=false)
plot(chop,             "Choppiness",          display=display.data_window, editable=false)
plot(biasScore,        "Bias Score",          display=display.data_window, editable=false)
plot(executionScore,   "Execution Score",     display=display.data_window, editable=false)
plot(smartMoneyScore,  "Smart Money Score",   display=display.data_window, editable=false)
plot(regimeScore,      "Regime Score",        display=display.data_window, editable=false)
plot(scorePenalty,     "Score Penalty",       display=display.data_window, editable=false)
```

Verified Pine variables (all exist in the script you uploaded):
- `atr` (line 68), `rsiVal` (69), `rocVal` (70)
- `macdLine` (82), `signalLine` (83), `macdHist` (84)
- `plusDI` (118), `minusDI` (119), `adx` (121), `chop` (126)
- `biasScore` (360), `scorePenalty` (369), `executionScore` (371)
- `smartMoneyScore` (260+), `regimeScore` (132)

---

## 2. AI Super Score Ensemble Engine v1 — append 1 plot

Most columns are already plotted; only `rel_vol` is missing.

```pinescript
//==================== DRIFT PARITY EXPORTS (appended by QTP) ====================//
plot(rel_vol,  "Rel Vol",  display=display.data_window, editable=false)
```

Already plotted (verified at lines 314-318), no changes needed:
- `final_score` → "Ensemble Score"  *(splitter will map this to `final_score`)*
- `raw_bull_score` → "Bull Score"  *(maps to `raw_bull_score`)*
- `raw_bear_score` → "Bear Score"  *(maps to `raw_bear_score`)*
- `adx_value` → "ADX"  *(maps to `adx`)*

---

## 3. AI Super Score Webhook Bridge v8 — append 3 plots

The bridge calculates MACD on line 32 but never plots it.

```pinescript
//==================== DRIFT PARITY EXPORTS (appended by QTP) ====================//
plot(macdLine,  "MACD",            display=display.data_window, editable=false)
plot(sigLine,   "MACD Signal",     display=display.data_window, editable=false)
plot(histLine,  "MACD Histogram",  display=display.data_window, editable=false)
```

Verified at line 32: `[macdLine, sigLine, histLine] = ta.macd(close, 12, 26, 9)`.

---

## 4. Quantum Scalp Strategy v5 — append 6 plots

Bull/Bear scores, ADX, RSI, RelVol are already plotted (lines 772-776). Need to add the rest.

```pinescript
//==================== DRIFT PARITY EXPORTS (appended by QTP) ====================//
plot(atr_val,         "ATR",             display=display.data_window, editable=false)
plot(histLine,        "MACD Histogram",  display=display.data_window, editable=false)
plot(scalp_stoch_k,   "Stoch %K",        display=display.data_window, editable=false)
plot(scalp_stoch_d,   "Stoch %D",        display=display.data_window, editable=false)
plot(scalp_cci,       "CCI",             display=display.data_window, editable=false)
plot(gap_pct,         "Gap %",           display=display.data_window, editable=false)
```

Verified Pine variables: `atr_val` (line 199), `histLine` (195), `scalp_stoch_k` (204), `scalp_stoch_d` (205), `scalp_cci` (206), `gap_pct` (391).

---

## 5. Quantum Swing v8.3 — Adaptive Multi-Ticker — append 17 plots

Uses `Swing ` prefixes on MACD/RSI/ATR/ADX so the columns don't collide with Pro v2.5 / Phase 1 / Ensemble when all four indicators are on the same chart. Plain titles (Stoch %K, CCI, etc.) are unique to Swing in this stack.

```pinescript
//==================== DRIFT PARITY EXPORTS (appended by QTP) ====================//
plot(rsi_14,         "Swing RSI",            display=display.data_window, editable=false)
plot(atr_14,         "Swing ATR",            display=display.data_window, editable=false)
plot(macdLine,       "Swing MACD",           display=display.data_window, editable=false)
plot(sigLine,        "Swing MACD Signal",    display=display.data_window, editable=false)
plot(histLine,       "Swing MACD Histogram", display=display.data_window, editable=false)
plot(adx_val,        "Swing ADX",            display=display.data_window, editable=false)
plot(stoch_k,        "Stoch %K",             display=display.data_window, editable=false)
plot(stoch_d,        "Stoch %D",             display=display.data_window, editable=false)
plot(cci_val,        "CCI",                  display=display.data_window, editable=false)
plot(mom_val,        "Momentum",             display=display.data_window, editable=false)
plot(psar_val,       "PSAR",                 display=display.data_window, editable=false)
plot(gap_pct,        "Gap %",                display=display.data_window, editable=false)
plot(vix_size_mult,  "VIX Size Mult",        display=display.data_window, editable=false)
plot(vix_stop_mult,  "VIX Stop Mult",        display=display.data_window, editable=false)
plot(daily_dd_pct,   "Daily DD %",           display=display.data_window, editable=false)
plot(weekly_dd_pct,  "Weekly DD %",          display=display.data_window, editable=false)
plot(swing_mom_rr,   "Momentum R:R",         display=display.data_window, editable=false)
```

Verified Pine variables (every one confirmed present in the uploaded source):
- `rsi_14` (193), `atr_14` (194)
- `macdLine, sigLine, histLine` (195, tuple-destructured)
- `adx_val` (212, tuple-destructured from `ta.dmi`)
- `stoch_k` (556), `stoch_d` (557), `cci_val` (560), `mom_val` (563), `psar_val` (569)
- `gap_pct` (461), `vix_size_mult` (261), `vix_stop_mult` (264)
- `daily_dd_pct` (324), `weekly_dd_pct` (338) — these are strategy.equity-derived; will reflect Pine's strategy tester state per bar
- `swing_mom_rr` (498)

After saving, hover any bar with **only** Quantum Swing applied — Data Window should show 17 new rows under "Quantum Swing v8.3 — Adaptive Multi-Ticker" in addition to the 7 already-plotted columns.

---

## 6. AI Super Score Pro v2.5 Universal — append 5 cross-asset plots

Captures Pine's actual per-bar values for VIX/QQQ/SPY (and SPY/QQQ EMA21) directly from the script's `request.security()` calls. Eliminates the CBOE:VIX vs TVC:VIX feed mismatch AND extends cross-asset coverage from the standalone CSVs' 300 bars to the full Pro v2.5 history (~2971 bars on AAPL 1D).

Use "Pro " prefixed titles so the columns don't collide with Ensemble v1's existing "VIX" plot or any future patches.

```pinescript
//==================== CROSS-ASSET PARITY EXPORTS (appended by QTP) ====================//
plot(vix,       "Pro VIX",        display=display.data_window, editable=false)
plot(qqqClose,  "Pro QQQ Close",  display=display.data_window, editable=false)
plot(spyClose,  "Pro SPY Close",  display=display.data_window, editable=false)
plot(qqqEma21,  "Pro QQQ EMA21",  display=display.data_window, editable=false)
plot(spyEma21,  "Pro SPY EMA21",  display=display.data_window, editable=false)
```

Verified Pine variables (all defined via `request.security(..., timeframe.period, ...)`):
- `vix` (line 94) → `CBOE:VIX` close
- `qqqClose` (97) → `NASDAQ:QQQ` close
- `spyClose` (98) → `AMEX:SPY` close
- `qqqEma21` (99) → `NASDAQ:QQQ` 21-EMA
- `spyEma21` (100) → `AMEX:SPY` 21-EMA

After saving, hover any bar with Pro v2.5 applied — Data Window should show 5 new rows under "AI Super Score Pro v2.5 Universal" at the bottom of its section.

---

## 7. AI Super Score Ensemble Engine v1 — append 11 cross-asset plots

Closes the 0/5 PASS on Ensemble. The script's `mtf_bull_score` / `mtf_bear_score` depend on HTF EMAs fetched via `request.security` (15m/60m/240m/D), which can't be reproduced from same-timeframe local OHLCV. Plotting them captures Pine's exact values for the runner to feed back.

```pinescript
//==================== CROSS-ASSET PARITY EXPORTS (appended by QTP) ====================//
plot(htf_ema_1,    "Ens HTF EMA 1",    display=display.data_window, editable=false)
plot(htf_ema_2,    "Ens HTF EMA 2",    display=display.data_window, editable=false)
plot(htf_ema_3,    "Ens HTF EMA 3",    display=display.data_window, editable=false)
plot(htf_ema_4,    "Ens HTF EMA 4",    display=display.data_window, editable=false)
plot(market_close, "Ens Market Close", display=display.data_window, editable=false)
plot(market_ema,   "Ens Market EMA",   display=display.data_window, editable=false)
plot(leader_close, "Ens Leader Close", display=display.data_window, editable=false)
plot(leader_ema,   "Ens Leader EMA",   display=display.data_window, editable=false)
plot(volume_score, "Ens Volume Score", display=display.data_window, editable=false)
plot(bull_count,   "Ens Bull Count",   display=display.data_window, editable=false)
plot(bear_count,   "Ens Bear Count",   display=display.data_window, editable=false)
```

Verified Pine variables (all defined via `request.security` at lines 97-111 of the ensemble source):
- `htf_ema_1` (15m EMA21), `htf_ema_2` (60m EMA21), `htf_ema_3` (240m EMA50), `htf_ema_4` (D EMA50)
- `market_close`, `market_ema` (SPY)
- `leader_close`, `leader_ema` (QQQ)
- `volume_score`, `bull_count`, `bear_count` — internal score components (line 102-103, 177)

After saving + re-exporting Ensemble v1 alone with **Volume bars visible** (so `volume` isn't zero in the export), the splitter and adapter automatically pick up the new `*_pine` columns; no further code changes needed.

---

## Two version-mismatch flags you should know about

The four .pine files you uploaded have these sha256 hashes vs the manifest:

| File | Uploaded | Manifest | Match |
|---|---|---|---|
| Pro v2.5 Universal | `01a2eedf…` | `01a2eedf…` | ✓ |
| Webhook Bridge v8 | `4f7c2f33…` | `4f7c2f33…` | ✓ |
| Ensemble Engine v1 | `7194db96…` | `0d3e3485…` | ✗ different version |
| Quantum Scalp Strategy v5 | `5a8ecf62…` | `87829049…` | ✗ different version |

The Python ports were likely built against the manifest hashes. For Ensemble v1 and Scalp v5, drift may report differences not because of a porting bug but because the Pine script has been edited since the port was written. If you see widespread DRIFT on those two modules after running, it's probably this — not a real parity break. Either restore the manifest-pinned `.pine` versions or update the Python port to match the new Pine logic.

---

## After applying all patches — re-verify Data Window, then export

1. In TradingView Pine Editor: paste each block at the bottom of its respective script, click **Save** (Ctrl/Cmd-S), then **Add to chart** (or reload existing).
2. On the AAPL 5m chart, apply **one indicator at a time**, open Data Window (Option+D), confirm every required column appears, then **Export chart data → CSV, include hidden plots: ON**.
3. Save with the exact filenames from `EXPORT_GUIDE.md`:
   - `AAPL_5m_super_score_pro.csv`
   - `AAPL_5m_ensemble.csv`
   - `AAPL_5m_bridge.csv`
   - `AAPL_5m_scalp.csv`
4. Drop the four CSVs in chat. I'll run the splitter + drift.
