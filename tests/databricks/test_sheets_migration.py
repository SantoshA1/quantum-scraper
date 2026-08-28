#!/usr/bin/env python3
"""Tests for scripts/migration/sheets_to_databricks.py.

Covers:
  * row normalization + source_row_id stamping
  * idempotency key computation + determinism
  * MERGE statement generation (trade_log and generic audit)
  * dry-run end-to-end flow (no Sheets, no Databricks)
  * execute_with_retry jitter + eventual success
"""
from __future__ import annotations

import json
import random
import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts" / "migration"))

import sheets_to_databricks as mig  # noqa: E402


class NormalizationTests(unittest.TestCase):
    def test_clean_col_lowercases_and_normalizes_separators(self):
        self.assertEqual(mig.clean_col("Trade TS"), "trade_ts")
        self.assertEqual(mig.clean_col("Daily P&L"), "daily_pandl")
        self.assertEqual(mig.clean_col("Win-Rate %"), "win_rate_pct")

    def test_normalize_raw_row_pads_and_stamps(self):
        rec = mig.normalize_raw_row("Trade Log", ["a", "b", "c"], ["1", "2"], row_index=3)
        self.assertEqual(rec, {
            "a": "1",
            "b": "2",
            "c": None,
            "source_row_id": "Trade Log!3",
            "source_worksheet": "Trade Log",
            "migration_loaded_at": rec["migration_loaded_at"],
        })
        self.assertTrue(rec["migration_loaded_at"].endswith("+00:00"))

    def test_to_decimal_strips_money_chars(self):
        self.assertEqual(str(mig.to_decimal("$1,234.56")), "1234.56")
        self.assertIsNone(mig.to_decimal(""))
        self.assertIsNone(mig.to_decimal("nan"))
        self.assertIsNone(mig.to_decimal("abc"))

    def test_q_quotes_and_nulls(self):
        self.assertEqual(mig.q(None), "NULL")
        self.assertEqual(mig.q(""), "NULL")
        self.assertEqual(mig.q("nan"), "NULL")
        self.assertEqual(mig.q("it's"), "'it''s'")

    def test_ts_formats_iso(self):
        self.assertEqual(mig.ts("2026-04-19 19:33:00"), "TIMESTAMP '2026-04-19 19:33:00'")
        self.assertEqual(mig.ts("2026-04-19"), "TIMESTAMP '2026-04-19 00:00:00'")
        self.assertEqual(mig.ts(""), "CURRENT_TIMESTAMP()")

    def test_full_table_backtick_quotes(self):
        self.assertEqual(
            mig.full_table("trading_prod", "quantum", "trade_log"),
            "`trading_prod`.`quantum`.`trade_log`",
        )


class IdempotencyTests(unittest.TestCase):
    def test_compute_trade_log_idempotency_is_deterministic(self):
        record = {
            "account_id": "acct_live_01",
            "strategy_id": "meanrev_v4",
            "broker_order_id": "brk_1",
            "trade_ts": "2026-04-19T19:33:00Z",
            "symbol": "AAPL",
            "side": "BUY",
            "quantity": 100,
            "avg_fill_price": 182.45,
        }
        a = mig.compute_trade_log_idempotency(record)
        b = mig.compute_trade_log_idempotency(record.copy())
        self.assertEqual(a, b)
        self.assertRegex(a, r"^[a-f0-9]{64}$")

    def test_explicit_idempotency_key_is_preserved(self):
        rec = {"idempotency_key": "sha256_pinned", "symbol": "X"}
        self.assertEqual(mig.compute_trade_log_idempotency(rec), "sha256_pinned")


class MergeStatementTests(unittest.TestCase):
    def test_trade_log_merge_targets_correct_table_and_uses_idempotency(self):
        records = [{
            "trade_id": "trd_1",
            "account_id": "acct", "strategy_id": "s",
            "trade_ts": "2026-04-19T19:33:00Z",
            "symbol": "AAPL", "side": "BUY",
            "quantity": 100, "avg_fill_price": 182.45,
        }]
        sql = mig.build_trade_log_merge("trading_prod", "quantum", records)
        self.assertIn("MERGE INTO `trading_prod`.`quantum`.`trade_log`", sql)
        self.assertIn("ON t.idempotency_key = s.idempotency_key", sql)
        self.assertIn("WHEN NOT MATCHED THEN INSERT", sql)

    def test_audit_merge_targets_audit_trail_for_non_trade_tables(self):
        records = [{"message": "hi", "account_id": "x"}]
        sql = mig.build_audit_merge("trading_prod", "quantum", records, "risk_events")
        self.assertIn("MERGE INTO `trading_prod`.`quantum`.`audit_trail`", sql)
        self.assertIn("MIGRATED_RISK_EVENTS", sql)

    def test_build_merge_statement_routes_by_table(self):
        rec = [{"trade_id": "t", "account_id": "a", "trade_ts": "2026-04-19T00:00:00Z", "symbol": "A", "side": "BUY", "quantity": 1, "avg_fill_price": 1}]
        t_sql = mig.build_merge_statement("trading_prod", "quantum", "trade_log", rec)
        a_sql = mig.build_merge_statement("trading_prod", "quantum", "risk_events", rec)
        self.assertIn("`trade_log`", t_sql)
        self.assertIn("`audit_trail`", a_sql)

    def test_empty_batch_raises(self):
        with self.assertRaises(ValueError):
            mig.build_trade_log_merge("c", "s", [])
        with self.assertRaises(ValueError):
            mig.build_audit_merge("c", "s", [], "x")


