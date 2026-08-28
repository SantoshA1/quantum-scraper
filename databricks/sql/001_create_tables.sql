-- Quantum Trading Pipeline: Unity Catalog Delta DDL
-- Target: trading_prod.quantum
-- Notes:
--   * Delta column DEFAULTs require TBLPROPERTIES('delta.feature.allowColumnDefaults' = 'supported')
--   * Constraints are INFORMATIONAL in Unity Catalog; enforce idempotency in ingestion via MERGE
--   * Liquid clustering; avoid physical partitioning (<1 TB tables)

CREATE CATALOG IF NOT EXISTS trading_prod;
CREATE SCHEMA IF NOT EXISTS trading_prod.quantum;

-- ---------------------------------------------------------------------------
-- 1. trade_log
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trading_prod.quantum.trade_log (
  trade_id STRING NOT NULL,
  source_row_id STRING,
  run_id STRING NOT NULL,
  strategy_id STRING NOT NULL,
  strategy_name STRING,
  signal_id STRING,
  order_id STRING,
  broker_order_id STRING,
  account_id STRING NOT NULL,
  trade_ts TIMESTAMP NOT NULL,
  trade_date DATE GENERATED ALWAYS AS (CAST(trade_ts AS DATE)),
  symbol STRING NOT NULL,
  asset_class STRING,
  exchange STRING,
  currency STRING DEFAULT 'USD',
  side STRING NOT NULL,
  order_type STRING,
  time_in_force STRING,
  quantity DECIMAL(38, 12) NOT NULL,
  filled_quantity DECIMAL(38, 12),
  avg_fill_price DECIMAL(38, 12) NOT NULL,
  notional DECIMAL(38, 12),
  fees DECIMAL(38, 12),
  slippage_bps DECIMAL(18, 6),
  gross_pnl DECIMAL(38, 12),
  net_pnl DECIMAL(38, 12),
  realized_pnl DECIMAL(38, 12),
  unrealized_pnl DECIMAL(38, 12),
  position_after DECIMAL(38, 12),
  exposure_after DECIMAL(38, 12),
  leverage_after DECIMAL(18, 8),
  trade_status STRING NOT NULL,
  execution_venue STRING,
  liquidity_flag STRING,
  model_version STRING,
  risk_check_status STRING,
  notes STRING,
  raw_payload VARIANT,
  idempotency_key STRING NOT NULL,
  ingested_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP(),
  updated_at TIMESTAMP,
  CONSTRAINT trade_log_pk PRIMARY KEY (trade_id)
)
USING DELTA
CLUSTER BY (trade_date, strategy_id, symbol, account_id)
TBLPROPERTIES ('delta.feature.allowColumnDefaults' = 'supported');

-- ---------------------------------------------------------------------------
-- 2. daily_pnl
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trading_prod.quantum.daily_pnl (
  pnl_id STRING NOT NULL,
  source_row_id STRING,
  account_id STRING NOT NULL,
  strategy_id STRING,
  trading_date DATE NOT NULL,
  starting_equity DECIMAL(38, 12),
  ending_equity DECIMAL(38, 12),
  gross_pnl DECIMAL(38, 12),
  net_pnl DECIMAL(38, 12),
  realized_pnl DECIMAL(38, 12),
  unrealized_pnl DECIMAL(38, 12),
  fees DECIMAL(38, 12),
  commissions DECIMAL(38, 12),
  borrow_fees DECIMAL(38, 12),
  deposits DECIMAL(38, 12),
  withdrawals DECIMAL(38, 12),
  cash_balance DECIMAL(38, 12),
  market_value DECIMAL(38, 12),
  exposure_gross DECIMAL(38, 12),
  exposure_net DECIMAL(38, 12),
  leverage DECIMAL(18, 8),
  trades_count BIGINT,
  winners_count BIGINT,
  losers_count BIGINT,
  win_rate DECIMAL(18, 8),
  avg_win DECIMAL(38, 12),
  avg_loss DECIMAL(38, 12),
  max_intraday_drawdown DECIMAL(38, 12),
  daily_return DECIMAL(18, 10),
  data_status STRING NOT NULL DEFAULT 'FINAL',
  raw_payload VARIANT,
  idempotency_key STRING NOT NULL,
  ingested_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP(),
  updated_at TIMESTAMP,
  CONSTRAINT daily_pnl_pk PRIMARY KEY (pnl_id)
)
USING DELTA
CLUSTER BY (trading_date, account_id, strategy_id)
TBLPROPERTIES ('delta.feature.allowColumnDefaults' = 'supported');

