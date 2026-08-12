#!/usr/bin/env python3
"""gov 209 — generate a SELF-VERIFYING migration.

Instead of shipping the 20KB function body (transcription risk), the migration makes
Postgres patch its OWN deployed def with the identical count-asserted substitutions,
then RAISEs (rolling everything back) unless the patched def's md5 equals the md5 of
the reviewed artifact docs/gov209-k3/new-def-v2.9.sql. Either the deployed bytes are
exactly the reviewed bytes, or nothing changes.
"""
import hashlib

OLD_MD5 = '625b111e0ca5ece7bf2ff80b731479bc'   # deployed v2.8 (verified twice)

subs = []
subs.append(('declare', 1,
"""  v_sample_scope text;
BEGIN""",
"""  v_sample_scope text;
  v_k3_hours     numeric;
  v_k3_symbol_wide boolean;
  v_k3_any_loss  boolean;
BEGIN"""))
subs.append(('flag_loads_and_outer_if', 1,
"""  IF p_symbol IS NOT NULL AND v_direction IS NOT NULL THEN
    SELECT id, exit_fill_time, exit_reason, net_pnl INTO v_cooldown_hit""",
"""  -- ===== K3 v2.9 (gov 209): EXTENDED LOSS COOLDOWN ====================================
  -- Evidence 2026-08-12: five re-entries within 120h of a same-symbol losing exit, ALL five
  -- lost, -785.71 USD total, zero winners inside any such window (WMT@71h, WST@72h cross-dir,
  -- AVB@96h cross-dir, WMB@91h, WSM@114h). WST#2's prior loss exited 'manual' -> the rule
  -- counts ANY losing exit, not only stop/trail. Flags FAIL CLOSED to the extended rule;
  -- setting 24/0/0 restores the v2.2 behavior exactly. p_cooldown_hours is superseded.
  v_k3_hours       := coalesce((SELECT live_value FROM quantum.gate_config
                                WHERE gate_id = 'GATE_K' AND constant_name = 'k3_cooldown_hours'), 120);
  IF v_k3_hours <= 0 THEN v_k3_hours := 120; END IF;  -- a zero/negative flag may not silently disable K3
  v_k3_symbol_wide := coalesce((SELECT live_value FROM quantum.gate_config
                                WHERE gate_id = 'GATE_K' AND constant_name = 'k3_symbol_wide'), 1) = 1;
  v_k3_any_loss    := coalesce((SELECT live_value FROM quantum.gate_config
                                WHERE gate_id = 'GATE_K' AND constant_name = 'k3_any_loss_exit'), 1) = 1;

  IF p_symbol IS NOT NULL AND (v_k3_symbol_wide OR v_direction IS NOT NULL) THEN
    SELECT id, exit_fill_time, exit_reason, net_pnl INTO v_cooldown_hit"""))
subs.append(('predicate', 1,
"""      AND status = 'closed' AND exit_reason IN ('stop', 'trail') AND net_pnl < 0
      AND exit_fill_time >= now() - make_interval(hours => p_cooldown_hours)
      AND (CASE WHEN side IN ('buy','buy_call','sell_put') THEN 'bullish' ELSE 'bearish' END) = v_direction""",
"""      AND status = 'closed' AND net_pnl < 0
      AND (v_k3_any_loss OR exit_reason IN ('stop', 'trail'))
      AND exit_fill_time >= now() - make_interval(hours => v_k3_hours::int)
      AND (v_k3_symbol_wide
           OR (CASE WHEN side IN ('buy','buy_call','sell_put') THEN 'bullish' ELSE 'bearish' END) = v_direction)"""))
subs.append(('payload_hours', 1,
"""        'cooldown_hours', p_cooldown_hours,""",
"""        'cooldown_hours', v_k3_hours,
        'cooldown_scope', jsonb_build_object('symbol_wide', v_k3_symbol_wide, 'any_loss_exit', v_k3_any_loss,
          'source', 'gate_config_fail_closed_120_1_1'),"""))
subs.append(('payload_note', 1,
"""        'note', 'same symbol+direction stopped out AT A LOSS within cooldown window - no revenge trades (v2.2: winner exits never cool down)');""",
"""        'note', 'symbol closed a LOSS within the cooldown window - no revenge trades (v2.9 gov209: 120h ~ 3 sessions, symbol-wide any-direction, ANY losing exit_reason; winner exits never cool down)');"""))
subs.append(('gate_version', 4,
"GATE_K_v2.8_R2_DIRECTION_SCOPED_20260807",
"GATE_K_v2.9_K3_EXTENDED_20260812"))

