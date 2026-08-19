#!/usr/bin/env python3
# gov 231 count-asserted patch: fix the stillborn stop-fill leg of the Expansion Kill-Switch.
import hashlib, sys

src = open('evaluate-trip-deployed.sql').read()

OLD = """), stops AS (
  SELECT count(*) AS stop_fills_today
  FROM quantum.order_events
  WHERE event_date = (now() AT TIME ZONE 'America/New_York')::date
    AND order_status = 'filled'
    AND order_type IN ('trailing_stop','stop','stop_limit')
)"""

NEW = """), stops AS (
  -- QTP_KS_STOPLEG_v5_gov231_20260819: the writer stamps Alpaca-style 'FILLED'; the old
  -- order_status='filled' matched ZERO rows in the table's entire history (witness: 08-18,
  -- four stop-outs standing, execution 600258 read stop_fills_today=0). DISTINCT orders
  -- because each fill emits ~2 events (8 events / 4 orders on 08-18); a raw count would
  -- trip the >=4 threshold at just 2 real stop-outs. coalesce covers NULL broker ids
  -- (0 such rows to date; defensive only).
  SELECT count(DISTINCT coalesce(broker_order_id, order_event_id::text)) AS stop_fills_today
  FROM quantum.order_events
  WHERE event_date = (now() AT TIME ZONE 'America/New_York')::date
    AND upper(order_status) = 'FILLED'
    AND order_type IN ('trailing_stop','stop','stop_limit')
)"""

n = src.count(OLD)
assert n == 1, f"expected exactly 1 occurrence of the stops CTE, found {n}"
# the broken predicate must appear exactly once in the file (inside that CTE) ...
assert src.count("order_status = 'filled'") == 1
# ... and the template expressions we must NOT touch are present, once each
for tpl in ["{{ $json.account_ok && $json.day_pnl !== null ? $json.day_pnl : 'NULL' }}",
            "{{ $json.account_ok && $json.equity ? $json.equity : 'NULL' }}",
            "{{ $json.account_ok ? 'true' : 'false' }}"]:
    assert src.count(tpl) == 1, f"template drifted: {tpl[:40]}"

out = src.replace(OLD, NEW, 1)
assert out.count("upper(order_status) = 'FILLED'") == 1
assert out.count("order_status = 'filled'") == 0
assert out.count("count(DISTINCT coalesce(broker_order_id, order_event_id::text))") == 1
assert out.count("QTP_KS_STOPLEG_v5_gov231_20260819") == 1
# nothing else changed: strip the swapped region from both and compare
assert src.replace(OLD, '\x00', 1) == out.replace(NEW, '\x00', 1), "patch leaked outside the stops CTE"
assert out.startswith('=WITH cfg AS ('), "n8n expression marker '=' must survive"

open('evaluate-trip-patched.sql', 'w').write(out)
print('OLD sha256:', hashlib.sha256(src.encode()).hexdigest())
print('NEW sha256:', hashlib.sha256(out.encode()).hexdigest())
print('NEW bytes :', len(out))
print('PATCH OK — 1 CTE swapped, 0 collateral edits')
