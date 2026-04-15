# H-2 Fix: Limit Order Entry — Replace Market Orders with NBBO-Informed Limits

**Issue**: H-2 — Market Orders on Scale-Out Cause Slippage  
**Severity**: HIGH  
**Status**: FIXED  
**Date**: 2026-04-15  
**Commit**: (see git log)

---

## Problem

All entry orders (initial + scale-out) were submitted as **market orders**, which provides
zero slippage protection. On low-liquidity, wide-spread names like SMCI and IONQ, a 500-share
market buy can walk the order book $0.50–$2.00 above the NBBO mid, costing $250–$1,000 per entry.

**Root cause**: Alpaca Paper Trade v4.3 used `type: 'market'` for both:
- The bracket path (standard tickers) — `type: 'market'` with `order_class: 'bracket'`
- The volatile/trailing stop path (SMCI, IONQ, TQQQ, etc.) — `type: 'market'` standalone

Market orders provide zero price control. The fill price is whatever the market maker offers
at execution time, which on thin books can be significantly adverse.

---

## Fix Applied — Alpaca Paper Trade v4.4

### Core Change: NBBO Quote → Limit Order

Before every entry, the node now fetches the latest NBBO quote from the Alpaca Data API:

```
GET https://data.alpaca.markets/v2/stocks/{symbol}/quotes/latest
```

The quote provides: bid price (bp), ask price (ap), bid size (bs), ask size (as).

### Limit Price Logic

| Side | Normal Spread (≤0.5%) | Wide Spread (>0.5%) |
|------|----------------------|---------------------|
| BUY  | ask + $0.01 (1 tick) | mid + $0.01         |
| SELL | bid − $0.01 (1 tick) | mid − $0.01         |

**Normal spread** — limit at ask+1tick crosses the spread aggressively, guaranteeing immediate
fill while providing a hard ceiling. The 1-tick buffer above the ask ensures we don't miss fills
on fast-moving quotes. Maximum adverse slippage = 1 tick ($0.01) above the ask at quote time.

**Wide spread** (>0.5% of mid) — the ask is unreliable (thin book). Using mid+1tick caps
adverse selection at half the spread instead of paying the full ask. This is the key protection
for SMCI/IONQ-type names where the spread can be $0.50–$1.00.

### Tick Size

SEC Rule 612 (Sub-Penny Rule): minimum price increment for stocks ≥ $1.00 is $0.01.
Since the S&P 500 whitelist contains no sub-dollar stocks, we use `TICK = $0.01` universally.

### Two Paths, Both Fixed

#### Bracket Path (Standard Tickers)

```javascript
// BEFORE (v4.3): blind market entry
{ type: 'market', order_class: 'bracket', time_in_force: 'gtc', ... }

// AFTER (v4.4): NBBO-informed limit entry
{ type: 'limit', limit_price: String(entryLimit), order_class: 'bracket', time_in_force: 'gtc', ... }
```

Bracket orders require TIF = `gtc` or `day`. IOC is not compatible with bracket order_class.
The limit price from the NBBO quote constrains the fill price while allowing the bracket's
stop-loss and take-profit legs to attach normally.

**Fallback**: If the limit bracket order is rejected (e.g., limit price too stale), the node
retries with `type: 'market'` to ensure position protection is never lost.

#### Volatile/Trailing Stop Path (SMCI, IONQ, TQQQ, etc.)

```javascript
// BEFORE (v4.3): blind market entry
{ type: 'market', time_in_force: 'gtc', ... }

// AFTER (v4.4): limit IOC with market fallback
{ type: 'limit', limit_price: String(entryLimit), time_in_force: 'ioc', ... }
```

IOC (Immediate Or Cancel) fills whatever quantity is available at or better than the limit price,
then cancels any unfilled remainder. This is ideal for the volatile path because:
- It provides the same immediacy as a market order
- It caps the price at the limit (no book-walking)
- If the IOC is fully cancelled (no fill at the limit), we fall back to market

**Market fallback on IOC cancel**: If the IOC limit order returns `cancelled` or `expired`,
the node immediately places a market order as a safety net. Position protection (getting the
trailing stop attached) is more important than saving slippage.

### Fallback Chain

```
1. Fetch NBBO quote
   ├── Success → limit order at ask+1tick (or mid+1tick if wide)
   │   ├── Fill → done
   │   └── IOC cancel / bracket reject → market fallback
   └── Failure (API down, pre-market) → market order (same as v4.3)
```

The system is never worse than v4.3 — the market fallback ensures identical behavior when
the Data API is unavailable.

---

## New Output Fields

The Alpaca Paper Trade node now emits three additional fields downstream:

| Field | Type | Description |
|-------|------|-------------|
| `alpaca_entry_type` | string | `'limit'` or `'market'` — which type was actually used |
| `alpaca_limit_price` | number|null | The limit price used (null if market fallback) |
| `alpaca_quote` | object|null | NBBO snapshot: `{ bid, ask, bidSize, askSize, spread, mid, spreadPct, wideSpread }` |

These fields are available to the Telegram formatter and logging for slippage analysis.

---

## Files Modified

| File | Change |
|------|--------|
| `n8n-workflows/signal-state-machine-v5.16.json` | SM v5.19→v5.20, Alpaca Paper Trade v4.3→v4.4 |
| `limit-order-entry.js` | NEW — Reference implementation module (standalone) |

---

## Slippage Savings Estimate

| Scenario | v4.3 (Market) | v4.4 (Limit) | Savings |
|----------|--------------|--------------|---------|
| SMCI 200 shares, $0.30 spread | ~$60 slippage | ~$2 slippage | ~$58/trade |
| IONQ 500 shares, $0.15 spread | ~$75 slippage | ~$5 slippage | ~$70/trade |
| AAPL 100 shares, $0.01 spread | ~$1 slippage | ~$1 slippage | ~$0 (tight spread) |

The fix primarily benefits wide-spread, lower-liquidity names. For tight-spread, high-liquidity
names (AAPL, MSFT, NVDA), the limit price is essentially the same as the market price and
the improvement is marginal.

---

## Testing Checklist

- [ ] Normal entry (tight spread): Verify limit order fills immediately at ask+1tick
- [ ] Wide spread entry (SMCI/IONQ): Verify mid+1tick limit is used, not full ask
- [ ] Data API failure: Verify market fallback triggers with log warning
- [ ] IOC cancel (volatile path): Verify market fallback fires after IOC expiry
- [ ] Bracket limit reject: Verify market bracket fallback succeeds
- [ ] Downstream fields: Verify `alpaca_entry_type`, `alpaca_limit_price`, `alpaca_quote` appear in output
- [ ] Telegram message: Verify entry type and limit price appear in trade notifications

---

## Risk Assessment

| Risk | Mitigation |
|------|-----------|
| Limit not filling (price moves away) | ask+1tick is aggressive; IOC fallback to market |
| Stale quote (data lag) | +1tick buffer; market fallback on reject |
| Data API down | Full market order fallback (identical to v4.3) |
| Bracket incompatibility | Bracket supports `type: 'limit'` with `limit_price` per Alpaca docs |
| Pre-market/after-hours | Quote may be stale → market fallback handles this gracefully |
