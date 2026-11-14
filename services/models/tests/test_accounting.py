import copy
import json
import math
from pathlib import Path
import subprocess
import sys
import unittest

from services.models.accounting import ScenarioError, build_manifest


def example_request():
    return {
        "runId": "test-run",
        "scenario": {
            "schemaVersion": "1.0", "mode": "illustrative", "name": "Synthetic example",
            "region": {"id": "demo-region", "name": "Synthetic region", "bbox": [-80, 43, -79, 44]},
            "years": {"start": 2026, "end": 2026},
            "assumptions": {
                "itLoadMw": 1, "utilization": 0.5, "pue": 1.2, "annualGrowthRate": 0,
                "gridKgCo2ePerKwh": 0.2, "wueLitresPerItKwh": 0.5,
                "electricityPricePerKwh": 0.1, "currency": "USD",
            },
        },
    }


class AccountingTests(unittest.TestCase):
    def test_hand_computed_energy_emissions_water_bill(self):
        result = build_manifest(example_request())
        values = {metric["id"]: metric["series"][0]["value"] for metric in result["metrics"]}
        # 500 kW IT * 8760 h = 4,380,000 IT kWh, then PUE 1.2.
        self.assertAlmostEqual(values["facility_electricity"], 5_256_000)
        self.assertAlmostEqual(values["grid_emissions"], 1051.2)
        # WUE is per IT kWh: applying PUE again here would be wrong.
        self.assertAlmostEqual(values["cooling_water_use"], 2_190_000)
        self.assertAlmostEqual(values["facility_electricity_bill"], 525_600)

    def test_leap_year_and_compounded_growth(self):
        request = example_request()
        request["scenario"]["years"] = {"start": 2027, "end": 2028}
        request["scenario"]["assumptions"]["annualGrowthRate"] = 0.1
        series = build_manifest(request)["metrics"][0]["series"]
        self.assertEqual([point["year"] for point in series], [2027, 2028])
        self.assertAlmostEqual(series[1]["value"] / series[0]["value"], 1.1 * 366 / 365)

    def test_zero_utilization_produces_zero_without_missing_metrics(self):
        request = example_request()
        request["scenario"]["assumptions"]["utilization"] = 0
        metrics = build_manifest(request)["metrics"]
        self.assertEqual(len(metrics), 4)
        self.assertTrue(all(metric["series"][0]["value"] == 0 for metric in metrics))

    def test_no_invented_concentration_noise_or_confidence_layers(self):
        result = build_manifest(example_request())
        self.assertEqual(result["layers"], [])
        self.assertEqual(result["provenance"]["kind"], "synthetic")
        self.assertEqual({item["domain"] for item in result["unavailable"]}, {
            "air-quality", "water-quality", "water-stress", "household-bills",
            "employment", "population", "land-ecosystems", "noise",
        })
        self.assertTrue(all(metric["status"] == "illustrative" for metric in result["metrics"]))
        self.assertTrue(all(metric["uncertainty"]["status"] == "not_quantified" for metric in result["metrics"]))

    def test_reject_invalid_numeric_inputs(self):
        for bad in [True, False, math.nan, math.inf, -math.inf, "1", None, -1, 100_001, 10 ** 1000]:
            with self.subTest(value=bad):
                request = example_request()
                request["scenario"]["assumptions"]["itLoadMw"] = bad
                with self.assertRaises(ScenarioError):
                    build_manifest(request)

    def test_reject_bad_years_region_mode_and_missing_fields(self):
        invalid_scenarios = []
        for years in [{"start": True, "end": 2026}, {"start": 2026.0, "end": 2026},
                      {"start": 2050, "end": 2040}, {"start": 2000, "end": 2100},
                      {"start": 2026, "end": 2101}]:
            scenario = copy.deepcopy(example_request()["scenario"])
            scenario["years"] = years
            invalid_scenarios.append(scenario)
        for bbox in [[170, 10, -170, 20], [-80, 44, -79, 43], [-181, 43, -79, 44]]:
            scenario = copy.deepcopy(example_request()["scenario"])
            scenario["region"]["bbox"] = bbox
            invalid_scenarios.append(scenario)
        scenario = copy.deepcopy(example_request()["scenario"])
        scenario["mode"] = "validated"
        invalid_scenarios.append(scenario)
        scenario = copy.deepcopy(example_request()["scenario"])
        del scenario["assumptions"]["pue"]
        invalid_scenarios.append(scenario)
        for scenario in invalid_scenarios:
            with self.subTest(scenario=scenario), self.assertRaises(ScenarioError):
                build_manifest({"runId": "test-run", "scenario": scenario})

    def test_currency_and_unknown_fields_are_rejected(self):
        request = example_request()
        request["scenario"]["assumptions"]["currency"] = "usd"
        with self.assertRaises(ScenarioError):
            build_manifest(request)
        request = example_request()
        request["scenario"]["assumptions"]["noiseDb"] = 40
        with self.assertRaises(ScenarioError):
            build_manifest(request)

    def test_canonical_name_and_region_id_limits(self):
        request = example_request()
        request["scenario"]["name"] = "n" * 120
        request["scenario"]["region"]["name"] = "r" * 120
        request["scenario"]["region"]["id"] = "A9_-" * 20
        self.assertEqual(build_manifest(request)["scenarioName"], "n" * 120)
        for owner, key in [("scenario", "name"), ("region", "name"), ("region", "id")]:
            with self.subTest(owner=owner, key=key):
                invalid = copy.deepcopy(request)
                target = invalid["scenario"] if owner == "scenario" else invalid["scenario"]["region"]
                target[key] += "x"
                with self.assertRaises(ScenarioError):
                    build_manifest(invalid)
        for invalid_id in ["region with spaces", "region/path", "région", "region\n", ""]:
            with self.subTest(region_id=invalid_id):
                invalid = example_request()
                invalid["scenario"]["region"]["id"] = invalid_id
                with self.assertRaises(ScenarioError):
                    build_manifest(invalid)

    def test_whitespace_only_names_are_rejected(self):
        for field in ["scenario", "region"]:
            with self.subTest(field=field):
                request = example_request()
                target = request["scenario"] if field == "scenario" else request["scenario"]["region"]
                target["name"] = " \t\n"
                with self.assertRaises(ScenarioError):
                    build_manifest(request)


