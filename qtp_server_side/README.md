# qtp_server_side

Server-side Python port of four TradingView Pine Script v5 indicators.

**Shadow / local use only. Do NOT connect to n8n or production workflows.**

---

## Package structure

```
qtp_server_side/
├── __init__.py
├── indicators.py              # Pine-equivalent series functions
├── super_score_pro_v25.py     # AI Super Score Pro v2.5 Universal
├── webhook_bridge_v8.py       # AI Super Score Webhook Bridge v8
├── ensemble_engine_v1.py      # AI Super Score Ensemble Engine v1
├── quantum_scalp_strategy_v5.py  # Quantum Scalp Strategy v5
├── payload.py                 # Alert payload field definitions
├── drift.py                   # Drift validation utilities
└── README.md
```

## Source Pine files

```
pine-source/
├── ai_super_score_pro_v25_universal.pine
├── ai_super_score_webhook_bridge_v8.pine
├── ai_super_score_ensemble_engine_v1.pine
└── quantum_scalp_strategy_v5.pine
```

---

## Requirements

```bash
pip install pandas numpy
```

Optional (for CSV drift exports):

```bash
pip install pyarrow  # faster parquet I/O
```

---

## Run commands

### 1 — Compute Super Score Pro v2.5 on a bar DataFrame

```python
import pandas as pd
from qtp_server_side.super_score_pro_v25 import compute, SuperScoreConfig

# ohlcv must have columns: open, high, low, close, volume
# with a DatetimeIndex for VWAP session reset and session filter
ohlcv = pd.read_csv("my_data.csv", index_col=0, parse_dates=True)

# Optional: supply aligned VIX / QQQ / SPY series
# vix = pd.read_csv("vix.csv", index_col=0, parse_dates=True)["close"]

cfg = SuperScoreConfig(profile_mode="Balanced")
result = compute(ohlcv, config=cfg)   # returns DataFrame, one row per bar

# Latest bar only
last = result.iloc[-1]
print(last["execution_bias"], last["execution_score"], last["signal_text"])
```

### 2 — Build a Webhook Bridge v8 payload

```python
from qtp_server_side.webhook_bridge_v8 import BridgeConfig, build_from_bar
import json

cfg = BridgeConfig(
    execution="BUY",
    signal="BULLISH",
    regime="TRENDING",
    bias_score=78.0,
    exec_score=82.0,
    grade="A",
    smart_money="BULLISH",
    liquidity="SSL NEAR",
    fvg="BULL FVG",
    order_block="BULL OB BELOW",
    chart_image_url="https://example.com/chart.png",
    chart_vision_enabled=True,
    signal_source="webhook_bridge_v8",
)

payload = build_from_bar(
    ohlcv,
    cfg,
    daily_high=float(ohlcv["high"].max()),
    daily_low=float(ohlcv["low"].min()),
    vix=18.5,
    spy_close=520.0, spy_prev=519.0, spy_sma20=515.0, spy_ema50=510.0,
    qqq_close=440.0, qqq_prev=438.0, qqq_sma20=435.0, qqq_ema50=430.0,
    xly_close=195.0, xly_prev=194.0, xly_sma20=192.0, xly_ema50=190.0,
    ticker="NVDA",
    exchange="NASDAQ",
    timeframe="5",
    prev_execution="STAND ASIDE",
)
print(json.dumps(payload, indent=2))
```

### 3 — Run Ensemble Engine v1

```python
from qtp_server_side.ensemble_engine_v1 import compute as ee_compute, EnsembleConfig
from qtp_server_side import indicators as ind

cfg = EnsembleConfig(
    execution="BUY",
    signal="BULLISH",
    smart_money="BULLISH",
    liquidity="SSL NEAR",
    order_block="BULL OB BELOW",
)

# Pre-compute HTF EMAs (example: 15m ema21 resampled and forward-filled)
htf_ema_1 = ind.ema(ohlcv_15m["close"], 21).reindex(ohlcv.index, method="ffill")

result = ee_compute(
    ohlcv,
    cfg,
    htf_ema_1=htf_ema_1,
    vix_close=vix_series,
    market_close=spy_series,
    market_ema=ind.ema(spy_series, 21),
    leader_close=qqq_series,
    leader_ema=ind.ema(qqq_series, 21),
)
print(result[["final_execution", "final_score", "final_grade"]].tail())
```

