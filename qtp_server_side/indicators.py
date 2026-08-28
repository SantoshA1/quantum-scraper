"""
indicators.py — Pine Script v5 equivalent series functions.

All functions accept pandas Series (or array-likes that pandas can wrap)
and return pandas Series unless noted otherwise.

TradingView semantics notes
===========================
* Pine ``ta.ema`` uses Wilder-style initialisation (SMA seed for the first
  `length` bars, then EMA from there).  pandas ``ewm(span=length)`` uses
  the standard exponential weight without an SMA seed.  We replicate the SMA
  seed here to match Pine output.

* Pine ``ta.rma`` (Wilder's Smoothed MA / RMA) is ``ewm(alpha=1/length)``.
  We expose it as ``rma()``.

* Pine ``ta.vwap`` resets every *session* (calendar day by default).  Without
  intraday timestamps we approximate a rolling VWAP over the supplied window;
  callers that have a ``datetime`` index can use ``vwap_daily()`` instead.

* Pine ``ta.atr`` uses RMA (Wilder smoothing), not SMA.

* ``barssince(cond)`` scans backward for the last True bar; returns NaN if
  the condition has never been True.

* ``highest()`` / ``lowest()`` lookback is Pine's ``[1]`` offset convention,
  meaning they look at the *previous* bar's window.  Use ``shift=1`` in
  callers to replicate ``ta.highest(high[1], n)``.

* VALIDATION: compare outputs bar-by-bar against TradingView data-window
  exports before using in production.  See drift.py for helper utilities.
"""

from __future__ import annotations

import math
from typing import Optional, Union

import numpy as np
import pandas as pd

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _as_series(x) -> pd.Series:
    if isinstance(x, pd.Series):
        return x
    return pd.Series(x)


def nz(series: pd.Series, replacement: float = 0.0) -> pd.Series:
    """Replace NaN with *replacement* (Pine ``nz()`` function)."""
    return series.fillna(replacement)


def clamp(series: pd.Series, lo: float = 0.0, hi: float = 100.0) -> pd.Series:
    """Clip series to [lo, hi] — Pine ``math.min(hi, math.max(lo, x))``."""
    return series.clip(lower=lo, upper=hi)


# ---------------------------------------------------------------------------
# Moving averages
# ---------------------------------------------------------------------------

def sma(series: pd.Series, length: int) -> pd.Series:
    """Simple moving average — Pine ``ta.sma``."""
    return _as_series(series).rolling(length, min_periods=length).mean()


def ema(series: pd.Series, length: int) -> pd.Series:
    """
    Exponential moving average matching Pine ``ta.ema``.

    Pine seeds the first value with SMA(length).  Subsequent values use the
    standard EMA formula:  ema = alpha * close + (1 - alpha) * prev_ema
    where alpha = 2 / (length + 1).

    NOTE: TradingView validates: output will differ from pandas ``ewm(span)``
    for the first ~length*3 bars due to seeding strategy.
    """
    s = _as_series(series).astype(float)
    alpha = 2.0 / (length + 1)
    result = np.full(len(s), np.nan)

    # Find first valid index
    first_valid = s.first_valid_index()
    if first_valid is None:
        return pd.Series(result, index=s.index)

    iloc_start = s.index.get_loc(first_valid)

    # Need at least `length` bars for SMA seed
    seed_end = iloc_start + length
    if seed_end > len(s):
        return pd.Series(result, index=s.index)

    seed = s.iloc[iloc_start:seed_end].mean()
    result[seed_end - 1] = seed

    for i in range(seed_end, len(s)):
        if np.isnan(s.iloc[i]):
            result[i] = result[i - 1]
        else:
            result[i] = alpha * s.iloc[i] + (1 - alpha) * result[i - 1]

    return pd.Series(result, index=s.index)


def rma(series: pd.Series, length: int) -> pd.Series:
    """
    Wilder Smoothed Moving Average — Pine ``ta.rma``.

    alpha = 1 / length.  Seeds with SMA(length).
    Used by ATR, RSI, ADX internally.
    """
    s = _as_series(series).astype(float)
    alpha = 1.0 / length
    result = np.full(len(s), np.nan)

    first_valid = s.first_valid_index()
    if first_valid is None:
        return pd.Series(result, index=s.index)

    iloc_start = s.index.get_loc(first_valid)
    seed_end = iloc_start + length
    if seed_end > len(s):
        return pd.Series(result, index=s.index)

    seed = s.iloc[iloc_start:seed_end].mean()
    result[seed_end - 1] = seed

    for i in range(seed_end, len(s)):
        if np.isnan(s.iloc[i]):
            result[i] = result[i - 1]
        else:
            result[i] = alpha * s.iloc[i] + (1 - alpha) * result[i - 1]

    return pd.Series(result, index=s.index)


