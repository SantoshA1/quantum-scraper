# TradingView Alert Setup — Post-PR #9

After PR #9 (SM-C4 + SE-C5), every webhook reaching the Signal State
Machine MUST carry the shared `webhook_secret` or it is fail-closed
rejected with `AUTH_FAILED` / `SKIP`. This guide is the only thing
that needs to change on the TradingView side.

## 1. Webhook URL

Open every alert that targets the SSM and set:

```
https://tradenextgen.app.n8n.cloud/webhook/tradingview-signal
```

(No query parameters needed. The auth happens via the `_secret`
field inside the alert JSON below.)

## 2. Alert message body (JSON)

Paste this into the alert's "Message" box. Keep `_secret` as the
**first key** and replace the Pine Script placeholders (`{{...}}`)
with the variables your strategy emits. Anything tagged `N/A` stays
`"N/A"` if your script doesn't compute it — the SSM tolerates that.

```json
{
  "_secret": "<WEBHOOK_SECRET_FROM_STATICDATA>",
  "ticker": "{{ticker}}",
  "price": "{{close}}",
  "execution": "{{strategy.order.action}}",
  "signal": "{{strategy.market_position}}",
  "bias_score": "{{plot_0}}",
  "regime": "TRENDING",
  "adx": "N/A",
  "rsi": "N/A",
  "macd_hist": "N/A",
  "atr": "{{plot_1}}",
  "volume_ratio": "N/A",
  "vix": "N/A",
  "timeframe": "{{interval}}",
  "alert_type": "TRADINGVIEW_AI_SUPER_SCORE",
  "comment": "{{strategy.order.comment}}",
  "momentum_engine": "false",
  "momentum_type": "tv_strategy"
}
```

### Notes

- `_secret` value: the live SSM auth secret (`staticData.global._credentials.webhook_secret`).
  In this repo it is intentionally NOT committed. The literal above was
  injected at deploy time. If TradingView shows alerts being rejected,
  pull the current secret with:

  ```bash
  curl -s "https://tradenextgen.app.n8n.cloud/api/v1/workflows/vaqfCaELhOEWnkdo" \
       -H "X-N8N-API-KEY: <ops-key>" \
       | jq -r '.staticData.global._credentials.webhook_secret'
  ```

- `alert_type`: pick anything stable; `TRADINGVIEW_AI_SUPER_SCORE` is
  a sensible default and keeps it distinguishable in execution history
  from internal sources (`REALTIME_AGENT_HYBRID`, `BROAD_SCANNER`,
  `POLYGON_NEWS`).

- The Daily Testing Agent's T7 probe and the Real-Time Signal Agent
  already inject `_secret` automatically — only TradingView alerts
  need this manual configuration.

## 3. Verifying TradingView is reaching the pipeline

After updating an alert and waiting for it to fire (or using the
"Test Alert" button), check execution history:

```bash
curl -s "https://tradenextgen.app.n8n.cloud/api/v1/executions?workflowId=vaqfCaELhOEWnkdo&limit=20&includeData=true" \
     -H "X-N8N-API-KEY: <ops-key>" \
     | jq -r '.data[] | "\(.id)  \(.startedAt)  \(.data.resultData.runData["Webhook Trigger"][0].data.main[0][0].json.body.alert_type // "?")"'
```

A successful TradingView alert should show:
- `alert_type`: `TRADINGVIEW_AI_SUPER_SCORE` (or whatever you picked)
- SSM `_sm_action`: `PASS` (NOT `AUTH_FAILED`)
- Pipeline traverses 10+ nodes ending in `Append to Google Sheet` or
  `Append Shadow to Sheet`
