# QTP Pine → Python Drift: TradingView Export Guide

**Target:** NASDAQ:AAPL · 5-minute timeframe · Pro+ / Premium / Ultimate plan
**Goal:** Produce four `_ohlcv.csv` + `_reference.csv` pairs so `run_drift_manifest.py` can validate Pine-to-Python parity.

---

## 0. Before you start — one structural issue to know about

TradingView's **Export chart data** only writes columns that the Pine indicator **plots**. Internal scoring variables (`bias_score`, `execution_score`, `smart_money_score`, `raw_bull_score`, `final_score`, etc.) will only land in the CSV if the `.pine` source has `plot(bias_score, title="Bias Score", display=display.data_window)` (or similar) for each of them. If your current `.pine` files don't expose those values as plots, the export will be missing them and drift can't validate scoring logic.

**Action before exporting:** open each of the four `.pine` scripts in Pine Editor and confirm every column listed in the "Required reference columns" section below has a corresponding `plot(...)` line. If anything is missing, add it as `plot(<var>, title="<exact title>", display=display.data_window)` — `display.data_window` keeps it out of the visible chart but still includes it in exports.

---

## 1. Common export settings (applies to all four indicators)

| Setting | Value | Why |
|---|---|---|
| Symbol | `NASDAQ:AAPL` | Liquid single name; clean 5m bars |
| Timeframe | 5m | Matches the manifest's expected resolution |
| Bar count | **≥ 1000 bars** | sma200 needs ≥ 200 bars; ADX/EMA seeding needs another ~50; drift skips first 50 as warmup. 1000+ gives comfortable margin. |
| Time range | Last ~10 trading days | At 5m, that's ~780 RTH bars; scroll back further with arrow keys before exporting if needed |
| Chart type | Candles | OHLCV export shape |
| Adjust for dividends | OFF | Keep raw prices so Python compute() matches |

To force the chart to load 1000+ bars: press **Home** to jump to most recent, then **←** repeatedly until the leftmost bar is at least 10 trading days back. Alternatively: right-click the time axis → **Reset chart** then scroll left.

---

## 2. Per-indicator export procedure

You'll export **one combined CSV per indicator** (TradingView writes OHLCV + every plotted indicator column into a single file). My `split_tv_export.py` script then carves that into the two CSVs the manifest expects.

### General steps (repeat 4×, once per indicator)

