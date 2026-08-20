#!/usr/bin/env python3
# gov 235 count-asserted patch: EARNINGS_WINDOW entry guard in QET Kelly SQL Build.
import hashlib
src = open('kelly-sql-build-deployed.js').read()

A_OLD = "WITH cfg AS (SELECT constant_name, live_value FROM quantum.gate_config WHERE gate_id = 'EXPANSION')"
A_NEW = "WITH cfg AS (SELECT constant_name, live_value FROM quantum.gate_config WHERE gate_id = 'EXPANSION'), cfge AS (SELECT constant_name, live_value FROM quantum.gate_config WHERE gate_id = 'EARNINGS')"

B_OLD = "coalesce((SELECT live_value FROM cfg WHERE constant_name = 'expansion_max_concurrent'), 0) AS cap_concurrent ) exp"
B_NEW = ("coalesce((SELECT live_value FROM cfg WHERE constant_name = 'expansion_max_concurrent'), 0) AS cap_concurrent, "
 "coalesce((SELECT live_value FROM cfge WHERE constant_name = 'earnings_guard_active'), 0) = 1 AS earn_on, "
 "EXISTS (SELECT 1 FROM quantum.earnings_calendar ec WHERE ec.symbol = $7 AND ec.report_date >= (now() AT TIME ZONE 'America/New_York')::date AND ec.report_date <= (now() AT TIME ZONE 'America/New_York')::date + coalesce((SELECT live_value FROM cfge WHERE constant_name = 'earnings_entry_block_days'), 3)::int) AS earn_hit ) exp")

C_OLD = "ELSE public.compute_kelly_gate("
C_NEW = ("WHEN exp.earn_on AND exp.earn_hit THEN jsonb_build_object('approved', false, 'blocked', true, 'reason', 'EARNINGS_WINDOW') "
 "ELSE public.compute_kelly_gate(")

out = src
for old, new, label in [(A_OLD, A_NEW, 'cfge-cte'), (B_OLD, B_NEW, 'exp-fields'), (C_OLD, C_NEW, 'when-clause')]:
    n = out.count(old)
    assert n == 1, f"{label}: expected 1, found {n}"
    out = out.replace(old, new, 1)

assert out.count('EARNINGS_WINDOW') == 1
assert out.count('earn_on') == 2 and out.count('earn_hit') == 2
assert out.count('cfge') == 3
# the WHEN must precede the ELSE in the generated template
assert out.index('exp.earn_on AND exp.earn_hit') < out.index('ELSE public.compute_kelly_gate')
# no stray $N tokens introduced beyond $7 (substitution loop covers $1..$8)
import re
added = out.replace(src.replace(A_OLD,'').replace(B_OLD,'').replace(C_OLD,''), '') if False else None
assert re.findall(r'\$\d', B_NEW) == ['$7']
# remainder identical outside the three sites
probe = src
for o in [A_OLD, B_OLD, C_OLD]: probe = probe.replace(o, '\x00', 1)
probe2 = out
for n2 in [A_NEW, B_NEW, C_NEW]: probe2 = probe2.replace(n2, '\x00', 1)
assert probe == probe2, 'patch leaked outside the three sites'

open('kelly-sql-build-patched.js','w').write(out)
print('OLD sha256:', hashlib.sha256(src.encode()).hexdigest())
print('NEW sha256:', hashlib.sha256(out.encode()).hexdigest())
print('sizes:', len(src), '->', len(out))
print('PATCH OK - 3 sites, 0 collateral')
