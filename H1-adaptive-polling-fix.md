# H-1 Fix: Adaptive Polling for Trailing Stop Manager

## Audit Issue

**ID:** H-1 (High)
**Component:** Trailing Stop Manager (n8n cron workflow)
**Risk:** 15-minute polling interval means a volatile stock can gap through multiple tiers without a stop adjustment. In the worst case, a position can move 3×ATR in 15 minutes (common for SMCI, IONQ, leveraged ETFs) with no stop update.

## Root Cause

The v1.7 trigger was a fixed `scheduleTrigger` set to 15-minute intervals. Every position — from stable utilities to 3x leveraged ETFs — was checked at the same frequency. This is a one-size-fits-none approach.

## Fix: Adaptive Dual-Mode Polling (v1.8)

### Trigger Change

| | v1.7 | v1.8 |
|--|------|------|
| Trigger interval | 15 minutes | **2 minutes** |
| Positions checked per run | All | **Only high-vol** (unless full scan cycle) |
| Full scan frequency | Every run | **Every 8th run (~16 min)** |

### Volatility Classification

Each position is classified every cycle. If ANY criterion is met, the position is HIGH-VOL:

| Criterion | Threshold | Rationale |
|-----------|-----------|-----------|
| ATR % of price | > 3% | Inherently volatile stock (e.g., SMCI, IONQ) |
| VIX level | > 20 | High-vol market regime → all positions need fast monitoring |
| Leveraged ETF | Any (TQQQ, SOXL, etc.) | 3x leverage = 3x gap risk |
| Price move since last check | > 1×ATR | Sudden move — emergency processing |
| Tier proximity | Within 0.5×ATR of next tier | About to trigger a stop adjustment |

### Scan Types

**FAST scan** (runs 1-7): Only HIGH-VOL positions are processed. Normal positions are skipped entirely — zero API calls for them.

**FULL scan** (every 8th run): All positions are processed regardless of volatility classification.

### API Call Budget

| Scenario | v1.7 (15-min) | v1.8 (2-min) |
|----------|--------------|--------------|
| 10 positions, 3 high-vol | 40 calls/hr | ~60 calls/hr |
| 10 positions, 0 high-vol | 40 calls/hr | ~16 calls/hr |
| 10 positions, all high-vol (VIX>20) | 40 calls/hr | ~300 calls/hr |
| 20 positions, 5 high-vol | 80 calls/hr | ~180 calls/hr |

Alpaca allows 10,000 calls/min — this is well within budget even at maximum.

### Emergency Scan

If any position's price has moved > 1×ATR since the last check (regardless of classification), it's force-promoted to HIGH-VOL and processed immediately. This catches flash moves that happen between full scans.

### WebSocket Consideration

Alpaca offers real-time WebSocket streaming (`wss://stream.data.alpaca.markets/v2/sip`). This was evaluated but NOT implemented because:

1. n8n Code nodes cannot maintain persistent WebSocket connections across executions
2. A separate always-on process (Railway/Docker) would be needed
3. The 2-min adaptive polling provides sufficient coverage for paper trading

**Recommendation:** Implement WebSocket monitoring as a separate Railway service before switching to live trading. This is tracked as a future enhancement, not a blocker.

## State Additions

| Key | Purpose |
|-----|---------|
| `_runCounter` | Tracks which cycle we're on (modulo 8 = full scan) |
| `_lastPrices` | Last checked price per symbol (for emergency detection) |
| `_pollingStats` | Running counters: fastScans, fullScans, emergencyScans |

## Files

- `trailing-stop-v1.8.js` — standalone reference code
- `n8n-workflows/trailing-stop-manager-v1.json` — importable workflow (trigger + code)
- `H1-adaptive-polling-fix.md` — this documentation

## Deployment

1. Open Trailing Stop Manager in n8n
2. **Update trigger**: Change "Every 15 min" to "Every 2 min" (Minutes → 2)
3. **Update code**: Replace "Trail Stops" Code node with contents of `trailing-stop-v1.8.js`
4. Save and activate
5. Verify: logs should show `[TRAIL v1.8] FAST scan #N` and `[TRAIL v1.8] FULL scan #N`

## Monitoring

Scan metadata is output on every run:
```
SCAN_META: { run: 5, scanType: "FAST", highVolProcessed: 3, normalSkipped: 7, vix: 22.5 }
```

Telegram messages now include scan type: `⚡ FAST` or `🔄 FULL`.
