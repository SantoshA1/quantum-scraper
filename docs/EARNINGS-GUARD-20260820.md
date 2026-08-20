# gov 235 — E3 Earnings Calendar Guard: built, deployed, live-proven (2026-08-20 afternoon)

**Born this morning:** WMT held long through its own scheduled earnings print with a 1.15%
stop and lost −7.93R through the gap — and nothing in QTP knew earnings existed. Both
catastrophic gap-throughs on record (SHW 07-23, WMT 08-20) are earnings-window gaps.
E3 closes the class in two layers, both live as of ~11:45 ET.

## Layer 1 — nightly calendar + open-position advisory (`SDE0GVo9FeFqvpxS`, active `b5c1f68c`)

Nightly 18:10 ET weekdays: ONE Alpha Vantage `EARNINGS_CALENDAR` call (3-month horizon,
whole market, key by `$vars.ALPHAVANTAGE_API_KEY` — name only), chunked idempotent upsert
into `quantum.earnings_calendar`, then a check of every open position against the calendar:
any position reporting within `earnings_alert_days` (config, default 3) sends a Telegram
advisory naming the position, the date, and the WMT lesson. HTML parse mode (gov 225b).

**Fail-loud is wired to the operator channel, not to a buried error execution** — the Maya
catch on my own first build: a missing API key originally THREW, killing the chain before
the alarm node, so the alarm could never send. Fixed pre-publish: missing key flows zero
rows through, and the advisory's zero-forward-rows path sends the loud "calendar unhealthy
/ guard fails open" Telegram. **Smoke-tested live (execution 617104): `sent:true,
kind:'stale'` — the guard announced its own missing key on the PO's Telegram.** Bad
responses (rate-limit stubs, short payloads, wrong header) still throw so a poisoned feed
can never overwrite the table.

## Layer 2 — EARNINGS_WINDOW entry block in the Kelly wrapper (main pipeline `cb21316f`)

Three insertion sites in `QET Kelly SQL Build` (before-gate sha matched `773b65bf…`; new
`0552eef6…`; scope-assert: exactly gov-232's SSM + this node differ from the 379178db
baseline across all 150 nodes): a `cfge` config CTE, `earn_on`/`earn_hit` fields, and ONE
new WHEN **before** the Gate-K ELSE — block with reason `EARNINGS_WINDOW` when the config
switch is on AND the symbol has a print within `earnings_entry_block_days` (default 3).

**Fail-open by construction, twice over:** a missing config row resolves the switch OFF
(`coalesce(...,0)=1`), and the block requires a positive `EXISTS` match — an empty or dead
calendar can never freeze entries. The suite's S1 sabotage proves a `NOT EXISTS`
(fail-closed) variant is rejected. The Gate-K call, every EXPANSION check, and the
substitution machinery are byte-identical (EW-06; quote-in-symbol injection covered EW-05).

**Live semantic proofs, run against the deployed bytes' own generated SQL:**
- Empty calendar + real symbol (WMB): verdict fell through to normal Gate-K
  (`negative_measured_edge`) — the guard added nothing. Fail-open proven live.
- Synthetic `ZZZTEST` calendar row (reports tomorrow): verdict
  `{"reason":"EARNINGS_WINDOW","blocked":true}` — the block fires before Gate-K. Probe row
  deleted after.

## Suites

- `tests/test-earnings-guard-20260820.js` — **9/9** + 3 sabotage runs (date-validation
  dropped → bites; staleness muted → bites; HTML escaping broken → bites). Pins the parser
  against quoted-comma names, CRLF, junk rows, rate-limit stubs; the advisory's loud-stale
  and quiet-healthy paths; XPEV 2026-08-24 as a fixture.
- `tests/test-earnings-entry-guard-20260820.js` — **7/7** + 2 sabotage runs, executing the
  REAL wrapper bytes (old = earnings-blind witness; new = block-before-gate, config-driven
  window, fail-open literals, quoting).

## Probe note, resolved on the spot

My first live probe passed side `'BUY'` uppercase and got a pooled-scope verdict — briefly
suggesting live direction-scoping was dead. The Prep node's bytes settle it: live derives
`side='buy'/'sell'` lowercase (line 24-25), so live verdicts are direction-scoped; the
probe input was unrepresentative. (The adjacent known backlog item stands: the wrapper's
`$6 = 'SELL'` EXPANSION_SELL_CAP comparison can never match lowercase `'sell'` — the
pre-existing dead branch, unchanged by gov 235.)

## The one PO step

**Get a free Alpha Vantage key (alphavantage.co, ~1 minute, email only) and add it in n8n
→ Variables as `ALPHAVANTAGE_API_KEY`.** Until then the guard runs fail-open and tells you
so nightly at 18:10 ET on Telegram. After the first successful fetch, the validation is
built in: `quantum.earnings_calendar` must show XPEV 2026-08-24 and DGX mid-October — and
if any position is still open within 3 days of its print, the advisory names it that same
night.

## VALIDATION ADDENDUM (13:25 ET) — key seeded, first real fetch, every prediction landed

PO seeded `ALPHAVANTAGE_API_KEY`; manual run 618280: **1,656 symbols ingested**
(2026-08-20 → 11-18, 1,048 with consensus EPS estimates), staleness 0.00, advisory
correctly SILENT (no open position within 3 days of a print — DGX and WMB verified below).

| prediction (made before the data existed) | calendar says | verdict |
|---|---|---|
| XPEV reports Mon 2026-08-24 (why the short was closed this morning) | **2026-08-24** | ✓ exact |
| DGX mid-October | **2026-10-20**, est $2.85 | ✓ |
| WMB already reported → no alert expected | absent from forward calendar | ✓ |
| — | **WMT 2026-08-20, est $0.73** — the first row in the table is this morning's −$933 print | the system now knows the thing that hurt it |

**The guard is armed on real data:** of the last 48h of live candidates, **ROST and WMT**
have prints within 3 days — both would return `EARNINGS_WINDOW` at the gate right now.
Precision note for the record: WMT's 08-12 *entry* predates the 3-day entry window — the
ENTRY guard alone would not have stopped it; the POSITION advisory is the layer that would
have fired (nightly from T-3, three warnings before the print). Both layers exist now.

## What else Alpha Vantage offers (PO asked) — catalogued, budget-aware

Free tier is a hard **25 requests/day**; the nightly calendar spends 1. Ranked by QTP value:

1. **`EARNINGS` (historical, per symbol)** — quarterly reportedDate + reported/estimated
   EPS + surprise%. **The one concrete use: E3b retro-measurement** — backfill PAST print
   dates and quantify what holding-through-earnings has cost across the whole ledger (the
   WMT+SHW pattern, measured). ~100 certified symbols ≈ 4–5 days of request budget,
   one-time. Already on the ledger; authorize and I build it on the E1 harness pattern.
2. **Consensus estimates in the calendar we already store** — free enrichment; could later
   distinguish high-attention prints (has-estimate) from junk listings.
3. `NEWS_SENTIMENT` — redundant (Polygon news + sentiment scorer already live).
4. Economic calendar / CPI / FOMC — a future macro-event guard candidate (FOMC days are
   gap risk too); regime layer partly covers this. Catalogued, not proposed.
5. `OVERVIEW` fundamentals — possible strat-cache enrichment someday; not a bottleneck.

## Ledger

- Config knobs (gate_config, EARNINGS): guard_active=1, entry_block_days=3, alert_days=3,
  calendar_stale_days=3 — tune without deploys.
- Main pipeline chain: … → 27304305 (gov 232) → **cb21316f (gov 235)**.
- Calendar boundary, known: AV covers ~1,656 symbols with prints in the next 3 months;
  absence means "no scheduled print," not missing data. Nightly refresh keeps it rolling.
- Watch: tonight's 18:10 scheduled run (should be silent); first EARNINGS_WINDOW audit row
  whenever entries resume near a print (ROST/WMT-class candidates).
- E3b retro-measurement: ready to build on PO authorization (uses AV `EARNINGS`, ~5 days
  of free-tier budget, zero live risk).
