#!/usr/bin/env python3
"""Google Sheets -> Databricks Delta backfill for the Quantum Trading Pipeline.

Usage:
    # Dry run (prints normalized rows + generated SQL, executes nothing)
    python scripts/migration/sheets_to_databricks.py --dry-run

    # Live run (requires Databricks env vars + service account credentials)
    python scripts/migration/sheets_to_databricks.py

Environment variables:
    GOOGLE_SHEET_ID                 — source spreadsheet id
    GOOGLE_SERVICE_ACCOUNT_B64      — base64-encoded service account JSON, OR
    GOOGLE_APPLICATION_CREDENTIALS  — path to service account JSON file
    DATABRICKS_HOST                 — e.g. https://dbc-xxxx.cloud.databricks.com
    DATABRICKS_TOKEN
    DATABRICKS_WAREHOUSE_ID
    DATABRICKS_CATALOG              — default trading_prod
    DATABRICKS_SCHEMA               — default quantum

This script preserves every raw sheet row as VARIANT in raw_payload and uses
idempotent MERGE writes keyed on idempotency_key, so it is safe to re-run.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import random
import sys
import tempfile
import time
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any, Dict, Iterable, List, Optional, Tuple

SCOPES = ["https://www.googleapis.com/auth/spreadsheets.readonly"]

WORKSHEET_MAP = {
    "Trade Log": "trade_log",
    "Daily P&L": "daily_pnl",
    "Portfolio Snapshot": "portfolio_snapshot",
    "Performance Metrics": "performance_metrics",
    "Audit Trail": "audit_trail",
    "Order Events": "order_events",
    "Risk Events": "risk_events",
    "Strategy Signals": "strategy_signals",
    "System Health": "system_health",
}

DEFAULTS = {
    "CATALOG": "trading_prod",
    "SCHEMA": "quantum",
    "MAX_RETRIES": 8,
    "BATCH_SIZE": 100,
    "BASE_DELAY": 0.25,
    "MAX_DELAY": 30.0,
}


# ---------------------------------------------------------------------------
# Helpers (unit-tested)
# ---------------------------------------------------------------------------
def sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def clean_col(col: Any) -> str:
    s = (
        str(col)
        .strip()
        .lower()
        .replace("&", "and")
        .replace("%", "pct")
        .replace("/", "_")
        .replace("-", "_")
        .replace(" ", "_")
    )
    while "__" in s:
        s = s.replace("__", "_")
    return s


def normalize_raw_row(
    worksheet: str, headers: List[str], row: List[Any], row_index: int
) -> Dict[str, Any]:
    """Pad + zip + stamp migration metadata onto a single sheet row."""
    padded = list(row) + [None] * (len(headers) - len(row))
    record: Dict[str, Any] = dict(zip(headers, padded))
    record["source_row_id"] = f"{worksheet}!{row_index}"
    record["source_worksheet"] = worksheet
    record["migration_loaded_at"] = now_iso()
    return record


def q(value: Any) -> str:
    if value is None:
        return "NULL"
    s = str(value)
    if s == "" or s.lower() in ("nan", "none", "null"):
        return "NULL"
    return "'" + s.replace("'", "''") + "'"


def q_json(value: Any) -> str:
    return f"parse_json({q(json.dumps(value, default=str))})"


def to_decimal(value: Any) -> Optional[Decimal]:
    if value is None:
        return None
    s = str(value).replace("$", "").replace(",", "").replace("%", "").strip()
    if s == "" or s.lower() in ("nan", "none", "null"):
        return None
    try:
        return Decimal(s)
    except InvalidOperation:
        return None


def dec(value: Any) -> str:
    d = to_decimal(value)
    return "NULL" if d is None else str(d)


def ts(value: Any) -> str:
    if value is None or str(value).strip() == "":
        return "CURRENT_TIMESTAMP()"
    s = str(value).strip()
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M:%S.%f",
                "%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            dt = datetime.strptime(s.replace("Z", "").split("+")[0], fmt)
            return f"TIMESTAMP {q(dt.strftime('%Y-%m-%d %H:%M:%S'))}"
        except ValueError:
            continue
    return "CURRENT_TIMESTAMP()"


def full_table(catalog: str, schema: str, table: str) -> str:
    return f"`{catalog}`.`{schema}`.`{table}`"


def compute_trade_log_idempotency(record: Dict[str, Any]) -> str:
    if record.get("idempotency_key"):
        return str(record["idempotency_key"])
    parts = "|".join([
        "trade_log",
        str(record.get("account_id", "")),
        str(record.get("strategy_id", "")),
        str(record.get("broker_order_id", "")),
        str(record.get("trade_ts") or record.get("timestamp") or ""),
        str(record.get("symbol", "")),
        str(record.get("side", "")),
        str(record.get("quantity", "")),
        str(record.get("avg_fill_price") or record.get("price") or ""),
    ])
    return sha256(parts)


def build_trade_log_merge(catalog: str, schema: str, records: List[Dict[str, Any]]) -> str:
    if not records:
        raise ValueError("build_trade_log_merge: records required")
    value_rows: List[str] = []
    for r in records:
        trade_id = r.get("trade_id") or f"mig_trd_{sha256(json.dumps(r, default=str))[:24]}"
        idem = compute_trade_log_idempotency(r)
        value_rows.append(f"""(
    {q(trade_id)},
    {q(r.get("source_row_id"))},
    {q(r.get("run_id") or "migration")},
    {q(r.get("strategy_id") or "unknown_strategy")},
    {q(r.get("strategy_name"))},
    {q(r.get("signal_id"))},
    {q(r.get("order_id"))},
    {q(r.get("broker_order_id"))},
    {q(r.get("account_id") or "unknown_account")},
    {ts(r.get("trade_ts") or r.get("timestamp"))},
    {q(r.get("symbol"))},
    {q(r.get("asset_class"))},
    {q(r.get("exchange"))},
    {q(r.get("currency") or "USD")},
    {q(r.get("side"))},
    {q(r.get("order_type"))},
    {q(r.get("time_in_force"))},
    {dec(r.get("quantity"))},
    {dec(r.get("filled_quantity") or r.get("quantity"))},
    {dec(r.get("avg_fill_price") or r.get("price"))},
    {dec(r.get("notional"))},
    {dec(r.get("fees"))},
    {dec(r.get("slippage_bps"))},
    {dec(r.get("gross_pnl"))},
    {dec(r.get("net_pnl"))},
    {dec(r.get("realized_pnl"))},
    {dec(r.get("unrealized_pnl"))},
    {dec(r.get("position_after"))},
    {dec(r.get("exposure_after"))},
    {dec(r.get("leverage_after"))},
    {q(r.get("trade_status") or "MIGRATED")},
    {q(r.get("execution_venue"))},
    {q(r.get("liquidity_flag"))},
    {q(r.get("model_version"))},
    {q(r.get("risk_check_status"))},
    {q(r.get("notes"))},
    {q_json(r)},
    {q(idem)},
    CURRENT_TIMESTAMP(),
    CURRENT_TIMESTAMP()
  )""")

    cols = (
        "trade_id, source_row_id, run_id, strategy_id, strategy_name, signal_id, order_id, "
        "broker_order_id, account_id, trade_ts, symbol, asset_class, exchange, currency, "
        "side, order_type, time_in_force, quantity, filled_quantity, avg_fill_price, "
        "notional, fees, slippage_bps, gross_pnl, net_pnl, realized_pnl, unrealized_pnl, "
        "position_after, exposure_after, leverage_after, trade_status, execution_venue, "
        "liquidity_flag, model_version, risk_check_status, notes, raw_payload, "
        "idempotency_key, ingested_at, updated_at"
    )
    source_cols = ", ".join(f"s.{c.strip()}" for c in cols.split(","))
    return f"""
