SELECT id::text AS trade_id, symbol, side, qty::numeric AS qty,
       entry_fill_price::numeric AS entry_price, intended_stop::numeric AS stop_level,
       to_char((entry_fill_time AT TIME ZONE 'America/New_York')::date,'YYYY-MM-DD') AS entry_day,
       to_char(COALESCE((exit_fill_time AT TIME ZONE 'America/New_York')::date,
                        (now() AT TIME ZONE 'America/New_York')::date),'YYYY-MM-DD') AS end_day,
       (status <> 'closed') AS is_open
FROM public.trade_ledger
WHERE mode='paper' AND entry_fill_time IS NOT NULL
  AND entry_fill_time >= now() - interval '95 days'
  AND coalesce(strategy,'') NOT ILIKE 'maya-%'
  AND coalesce(qty,0) <> 0
ORDER BY entry_fill_time;