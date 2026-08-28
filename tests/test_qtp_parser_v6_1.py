"""Regression tests for QTP v6.1 parser threshold relaxation.

Covers:
  1. Strict mode rejects below strict threshold.
  2. Strict mode passes at strict threshold.
  3. pre_market_mode accepts the RELAXED threshold.
  4. relaxed_mode accepts the RELAXED threshold.
  5. High-vol symbols (VFS, USO) accept HIGH_VOL_RELAXED threshold.
  6. Normal SCALP / BROAD_SCANNER behavior is unchanged, including the
     R3.2 hard-opposite KILL short-circuit.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir)))

from qtp_parser_v6_1 import ParserConfig, parse_signal_v6_1  # noqa: E402


def _payload(**overrides):
    base = {
        "ticker": "AAPL",
        "alert_type": "SCALP",
        "signal": "long",
        "bias": "long",
        "strat_total_trades": 150,
        "strat_profit_factor": 1.30,
    }
    base.update(overrides)
    return base


class StrictModeTests(unittest.TestCase):
    def test_strict_rejects_below_threshold(self):
        # 80 trades / pf 1.10 — clearly below strict (100 / 1.20)
        out = parse_signal_v6_1(_payload(strat_total_trades=80, strat_profit_factor=1.10))
        self.assertEqual(out["_backtest_enforcement_action"], "STRICT")
        self.assertFalse(out["_backtest_relaxed_thresholds"])
        self.assertEqual(out["_used_min_trades"], 100)
        self.assertAlmostEqual(out["_used_min_pf"], 1.20)
        self.assertFalse(out["backtest_valid"])
        self.assertEqual(out["action"], "REJECT_BACKTEST")

    def test_strict_passes_at_threshold(self):
        out = parse_signal_v6_1(_payload(strat_total_trades=100, strat_profit_factor=1.20))
        self.assertEqual(out["_backtest_enforcement_action"], "STRICT")
        self.assertFalse(out["_backtest_relaxed_thresholds"])
        self.assertEqual(out["_used_min_trades"], 100)
        self.assertAlmostEqual(out["_used_min_pf"], 1.20)
        self.assertTrue(out["backtest_valid"])
        self.assertEqual(out["action"], "PASS")


class RelaxedModeTests(unittest.TestCase):
    def test_pre_market_mode_accepts_relaxed_threshold(self):
        # 50 trades / pf 1.10 — below strict, above relaxed (40 / 1.05)
        out = parse_signal_v6_1(
            _payload(ticker="D", strat_total_trades=50, strat_profit_factor=1.10),
            pre_market_mode=True,
        )
        self.assertEqual(out["_backtest_enforcement_action"], "RELAXED")
        self.assertTrue(out["_backtest_relaxed_thresholds"])
        self.assertEqual(out["_used_min_trades"], 40)
        self.assertAlmostEqual(out["_used_min_pf"], 1.05)
        self.assertTrue(out["backtest_valid"])
        self.assertEqual(out["action"], "PASS")

    def test_relaxed_mode_accepts_relaxed_threshold(self):
        out = parse_signal_v6_1(
            _payload(ticker="DHR", strat_total_trades=40, strat_profit_factor=1.05),
            relaxed_mode=True,
        )
        self.assertEqual(out["_backtest_enforcement_action"], "RELAXED")
        self.assertTrue(out["_backtest_relaxed_thresholds"])
        self.assertEqual(out["_used_min_trades"], 40)
        self.assertAlmostEqual(out["_used_min_pf"], 1.05)
        self.assertTrue(out["backtest_valid"])
        self.assertEqual(out["action"], "PASS")


class HighVolTests(unittest.TestCase):
    def test_vfs_uso_accept_high_vol_threshold(self):
        # 30 trades / pf 0.95 — below relaxed, above high-vol (30 / 0.95)
        for sym in ("VFS", "USO"):
            with self.subTest(ticker=sym):
                out = parse_signal_v6_1(
                    _payload(ticker=sym, strat_total_trades=30, strat_profit_factor=0.95)
                )
                self.assertEqual(out["_backtest_enforcement_action"], "HIGH_VOL_RELAXED")
                self.assertTrue(out["_backtest_relaxed_thresholds"])
                self.assertEqual(out["_used_min_trades"], 30)
                self.assertAlmostEqual(out["_used_min_pf"], 0.95)
                self.assertTrue(out["backtest_valid"])
                self.assertEqual(out["action"], "PASS")

    def test_high_vol_takes_precedence_over_relaxed(self):
        # VFS with pre_market_mode=True must still see HIGH_VOL_RELAXED.
        out = parse_signal_v6_1(
            _payload(ticker="VFS", strat_total_trades=30, strat_profit_factor=0.95),
            pre_market_mode=True,
            relaxed_mode=True,
        )
        self.assertEqual(out["_backtest_enforcement_action"], "HIGH_VOL_RELAXED")
        self.assertEqual(out["_used_min_trades"], 30)
        self.assertAlmostEqual(out["_used_min_pf"], 0.95)

    def test_payload_high_vol_flag_triggers_high_vol_mode(self):
        out = parse_signal_v6_1(
            _payload(ticker="DLTR", strat_total_trades=30, strat_profit_factor=0.95, high_vol=True)
        )
        self.assertEqual(out["_backtest_enforcement_action"], "HIGH_VOL_RELAXED")


class UnchangedBehaviorTests(unittest.TestCase):
    def test_scalp_normal_path_unchanged(self):
        out = parse_signal_v6_1(_payload(strat_total_trades=200, strat_profit_factor=1.50))
        self.assertEqual(out["_backtest_enforcement_action"], "STRICT")
        self.assertFalse(out["_backtest_relaxed_thresholds"])
        self.assertTrue(out["backtest_valid"])
        self.assertEqual(out["action"], "PASS")

    def test_broad_scanner_skips_backtest_gate(self):
        # Scanner alerts have no backtest stats — must not be gated.
        out = parse_signal_v6_1(_payload(
            alert_type="BROAD_SCANNER",
            strat_total_trades=0,
            strat_profit_factor=0,
        ))
        self.assertEqual(out["_backtest_enforcement_action"], "SKIPPED_SCANNER")
        self.assertFalse(out["_backtest_relaxed_thresholds"])
        self.assertTrue(out["backtest_valid"])
        self.assertEqual(out["action"], "PASS")

    def test_r3_2_hard_opposite_kill_short_circuit(self):
        out = parse_signal_v6_1(_payload(signal="long", bias="short"))
        self.assertEqual(out["_sm_action"], "KILL")
        self.assertEqual(out["_sm_route"], "SKIP")
        self.assertEqual(out["_kill_rule"], "R3.2_HARD_OPPOSITE")
        self.assertEqual(out["action"], "KILL")
        self.assertFalse(out["backtest_valid"])


class ConfigOverrideTests(unittest.TestCase):
    def test_custom_high_vol_symbols(self):
        cfg = ParserConfig(high_vol_symbols=frozenset({"VFS", "USO", "USIO"}))
        out = parse_signal_v6_1(
            _payload(ticker="USIO", strat_total_trades=30, strat_profit_factor=0.95),
            config=cfg,
        )
        self.assertEqual(out["_backtest_enforcement_action"], "HIGH_VOL_RELAXED")


if __name__ == "__main__":
    unittest.main()
