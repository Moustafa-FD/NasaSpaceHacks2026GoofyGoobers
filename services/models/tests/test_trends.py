import json
import math
from pathlib import Path
import random
import subprocess
import sys
import tempfile
import unittest
from datetime import date

from services.models.trends import analysis, catalog, series, stats
from services.models.trends.make_synthetic import synthetic_monthly, write_csv

ROOT = Path(__file__).resolve().parents[3]

try:  # Optional cross-checks; CI runs without scipy.
    import scipy.stats as scipy_stats
except ImportError:  # pragma: no cover
    scipy_stats = None


def monthly_from_rows(rows):
    return [series.MonthlyValue(int(d[:4]), int(d[5:7]), v) for d, v in rows]


class DistributionTests(unittest.TestCase):
    def test_student_t_reference_values(self):
        self.assertAlmostEqual(stats.t_two_sided_p(2.0, 10), 0.07338803477074037, places=12)
        self.assertAlmostEqual(stats.t_critical(0.05, 10), 2.2281388519862744, places=9)
        self.assertAlmostEqual(stats.t_two_sided_p(1.0, 1), 0.5, places=12)
        self.assertEqual(stats.t_two_sided_p(0.0, 5), 1.0)

    def test_incomplete_beta_symmetry(self):
        for a, b, x in [(2.5, 0.5, 0.3), (10, 3, 0.8), (0.7, 4, 0.05)]:
            left = stats.regularized_incomplete_beta(a, b, x)
            right = 1 - stats.regularized_incomplete_beta(b, a, 1 - x)
            self.assertAlmostEqual(left, right, places=12)


class LinearTrendTests(unittest.TestCase):
    def test_hand_computed_ols(self):
        result = stats.linear_trend([0, 1, 2, 3, 4], [1, 3, 2, 5, 4], adjust_autocorrelation=False)
        self.assertAlmostEqual(result.slope, 0.8)
        self.assertAlmostEqual(result.intercept, 1.4)
        self.assertAlmostEqual(result.standard_error, math.sqrt(0.12))
        self.assertAlmostEqual(result.p_value, 0.10408803866182778, places=10)
        self.assertEqual(result.degrees_of_freedom, 3)

    def test_autocorrelation_widens_uncertainty(self):
        rng = random.Random(4)
        values, previous = [], 0.0
        for i in range(120):
            previous = 0.8 * previous + rng.gauss(0, 1)
            values.append(0.01 * i + previous)
        times = list(range(120))
        plain = stats.linear_trend(times, values, adjust_autocorrelation=False)
        adjusted = stats.linear_trend(times, values, adjust_autocorrelation=True)
        self.assertTrue(adjusted.autocorrelation_adjusted)
        self.assertLess(adjusted.effective_n, 120)
        self.assertGreater(adjusted.standard_error, plain.standard_error)
        self.assertGreater(adjusted.p_value, plain.p_value)

    def test_rejects_bad_input(self):
        with self.assertRaises(stats.TrendInputError):
            stats.linear_trend([1, 1, 1], [1, 2, 3])
        with self.assertRaises(stats.TrendInputError):
            stats.linear_trend([1, 2, 3], [1, float("nan"), 3])
        with self.assertRaises(stats.TrendInputError):
            stats.linear_trend([1, 2], [1, 2])


