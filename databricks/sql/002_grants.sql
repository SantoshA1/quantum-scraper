-- Unity Catalog least-privilege grants for the Quantum Trading Pipeline.
-- Replace the service principal names with your actual principals.

-- 1. Logger service principal (live n8n append/merge only)
GRANT USE CATALOG ON CATALOG trading_prod TO `sp-quantum-trading-logger-prod`;
GRANT USE SCHEMA ON SCHEMA trading_prod.quantum TO `sp-quantum-trading-logger-prod`;

GRANT SELECT, INSERT, MODIFY ON TABLE trading_prod.quantum.trade_log           TO `sp-quantum-trading-logger-prod`;
GRANT SELECT, INSERT, MODIFY ON TABLE trading_prod.quantum.daily_pnl           TO `sp-quantum-trading-logger-prod`;
GRANT SELECT, INSERT, MODIFY ON TABLE trading_prod.quantum.portfolio_snapshot  TO `sp-quantum-trading-logger-prod`;
GRANT SELECT, INSERT, MODIFY ON TABLE trading_prod.quantum.performance_metrics TO `sp-quantum-trading-logger-prod`;
GRANT SELECT, INSERT, MODIFY ON TABLE trading_prod.quantum.audit_trail         TO `sp-quantum-trading-logger-prod`;
GRANT SELECT, INSERT, MODIFY ON TABLE trading_prod.quantum.order_events        TO `sp-quantum-trading-logger-prod`;
GRANT SELECT, INSERT, MODIFY ON TABLE trading_prod.quantum.risk_events         TO `sp-quantum-trading-logger-prod`;
GRANT SELECT, INSERT, MODIFY ON TABLE trading_prod.quantum.strategy_signals    TO `sp-quantum-trading-logger-prod`;
GRANT SELECT, INSERT, MODIFY ON TABLE trading_prod.quantum.system_health       TO `sp-quantum-trading-logger-prod`;
GRANT SELECT, INSERT, MODIFY ON TABLE trading_prod.quantum.logging_dead_letter TO `sp-quantum-trading-logger-prod`;

-- 2. Migration-only service principal (revoke after one-time backfill)
GRANT USE CATALOG ON CATALOG trading_prod TO `sp-quantum-trading-migration-once`;
GRANT USE SCHEMA  ON SCHEMA  trading_prod.quantum TO `sp-quantum-trading-migration-once`;
GRANT CREATE TABLE, CREATE VOLUME ON SCHEMA trading_prod.quantum TO `sp-quantum-trading-migration-once`;
GRANT SELECT, INSERT, MODIFY ON SCHEMA trading_prod.quantum TO `sp-quantum-trading-migration-once`;

-- 3. Read-only dashboards / monitoring
GRANT USE CATALOG ON CATALOG trading_prod TO `sp-quantum-trading-reader-prod`;
GRANT USE SCHEMA  ON SCHEMA  trading_prod.quantum TO `sp-quantum-trading-reader-prod`;
GRANT SELECT ON SCHEMA trading_prod.quantum TO `sp-quantum-trading-reader-prod`;