---

## T01 parity modules — import and run all four

All four ports are shadow/local only and are safe to run against CSV or Massive
market data without touching n8n, Supabase writes, Alpaca, or production order
routing.

```python
import pandas as pd

from qtp_server_side.super_score_pro_v25 import (
    SuperScoreConfig,
    compute as compute_super_score,
    build_signal_payload as build_super_score_payload,
)
from qtp_server_side.ensemble_engine_v1 import (
    EnsembleConfig,
    compute as compute_ensemble,
    build_signal_payload as build_ensemble_payload,
)
from qtp_server_side.webhook_bridge_v8 import (
    BridgeConfig,
    compute_technicals as compute_bridge_technicals,
    detect_sweeps as compute_bridge_sweeps,
    build_signal_payload as build_bridge_payload,
)
from qtp_server_side.quantum_scalp_strategy_v5 import (
    ScalpConfig,
    compute as compute_scalp,
    build_signal_payload as build_scalp_payload,
    PortfolioState,
)

ohlcv = pd.read_csv("ohlcv.csv", index_col=0, parse_dates=True)

super_score = compute_super_score(ohlcv, SuperScoreConfig())
ensemble = compute_ensemble(ohlcv, EnsembleConfig())
bridge = compute_bridge_technicals(ohlcv).join(compute_bridge_sweeps(ohlcv), how="left")
scalp = compute_scalp(ohlcv, ScalpConfig())

print(super_score.tail(1))
print(ensemble.tail(1))
print(bridge.tail(1))
print(scalp.tail(1))
```

### One-command drift test

```bash
PYTHONPATH=/home/user/workspace python -m qtp_server_side.run_drift_manifest \
  --manifest /home/user/workspace/pine-source/manifest.json \
  --ohlcv-dir /home/user/workspace/pine-reference/ohlcv \
  --reference-dir /home/user/workspace/pine-reference/outputs \
  --out /home/user/workspace/qtp_server_side/drift_report.json
```

If a reference CSV is not present, that module is marked `SKIPPED` rather than
failed. Add reference exports with names like
`ai_super_score_pro_v25_universal_reference.csv` and matching OHLCV exports like
`ai_super_score_pro_v25_universal_ohlcv.csv`.

### One-command scanner shadow smoke test

This validates the main scanner can import and run all four parity modules in
shadow-only mode. It does not call n8n, Supabase, Alpaca, or Telegram.

```bash
PYTHONPATH=/home/user/workspace python - <<'PY'
import datetime as dt, math, random
from qtp_server_side_scanner_v55 import (
    Candle,
    build_shadow_parity_payloads,
    build_webhook_payload,
    compute_indicator_state,
)

random.seed(7)
start = dt.datetime(2026, 5, 15, 13, 30, tzinfo=dt.timezone.utc)
five = []
for i in range(260):
    base = 100 + math.sin(i / 10) * 1.5 + i * 0.02
    close = base + random.uniform(-0.2, 0.2)
    open_ = base + random.uniform(-0.2, 0.2)
    five.append(Candle(start + dt.timedelta(minutes=5 * i), open_, max(open_, close) + 0.3, min(open_, close) - 0.3, close, 100000 + i * 100))

daily = []
for i in range(260):
    base = 90 + i * 0.05
    daily.append(Candle(start - dt.timedelta(days=260 - i), base, base + 2, base - 2, base + 1, 1000000))

shadow = build_shadow_parity_payloads(
    ticker="AAPL",
    exchange="NASDAQ",
    timeframe="5",
    five_min=five,
    daily=daily,
    chart_vision_enabled=False,
    signal_source="server_side",
)
indicator = compute_indicator_state("AAPL", five, daily)
payload = build_webhook_payload(
    ticker="AAPL",
    exchange="NASDAQ",
    indicator=indicator,
    signal_source="server_side",
    shadow_parity=shadow,
)
assert payload["shadow_parity_enabled"] is True
assert set(payload["shadow_parity"]["modules"]) == {
    "super_score_pro_v25",
    "ensemble_engine_v1",
    "webhook_bridge_v8",
    "quantum_scalp_v5",
}
print("SHADOW_PARITY_OK")
PY
```

