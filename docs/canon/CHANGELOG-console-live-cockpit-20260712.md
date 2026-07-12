# QTP Operations Console — Live Cockpit (2026-07-12)

Change set that turned `/console` into the live operations cockpit (Telegram replacement)
and shipped the public "How It Works" page + nav link. Frontend is in git
(`Agility-Business-Services/qlib-frontend@main`); backend is version-tracked in Supabase
migration history and n8n published versions. This document is the single written trail.

## Operating principle set by this change
- **Only `/console` is live.** It polls the QTP Console Data feed every **8s**.
- **Every other surface is reload-only** — Live P&L (`/pnl-dashboard`) and the homepage
  Performance section fetch once per page load, no polling. (`/api/alpaca-stats` recomputes
  server-side each request, edge-cached 30s.)

## Frontend — `qlib-frontend@main` (pushed via deploy .command, Mac git creds)
- `app/(app)/console/page.tsx` — rewritten as a client component:
  - Polls `https://tradenextgen.app.n8n.cloud/webhook/qtp-console-data-7f3a9c` every 8s.
  - Header: regime chips, equity, day P&L, open count, protection, net uPnL, pulsing LIVE dot + "updated Ns ago".
  - Pipeline strip: Signals → Bias/SSM → VC Gate → Gate-K → Execution → Ledger, real per-stage pass/fail counts, animated flow on live stages.
  - Latest decisions: committee verdict cards streamed from real QTP candidate traces
    (Scanner score, Bias/SSM, VC verdict+score, Risk/Exec). Executed signals matched to open positions get an EXECUTED badge.
  - Live-feed UX: arrival flash on new cards, "▲ N new" pill (jump-to-top + reset), scrollable 40-signal session history.
  - Fail-soft: never renders stale numbers if the feed drops; shows last-known + reconnect state.
  - Theme-aware via app CSS vars (light + dark).
- `components/site-nav.tsx` — added `/how-it-works` to primary nav (desktop + mobile), after Features.
- `app/(marketing)/how-it-works/page.tsx` — public "How QTP Operates" page (illustrative, no live values).

## Backend — Supabase `qtp_prod` (vdmtwmwpxvohodyrdlon)
Migration `qtp_console_live_signalflow` (version `20260712003445`) — see `qtp_console_live_signalflow.sql`:
- `console.v_session_day` — latest day with scanned candidates (today during market hours; last session otherwise → cockpit never blank).
- `console.v_funnel_session` — one row per pipeline stage with real session counts (front funnel from `quantum.candidate_path_trace_10fc`; Gate-K from `audit_log`; Execution/Ledger from `trade_ledger`).
- `console.v_cards_live` — recent candidate journeys, one card per ticker/day, newest first, 5-day window. Front-half agents (Scanner/Bias/VC) are per-signal real; executed match added by the feed.

## Backend — n8n workflow `89MYBPYNrFTyWxx4` "QTP Console Data (live feed)"
- Added **Alpaca Account** httpRequest node (GET `/v2/account`, Alpaca-PAPER cred, executeOnce) → equity + day P&L (equity − last_equity).
- Rewired: Webhook → Alpaca Positions → Alpaca Account → Console Aggregate → Merge Payload.
- Console Aggregate query now emits `session_day`, `funnel` (v_funnel_session), `cards` (v_cards_live, LIMIT 40), alongside regime/edge/rejections/protection.
- Merge Payload now emits `session_day`, `equity`, `day_pnl`, `funnel`, and per-card `executed` flag (matched to live broker positions).
- Published versions: feed rebuild, then LIMIT 40 for scrollback.

## Honesty notes (carry forward)
- Front funnel (Scanner → Bias → VC) is fully per-signal instrumented → cards are real and rich.
- Back half (Gate-K sizing, Execution) is only sparsely per-signal in `audit_log` today → cards show
  "→ sizing / not reached" rather than inventing verdicts; executed trades surface via matched open positions.
- **Open follow-up:** instrument the pipeline to write Gate-K + execution outcomes into the candidate
  trace so every card can show a full 5-agent verdict during live trading.

## Verification done
- Feed payload verified live: session_day, 6-stage funnel, equity 108,802.57, 40 cards spanning Jul-10/Jul-09.
- Both TSX files compile clean (esbuild transform, exit 0).
- Deploy landed: `/how-it-works` live, "How It Works" present in nav on production.
