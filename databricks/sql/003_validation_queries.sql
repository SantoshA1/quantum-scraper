-- Pre-cutover validation queries for the Quantum Trading Pipeline.

-- Row counts across all managed logging tables
SELECT 'trade_log'           AS table_name, COUNT(*) AS row_count FROM trading_prod.quantum.trade_log
UNION ALL SELECT 'daily_pnl',           COUNT(*) FROM trading_prod.quantum.daily_pnl
UNION ALL SELECT 'portfolio_snapshot',  COUNT(*) FROM trading_prod.quantum.portfolio_snapshot
UNION ALL SELECT 'performance_metrics', COUNT(*) FROM trading_prod.quantum.performance_metrics
UNION ALL SELECT 'audit_trail',         COUNT(*) FROM trading_prod.quantum.audit_trail
UNION ALL SELECT 'order_events',        COUNT(*) FROM trading_prod.quantum.order_events
UNION ALL SELECT 'risk_events',         COUNT(*) FROM trading_prod.quantum.risk_events
UNION ALL SELECT 'strategy_signals',    COUNT(*) FROM trading_prod.quantum.strategy_signals
UNION ALL SELECT 'system_health',       COUNT(*) FROM trading_prod.quantum.system_health
UNION ALL SELECT 'logging_dead_letter', COUNT(*) FROM trading_prod.quantum.logging_dead_letter;

-- Duplicate idempotency keys in trade_log (must return 0 rows)
SELECT idempotency_key, COUNT(*) AS duplicate_count
FROM trading_prod.quantum.trade_log
GROUP BY idempotency_key
HAVING COUNT(*) > 1;

-- Required live-trading fields on trade_log (must return 0 rows)
SELECT *
FROM trading_prod.quantum.trade_log
WHERE trade_id IS NULL
   OR account_id IS NULL
   OR strategy_id IS NULL
   OR trade_ts IS NULL
   OR symbol IS NULL
   OR side IS NULL
   OR quantity IS NULL
   OR avg_fill_price IS NULL
LIMIT 100;

-- Daily aggregate reconciliation against Google Sheets totals
SELECT
  trade_date,
  account_id,
  strategy_id,
  COUNT(*)        AS databricks_trade_count,
  SUM(net_pnl)    AS databricks_net_pnl
FROM trading_prod.quantum.trade_log
GROUP BY trade_date, account_id, strategy_id
ORDER BY trade_date DESC, account_id, strategy_id;
