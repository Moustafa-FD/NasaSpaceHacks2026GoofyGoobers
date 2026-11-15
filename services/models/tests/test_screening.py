import copy
import json
import math
import subprocess
import sys
import unittest
from unittest import mock

from services.models.screening import worker

SOURCE = {"evidence": "assumed", "citation": "Explicit synthetic unit-test scenario, not facility observations"}
SITE = {"id": "point", "lat": 39.0, "lon": -77.0, "prepared": False}


def request(row=None, **extra):
    return {"schemaVersion": "1.0", "kind": "environment-screening", "point": {"latitude": 39.0, "longitude": -77.0}, "site": SITE,
            "years": [{"year": 2030, **({"source": SOURCE, **row} if row else {})}], **extra}


def metrics(result):
    return {item["id"]: item for item in result["years"][0]["metrics"]}


class ScreeningTests(unittest.TestCase):
    def test_missing_inputs_are_actionable_not_invented_zero(self):
        result = worker.run(request())
        self.assertEqual(result["years"][0]["metrics"], [])
        self.assertEqual(result["inputEvidence"], "missing-inputs")
        self.assertEqual({item["domain"] for item in result["requiredInputs"]}, set(worker.REQUIRED))
        self.assertIsNone(result["spatial"])
        self.assertTrue(any(item["id"] == "crop_yield" for item in result["unavailable"]))

    def test_heat_and_air_have_hand_checked_dimensions_and_retain_nasa_footprint(self):
        footprint = {"site": SITE, "peak": {"chiOverQ": 2e-6}, "grid": {"n": 2, "values": [[0, 2e-6], [None, 1e-6]]}}
        result = worker.run(request({"heatMw": 1, "emissionRateGs": 2, "pollutant": "primary inert tracer"},
                                    dispersion={"effectiveHeightM": 20, "landUse": "urban", "airDensityKgM3": 1.2, "specificHeatJkgK": 1000, "source": SOURCE}), footprint)
        values = metrics(result)
        self.assertAlmostEqual(values["heat_peak_temperature_rise"]["value"], 2e-6 * 1e6 / 1200)
        self.assertEqual(values["air_peak_source_contribution"]["value"], 4)
        self.assertEqual(values["air_peak_source_contribution"]["unit"], "µg/m³")
        self.assertIs(result["spatial"]["dispersion"], footprint)
        self.assertEqual(footprint["grid"]["values"][1][0], None)
        self.assertEqual(result["evidence"], "screening-scenario")
        self.assertEqual(result["uncertainty"]["status"], "not_quantified")

    def test_real_zero_release_is_retained_when_transport_and_sources_are_supplied(self):
        result = worker.run(request({"heatMw": 0, "emissionRateGs": 0, "pollutant": "tracer"},
                                    dispersion={"effectiveHeightM": 20, "landUse": "urban", "airDensityKgM3": 1.2, "specificHeatJkgK": 1000, "source": SOURCE}), {"peak": {"chiOverQ": 0}})
        self.assertEqual(metrics(result)["heat_peak_temperature_rise"]["value"], 0)
        self.assertEqual(metrics(result)["air_peak_source_contribution"]["value"], 0)

    def test_water_annual_accounting_uses_leap_year_and_does_not_predict_depletion(self):
        base = request({"withdrawalM3s": 1, "returnM3s": .25})
        base["years"] = [{**base["years"][0], "year": year} for year in [2028, 2029]]
        result = worker.run(base)
        for row, days in zip(result["years"], [366, 365]):
            values = {item["id"]: item["value"] for item in row["metrics"]}
            self.assertEqual(values["water_withdrawal"], days * 86400)
            self.assertEqual(values["water_return"], days * 86400 * .25)
            self.assertEqual(values["water_balance"], days * 86400 * .75)

    def test_conservative_water_and_heat_mixing_preserve_mass_and_zero(self):
        result = worker.run(request({"riverFlowM3s": 9, "returnM3s": 1, "upstreamTempC": 10, "dischargeTempC": 30,
                                     "upstreamMgL": 2, "dischargeMgL": 12, "pollutant": "conservative test constituent"}))
        values = metrics(result)
        self.assertEqual(values["water_mixed_temperature"]["value"], 12)
        self.assertEqual(values["water_mixed_temperature_change"]["value"], 2)
        self.assertEqual(values["water_mixed_concentration"]["value"], 3)
        self.assertEqual(values["water_mixed_concentration_change"]["value"], 1)
        self.assertEqual(worker.mixing(9, 0, 1, 0), 0)
        self.assertIsNone(worker.mixing(0, 10, 0, 20))

    def test_zero_total_flow_returns_missing_mixing_but_valid_zero_accounting(self):
        result = worker.run(request({"withdrawalM3s": 0, "returnM3s": 0, "riverFlowM3s": 0, "upstreamTempC": 0, "dischargeTempC": 0}))
        self.assertEqual(metrics(result)["water_balance"]["value"], 0)
        self.assertNotIn("water_mixed_temperature", metrics(result))
        self.assertTrue(any("undefined" in item["reason"] for item in result["requiredInputs"]))

    def test_free_field_distance_doubling_and_logarithmic_background_addition(self):
        source_level = 100 - 10 * math.log10(4 * math.pi * 10 ** 2)
        result = worker.run(request({"soundPowerDbA": 100}, receptors=[{"name": "A", "distanceM": 10}, {"name": "B", "distanceM": 20}],
                                    backgroundNoise={"dbA": source_level, "source": SOURCE}))
        values = result["years"][0]["metrics"]
        levels = [item["value"] for item in values if item["id"] == "noise_source_db_a"]
        self.assertAlmostEqual(levels[0] - levels[1], 20 * math.log10(2))
        total = next(item["value"] for item in values if item.get("key") == "noise_total_db_a:0")
        self.assertAlmostEqual(total - source_level, 10 * math.log10(2))
        self.assertNotEqual(total, source_level * 2)

    def test_optional_noise_contours_are_chosen_display_levels_not_implicit_limits(self):
        result = worker.run(request({"soundPowerDbA": 100}, noiseContourLevelsDbA=[60, 50]))
        contours = result["years"][0]["noiseContours"]
        self.assertAlmostEqual(contours[0]["radiusM"], math.sqrt(10000 / (4 * math.pi)))
        self.assertAlmostEqual(contours[1]["radiusM"] / contours[0]["radiusM"], math.sqrt(10))
        outside = worker.run(request({"soundPowerDbA": 200}, noiseContourLevelsDbA=[10]))
        self.assertIsNone(outside["years"][0]["noiseContours"][0]["radiusM"])
        self.assertEqual(outside["years"][0]["noiseContours"][0]["status"], "outside-supported-distance")
        self.assertEqual(worker.run(request({"soundPowerDbA": 100}, receptors=[{"name": "A", "distanceM": 10}]))["years"][0]["noiseContours"], [])

    def test_missing_years_are_not_extrapolated_and_source_classes_remain_visible(self):
        data = request({"withdrawalM3s": 1, "returnM3s": 1})
        data["years"] += [{"year": 2032, "source": {"evidence": "reported", "citation": "Reported test record"}, "withdrawalM3s": 0, "returnM3s": 0}]
        result = worker.run(data)
        self.assertEqual([row["year"] for row in result["years"]], [2030, 2032])
        self.assertEqual(result["inputEvidence"], "contains-assumptions")
        self.assertEqual(len(result["sources"]), 2)

    def test_transport_failure_does_not_erase_independent_water_results(self):
        data = request({"emissionRateGs": 1, "pollutant": "tracer", "withdrawalM3s": 1, "returnM3s": .5},
                       dispersion={"effectiveHeightM": 20, "landUse": "urban", "source": SOURCE})
        with mock.patch.object(worker.plume, "point_frames", side_effect=worker.plume.PlumeError("No wind coverage")):
            result = worker.run(data)
        self.assertIn("water_balance", metrics(result))
        self.assertNotIn("air_peak_source_contribution", metrics(result))
        self.assertTrue(any(item["reason"] == "No wind coverage" for item in result["requiredInputs"]))

    def test_unsourced_invalid_nonfinite_and_mismatched_inputs_fail(self):
        invalid = [request({"heatMw": True}), request({"emissionRateGs": float("nan")}), request({"withdrawalM3s": 1, "returnM3s": 2}),
                   request({"soundPowerDbA": 100}, receptors=[{"name": "near field", "distanceM": 0}]), request({"soundPowerDbA": 100}, noiseContourLevelsDbA=[60, 60])]
        missing_source = request({"heatMw": 1}); del missing_source["years"][0]["source"]; invalid.append(missing_source)
        mismatch = request(); mismatch["site"] = {**SITE, "lon": -78}; invalid.append(mismatch)
        duplicate = request(); duplicate["years"] *= 2; invalid.append(duplicate)
        for item in invalid:
            with self.assertRaises(ValueError): worker.run(item)

    def test_worker_json_protocol_and_duplicate_fields(self):
        valid = subprocess.run([sys.executable, "-m", "services.models.screening.worker"], input=json.dumps(request({"withdrawalM3s": 1, "returnM3s": .5})), capture_output=True, text=True)
        self.assertEqual(valid.returncode, 0, valid.stderr)
        events = [json.loads(line) for line in valid.stdout.splitlines()]
        self.assertEqual(sum(event["type"] == "result" for event in events), 1)
        self.assertEqual(events[-1]["result"]["evidence"], "screening-scenario")
        invalid = subprocess.run([sys.executable, "-m", "services.models.screening.worker"], input='{"kind":"x","kind":"y"}', capture_output=True, text=True)
        self.assertNotEqual(invalid.returncode, 0)
        self.assertEqual(invalid.stdout, "")
        self.assertEqual(json.loads(invalid.stderr)["error"]["code"], "INVALID_SCREENING_REQUEST")


if __name__ == "__main__":
    unittest.main()
