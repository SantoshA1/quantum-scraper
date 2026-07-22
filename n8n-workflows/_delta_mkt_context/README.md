# QTP_MKT_CONTEXT_v1_20260722 — index/sector tape context (PO-directed)

Goal: every trade decision sees how the broad market and the stock's own sector
index are performing. Advisory-only; nothing gates on it yet.

## Shipped 2026-07-22 (both live)

### 1. Regime Service v2 — `QTP Regime Service v1` (YIfED3NC8YyC7Ubv), gov #136
File: `regime-service-v2-labeler.js` (node "Fetch Market Data + Regime Labeler")

- **BUG FIX (perpetual CHOP):** v1's daily-bars call had no `start` param, so
  Alpaca returned only today's partial bar → `spyPrev == spyLast` → every row
  since 07-08 wrote 0.00% / CHOP / LOW. v2 uses the snapshot endpoint's
  `prevDailyBar` (same pattern as the Broad Scanner).
- **ADD:** DIA, IWM + 11 SPDR sector ETFs (XLK XLF XLV XLE XLY XLP XLI XLU XLB
  XLRE XLC) day-returns persisted into `regime_state.inputs.sectors` (jsonb, no
  schema change) + breadth counts `sectors_up`/`sectors_dn`.
- method_version `QTP_REGIME_V2_SECTORS_20260722`. Cadence 30 min, market hours.
- Test-verified exec 435462: SPY +0.06 / QQQ −0.27 real divergence, sectors full.

### 2. Analyst v2.3 — main SM (vaqfCaELhOEWnkdo), node "Grok AI Analysis", gov #137
File: `claude-ai-analysis-v2.3.js` — live version 1aaee601 (before: 88e43b98)

- SIC→SPDR sector mapping via Polygon ticker overview (uses `item._polygon_key`
  exposed by Indicator Enrichment).
- One Alpaca snapshot call (SPY, QQQ, DIA, IWM + sector ETF), day % vs prevDailyBar.
- Prompt gains `Index/Sector tape: SPY +x% | QQQ ... | sector XLY -0.71% -> trade
  is WITH TAPE`; system prompt instructs: counter-tape trades need stronger
  evidence / lower confidence.
- Telemetry: `_mkt_spy_pct _mkt_qqq_pct _mkt_dia_pct _mkt_iwm_pct _mkt_sector_etf
  _mkt_sector_pct _mkt_sic_code _mkt_alignment(WITH_TAPE/AGAINST_TAPE/NEUTRAL_TAPE)
  _mkt_benchmark _mkt_ctx_ok`.
- FAIL-OPEN: both HTTP calls try/caught; on any failure prompt says "unavailable"
  and pipeline continues identically to v2.2. Contract unchanged
  (choices[0].message.content + AIJSON + _grok_ai_* names).
- Harness-verified exec 435485: WMT SIC 5331→XLY, live tape, Opus reasoned about
  the tape explicitly, AIJSON parsed (SELL 62).

## Measurement (before any gating decision)
`_mkt_alignment` joins to outcomes via trade_ledger; regime_state now carries
real sector history every 30 min. After the swing calibration sample (30–50
closed trades), compare expectancy WITH_TAPE vs AGAINST_TAPE before proposing
any hard gate on tape alignment.
