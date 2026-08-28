# Databricks Logging Migration — Runbook

Production runbook for migrating the Quantum Trading Pipeline from Google Sheets
to Databricks Unity Catalog + Delta Lake (Serverless SQL Warehouse), including
the async n8n logger, the Google Sheets backfill, and the rollback procedure.

---

## 1. Repository layout

| Path | Purpose |
| --- | --- |
| `databricks/config.js` | Env loading, host normalization, warehouse path, validation |
| `databricks/sql-format.js` | Primitive SQL literal formatters (string, timestamp, decimal, variant) |
| `databricks/sql-builders.js` | `MERGE` statement builders for `trade_log` and audit fallback |
| `databricks/retry.js` | Exponential backoff with jitter, non-blocking final failure |
| `databricks/telegram-alert.js` | Telegram payload builder + injectable HTTPS sender |
| `databricks/normalize-payload.js` | Per-item normalization + idempotency key |
| `databricks/logger.js` | Top-level `logPayloads(items, deps)` for the n8n Code node |
| `databricks/sql/001_create_tables.sql` | Unity Catalog DDL for all 10 tables |
| `databricks/sql/002_grants.sql` | Least-privilege GRANTs |
| `databricks/sql/003_validation_queries.sql` | Pre-cutover + shadow-mode queries |
| `n8n-workflows/code-nodes/01-normalize-logging-payload.js` | Paste-ready Code node |
| `n8n-workflows/code-nodes/02-databricks-batch-writer.js` | Paste-ready Code node |
| `n8n-workflows/code-nodes/03-telegram-fallback-alert.js` | Paste-ready Code node |
| `n8n-workflows/databricks-async-logger.json` | Sub-workflow skeleton |
| `scripts/migration/sheets_to_databricks.py` | Backfill script with `--dry-run` |
| `docs/backups/n8n/signal-state-machine-pre-databricks-20260419-2011.json` | Pre-migration n8n export |
| `tests/databricks/` | Node + Python test suite + `run-all.sh` |

---

## 2. Required environment variables

Set these in the n8n runtime (and locally when testing the migration script).
**Never commit actual values.**

```bash
# Databricks
DATABRICKS_HOST=https://dbc-xxxxxxxx-xxxx.cloud.databricks.com
DATABRICKS_TOKEN=<service-principal-oauth-token-or-pat>
DATABRICKS_WAREHOUSE_ID=<warehouse-id>
DATABRICKS_CATALOG=trading_prod
DATABRICKS_SCHEMA=quantum

# Telegram fallback
TELEGRAM_BOT_TOKEN=<bot-token>
TELEGRAM_PERSONAL_CHAT_ID=<personal-chat-id>
TELEGRAM_SUBSCRIBER_CHAT_ID=<subscriber-chat-id>

# n8n Code-node runtime
N8N_BLOCK_ENV_ACCESS_IN_NODE=false
NODE_FUNCTION_ALLOW_EXTERNAL=@databricks/sql
NODE_FUNCTION_ALLOW_BUILTIN=crypto,https

# Migration only
GOOGLE_SHEET_ID=<sheet-id>
GOOGLE_SERVICE_ACCOUNT_B64=<base64 of service account json>   # OR
GOOGLE_APPLICATION_CREDENTIALS=/secure/path/service-account.json
```

---

## 3. Staging / deployment sequence

1. **Apply DDL**
   ```bash
   databricks sql query -f databricks/sql/001_create_tables.sql
   databricks sql query -f databricks/sql/002_grants.sql
   ```
   (Or run the files through the SQL editor with a warehouse admin identity.)
   > The 10 tables in `trading_prod.quantum` were already deployed successfully
   > with `TBLPROPERTIES('delta.feature.allowColumnDefaults' = 'supported')`.

2. **Run tests locally**
   ```bash
   bash tests/databricks/run-all.sh
   ```
   Expect all Node + Python tests green before promoting to n8n.

3. **Dry-run the migration**
   ```bash
   GOOGLE_SHEET_ID=<sheet-id> \
   GOOGLE_APPLICATION_CREDENTIALS=/secure/path/sa.json \
   python3 scripts/migration/sheets_to_databricks.py --dry-run
   ```
   Produces per-worksheet row counts and generated `MERGE` statements without
   touching Databricks or modifying Sheets.

4. **Live backfill (migration service principal)**
   Export the `DATABRICKS_*` env vars for `sp-quantum-trading-migration-once`,
   then:
   ```bash
   python3 scripts/migration/sheets_to_databricks.py
   ```
   The script uses idempotent `MERGE` keyed on `idempotency_key`, so it is
   safe to re-run.