MERGE INTO {full_table(catalog, schema, "trade_log")} AS t
USING (
  SELECT * FROM VALUES
  {",".join(value_rows)}
  AS s({cols})
) AS s
ON t.idempotency_key = s.idempotency_key
WHEN NOT MATCHED THEN INSERT ({cols}) VALUES ({source_cols})
""".strip()


def build_audit_merge(catalog: str, schema: str, records: List[Dict[str, Any]], target_name: str) -> str:
    if not records:
        raise ValueError("build_audit_merge: records required")
    value_rows: List[str] = []
    for r in records:
        audit_id = r.get("audit_id") or f"mig_{target_name}_{sha256(json.dumps(r, default=str))[:24]}"
        idem = r.get("idempotency_key") or sha256(json.dumps(r, default=str, sort_keys=True))
        value_rows.append(f"""(
    {q(audit_id)},
    {q(r.get("source_row_id"))},
    {ts(r.get("event_ts") or r.get("timestamp"))},
    {q(r.get("actor_type") or "migration")},
    {q(r.get("actor_id") or "google_sheets_backfill")},
    {q(r.get("workflow_id"))},
    {q(r.get("workflow_name") or "migration")},
    {q(r.get("run_id") or "migration")},
    {q(r.get("account_id"))},
    {q(r.get("strategy_id"))},
    {q(r.get("event_type") or f"MIGRATED_{target_name.upper()}")},
    {q(r.get("event_severity") or "INFO")},
    {q(r.get("event_status") or "MIGRATED")},
    {q(r.get("entity_type") or target_name)},
    {q(r.get("entity_id") or r.get("trade_id") or r.get("order_id"))},
    {q(r.get("message") or f"Migrated row from Google Sheets worksheet {r.get('source_worksheet')}")},
    parse_json('{{}}'),
    parse_json('{{}}'),
    {q_json(r)},
    {q(r.get("ip_address"))},
    {q(r.get("user_agent"))},
    {q(r.get("correlation_id"))},
    {q(idem)},
    CURRENT_TIMESTAMP()
  )""")

    cols = (
        "audit_id, source_row_id, event_ts, actor_type, actor_id, workflow_id, "
        "workflow_name, run_id, account_id, strategy_id, event_type, event_severity, "
        "event_status, entity_type, entity_id, message, before_state, after_state, "
        "raw_payload, ip_address, user_agent, correlation_id, idempotency_key, ingested_at"
    )
    source_cols = ", ".join(f"s.{c.strip()}" for c in cols.split(","))
    return f"""
