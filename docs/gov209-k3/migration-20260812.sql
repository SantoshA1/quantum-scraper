-- gov 209: K3 extended cooldown - PO "Authorized K3" 2026-08-12
-- 24h -> 120h (~3 sessions), symbol-wide (any direction), ANY losing exit (net_pnl<0).
-- Evidence: 5 re-entries within 120h of a same-symbol loss, ALL 5 lost, -785.71 USD,
-- zero winners inside any window. Flags FAIL CLOSED to the extended rule (120/1/1).
-- SELF-VERIFYING: patches the DEPLOYED def in place with count-asserted substitutions;
-- aborts atomically unless the result md5 = d2a9e38148fa927eba02a115716f0d09 (the reviewed artifact).

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
  IF md5(v_def) <> '625b111e0ca5ece7bf2ff80b731479bc' THEN
    RAISE EXCEPTION 'ABORT gov209: deployed md5 % is not the v2.8 baseline 625b111e0ca5ece7bf2ff80b731479bc', md5(v_def);
  END IF;

  -- sub 1: declare
  v_cnt := (length(v_def) - length(replace(v_def, $o1$  v_sample_scope text;
BEGIN$o1$, ''))) / length($o1$  v_sample_scope text;
BEGIN$o1$);
  IF v_cnt <> 1 THEN RAISE EXCEPTION 'ABORT gov209 sub declare: % occurrences, expected 1', v_cnt; END IF;
  v_def := replace(v_def, $o1$  v_sample_scope text;
BEGIN$o1$, $n1$  v_sample_scope text;
  v_k3_hours     numeric;
  v_k3_symbol_wide boolean;
  v_k3_any_loss  boolean;
BEGIN$n1$);

  -- sub 2: flag_loads_and_outer_if
  v_cnt := (length(v_def) - length(replace(v_def, $o2$  IF p_symbol IS NOT NULL AND v_direction IS NOT NULL THEN
    SELECT id, exit_fill_time, exit_reason, net_pnl INTO v_cooldown_hit$o2$, ''))) / length($o2$  IF p_symbol IS NOT NULL AND v_direction IS NOT NULL THEN
    SELECT id, exit_fill_time, exit_reason, net_pnl INTO v_cooldown_hit$o2$);
  IF v_cnt <> 1 THEN RAISE EXCEPTION 'ABORT gov209 sub flag_loads_and_outer_if: % occurrences, expected 1', v_cnt; END IF;
  v_def := replace(v_def, $o2$  IF p_symbol IS NOT NULL AND v_direction IS NOT NULL THEN
    SELECT id, exit_fill_time, exit_reason, net_pnl INTO v_cooldown_hit$o2$, $n2$  -- ===== K3 v2.9 (gov 209): EXTENDED LOSS COOLDOWN ====================================
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
    SELECT id, exit_fill_time, exit_reason, net_pnl INTO v_cooldown_hit$n2$);

  -- sub 3: predicate
  v_cnt := (length(v_def) - length(replace(v_def, $o3$      AND status = 'closed' AND exit_reason IN ('stop', 'trail') AND net_pnl < 0
      AND exit_fill_time >= now() - make_interval(hours => p_cooldown_hours)
      AND (CASE WHEN side IN ('buy','buy_call','sell_put') THEN 'bullish' ELSE 'bearish' END) = v_direction$o3$, ''))) / length($o3$      AND status = 'closed' AND exit_reason IN ('stop', 'trail') AND net_pnl < 0
      AND exit_fill_time >= now() - make_interval(hours => p_cooldown_hours)
      AND (CASE WHEN side IN ('buy','buy_call','sell_put') THEN 'bullish' ELSE 'bearish' END) = v_direction$o3$);
  IF v_cnt <> 1 THEN RAISE EXCEPTION 'ABORT gov209 sub predicate: % occurrences, expected 1', v_cnt; END IF;
  v_def := replace(v_def, $o3$      AND status = 'closed' AND exit_reason IN ('stop', 'trail') AND net_pnl < 0
      AND exit_fill_time >= now() - make_interval(hours => p_cooldown_hours)
      AND (CASE WHEN side IN ('buy','buy_call','sell_put') THEN 'bullish' ELSE 'bearish' END) = v_direction$o3$, $n3$      AND status = 'closed' AND net_pnl < 0
      AND (v_k3_any_loss OR exit_reason IN ('stop', 'trail'))
      AND exit_fill_time >= now() - make_interval(hours => v_k3_hours::int)
      AND (v_k3_symbol_wide
           OR (CASE WHEN side IN ('buy','buy_call','sell_put') THEN 'bullish' ELSE 'bearish' END) = v_direction)$n3$);

  -- sub 4: payload_hours
  v_cnt := (length(v_def) - length(replace(v_def, $o4$        'cooldown_hours', p_cooldown_hours,$o4$, ''))) / length($o4$        'cooldown_hours', p_cooldown_hours,$o4$);
  IF v_cnt <> 1 THEN RAISE EXCEPTION 'ABORT gov209 sub payload_hours: % occurrences, expected 1', v_cnt; END IF;
  v_def := replace(v_def, $o4$        'cooldown_hours', p_cooldown_hours,$o4$, $n4$        'cooldown_hours', v_k3_hours,
        'cooldown_scope', jsonb_build_object('symbol_wide', v_k3_symbol_wide, 'any_loss_exit', v_k3_any_loss,
          'source', 'gate_config_fail_closed_120_1_1'),$n4$);

  -- sub 5: payload_note
  v_cnt := (length(v_def) - length(replace(v_def, $o5$        'note', 'same symbol+direction stopped out AT A LOSS within cooldown window - no revenge trades (v2.2: winner exits never cool down)');$o5$, ''))) / length($o5$        'note', 'same symbol+direction stopped out AT A LOSS within cooldown window - no revenge trades (v2.2: winner exits never cool down)');$o5$);
  IF v_cnt <> 1 THEN RAISE EXCEPTION 'ABORT gov209 sub payload_note: % occurrences, expected 1', v_cnt; END IF;
  v_def := replace(v_def, $o5$        'note', 'same symbol+direction stopped out AT A LOSS within cooldown window - no revenge trades (v2.2: winner exits never cool down)');$o5$, $n5$        'note', 'symbol closed a LOSS within the cooldown window - no revenge trades (v2.9 gov209: 120h ~ 3 sessions, symbol-wide any-direction, ANY losing exit_reason; winner exits never cool down)');$n5$);

  -- sub 6: gate_version
  v_cnt := (length(v_def) - length(replace(v_def, $o6$GATE_K_v2.8_R2_DIRECTION_SCOPED_20260807$o6$, ''))) / length($o6$GATE_K_v2.8_R2_DIRECTION_SCOPED_20260807$o6$);
  IF v_cnt <> 4 THEN RAISE EXCEPTION 'ABORT gov209 sub gate_version: % occurrences, expected 4', v_cnt; END IF;
  v_def := replace(v_def, $o6$GATE_K_v2.8_R2_DIRECTION_SCOPED_20260807$o6$, $n6$GATE_K_v2.9_K3_EXTENDED_20260812$n6$);

  IF md5(v_def) <> 'd2a9e38148fa927eba02a115716f0d09' THEN
    RAISE EXCEPTION 'ABORT gov209: patched md5 % <> reviewed d2a9e38148fa927eba02a115716f0d09 - nothing deployed', md5(v_def);
  END IF;
  EXECUTE v_def;
  SELECT pg_get_functiondef('public.compute_kelly_gate(uuid,uuid,text,text,numeric,numeric,numeric,numeric,text,text,integer,integer,numeric,numeric,text,numeric,integer,integer)'::regprocedure) INTO v_def;
  IF md5(v_def) <> 'd2a9e38148fa927eba02a115716f0d09' THEN
    RAISE EXCEPTION 'ABORT gov209: post-EXECUTE deployed md5 % <> reviewed d2a9e38148fa927eba02a115716f0d09', md5(v_def);
  END IF;
END $mig$;
