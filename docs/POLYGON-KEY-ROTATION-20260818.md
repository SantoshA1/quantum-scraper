# gov 227 — Polygon key rotation runbook

**Date:** 2026-08-18, after close · **Prep deployed:** main pipeline `c396b41b`, news feeder
`4f08c7bc` · **Suite:** `test-polygon-rotation-20260818.js` 10/10
**Status: everything on my side is done. Two steps remain, and only you can do them —
they need your polygon.io and n8n logins.**

---

## Why this needed prep before you could rotate

The old key didn't live in one place. Rotating at polygon.io first would have broken QTP:

| where the OLD key lives | effect of rotating without prep |
|---|---|
| Main pipeline `Indicator Enrichment` — read from workflow staticData, **SE-C1 hard-throw** without it | the entire signal path halts at the first enrichment call |
| News feeder `Polygon Key Init` — **hardcoded literal, re-seeded every 10 minutes**, only-if-absent | the old key resurrects itself forever; news fetch 401s **silently** (onError=continue) |
| n8n version history (`bf5285f3`, `0df64c18`…), old exports, inactive SM v2 clone (5 nodes), archived Quantum Polygon Backtester | dormant copies — harmless once the key is dead |

**Deployed today (gov 227):** both live readers now resolve the key from
**`$vars.POLYGON_API_KEY` first** (legacy `$vars.POLYGON_KEY` also accepted), falling back to
the old staticData path until the Variable exists — proven no-behavior-change while the
Variable is absent (PR-06/PR-07), fail-closed when no key exists anywhere (PR-08), and the
seeder now **overwrites** a stale staticData key instead of protecting it (PR-05). The
hardcoded literal is gone from the active bytes. Two live production runs on the new feeder
code already green.

## Your steps — do 1 and 2 back-to-back, tonight or before 09:30 ET

**Step 1 — get a new key at Polygon (~2 min).**
Sign in at **polygon.io** → Dashboard → **API Keys** (Polygon rebranded to "Massive" in 2026,
so the page may say massive.com — same account).
- If your plan lets you **create a second key**: create one, leave the old key alive for now.
- If your plan only offers **Regenerate**: regenerating kills the old key instantly — that is
  fine right now (market closed; the only overnight consumer is the news feeder, whose
  failures are non-fatal), just go straight to Step 2.
Copy the new key. **Do not paste it into chat, Telegram, or any file — it goes into exactly
one place, in Step 2.**

**Step 2 — seed it in n8n (~1 min).**
Open **https://tradenextgen.app.n8n.cloud** → left sidebar → **Variables** (same page where
`ALPACA_API_KEY` and friends live) → **Add variable**:
- Key: `POLYGON_API_KEY`  ← exact spelling, case-sensitive
- Value: paste the new key → Save.

That's it. The news feeder picks it up on its next 10-minute run and overwrites the stale
staticData copy; the main pipeline reads it on its first execution tomorrow (~09:35 ET).

**Step 3 — say "rotated" to me.** I will verify without ever seeing the value:
- fire the news feeder once and confirm `Polygon Key Init` logs *"staticData key updated from
  $vars"* and the Polygon call returns 200;
- confirm the main pipeline's first Wednesday execution passes enrichment with no SE-C1;
- then, **only if you created a second key in Step 1**, you delete the OLD key at polygon.io
  and I re-verify nothing broke.

**Step 4 (mine, after verification) — gov 227b cleanup:** purge the dead key from both
workflows' staticData, remove the now-dead fallbacks, and remove the `_polygon_key`
**payload passthrough** in the main pipeline — important honesty note: until that passthrough
is removed, the *new* key will ride signal items into n8n execution logs just as the old one
did (log retention ~4–5 days, visible only to n8n account holders, but it partially defeats
the rotation). That is a 6-node main-pipeline change I'll do with full discipline once the
rotation is confirmed.

## Also surfaced by the sweep — for a later pass, your call

