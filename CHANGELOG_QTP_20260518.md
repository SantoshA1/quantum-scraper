# QTP GitHub Sync — 2026-05-18

## Synced production n8n workflow exports

- Updated `n8n_workflows/current/main_trading_current.json` from live n8n workflow `vaqfCaELhOEWnkdo`.
- Updated `n8n_workflows/current/broad_scanner_real_time_agent_current.json` from live n8n workflow `975pZZEtxeUbzI22`.
- Added timestamped backup exports under `n8n_workflows/backups/`.

## Main Trading Bias Filter v5.6 updates captured

- Production paper-gated Bias Filter threshold remains `55`.
- Paper-only relaxed secondary confirmation captured: `PAPER_RELAXED_SECONDARY_V56`.
- Paper-gated trend-conflict hard-allow captured: `PAPER_HARD_ALLOW_TREND_CONFLICT`.
- Relaxed paper secondary supports `volume_ratio > 0.95` or neutral/unknown/aligned/confirmed/strong cross-asset context.

## Safety state

- Alpaca remains paper-only.
- `qtp_live_trading_allowed=false` remains the required production paper-gated safety flag.
- VC Gate, backtest enforcement, risk, pause, idempotency, protected position, Telegram, and Supabase paths are preserved as workflow exports only.