-- ---------------------------------------------------------------------------
-- 3. portfolio_snapshot
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trading_prod.quantum.portfolio_snapshot (
  snapshot_id STRING NOT NULL,
  source_row_id STRING,
  account_id STRING NOT NULL,
  snapshot_ts TIMESTAMP NOT NULL,
  snapshot_date DATE GENERATED ALWAYS AS (CAST(snapshot_ts AS DATE)),
  symbol STRING NOT NULL,
  asset_class STRING,
  currency STRING DEFAULT 'USD',
  quantity DECIMAL(38, 12) NOT NULL,
  avg_cost DECIMAL(38, 12),
  mark_price DECIMAL(38, 12),
  market_value DECIMAL(38, 12),
  cost_basis DECIMAL(38, 12),
  unrealized_pnl DECIMAL(38, 12),
  realized_pnl_today DECIMAL(38, 12),
  weight DECIMAL(18, 10),
  beta DECIMAL(18, 8),
  delta DECIMAL(18, 8),
  gamma DECIMAL(18, 8),
  theta DECIMAL(18, 8),
  vega DECIMAL(18, 8),
  gross_exposure DECIMAL(38, 12),
  net_exposure DECIMAL(38, 12),
  cash_balance DECIMAL(38, 12),
  buying_power DECIMAL(38, 12),
  margin_used DECIMAL(38, 12),
  portfolio_equity DECIMAL(38, 12),
  data_status STRING NOT NULL DEFAULT 'SNAPSHOT',
  raw_payload VARIANT,
  idempotency_key STRING NOT NULL,
  ingested_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP(),
  updated_at TIMESTAMP,
  CONSTRAINT portfolio_snapshot_pk PRIMARY KEY (snapshot_id)
)
USING DELTA
CLUSTER BY (snapshot_date, account_id, symbol)
TBLPROPERTIES ('delta.feature.allowColumnDefaults' = 'supported');

-- ---------------------------------------------------------------------------
-- 4. performance_metrics
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trading_prod.quantum.performance_metrics (
  metric_id STRING NOT NULL,
  source_row_id STRING,
  account_id STRING NOT NULL,
  strategy_id STRING,
  metric_ts TIMESTAMP NOT NULL,
  metric_date DATE GENERATED ALWAYS AS (CAST(metric_ts AS DATE)),
  window_name STRING NOT NULL,
  cumulative_return DECIMAL(18, 10),
  annualized_return DECIMAL(18, 10),
  annualized_volatility DECIMAL(18, 10),
  sharpe_ratio DECIMAL(18, 8),
  sortino_ratio DECIMAL(18, 8),
  calmar_ratio DECIMAL(18, 8),
  max_drawdown DECIMAL(18, 10),
  current_drawdown DECIMAL(18, 10),
  var_95 DECIMAL(38, 12),
  cvar_95 DECIMAL(38, 12),
  win_rate DECIMAL(18, 8),
  profit_factor DECIMAL(18, 8),
  expectancy DECIMAL(38, 12),
  avg_trade_pnl DECIMAL(38, 12),
  median_trade_pnl DECIMAL(38, 12),
  best_trade DECIMAL(38, 12),
  worst_trade DECIMAL(38, 12),
  trades_count BIGINT,
  avg_holding_period_seconds BIGINT,
  turnover DECIMAL(18, 8),
  capacity_estimate DECIMAL(38, 12),
  model_version STRING,
  data_status STRING NOT NULL DEFAULT 'FINAL',
  raw_payload VARIANT,
  idempotency_key STRING NOT NULL,
  ingested_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP(),
  updated_at TIMESTAMP,
  CONSTRAINT performance_metrics_pk PRIMARY KEY (metric_id)
)
USING DELTA
CLUSTER BY (metric_date, strategy_id, account_id, window_name)
TBLPROPERTIES ('delta.feature.allowColumnDefaults' = 'supported');