class MannKendallSenTests(unittest.TestCase):
    def test_hand_computed_mann_kendall(self):
        result = stats.mann_kendall([1, 2, 3, 4, 5], [1, 2, 3, 4, 5])
        self.assertEqual(result.s, 10)
        self.assertAlmostEqual(result.var_s, 5 * 4 * 15 / 18)
        self.assertAlmostEqual(result.z, 9 / math.sqrt(5 * 4 * 15 / 18))
        self.assertAlmostEqual(result.tau, 1.0)
        self.assertAlmostEqual(result.p_value, 0.02748, places=4)

    def test_tie_correction(self):
        result = stats.mann_kendall([1, 2, 3], [1, 1, 2])
        self.assertEqual(result.s, 2)
        self.assertAlmostEqual(result.var_s, (66 - 18) / 18)

    def test_order_follows_time_not_input_order(self):
        forward = stats.mann_kendall([1, 2, 3, 4], [1, 2, 3, 4])
        shuffled = stats.mann_kendall([3, 1, 4, 2], [3, 1, 4, 2])
        self.assertEqual(forward.s, shuffled.s)

    def test_hand_computed_sen_slope(self):
        result = stats.sens_slope([0, 1, 2, 3, 4], [1, 3, 2, 5, 4])
        self.assertAlmostEqual(result.slope, 0.875)
        self.assertAlmostEqual(result.intercept, 1.25)
        self.assertEqual((result.ci_low, result.ci_high), (-1.0, 3.0))

    def test_sen_slope_uses_uneven_times(self):
        result = stats.sens_slope([0, 1, 5], [0, 2, 10])
        self.assertAlmostEqual(result.slope, 2.0)

    def test_hamed_rao_inflates_variance_for_persistent_series(self):
        rng = random.Random(9)
        values, previous = [], 0.0
        for _ in range(80):
            previous = 0.9 * previous + rng.gauss(0, 1)
            values.append(previous)
        times = list(range(80))
        original = stats.mann_kendall(times, values)
        corrected = stats.mann_kendall(times, values, hamed_rao=True)
        self.assertEqual(corrected.variant, "hamed_rao")
        self.assertGreater(corrected.variance_correction_factor, 1.0)
        self.assertGreater(corrected.p_value, original.p_value)

    def test_hamed_rao_never_narrows_uncertainty(self):
        values = [1 if i % 2 else -1 for i in range(40)]  # strongly alternating: negative lag-1 autocorrelation
        values = [v + 0.01 * i for i, v in enumerate(values)]
        times = list(range(40))
        original = stats.mann_kendall(times, values)
        corrected = stats.mann_kendall(times, values, hamed_rao=True)
        self.assertEqual(corrected.variance_correction_factor, 1.0)
        self.assertAlmostEqual(corrected.var_s, original.var_s)

    def test_seasonal_single_season_matches_plain(self):
        pairs = [(2000 + i, v) for i, v in enumerate([3, 1, 4, 1, 5, 9, 2, 6])]
        seasonal, _ = stats.seasonal_mann_kendall([pairs])
        plain = stats.mann_kendall([p[0] for p in pairs], [p[1] for p in pairs])
        self.assertEqual(seasonal.s, plain.s)
        self.assertAlmostEqual(seasonal.var_s, plain.var_s)

    def test_seasonal_recovers_noise_free_trend(self):
        monthly = monthly_from_rows(synthetic_monthly(2000, 15, 0.05, seed=1, noise=0.0))
        result = analysis.analyze_monthly(monthly)
        self.assertAlmostEqual(result["sen"]["slopePerDecade"], 0.5, places=9)
        self.assertEqual(result["direction"], "increasing")

    def test_false_positive_rate_is_near_alpha_for_trendless_series(self):
        # Seasonal cycle plus noise, no trend: about 5% of series should be flagged at alpha 0.05.
        flagged = 0
        trials = 120
        for seed in range(trials):
            monthly = monthly_from_rows(synthetic_monthly(2000, 15, 0.0, seed=seed, noise=0.3))
            flagged += analysis.analyze_monthly(monthly)["mannKendall"]["significant"]
        self.assertLess(flagged / trials, 0.12)

    def test_benjamini_hochberg(self):
        self.assertEqual(stats.benjamini_hochberg([0.01, 0.04, 0.03, 0.005]),
                         [0.02, 0.04, 0.04, 0.02])