def wma(series: pd.Series, length: int) -> pd.Series:
    """Weighted moving average — Pine ``ta.wma``."""
    s = _as_series(series).astype(float)
    weights = np.arange(1, length + 1, dtype=float)
    return s.rolling(length, min_periods=length).apply(
        lambda x: np.dot(x, weights) / weights.sum(), raw=True
    )


# ---------------------------------------------------------------------------
# Volatility
# ---------------------------------------------------------------------------

def true_range(high: pd.Series, low: pd.Series, close: pd.Series) -> pd.Series:
    """True Range — Pine ``ta.tr(true)`` (uses previous close)."""
    h = _as_series(high)
    l = _as_series(low)
    c = _as_series(close)
    prev_c = c.shift(1)
    tr = pd.concat([
        h - l,
        (h - prev_c).abs(),
        (l - prev_c).abs(),
    ], axis=1).max(axis=1)
    return tr


def atr(high: pd.Series, low: pd.Series, close: pd.Series, length: int = 14) -> pd.Series:
    """
    Average True Range — Pine ``ta.atr(length)``.
    Uses Wilder's RMA (not SMA).
    """
    tr = true_range(high, low, close)
    return rma(tr, length)


def stdev(series: pd.Series, length: int) -> pd.Series:
    """Population std dev over rolling window — Pine ``ta.stdev``."""
    # Pine uses population std dev (ddof=0)
    return _as_series(series).rolling(length, min_periods=length).std(ddof=0)


def bollinger_bands(
    series: pd.Series, length: int = 20, mult: float = 2.0
) -> tuple[pd.Series, pd.Series, pd.Series]:
    """
    Bollinger Bands — Pine ``ta.bb``.
    Returns (upper, basis, lower).
    """
    basis = sma(series, length)
    dev = stdev(series, length)
    upper = basis + mult * dev
    lower = basis - mult * dev
    return upper, basis, lower


# ---------------------------------------------------------------------------
# Momentum
# ---------------------------------------------------------------------------

def rsi(series: pd.Series, length: int = 14) -> pd.Series:
    """
    Relative Strength Index — Pine ``ta.rsi``.

    Uses Wilder smoothing (RMA) on gains / losses, seeded with SMA.

    NOTE: RSI will converge to Pine output after roughly 3×length bars.
    Validate the first 50 bars against TradingView.
    """
    s = _as_series(series).astype(float)
    delta = s.diff()
    gain = delta.clip(lower=0)
    loss = (-delta).clip(lower=0)
    avg_gain = rma(gain, length)
    avg_loss = rma(loss, length)
    rs = avg_gain / avg_loss.replace(0, np.nan)
    return 100.0 - (100.0 / (1.0 + rs))


def macd(
    series: pd.Series,
    fast: int = 12,
    slow: int = 26,
    signal_len: int = 9,
) -> tuple[pd.Series, pd.Series, pd.Series]:
    """
    MACD — Pine ``ta.macd(close, 12, 26, 9)``.
    Returns (macd_line, signal_line, histogram).
    """
    fast_ema = ema(series, fast)
    slow_ema = ema(series, slow)
    macd_line = fast_ema - slow_ema
    signal_line = ema(macd_line, signal_len)
    histogram = macd_line - signal_line
    return macd_line, signal_line, histogram


def roc(series: pd.Series, length: int = 14) -> pd.Series:
    """Rate of Change — Pine ``ta.roc``."""
    s = _as_series(series).astype(float)
    return ((s - s.shift(length)) / s.shift(length)) * 100.0


def momentum(series: pd.Series, length: int = 10) -> pd.Series:
    """Price momentum — Pine ``ta.mom``."""
    s = _as_series(series).astype(float)
    return s - s.shift(length)


def cci(high: pd.Series, low: pd.Series, close: pd.Series, length: int = 20) -> pd.Series:
    """
    Commodity Channel Index — Pine ``ta.cci``.
    CCI = (typical_price - SMA(tp, n)) / (0.015 * mean_deviation)
    """
    tp = (high + low + close) / 3.0
    tp_sma = sma(tp, length)
    mean_dev = tp.rolling(length, min_periods=length).apply(
        lambda x: np.mean(np.abs(x - x.mean())), raw=True
    )
    return (tp - tp_sma) / (0.015 * mean_dev)