MERGE INTO {full_table(catalog, schema, "audit_trail")} AS t
USING (
  SELECT * FROM VALUES
  {",".join(value_rows)}
  AS s({cols})
) AS s
ON t.idempotency_key = s.idempotency_key
WHEN NOT MATCHED THEN INSERT ({cols}) VALUES ({source_cols})
""".strip()


def build_merge_statement(
    catalog: str, schema: str, table: str, records: List[Dict[str, Any]]
) -> str:
    if table == "trade_log":
        return build_trade_log_merge(catalog, schema, records)
    return build_audit_merge(catalog, schema, records, table)


# ---------------------------------------------------------------------------
# I/O (only invoked outside tests)
# ---------------------------------------------------------------------------
def _materialize_service_account_file() -> Optional[str]:
    """Prefer GOOGLE_APPLICATION_CREDENTIALS; otherwise decode the B64 env var."""
    existing = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    if existing:
        return existing
    b64 = os.environ.get("GOOGLE_SERVICE_ACCOUNT_B64")
    if not b64:
        return None
    decoded = base64.b64decode(b64)
    tmp = tempfile.NamedTemporaryFile(
        prefix="sa-", suffix=".json", delete=False, mode="wb"
    )
    tmp.write(decoded)
    tmp.flush()
    tmp.close()
    os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = tmp.name
    return tmp.name


def _get_sheets_service():
    from google.oauth2 import service_account
    from googleapiclient.discovery import build

    path = _materialize_service_account_file()
    if not path:
        raise RuntimeError(
            "Set GOOGLE_APPLICATION_CREDENTIALS or GOOGLE_SERVICE_ACCOUNT_B64 "
            "before running the live migration."
        )
    creds = service_account.Credentials.from_service_account_file(path, scopes=SCOPES)
    return build("sheets", "v4", credentials=creds)


def _read_worksheet(service, sheet_id: str, worksheet: str) -> List[Dict[str, Any]]:
    result = service.spreadsheets().values().get(
        spreadsheetId=sheet_id, range=f"'{worksheet}'"
    ).execute()
    values = result.get("values", [])
    if not values:
        return []
    headers = [clean_col(h) for h in values[0]]
    out: List[Dict[str, Any]] = []
    for i, row in enumerate(values[1:], start=2):
        out.append(normalize_raw_row(worksheet, headers, row, i))
    return out


def _execute_with_retry(cursor, statement: str, *, max_retries: int = DEFAULTS["MAX_RETRIES"],
                        base_delay: float = DEFAULTS["BASE_DELAY"],
                        max_delay: float = DEFAULTS["MAX_DELAY"],
                        rng: random.Random = random.Random()) -> None:
    last: Optional[Exception] = None
    for attempt in range(max_retries + 1):
        try:
            cursor.execute(statement)
            return
        except Exception as exc:  # noqa: BLE001
            last = exc
            if attempt == max_retries:
                break
            exp = min(max_delay, base_delay * (2 ** attempt))
            time.sleep(rng.random() * exp)
    raise last if last else RuntimeError("unknown migration failure")


def migrate(
    *,
    dry_run: bool,
    sheet_id: Optional[str] = None,
    catalog: str = DEFAULTS["CATALOG"],
    schema: str = DEFAULTS["SCHEMA"],
    batch_size: int = DEFAULTS["BATCH_SIZE"],
    worksheet_map: Dict[str, str] = WORKSHEET_MAP,
    reader: Optional[Any] = None,
    cursor: Optional[Any] = None,
    log: Any = print,
) -> Dict[str, Any]:
    """Migration entry point.

    ``reader`` must be a callable ``reader(worksheet_name) -> List[Dict]`` so the
    function can be unit tested without Google API access. When not provided and
    ``dry_run`` is False, a real Sheets client is built.
    """
    sheet_id = sheet_id or os.environ.get("GOOGLE_SHEET_ID")
    if reader is None:
        if dry_run and sheet_id is None:
            reader = lambda ws: []  # noqa: E731
        else:
            if not sheet_id:
                raise RuntimeError("GOOGLE_SHEET_ID is required")
            service = _get_sheets_service()
            reader = lambda ws: _read_worksheet(service, sheet_id, ws)  # noqa: E731

    summary: Dict[str, Any] = {"dry_run": dry_run, "tables": {}, "statements": []}

    for worksheet, table in worksheet_map.items():
        rows = reader(worksheet) or []
        if not rows:
            log(f"Skipping empty worksheet: {worksheet}")
            continue

        log(f"Migrating {len(rows)} rows from {worksheet} -> {table}")
        summary["tables"][table] = summary["tables"].get(table, 0) + len(rows)
        for i in range(0, len(rows), batch_size):
            batch = rows[i:i + batch_size]
            sql = build_merge_statement(catalog, schema, table, batch)
            if dry_run:
                summary["statements"].append({"table": table, "rows": len(batch), "sql": sql})
                log(f"[dry-run] {table} batch rows={len(batch)} sql_len={len(sql)}")
                continue
            if cursor is None:
                raise RuntimeError("cursor is required when dry_run=False")
            _execute_with_retry(cursor, sql)

    return summary


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def _normalize_host(raw: str) -> str:
    return raw.replace("https://", "").replace("http://", "").rstrip("/")


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="Build SQL but execute nothing")
    parser.add_argument("--batch-size", type=int, default=DEFAULTS["BATCH_SIZE"])
    parser.add_argument("--catalog", default=os.environ.get("DATABRICKS_CATALOG", DEFAULTS["CATALOG"]))
    parser.add_argument("--schema", default=os.environ.get("DATABRICKS_SCHEMA", DEFAULTS["SCHEMA"]))
    args = parser.parse_args(argv)

    if args.dry_run:
        summary = migrate(
            dry_run=True,
            sheet_id=os.environ.get("GOOGLE_SHEET_ID"),
            catalog=args.catalog,
            schema=args.schema,
            batch_size=args.batch_size,
        )
        json.dump(summary["tables"], sys.stdout, indent=2)
        sys.stdout.write("\n")
        return 0

    host = _normalize_host(os.environ["DATABRICKS_HOST"])
    token = os.environ["DATABRICKS_TOKEN"]
    warehouse_id = os.environ["DATABRICKS_WAREHOUSE_ID"]

    from databricks import sql  # type: ignore
    with sql.connect(
        server_hostname=host,
        http_path=f"/sql/1.0/warehouses/{warehouse_id}",
        access_token=token,
    ) as conn:
        with conn.cursor() as cursor:
            summary = migrate(
                dry_run=False,
                sheet_id=os.environ.get("GOOGLE_SHEET_ID"),
                catalog=args.catalog,
                schema=args.schema,
                batch_size=args.batch_size,
                cursor=cursor,
            )
    json.dump(summary["tables"], sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
