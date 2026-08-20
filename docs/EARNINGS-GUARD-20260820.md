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

## Ledger

- Config knobs (gate_config, EARNINGS): guard_active=1, entry_block_days=3, alert_days=3,
  calendar_stale_days=3 — tune without deploys.
- Main pipeline chain: … → 27304305 (gov 232) → **cb21316f (gov 235)**.
- Watch: first scheduled nightly run tonight 18:10 ET (expect the stale alarm until the
  key is seeded); first real calendar fetch validates XPEV/DGX; first EARNINGS_WINDOW
  audit row whenever entries resume near a print.
- Retro-measurement (E3b, later): count historical certified trades held through prints
  and their cost — the WMT+SHW pattern quantified.