@unittest.skipIf(scipy_stats is None, "scipy not installed; optional cross-check")
class ScipyCrossChecks(unittest.TestCase):
    def setUp(self):
        rng = random.Random(42)
        self.times = [2000 + i / 12 for i in range(150)]
        self.values = [0.03 * t + rng.gauss(0, 1) for t in self.times]

    def test_ols_matches_linregress(self):
        ours = stats.linear_trend(self.times, self.values, adjust_autocorrelation=False)
        ref = scipy_stats.linregress(self.times, self.values)
        self.assertAlmostEqual(ours.slope, ref.slope, places=10)
        self.assertAlmostEqual(ours.standard_error, ref.stderr, places=10)
        self.assertAlmostEqual(ours.p_value, ref.pvalue, places=10)

    def test_sen_matches_theilslopes(self):
        ours = stats.sens_slope(self.times, self.values)
        ref = scipy_stats.theilslopes(self.values, self.times, 0.95)
        self.assertAlmostEqual(ours.slope, ref[0], places=10)
        self.assertAlmostEqual(ours.ci_low, ref[2], places=10)
        self.assertAlmostEqual(ours.ci_high, ref[3], places=10)

    def test_tau_matches_kendalltau(self):
        ours = stats.mann_kendall(self.times, self.values)
        ref = scipy_stats.kendalltau(self.times, self.values)
        self.assertAlmostEqual(ours.tau, ref.statistic, places=10)

    def test_t_distribution_matches(self):
        for t, df in [(0.3, 2.5), (1.7, 7), (4.2, 33.3), (12, 200)]:
            self.assertAlmostEqual(stats.t_two_sided_p(t, df), 2 * scipy_stats.t.sf(t, df), places=12)


class SeriesTests(unittest.TestCase):
    def write(self, text):
        handle = tempfile.NamedTemporaryFile("w", suffix=".csv", delete=False, encoding="utf-8")
        handle.write(text)
        handle.close()
        self.addCleanup(Path(handle.name).unlink)
        return handle.name

    def test_reads_preamble_fill_values_and_missing(self):
        path = self.write("Title:,Example\nFill Value (mean_x):,-9999\n\ntime,mean_x\n"
                          "2001-02-01,2.5\n2001-01-01,-9999\n2001-03-01,NaN\n2001-04-01,\n")
        data = series.read_time_series_csv(path)
        self.assertEqual(data.value_column, "mean_x")
        self.assertEqual(data.metadata["Title"], "Example")
        self.assertEqual([o.day for o in data.observations],
                         [date(2001, 1, 1), date(2001, 2, 1), date(2001, 3, 1), date(2001, 4, 1)])
        self.assertEqual([o.value for o in data.observations], [None, 2.5, None, None])

    def test_rejects_duplicates_and_missing_header(self):
        with self.assertRaises(series.SeriesError):
            series.read_time_series_csv(self.write("time,x\n2001-01-01,1\n2001-01-01,2\n"))
        with self.assertRaises(series.SeriesError):
            series.read_time_series_csv(self.write("a,b\n1,2\n"))
        with self.assertRaises(series.SeriesError):
            series.read_time_series_csv(self.write("time,x,y\n2001-01-01,1,2\n"))

    def test_monthly_grid_keeps_gaps_as_none(self):
        obs = [series.Observation(date(2001, 1, d), float(d)) for d in (1, 2, 3)]
        obs += [series.Observation(date(2001, 3, 5), None), series.Observation(date(2001, 4, 1), 7.0)]
        monthly = series.to_monthly(obs, min_count=2)
        self.assertEqual([(m.month, m.value) for m in monthly],
                         [(1, 2.0), (2, None), (3, None), (4, None)])

    def test_deseasonalized_annual_is_not_biased_by_missing_month(self):
        cycle = [-10, -8, -4, 0, 4, 8, 10, 8, 4, 0, -4, -8]
        monthly = [series.MonthlyValue(y, m, 20.0 + cycle[m - 1]) for y in (2000, 2001) for m in range(1, 13)]
        monthly[0] = series.MonthlyValue(2000, 1, None)  # drop a cold month
        fixed = series.to_annual(monthly, min_months=10)
        plain = series.to_annual(monthly, min_months=10, deseasonalize=False)
        self.assertAlmostEqual(fixed[0].value, fixed[1].value)
        self.assertGreater(plain[0].value, plain[1].value)

    def test_anomalies_and_difference(self):
        monthly = [series.MonthlyValue(y, 1, v) for y, v in ((2000, 1.0), (2001, 3.0))]
        self.assertEqual([a.value for a in series.monthly_anomalies(monthly)], [-1.0, 1.0])
        control = [series.MonthlyValue(2000, 1, 0.5), series.MonthlyValue(2001, 1, None)]
        self.assertEqual([d.value for d in series.difference(monthly, control)], [0.5, None])