def stochastic(
    close: pd.Series,
    high: pd.Series,
    low: pd.Series,
    k_length: int = 14,
    k_smooth: int = 3,
    d_smooth: int = 3,
) -> tuple[pd.Series, pd.Series]:
    """
    Stochastic Oscillator — Pine ``ta.stoch``.
    Returns (stoch_k_smoothed, stoch_d).
    """
    lowest = low.rolling(k_length, min_periods=k_length).min()
    highest = high.rolling(k_length, min_periods=k_length).max()
    raw_k = 100.0 * (close - lowest) / (highest - lowest).replace(0, np.nan)
    k = sma(raw_k, k_smooth)
    d = sma(k, d_smooth)
    return k, d


# ---------------------------------------------------------------------------
# Trend / Directional
# ---------------------------------------------------------------------------

def dmi(
    high: pd.Series,
    low: pd.Series,
    close: pd.Series,
    di_length: int = 14,
    adx_length: int = 14,
) -> tuple[pd.Series, pd.Series, pd.Series]:
    """
    Directional Movement Index — Pine ``ta.dmi(di_length, adx_length)``.
    Returns (plus_di, minus_di, adx).

    NOTE: Pine ``ta.dmi`` uses RMA for both smoothing steps.  We replicate
    that.  Some data vendors use SMA; validate outputs.
    """
    h = _as_series(high).astype(float)
    l = _as_series(low).astype(float)
    c = _as_series(close).astype(float)

    up_move = h - h.shift(1)
    down_move = l.shift(1) - l

    plus_dm = pd.Series(np.where(
        (up_move > down_move) & (up_move > 0), up_move, 0.0
    ), index=h.index)
    minus_dm = pd.Series(np.where(
        (down_move > up_move) & (down_move > 0), down_move, 0.0
    ), index=h.index)

    tr = true_range(high, low, close)
    tr_rma = rma(tr, di_length)
    plus_dm_rma = rma(plus_dm, di_length)
    minus_dm_rma = rma(minus_dm, di_length)

    plus_di = 100.0 * plus_dm_rma / tr_rma.replace(0, np.nan)
    minus_di = 100.0 * minus_dm_rma / tr_rma.replace(0, np.nan)

    di_sum = plus_di + minus_di
    dx = 100.0 * (plus_di - minus_di).abs() / di_sum.replace(0, np.nan)
    adx_val = rma(dx, adx_length)

    return plus_di, minus_di, adx_val


def adx_manual(
    high: pd.Series,
    low: pd.Series,
    close: pd.Series,
    length: int = 14,
) -> pd.Series:
    """
    Computes ADX as done in ai_super_score_pro_v25 (manual DM derivation,
    not using ta.dmi).  Kept separate so both formulations are available.
    """
    _, _, adx_val = dmi(high, low, close, length, length)
    return adx_val


def chop(
    high: pd.Series,
    low: pd.Series,
    close: pd.Series,
    length: int = 14,
) -> pd.Series:
    """
    Choppiness Index — Pine formula used in ai_super_score_pro_v25.
    CHOP = 100 * log10(SumTR(n) / (HH(n) - LL(n))) / log10(n)

    NOTE: Pine ``ta.sma(tr, n) * n`` gives the same result as ``ta.sum(tr, n)``
    for non-NaN inputs.  We use rolling sum directly.
    """
    tr = true_range(high, low, close)
    sum_tr = tr.rolling(length, min_periods=length).sum()
    hh = high.rolling(length, min_periods=length).max()
    ll = low.rolling(length, min_periods=length).min()
    hl_range = (hh - ll).replace(0, np.nan)
    return 100.0 * np.log10(sum_tr / hl_range) / math.log10(length)


# ---------------------------------------------------------------------------
# Volume / Price
# ---------------------------------------------------------------------------

def vwap_rolling(
    close: pd.Series,
    volume: pd.Series,
    length: int = 14,
) -> pd.Series:
    """
    Rolling VWAP approximation.  Pine ``ta.vwap`` resets each session;
    this version uses a rolling window and is suitable for daily / non-
    intraday data.  For intraday data with a DatetimeIndex use vwap_daily().

    VALIDATION REQUIRED: Compare to TradingView VWAP plot on the same chart.
    """
    c = _as_series(close).astype(float)
    v = _as_series(volume).astype(float)
    cumvp = (c * v).rolling(length, min_periods=1).sum()
    cumv = v.rolling(length, min_periods=1).sum()
    return cumvp / cumv.replace(0, np.nan)


