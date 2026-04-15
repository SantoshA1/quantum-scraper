# C-6 Fix: Position Notional Cap + Sector Concentration Limits

## Audit Issue

**ID:** C-6 (Critical)
**Component:** Signal State Machine + Alpaca Paper Trade (n8n workflows)
**Risk:** No absolute dollar cap per position. A single position can consume disproportionate equity. A single bad trade in a concentrated sector can wipe out gains across the portfolio.

## Root Cause

The existing system has position count limits (`MAX_CONCURRENT = 20`) and heat percentage tracking, but:
- **No per-position dollar cap** — a $500 stock with 5% sizing on a $100K account = $5K, but the same % on a concentrated high-conviction signal could be much larger
- **No sector concentration limit** — 4 tech positions could consume 40%+ of equity
- **Leveraged ETFs not accounted for** — TQQQ at 3x means $10K notional = $30K effective exposure
- **No warning before breach** — positions silently grow too large

## Fix: Two-Layer Defense

### Layer 1: Signal State Machine (Pre-Trade Gate)
Checks proposed position against caps BEFORE routing to Alpaca. Can:
- **Clamp** qty down to fit within caps
- **Block** entry entirely if sector is full
- **Warn** when approaching limits (Telegram alert)

### Layer 2: Alpaca Paper Trade (Final Guard)
Verifies notional one more time right before order submission. Catches any edge case where stale data in the SM allowed an oversized position through.

## Files

- `position-sizer.js` — canonical reference module with sector map, limit config, and `preTradeCheck()` function
- `C6-position-notional-cap-fix.md` — this documentation

## Configuration

Override defaults via workflow static data key `_positionLimits`:

```json
{
  "maxPositionPct": 10,
  "maxSectorPct": 25,
  "warnPositionPct": 8,
  "warnSectorPct": 20,
  "maxTotalExposurePct": 80
}
```

| Limit | Default | Purpose |
|-------|---------|---------|
| `maxPositionPct` | 10% | Hard cap per position (% of equity) |
| `maxSectorPct` | 25% | Hard cap per GICS sector (% of equity) |
| `warnPositionPct` | 8% | Telegram warning threshold |
| `warnSectorPct` | 20% | Telegram warning threshold |
| `maxTotalExposurePct` | 80% | Total portfolio exposure cap |

Leveraged ETFs (TQQQ, SOXL, etc.) are multiplied by their leverage factor (2x or 3x) for concentration calculations.

## Deployment

See the n8n modification guide in the commit for exact code insertion points.