# ── prove these subs are byte-identical to the reviewed patch ───────────────────
old = open('docs/gov209-k3/old-def-v2.8.sql', encoding='utf-8').read()
assert hashlib.md5(old.encode()).hexdigest() == OLD_MD5
t = old
for name, exp, o, n in subs:
    assert t.count(o) == exp, f'{name}: {t.count(o)} != {exp}'
    t = t.replace(o, n)
reviewed = open('docs/gov209-k3/new-def-v2.9.sql', encoding='utf-8').read()
assert t == reviewed, 'generator subs are NOT identical to the reviewed patch'
NEW_MD5 = hashlib.md5(t.encode()).hexdigest()

# ── emit the migration ──────────────────────────────────────────────────────────
def dq(s, tag):
    assert f'${tag}$' not in s
    return f'${tag}$' + s + f'${tag}$'

parts = []
parts.append(f"""-- gov 209: K3 extended cooldown - PO "Authorized K3" 2026-08-12
-- 24h -> 120h (~3 sessions), symbol-wide (any direction), ANY losing exit (net_pnl<0).
-- Evidence: 5 re-entries within 120h of a same-symbol loss, ALL 5 lost, -785.71 USD,
-- zero winners inside any window. Flags FAIL CLOSED to the extended rule (120/1/1).
-- SELF-VERIFYING: patches the DEPLOYED def in place with count-asserted substitutions;
-- aborts atomically unless the result md5 = {NEW_MD5} (the reviewed artifact).

INSERT INTO quantum.gate_config (gate_id, constant_name, live_value, config_hash, status, promoted_by, promoted_at, updated_at)
VALUES
  ('GATE_K', 'k3_cooldown_hours', 120, 'po_authorized_20260812_gov209_k3', 'PROMOTED', 'po_authorized_k3_20260812', now(), now()),
  ('GATE_K', 'k3_symbol_wide',    1,   'po_authorized_20260812_gov209_k3', 'PROMOTED', 'po_authorized_k3_20260812', now(), now()),
  ('GATE_K', 'k3_any_loss_exit',  1,   'po_authorized_20260812_gov209_k3', 'PROMOTED', 'po_authorized_k3_20260812', now(), now())
ON CONFLICT (gate_id, constant_name) DO UPDATE
  SET live_value = EXCLUDED.live_value, config_hash = EXCLUDED.config_hash, status = EXCLUDED.status,
      promoted_by = EXCLUDED.promoted_by, promoted_at = EXCLUDED.promoted_at, updated_at = now();

DO $mig$
DECLARE
  v_def text; v_cnt int;
BEGIN
  SELECT pg_get_functiondef('public.compute_kelly_gate(uuid,uuid,text,text,numeric,numeric,numeric,numeric,text,text,integer,integer,numeric,numeric,text,numeric,integer,integer)'::regprocedure) INTO v_def;
  IF md5(v_def) <> '{OLD_MD5}' THEN
    RAISE EXCEPTION 'ABORT gov209: deployed md5 % is not the v2.8 baseline {OLD_MD5}', md5(v_def);
  END IF;
""")
for i, (name, exp, o, n) in enumerate(subs, 1):
    so, sn = dq(o, f'o{i}'), dq(n, f'n{i}')
    parts.append(f"""
  -- sub {i}: {name}
  v_cnt := (length(v_def) - length(replace(v_def, {so}, ''))) / length({so});
  IF v_cnt <> {exp} THEN RAISE EXCEPTION 'ABORT gov209 sub {name}: % occurrences, expected {exp}', v_cnt; END IF;
  v_def := replace(v_def, {so}, {sn});
""")
parts.append(f"""
  IF md5(v_def) <> '{NEW_MD5}' THEN
    RAISE EXCEPTION 'ABORT gov209: patched md5 % <> reviewed {NEW_MD5} - nothing deployed', md5(v_def);
  END IF;
  EXECUTE v_def;
  SELECT pg_get_functiondef('public.compute_kelly_gate(uuid,uuid,text,text,numeric,numeric,numeric,numeric,text,text,integer,integer,numeric,numeric,text,numeric,integer,integer)'::regprocedure) INTO v_def;
  IF md5(v_def) <> '{NEW_MD5}' THEN
    RAISE EXCEPTION 'ABORT gov209: post-EXECUTE deployed md5 % <> reviewed {NEW_MD5}', md5(v_def);
  END IF;
END $mig$;
""")
mig = ''.join(parts)
open('docs/gov209-k3/migration-20260812.sql', 'w', encoding='utf-8').write(mig)
print('OK  reviewed NEW_MD5 =', NEW_MD5)
print('migration chars:', len(mig))