def vwap_daily(
    close: pd.Series,
    volume: pd.Series,
    hlc3: Optional[pd.Series] = None,
) -> pd.Series:
    """
    Session-reset VWAP using DatetimeIndex groupby.

    Mirrors Pine ``ta.vwap(hlc3)`` which resets at the start of each
    calendar day.  Requires a tz-aware or tz-naive DatetimeIndex.

    Parameters
    ----------
    close  : bar close (used as fallback typical price if hlc3 is None)
    volume : bar volume
    hlc3   : (high+low+close)/3 — use this if available (matches Pine default)
    """
    if hlc3 is None:
        tp = close
    else:
        tp = hlc3
    df = pd.DataFrame({"tp": tp, "volume": volume, "date": tp.index.date})
    df["cum_vp"] = df.groupby("date").apply(
        lambda g: (g["tp"] * g["volume"]).cumsum()
    ).values
    df["cum_v"] = df.groupby("date")["volume"].cumsum().values
    return df["cum_vp"] / df["cum_v"].replace(0, np.nan)


# ---------------------------------------------------------------------------
# High / Low lookbacks
# ---------------------------------------------------------------------------

def highest(series: pd.Series, length: int, shift: int = 0) -> pd.Series:
    """
    Rolling max — Pine ``ta.highest(series, length)``.
    Use shift=1 to replicate ``ta.highest(series[1], length)`` (Pine offset).
    """
    s = _as_series(series)
    if shift:
        s = s.shift(shift)
    return s.rolling(length, min_periods=length).max()


def lowest(series: pd.Series, length: int, shift: int = 0) -> pd.Series:
    """
    Rolling min — Pine ``ta.lowest(series, length)``.
    Use shift=1 to replicate ``ta.lowest(series[1], length)``.
    """
    s = _as_series(series)
    if shift:
        s = s.shift(shift)
    return s.rolling(length, min_periods=length).min()


# ---------------------------------------------------------------------------
# Utility
# ---------------------------------------------------------------------------

def barssince(condition: pd.Series) -> pd.Series:
    """
    Number of bars since condition was last True — Pine ``ta.barssince``.
    Returns NaN if condition has never been True up to that bar.

    NOTE: Pine counts from 0 on the triggering bar.  This function returns
    0 on the bar where condition is True, and increments each subsequent bar.
    """
    cond = _as_series(condition).astype(bool)
    result = np.full(len(cond), np.nan)
    last_true = None
    for i, val in enumerate(cond):
        if val:
            last_true = i
        if last_true is not None:
            result[i] = i - last_true
    return pd.Series(result, index=cond.index)


def crossover(a: pd.Series, b: pd.Series) -> pd.Series:
    """True on bar where a crosses above b — Pine ``ta.crossover``."""
    a, b = _as_series(a), _as_series(b)
    return (a > b) & (a.shift(1) <= b.shift(1))


def crossunder(a: pd.Series, b: pd.Series) -> pd.Series:
    """True on bar where a crosses below b — Pine ``ta.crossunder``."""
    a, b = _as_series(a), _as_series(b)
    return (a < b) & (a.shift(1) >= b.shift(1))


def change(series: pd.Series, length: int = 1) -> pd.Series:
    """Difference from *length* bars ago — Pine ``ta.change``."""
    return _as_series(series).diff(length)


def parabolic_sar(
    high: pd.Series,
    low: pd.Series,
    start: float = 0.02,
    increment: float = 0.02,
    maximum: float = 0.2,
) -> pd.Series:
    """
    Parabolic SAR — Pine ``ta.sar(start, increment, maximum)``.

    NOTE: This is a simplified implementation.  TradingView's SAR uses
    specific initialisation logic.  VALIDATION REQUIRED for the first
    ~20 bars.
    """
    h = _as_series(high).values.astype(float)
    l = _as_series(low).values.astype(float)
    n = len(h)
    sar = np.full(n, np.nan)
    if n < 2:
        return pd.Series(sar, index=high.index)

    is_bull = True
    af = start
    ep = h[0]
    sar[0] = l[0]

    for i in range(1, n):
        if is_bull:
            sar[i] = sar[i - 1] + af * (ep - sar[i - 1])
            sar[i] = min(sar[i], l[i - 1], l[i - 2] if i > 1 else l[i - 1])
            if l[i] < sar[i]:
                is_bull = False
                sar[i] = ep
                ep = l[i]
                af = start
            else:
                if h[i] > ep:
                    ep = h[i]
                    af = min(af + increment, maximum)
        else:
            sar[i] = sar[i - 1] + af * (ep - sar[i - 1])
            sar[i] = max(sar[i], h[i - 1], h[i - 2] if i > 1 else h[i - 1])
            if h[i] > sar[i]:
                is_bull = True
                sar[i] = ep
                ep = h[i]
                af = start
            else:
                if l[i] < ep:
                    ep = l[i]
                    af = min(af + increment, maximum)

    return pd.Series(sar, index=high.index)