### 4 — Quantum Scalp Strategy v5 signals

```python
from qtp_server_side.quantum_scalp_strategy_v5 import compute as qs_compute, ScalpConfig

cfg = ScalpConfig(mode="AUTO", require_cross=True, enable_momentum=True)

result = qs_compute(
    ohlcv,
    cfg,
    htf_ema_1=htf_5m_ema21,
    htf_ema_2=htf_15m_ema21,
    htf_ema_3=htf_60m_ema50,
    htf_ema_4=htf_240m_ema50,
    vix_close=vix_series,
    spy_close=spy_5m, spy_prev=spy_5m.shift(1),
    spy_sma20=ind.sma(spy_5m, 20), spy_ema50=ind.ema(spy_5m, 50),
    qqq_close=qqq_5m, qqq_prev=qqq_5m.shift(1),
    qqq_sma20=ind.sma(qqq_5m, 20), qqq_ema50=ind.ema(qqq_5m, 50),
    daily_close=daily_close_ff, daily_sma50=daily_sma50_ff, daily_ema21=daily_ema21_ff,
)

# Rows where score engine triggers a long
longs = result[result["score_long_signal"]]
print(longs[["raw_bull_score", "raw_bear_score", "adx_val", "gap_pct"]])
```

### 5 — Validate payload fields

```python
from qtp_server_side.payload import normalize_payload, validate_payload, payload_to_json

p = normalize_payload(raw_webhook_dict)
errors = validate_payload(p)
if errors:
    print("Payload errors:", errors)
else:
    print(payload_to_json(p, indent=2))
```

---

## Drift validation steps

### Step 1 — Export Pine reference data from TradingView

1. Open the chart with the indicator loaded.
2. Shift-click a bar to open the Data Window.
3. Right-click → "Export data to CSV".
4. Repeat for at least **200 bars** (covering indicator warm-up).
5. Save as `pine_ref_{indicator}_{ticker}_{timeframe}.csv`.

Required columns per module:

| Module | Columns to export |
|--------|-------------------|
| super_score_pro_v25 | execution_score, bias_score, adx, chop, rsi, ema9, ema21, ema50, sma200, atr, macd_hist, rel_vol, smart_money_score |
| webhook_bridge_v8 | rsi_14, macd_line, macd_hist, sma_50, ema_200, vwap, atr_14, adx_val |
| ensemble_engine_v1 | raw_bull_score, raw_bear_score, final_score, adx, rel_vol |
| quantum_scalp_v5 | raw_bull_score, raw_bear_score, adx_val, rsi_14, rel_vol, gap_pct, stoch_k, stoch_d |

### Step 2 — Run drift comparison

```python
import pandas as pd
from qtp_server_side.drift import drift_report, TOLERANCES_SUPER_SCORE
from qtp_server_side.super_score_pro_v25 import compute, SuperScoreConfig

# Load OHLCV and Pine reference
ohlcv = pd.read_csv("ohlcv_NVDA_5m.csv", index_col=0, parse_dates=True)
pine  = pd.read_csv("pine_ref_super_score_NVDA_5m.csv", index_col=0, parse_dates=True)

# Compute Python version
python_df = compute(ohlcv, SuperScoreConfig())

# Compare
results = drift_report(
    python_df, pine,
    fields=TOLERANCES_SUPER_SCORE,
    skip_warmup=50,
)
```

### Step 3 — Investigate drift bars

```python
from qtp_server_side.drift import compare_series

r = compare_series(
    python_df["execution_score"],
    pine["execution_score"],
    name="execution_score",
    tolerance=0.5,
    skip_warmup=50,
)

# Inspect specific drift bars
for idx in r["drift_bars"][:5]:
    print(f"Bar {idx}:")
    print(f"  Python: {python_df.loc[idx, 'execution_score']:.4f}")
    print(f"  Pine:   {pine.loc[idx, 'execution_score']:.4f}")
    print(f"  VWAP py:{python_df.loc[idx, 'vwap']:.4f}")
```