class AnalysisTests(unittest.TestCase):
    def test_short_record_reports_insufficient_data(self):
        monthly = monthly_from_rows(synthetic_monthly(2015, 5, 0.1, seed=3))
        result = analysis.analyze_monthly(monthly, min_years=10)
        self.assertEqual(result["status"], "insufficient_data")
        self.assertNotIn("sen", result)
        self.assertTrue(result["reasons"])

    def test_too_much_missing_reports_insufficient_data(self):
        rows = synthetic_monthly(2000, 15, 0.1, seed=3, missing_every=2)
        result = analysis.analyze_monthly(monthly_from_rows(rows))
        self.assertEqual(result["status"], "insufficient_data")

    def test_report_is_strict_json(self):
        monthly = monthly_from_rows(synthetic_monthly(2000, 15, 0.05, seed=5, missing_every=29))
        for report in (analysis.analyze_monthly(monthly),
                       analysis.analyze_annual(series.to_annual(monthly)),
                       analysis.compare_regions(monthly, monthly_from_rows(
                           synthetic_monthly(2000, 15, 0.0, seed=6)))):
            json.dumps(report, allow_nan=False)

    def test_annual_trend_detected(self):
        monthly = monthly_from_rows(synthetic_monthly(2000, 20, 0.05, seed=7, missing_every=31))
        result = analysis.analyze_annual(series.to_annual(monthly), units="K")
        self.assertEqual(result["direction"], "increasing")
        low, high = result["sen"]["ciPerDecade"]
        self.assertLess(low, 0.5)
        self.assertGreater(high, 0.5)

    def test_identical_regions_have_no_difference_trend(self):
        monthly = monthly_from_rows(synthetic_monthly(2000, 15, 0.05, seed=8))
        result = analysis.compare_regions(monthly, monthly)
        self.assertEqual(result["target"]["direction"], "increasing")
        self.assertEqual(result["difference"]["direction"], "no significant trend")


class CatalogTests(unittest.TestCase):
    def test_catalog_is_valid_and_honest(self):
        entries = catalog.load_catalog()
        candidates = [e for e in entries if e["status"] == "candidate"]
        self.assertGreaterEqual(len(candidates), 8)
        for entry in candidates:
            self.assertTrue(entry["caveats"], entry["id"])
            self.assertFalse(entry["checked"], "flip only after verifying against Earthdata")
        unavailable = {e["id"] for e in entries if e["status"] == "unavailable"}
        self.assertIn("environmental-noise", unavailable)


class CliTests(unittest.TestCase):
    def run_cli(self, *args):
        return subprocess.run([sys.executable, "-m", "services.models.trends.cli", *args], cwd=ROOT,
                              capture_output=True, text=True, encoding="utf-8", timeout=60)

    def test_json_report_from_csv(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "series.csv"
            write_csv(path, "test", synthetic_monthly(2000, 12, 0.05, seed=10, missing_every=40), "mean_x")
            completed = self.run_cli(str(path), "--json", "--units", "K")
        self.assertEqual(completed.returncode, 0, completed.stderr)
        report = json.loads(completed.stdout)
        self.assertEqual(report["status"], "ok")
        self.assertEqual(report["missing"]["missing"], 3)

    def test_bad_input_reports_error_on_stderr(self):
        completed = self.run_cli(str(ROOT / "does-not-exist.csv"))
        self.assertEqual(completed.returncode, 1)
        self.assertEqual(completed.stdout, "")
        self.assertEqual(json.loads(completed.stderr)["error"]["code"], "TREND_INPUT")


if __name__ == "__main__":
    unittest.main()