Rotation-worthy secrets hardcoded elsewhere (all values withheld, locations on file): an
**xAI key** in 3 workflows (incl. the news feeder's Grok scorer), a **Perplexity bearer** in
Hybrid Discovery, **Alpaca fallback literals** in Daily Summary, **webhook-secret literals**
in 2 workflows. Same treatment as today: patch readers to `$vars` by name, then rotate each
at its provider. Say the word and I'll run the same playbook per key.

Five workflows remain MCP-blocked and unauditable (incl. the archived "Quantum Polygon
Backtester", near-certain old-key carrier — dead key makes it moot, but enable MCP on the
workflow cards when convenient so future sweeps cover everything).

---

## ADDENDUM — rotation completed and verified, 2026-08-18 evening

**Step 3 done (18:04 ET).** Fired the news feeder once with the PO's rotation in place:
execution 601845 success; `Polygon Key Init` v2 ran clean; `Polygon News per Ticker` returned
**HTTP 200 / status "OK" on every fetch** (empty results = quiet news window, not an auth
condition). With the old key dead, 200s prove the `POLYGON_API_KEY` Variable was found,
staticData was overwritten, and the NEW key is live end-to-end. Scheduled 10-minute runs
green. No key value was read at any point.

**Step 4 done — gov 227b published (`379178db`).** The `_polygon_key` payload passthrough is
gone: `Indicator Enrichment` no longer stamps the key on signal items; the four Polygon HTTP
nodes read `$vars.POLYGON_API_KEY` in their url expressions (each URL changed by exactly one
token, proven); `Grok AI Analysis` resolves $vars first with a deploy-order-safe item
fallback. Six nodes changed, 144 untouched by manifest hash. Suite
`test-polygon-passthrough-20260818.js` 7/7. From this version on, execution logs stop
accumulating the key. **Morning watch:** the first scheduled execution (~09:35 ET Wed)
exercises the $vars path in the main pipeline — SE-C1 or empty options/cross-asset data would
be the failure signature; none is expected (the identical pattern is already live and green
in two other workflows).

**New finding, added to the hardcoded-secrets follow-up list:** the main pipeline's
`Grok AI Analysis` node carries a JWT-shaped **`QTP_SB_METER_KEY` (Supabase) literal** at
line 4 — redacted from the committed fixtures, unchanged in production. Full follow-up list
now: this Supabase key, xAI keys (3 workflows), a Perplexity bearer, Alpaca fallback
literals, webhook-secret literals (2 workflows). Same playbook per key when the PO says go.

## PROVIDER NOTE (PO-prompted check, 2026-08-18 evening) — "Grok" is a legacy label

Verified from the live bytes: **`Grok AI Analysis` is Grok in name only.** Every LLM call in
it goes to `api.anthropic.com/v1/messages`, default model **`claude-opus-4-8`** (overridable
via `$vars.ANTHROPIC_MODEL`); the `_grok_ai_*` / `grokResponse` names are deliberately
preserved legacy telemetry ("Contract preserved" per the node's own migration comment).
Wider sweep of the main pipeline: **zero xAI references anywhere**; four nodes call Anthropic
(`VC Agent Gatekeeper`, `Grok AI Analysis`, `Grok Signal Analyzer`, `Indicator Enrichment`
chart-vision) and **all four resolve the key by name** (`$vars.ANTHROPIC_API_KEY`, staticData
fallback, placeholder-guarded) — no hardcoded Anthropic literal exists. Fail-open by design:
a missing Anthropic key passes the signal through with "AI analysis unavailable" rather than
halting trading. Corrections this implies: the follow-up list's "xAI keys in 3 workflows"
refers to OTHER workflows (the news feeder's Grok Sentiment Scorer — genuinely xAI with a
hardcoded literal — plus the two Website Signal workflows), not the main pipeline; and the
`QTP_SB_METER_KEY` literal is the Supabase credential used by `qtpMeterLLM` to log per-call
Anthropic token costs. gov 227b is unaffected — it touched only Polygon key resolution.