-- ---------------------------------------------------------------------------
-- 5. audit_trail
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trading_prod.quantum.audit_trail (
  audit_id STRING NOT NULL,
  source_row_id STRING,
  event_ts TIMESTAMP NOT NULL,
  event_date DATE GENERATED ALWAYS AS (CAST(event_ts AS DATE)),
  actor_type STRING NOT NULL,
  actor_id STRING,
  workflow_id STRING,
  workflow_name STRING,
  run_id STRING,
  account_id STRING,
  strategy_id STRING,
  event_type STRING NOT NULL,
  event_severity STRING NOT NULL,
  event_status STRING NOT NULL,
  entity_type STRING,
  entity_id STRING,
  message STRING,
  before_state VARIANT,
  after_state VARIANT,
  raw_payload VARIANT,
  ip_address STRING,
  user_agent STRING,
  correlation_id STRING,
  idempotency_key STRING NOT NULL,
  ingested_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP(),
  CONSTRAINT audit_trail_pk PRIMARY KEY (audit_id)
)
USING DELTA
CLUSTER BY (event_date, event_type, event_severity, account_id)
TBLPROPERTIES ('delta.feature.allowColumnDefaults' = 'supported');

-- ---------------------------------------------------------------------------
-- 6. order_events
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trading_prod.quantum.order_events (
  order_event_id STRING NOT NULL,
  order_id STRING NOT NULL,
  broker_order_id STRING,
  account_id STRING NOT NULL,
  strategy_id STRING,
  signal_id STRING,
  event_ts TIMESTAMP NOT NULL,
  event_date DATE GENERATED ALWAYS AS (CAST(event_ts AS DATE)),
  symbol STRING NOT NULL,
  side STRING NOT NULL,
  order_type STRING,
  time_in_force STRING,
  order_status STRING NOT NULL,
  requested_quantity DECIMAL(38, 12),
  filled_quantity DECIMAL(38, 12),
  remaining_quantity DECIMAL(38, 12),
  limit_price DECIMAL(38, 12),
  stop_price DECIMAL(38, 12),
  avg_fill_price DECIMAL(38, 12),
  rejection_reason STRING,
  raw_payload VARIANT,
  idempotency_key STRING NOT NULL,
  ingested_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP(),
  CONSTRAINT order_events_pk PRIMARY KEY (order_event_id)
)
USING DELTA
CLUSTER BY (event_date, account_id, order_id, symbol)
TBLPROPERTIES ('delta.feature.allowColumnDefaults' = 'supported');

-- ---------------------------------------------------------------------------
-- 7. risk_events
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trading_prod.quantum.risk_events (
  risk_event_id STRING NOT NULL,
  event_ts TIMESTAMP NOT NULL,
  event_date DATE GENERATED ALWAYS AS (CAST(event_ts AS DATE)),
  account_id STRING NOT NULL,
  strategy_id STRING,
  symbol STRING,
  order_id STRING,
  trade_id STRING,
  risk_check_name STRING NOT NULL,
  risk_limit_name STRING,
  risk_status STRING NOT NULL,
  severity STRING NOT NULL,
  observed_value DECIMAL(38, 12),
  limit_value DECIMAL(38, 12),
  action_taken STRING,
  block_trade BOOLEAN,
  message STRING,
  raw_payload VARIANT,
  idempotency_key STRING NOT NULL,
  ingested_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP(),
  CONSTRAINT risk_events_pk PRIMARY KEY (risk_event_id)
)
USING DELTA
CLUSTER BY (event_date, account_id, strategy_id, risk_status)
TBLPROPERTIES ('delta.feature.allowColumnDefaults' = 'supported');