### Step 4 — Check known differences

```python
from qtp_server_side.drift import print_known_differences
print_known_differences()
```

---

## Key formulas and TradingView semantic notes

### EMA (indicators.py)
Pine seeds with SMA(length) then uses `alpha = 2/(length+1)`.  Our implementation
replicates this seed.  Differences persist for the first `3×length` bars.

### RMA / Wilder smoothing
`alpha = 1/length`.  Used by ATR, RSI internal smoothing, and ADX.

### ATR
`atr = rma(tr, length)` — NOT SMA.  Pine v5 default uses Wilder smoothing.

### Choppiness Index
```
CHOP = 100 × log10(SumTR(n) / (HH(n) - LL(n))) / log10(n)
```
where `SumTR` = rolling sum of True Range over `n` bars.

### ADX / DMI
Standard Wilder DMI: `plusDI = 100 × rma(plusDM, n) / rma(tr, n)`.
The bridge script uses a non-standard proxy:
`adx_val = rma(abs(change(high) - change(low)), 14)` — replicated in `pseudo_adx()`.

### VWAP
Pine resets each *session* (calendar day by default).
- `vwap_daily()` — use with DatetimeIndex for accurate day-reset.
- `vwap_rolling()` — 30-bar rolling approximation.

### Bollinger Bands standard deviation
Pine uses **population** std dev (ddof=0).  Our `stdev()` matches this.

### Signal grades (Super Score Pro)
```
A  = gradeScore >= 6  (7 criteria total)
B  = gradeScore >= 4
C  = gradeScore < 4
```

### Score components (Super Score Pro)
| Component | Max contribution |
|-----------|-----------------|
| trendScore (full alignment) | ±25 |
| mtfScore (QQQ/SPY/EMA) | ±20 |
| momScore (RSI/MACD/ROC) | ±19 |
| volScore | ±15 |
| smartMoneyScore | ±76 (incl. sweep ±18) |
| regimeScore | +12 / −12 / −6 |
| priceActionScore | ±10 |
| bbScore | +8 / +5 / −5 |

Execution score = clamp(0, 100, 50 + all components − penalties)

### Ensemble Engine grade thresholds
```
A+ >= 95,  A >= 90,  B+ >= 85,  B >= 80,
C+ >= 70,  C >= 60,  D >= 50,   F < 50
```

---

## Formulas not fully ported

| Formula / Feature | Reason | Workaround |
|---|---|---|
| `ta.vwap(hlc3)` session reset | Requires intraday DatetimeIndex with US session boundaries | Use `vwap_daily()` with tz-aware index |
| Session filter (`sessionInput`) | Pine `time()` session string parsing not replicated | Filter by DatetimeIndex hour/minute on caller side |
| `request.security()` live data | Only callable from TradingView | Supply aligned Series as arguments |
| `strategy.exit` trailing stop | Requires live order book | Compute `trail_pts` / `trail_offset` fields and pass to order manager |
| `fill_orders_on_standard_ohlc=false` + `use_bar_magnifier=true` | TradingView execution model | Cannot replicate; backtest P&L will differ |
| `bar_index` guard in FVG (`bar_index >= 2`) | Always satisfied after warmup in batch mode | First 2 bars return False by design |
| `ta.barssince()` initialization | Pine returns `na` when condition never true; Python returns `NaN` | Same semantic, different type — use `.isna()` |
| `parabolic_sar` exact TradingView initialization | Complex edge case for first SAR direction | Validate and override manually if needed |
| Weekly drawdown new_week detection | `ta.change(time("W"))` requires calendar-aligned DatetimeIndex | Use `ohlcv.index.isocalendar().week.diff() != 0` |

---

## Important reminders

- All modules are **shadow-only**.  No production data is read or written.
- Do not import these modules in any n8n script or webhook endpoint.
- VWAP numbers will diverge from live chart unless you pass a DatetimeIndex with the correct session timezone.
- Always run `drift_report()` before relying on output for decision-making.