1. Open chart at NASDAQ:AAPL 5m
2. Remove all other indicators from the chart (so the export only contains the one you're validating)
3. Apply **only one** of the four indicators
4. Wait for it to fully compute (status bottom-right says "Ready")
5. Click **chart menu → Export chart data…** (alternative path: top menu **File → Export → Chart data**)
6. In the dialog:
   - Time format: **UNIX timestamp** *or* **ISO 8601** (both work — my splitter parses either)
   - Include hidden plots: **ON** (this is the one that picks up `display=display.data_window` columns)
   - Format: **CSV**
7. Save to your **Downloads** folder with this exact filename (matters for the splitter call below):

| Indicator (TV name) | Downloaded filename |
|---|---|
| AI Super Score Pro v2.5 Universal | `AAPL_5m_super_score_pro.csv` |
| AI Super Score Ensemble Engine v1 | `AAPL_5m_ensemble.csv` |
| AI Super Score Webhook Bridge v8 | `AAPL_5m_bridge.csv` |
| Quantum Scalp Strategy v5 | `AAPL_5m_scalp.csv` |

### Required reference columns per indicator

These are the column names the Python module's `compute()` function emits. Drift will only validate columns that appear under these exact names. The `split_tv_export.py` script renames TradingView plot titles to these — but only if the rename map matches your actual Pine `title=` strings. Confirm or adjust the map after your first export.

**AI Super Score Pro v2.5** (20 columns)
`ema9, ema21, ema50, sma200, atr, rsi, roc, macd_line, macd_signal, macd_hist, adx, plus_di, minus_di, chop, vwap, bias_score, execution_score, smart_money_score, regime_score, score_penalty`

**AI Super Score Ensemble v1** (5 columns)
`raw_bull_score, raw_bear_score, final_score, adx, rel_vol`

**Webhook Bridge v8** (3 columns — only MACD trio is in the indicator tolerance dict)
`macd_line, macd_signal, macd_hist`
*Note: the bridge produces `rsi_14`/`atr_14` but the indicator tolerance dict uses `rsi`/`atr`, so those won't be drift-tested without a packaging fix. Not your problem to solve at export time.*

**Quantum Scalp v5** (11 columns)
`raw_bull_score, raw_bear_score, adx_val, rsi_14, rel_vol, atr_val, macd_hist, stoch_k, stoch_d, cci, gap_pct`

---

## 3. After each export — run the splitter

The splitter lives at `qtp_server_side/split_tv_export.py`. From inside the workspace root:

```bash
cd "/Users/santoshadari/Documents/Claude/Projects/Quantlys Engine"

# Step 1 (do this ONCE per file): see what column names TradingView actually used
PYTHONPATH=. python -m qtp_server_side.split_tv_export \
  --in  ~/Downloads/AAPL_5m_super_score_pro.csv \
  --module super_score_pro_v25 \
  --out-ohlcv     /dev/null \
  --out-reference /dev/null \
  --print-headers

# Step 2: if any plot titles in the printed headers don't match the keys in
#          COLUMN_MAPS at the top of split_tv_export.py, edit the file to fix them.
#          (Or send me the header list and I'll update it.)

# Step 3: split for real (super_score_pro_v25)
PYTHONPATH=. python -m qtp_server_side.split_tv_export \
  --in  ~/Downloads/AAPL_5m_super_score_pro.csv \
  --module super_score_pro_v25 \
  --out-ohlcv     pine-reference/ohlcv/ai_super_score_pro_v25_universal_ohlcv.csv \
  --out-reference pine-reference/outputs/ai_super_score_pro_v25_universal_reference.csv

# ensemble_engine_v1
PYTHONPATH=. python -m qtp_server_side.split_tv_export \
  --in  ~/Downloads/AAPL_5m_ensemble.csv \
  --module ensemble_engine_v1 \
  --out-ohlcv     pine-reference/ohlcv/ai_super_score_ensemble_engine_v1_ohlcv.csv \
  --out-reference pine-reference/outputs/ai_super_score_ensemble_engine_v1_reference.csv

# webhook_bridge_v8
PYTHONPATH=. python -m qtp_server_side.split_tv_export \
  --in  ~/Downloads/AAPL_5m_bridge.csv \
  --module webhook_bridge_v8 \
  --out-ohlcv     pine-reference/ohlcv/ai_super_score_webhook_bridge_v8_ohlcv.csv \
  --out-reference pine-reference/outputs/ai_super_score_webhook_bridge_v8_reference.csv

# quantum_scalp_strategy_v5
PYTHONPATH=. python -m qtp_server_side.split_tv_export \
  --in  ~/Downloads/AAPL_5m_scalp.csv \
  --module quantum_scalp_strategy_v5 \
  --out-ohlcv     pine-reference/ohlcv/quantum_scalp_strategy_v5_ohlcv.csv \
  --out-reference pine-reference/outputs/quantum_scalp_strategy_v5_reference.csv
```

The splitter prints a summary including any required columns missing from the export — those are the ones you'll need to add `plot(...)` for in Pine and re-export.

---

## 4. Final drift run

After all four `_ohlcv.csv` + `_reference.csv` pairs land in `pine-reference/ohlcv/` and `pine-reference/outputs/`, run:

```bash
cd "/Users/santoshadari/Documents/Claude/Projects/Quantlys Engine"
PYTHONPATH=. python -m qtp_server_side.run_drift_manifest \
  --manifest pine-source/manifest.json \
  --ohlcv-dir pine-reference/ohlcv \
  --reference-dir pine-reference/outputs \
  --out qtp_server_side/drift_report.json \
  --skip-warmup 50
```

Expected good output: `{"PASS": 4, "DRIFT": 0, "SKIPPED": 0}`. Any DRIFT module means at least one column diverged beyond its tolerance; I'll dig into `drift_report.json` per offending bar.

---

## 5. The fastest way to send results back to me

Zip the four exported CSVs (the raw TradingView downloads, before splitting) and drop them in the chat:

```
AAPL_5m_super_score_pro.csv
AAPL_5m_ensemble.csv
AAPL_5m_bridge.csv
AAPL_5m_scalp.csv
```

I'll run the splitter with the right column maps (after eyeballing your real plot titles), drop the eight resulting CSVs into the correct folders, run drift, and report per-column PASS/DRIFT results.
