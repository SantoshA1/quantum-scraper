#!/usr/bin/env python3
"""gov 209 — patch compute_kelly_gate v2.8 -> v2.9 (K3 extended cooldown).

Every substitution asserts its exact occurrence count BEFORE replacing, so a drifted
baseline aborts loudly instead of producing a half-patched function.
"""
import hashlib, sys

SRC = 'docs/gov209-k3/old-def-v2.8.sql'
DST = 'docs/gov209-k3/new-def-v2.9.sql'

text = open(SRC, encoding='utf-8').read()

subs = []  # (name, expected_count, old, new)

# ── 1. DECLARE additions ────────────────────────────────────────────────────────
subs.append(('declare', 1,
"""  v_sample_scope text;
BEGIN""",
"""  v_sample_scope text;
  v_k3_hours     numeric;
  v_k3_symbol_wide boolean;
  v_k3_any_loss  boolean;
BEGIN"""))

# ── 2. flag loads (fail closed to the EXTENDED rule) + symbol-wide outer IF ─────
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

# ── 3. the predicate: any-loss, flag-driven window, symbol-wide direction scope ─
subs.append(('predicate', 1,
"""      AND status = 'closed' AND exit_reason IN ('stop', 'trail') AND net_pnl < 0
      AND exit_fill_time >= now() - make_interval(hours => p_cooldown_hours)
      AND (CASE WHEN side IN ('buy','buy_call','sell_put') THEN 'bullish' ELSE 'bearish' END) = v_direction""",
"""      AND status = 'closed' AND net_pnl < 0
      AND (v_k3_any_loss OR exit_reason IN ('stop', 'trail'))
      AND exit_fill_time >= now() - make_interval(hours => v_k3_hours::int)
      AND (v_k3_symbol_wide
           OR (CASE WHEN side IN ('buy','buy_call','sell_put') THEN 'bullish' ELSE 'bearish' END) = v_direction)"""))

# ── 4. rejection payload: report the governing values, additively ───────────────
subs.append(('payload_hours', 1,
"""        'cooldown_hours', p_cooldown_hours,""",
"""        'cooldown_hours', v_k3_hours,
        'cooldown_scope', jsonb_build_object('symbol_wide', v_k3_symbol_wide, 'any_loss_exit', v_k3_any_loss,
          'source', 'gate_config_fail_closed_120_1_1'),"""))

subs.append(('payload_note', 1,
"""        'note', 'same symbol+direction stopped out AT A LOSS within cooldown window - no revenge trades (v2.2: winner exits never cool down)');""",
"""        'note', 'symbol closed a LOSS within the cooldown window - no revenge trades (v2.9 gov209: 120h ~ 3 sessions, symbol-wide any-direction, ANY losing exit_reason; winner exits never cool down)');"""))

# ── 5. version string, all occurrences ──────────────────────────────────────────
subs.append(('gate_version', 4,
"GATE_K_v2.8_R2_DIRECTION_SCOPED_20260807",
"GATE_K_v2.9_K3_EXTENDED_20260812"))

for name, expected, old, new in subs:
    got = text.count(old)
    assert got == expected, f"ABORT {name}: expected {expected} occurrence(s), found {got}"
    text = text.replace(old, new)

# post-conditions: nothing stale survives
assert text.count('GATE_K_v2.8') == 0, 'stale v2.8 version string survived'
assert text.count('GATE_K_v2.9_K3_EXTENDED_20260812') == 4
# p_cooldown_hours survives ONLY in the signature (kept for signature stability) + the comment naming it superseded
assert text.count('p_cooldown_hours') == 2, f"p_cooldown_hours occurrences: {text.count('p_cooldown_hours')}"
assert text.count('v_k3_hours') == 6           # declare, load, guard IF, guard assign, predicate, payload
assert text.count('v_k3_symbol_wide') == 5     # declare, load, outer IF, predicate, payload
assert text.count('v_k3_any_loss') == 4        # declare, load, predicate, payload

open(DST, 'w', encoding='utf-8').write(text)
print('OK  wrote', DST)
print('md5(file bytes) =', hashlib.md5(text.encode()).hexdigest())