-- ---------------------------------------------------------------------------
-- 8. strategy_signals
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trading_prod.quantum.strategy_signals (
  signal_id STRING NOT NULL,
  run_id STRING NOT NULL,
  account_id STRING,
  strategy_id STRING NOT NULL,
  strategy_name STRING,
  signal_ts TIMESTAMP NOT NULL,
  signal_date DATE GENERATED ALWAYS AS (CAST(signal_ts AS DATE)),
  symbol STRING NOT NULL,
  signal_type STRING NOT NULL,
  signal_direction STRING NOT NULL,
  signal_strength DECIMAL(18, 10),
  confidence DECIMAL(18, 10),
  target_quantity DECIMAL(38, 12),
  target_weight DECIMAL(18, 10),
  reference_price DECIMAL(38, 12),
  feature_vector VARIANT,
  model_version STRING,
  model_hash STRING,
  decision_reason STRING,
  raw_payload VARIANT,
  idempotency_key STRING NOT NULL,
  ingested_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP(),
  CONSTRAINT strategy_signals_pk PRIMARY KEY (signal_id)
)
USING DELTA
CLUSTER BY (signal_date, strategy_id, symbol, account_id)
TBLPROPERTIES ('delta.feature.allowColumnDefaults' = 'supported');

-- ---------------------------------------------------------------------------
-- 9. system_health
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trading_prod.quantum.system_health (
  health_id STRING NOT NULL,
  observed_ts TIMESTAMP NOT NULL,
  observed_date DATE GENERATED ALWAYS AS (CAST(observed_ts AS DATE)),
  component STRING NOT NULL,
  environment STRING NOT NULL,
  status STRING NOT NULL,
  severity STRING NOT NULL,
  latency_ms BIGINT,
  request_count BIGINT,
  error_count BIGINT,
  rate_limit_count BIGINT,
  queue_depth BIGINT,
  broker_status STRING,
  market_data_status STRING,
  databricks_status STRING,
  n8n_execution_id STRING,
  message STRING,
  raw_payload VARIANT,
  idempotency_key STRING NOT NULL,
  ingested_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP(),
  CONSTRAINT system_health_pk PRIMARY KEY (health_id)
)
USING DELTA
CLUSTER BY (observed_date, component, status, environment)
TBLPROPERTIES ('delta.feature.allowColumnDefaults' = 'supported');

-- ---------------------------------------------------------------------------
-- 10. logging_dead_letter
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trading_prod.quantum.logging_dead_letter (
  dead_letter_id STRING NOT NULL,
  failed_at TIMESTAMP NOT NULL,
  failed_date DATE GENERATED ALWAYS AS (CAST(failed_at AS DATE)),
  source_workflow STRING,
  source_node STRING,
  target_table STRING,
  operation STRING,
  retry_count INT,
  final_error STRING,
  error_stack STRING,
  trade_id STRING,
  order_id STRING,
  account_id STRING,
  strategy_id STRING,
  symbol STRING,
  payload VARIANT NOT NULL,
  alert_sent BOOLEAN NOT NULL DEFAULT false,
  alert_channels ARRAY<STRING>,
  replay_status STRING NOT NULL DEFAULT 'PENDING',
  replayed_at TIMESTAMP,
  idempotency_key STRING NOT NULL,
  ingested_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP(),
  CONSTRAINT logging_dead_letter_pk PRIMARY KEY (dead_letter_id)
)
USING DELTA
CLUSTER BY (failed_date, target_table, replay_status, account_id)
TBLPROPERTIES ('delta.feature.allowColumnDefaults' = 'supported');