class WorkerProtocolTests(unittest.TestCase):
    def run_worker(self, payload):
        worker = Path(__file__).resolve().parents[1] / "worker.py"
        return subprocess.run([sys.executable, str(worker)], input=payload, text=True, encoding="utf-8",
                              capture_output=True, timeout=10, check=False)

    def test_one_json_request_one_json_result(self):
        result = self.run_worker(json.dumps(example_request()))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, "")
        self.assertEqual(len(result.stdout.splitlines()), 1)
        self.assertEqual(json.loads(result.stdout)["runId"], "test-run")

    def test_worker_preserves_utf8_names_independent_of_windows_locale(self):
        request = example_request()
        request["scenario"]["name"] = "Québec / 東京"
        request["scenario"]["region"]["name"] = "Montréal"
        result = self.run_worker(json.dumps(request, ensure_ascii=False))
        self.assertEqual(result.returncode, 0, result.stderr)
        manifest = json.loads(result.stdout)
        self.assertEqual(manifest["scenarioName"], request["scenario"]["name"])
        self.assertEqual(manifest["region"]["name"], request["scenario"]["region"]["name"])

    def test_bad_json_and_duplicate_keys_fail_without_stdout(self):
        for payload in ["{", '{"runId":"one","runId":"two","scenario":{}}',
                        json.dumps(example_request()).replace('"itLoadMw": 1', '"itLoadMw": NaN')]:
            with self.subTest(payload=payload):
                result = self.run_worker(payload)
                self.assertEqual(result.returncode, 1)
                self.assertEqual(result.stdout, "")
                self.assertEqual(json.loads(result.stderr)["error"]["code"], "INVALID_SCENARIO")


if __name__ == "__main__":
    unittest.main()