class DryRunMigrationTests(unittest.TestCase):
    def test_dry_run_produces_statements_and_executes_nothing(self):
        fake_data = {
            "Trade Log": [
                {"trade_id": "t1", "account_id": "a", "strategy_id": "s", "trade_ts": "2026-04-19T19:33:00Z", "symbol": "AAPL", "side": "BUY", "quantity": 1, "avg_fill_price": 1, "source_row_id": "Trade Log!2"},
                {"trade_id": "t2", "account_id": "a", "strategy_id": "s", "trade_ts": "2026-04-19T19:33:01Z", "symbol": "MSFT", "side": "SELL", "quantity": 2, "avg_fill_price": 3, "source_row_id": "Trade Log!3"},
            ],
            "Daily P&L": [
                {"trading_date": "2026-04-19", "account_id": "a", "source_row_id": "Daily P&L!2"},
            ],
            "Performance Metrics": [],  # empty should be skipped
        }

        def reader(ws):
            return list(fake_data.get(ws, []))

        # Only the three worksheets above are relevant for this test.
        subset_map = {
            "Trade Log": "trade_log",
            "Daily P&L": "daily_pnl",
            "Performance Metrics": "performance_metrics",
        }

        messages = []
        summary = mig.migrate(
            dry_run=True,
            worksheet_map=subset_map,
            reader=reader,
            batch_size=1,
            log=messages.append,
        )
        self.assertTrue(summary["dry_run"])
        self.assertEqual(summary["tables"], {"trade_log": 2, "daily_pnl": 1})
        # batch_size=1 -> trade_log emits 2 statements, daily_pnl 1, total 3
        self.assertEqual(len(summary["statements"]), 3)
        for stmt in summary["statements"]:
            self.assertIn("MERGE INTO", stmt["sql"])
        # Performance Metrics empty -> logged as skipped
        self.assertTrue(any("Skipping empty worksheet: Performance Metrics" in m for m in messages))

    def test_dry_run_requires_no_cursor(self):
        summary = mig.migrate(
            dry_run=True,
            worksheet_map={"Trade Log": "trade_log"},
            reader=lambda ws: [{"trade_id": "t", "account_id": "a", "strategy_id": "s", "trade_ts": "2026-04-19T00:00:00Z", "symbol": "A", "side": "BUY", "quantity": 1, "avg_fill_price": 1}],
            batch_size=100,
            log=lambda *a, **k: None,
        )
        self.assertEqual(summary["tables"], {"trade_log": 1})

    def test_live_run_without_cursor_raises(self):
        with self.assertRaises(RuntimeError):
            mig.migrate(
                dry_run=False,
                worksheet_map={"Trade Log": "trade_log"},
                reader=lambda ws: [{"trade_id": "t", "account_id": "a", "strategy_id": "s", "trade_ts": "2026-04-19T00:00:00Z", "symbol": "A", "side": "BUY", "quantity": 1, "avg_fill_price": 1}],
                batch_size=100,
                log=lambda *a, **k: None,
            )


class RetryTests(unittest.TestCase):
    def test_execute_with_retry_eventually_succeeds(self):
        calls = {"n": 0}

        class FakeCursor:
            def execute(self, sql):
                calls["n"] += 1
                if calls["n"] < 3:
                    raise RuntimeError("transient")

        # Use a deterministic RNG and short caps so the test doesn't actually sleep much.
        mig._execute_with_retry(FakeCursor(), "SELECT 1",
                                max_retries=5, base_delay=0.0, max_delay=0.0,
                                rng=random.Random(0))
        self.assertEqual(calls["n"], 3)

    def test_execute_with_retry_raises_after_budget(self):
        class AlwaysFails:
            def execute(self, sql):
                raise RuntimeError("perma")
        with self.assertRaises(RuntimeError):
            mig._execute_with_retry(AlwaysFails(), "SELECT 1",
                                    max_retries=2, base_delay=0.0, max_delay=0.0,
                                    rng=random.Random(0))


if __name__ == "__main__":
    unittest.main()