5. **Deploy the async n8n logger**

   Create a new n8n workflow named `Quantum — Async Databricks Logger`
   from `n8n-workflows/databricks-async-logger.json`. For each Code node,
   paste the body from the matching file under `n8n-workflows/code-nodes/`.

   The Databricks Batch Writer node must have **On Error: Continue** (the
   workflow should never raise into the main pipeline). The sub-workflow is
   invoked from the main trading pipeline's `Execute Workflow` node with
   **Wait for completion: false**.

6. **Shadow mode**
   Keep the existing Google Sheets Writer node enabled. Run the Databricks
   logger in parallel for at least one full trading session.

7. **Reconcile**
   Run the queries in `databricks/sql/003_validation_queries.sql`:
   * row counts across all 10 tables
   * no duplicate idempotency keys in `trade_log`
   * no required-field NULLs in `trade_log`
   * aggregate reconciliation against Google Sheets totals

8. **Cutover**
   Disable the Google Sheets Writer node. Keep the sheet read-only for
   emergency reference for at least one week.

9. **Monitor**
   Tail `audit_trail` and `system_health`; review Telegram alerts.

---

## 4. Testing

```bash
bash tests/databricks/run-all.sh
```

Covers every required stage:

* **Config validation** – `test-config.js`: env loading, host normalization,
  warehouse-path construction, missing-key errors.
* **SQL generation / DDL coverage** – `test-sql-builders.js`: `MERGE` for
  `trade_log` and audit fallback, event-type routing, backtick-quoted
  identifiers, SQL-injection-safe escaping; asserts all 10 tables + the
  `allowColumnDefaults` property + liquid `CLUSTER BY`.
* **Retry / jitter** – `test-retry.js`: exponential shape, cap at `maxDelayMs`,
  `maxRetries + 1` attempt budget, `onFinalFailure` wiring, non-blocking
  failure result (never throws).
* **Telegram alert payload** – `test-telegram-alert.js`: alert body shape,
  payload truncation, two-channel fanout, HTTPS mock (no network).
* **Normalization + idempotency** – `test-normalize-payload.js`.
* **End-to-end logger** – `test-logger.js`: group-by-table, batch writes, happy
  path, retry-then-success, permanent-failure → `databricks_logging_ok: false`.
* **Migration dry-run + idempotency** – `test_sheets_migration.py`: row
  normalization, MERGE generation, dry-run flow, retry helper.

---

## 5. Rollback

### Immediate (workflow level)
1. Disable `Quantum — Async Databricks Logger` (sub-workflow or main-workflow
   `Execute Workflow` node).
2. Re-enable the Google Sheets Writer node.
3. Leave idempotency keys unchanged — replay will dedupe on re-enable.

### Data-level rollback (Delta time travel)
```sql
RESTORE TABLE trading_prod.quantum.trade_log
TO TIMESTAMP AS OF '2026-04-19 19:00:00';
```

### Scenario playbook

| Scenario | Action |
| --- | --- |
| Databricks degraded | Disable logger branch, re-enable Sheets writer temporarily |
| Schema bug | Pause logger, fix schema, replay from Telegram / dead-letter / `audit_trail` payloads |
| Duplicate ingestion | Delete by bad `run_id` or `RESTORE TABLE …` |
| Service principal token leak | Revoke token, rotate secret, update n8n env var |
| n8n code bug | Roll back node version; replay by `idempotency_key` |

---

## 6. Live n8n update (manual)

This repo **does not** push workflow changes via the n8n API. The remaining
manual steps are:

1. In the n8n UI, import `n8n-workflows/databricks-async-logger.json` as a
   new workflow.
2. For each Code node (`Normalize Logging Payload`, `Databricks Batch Writer`,
   `Telegram Fallback Alert`), paste the corresponding file from
   `n8n-workflows/code-nodes/` into the node's JavaScript editor.
3. Activate the workflow.
4. Edit the main trading pipeline (v5.21): add an `Execute Workflow` node that
   calls the new sub-workflow with **Wait for completion: false** and
   **On Error: Continue**, branching off after the signal/execution leg.
5. Keep the existing Google Sheets Writer node enabled for shadow mode.
6. After reconciliation, disable the Google Sheets Writer node.

---

## 7. Security notes

* The SQL builders escape single quotes via `sqlString` and emit `NULL` on
  falsy input; no placeholders/parameter binding is used because the
  warehouse statement API takes a raw SQL string. `test-sql-builders.js`
  includes an injection-safety regression test.
* Tokens and service account JSON are read from environment variables only;
  nothing is committed.
* Telegram alerts include payload content. In regulated environments, scrub
  PII before emitting (extend `buildAlertText` if needed).
