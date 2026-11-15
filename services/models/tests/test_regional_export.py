import json
import tempfile
import unittest
from pathlib import Path

from services.models.trends import export_web as export


class RegionalExportTests(unittest.TestCase):
    def test_precipitation_total_uses_calendar_days_and_requires_all_months(self):
        definition = export.POWER_VARIABLES[0]
        monthly = [{"date": f"2024-{m:02d}", "value": 1} for m in range(1, 13)]
        self.assertEqual(export.annual_rows(monthly, definition)[0]["value"], 366)
        monthly[3]["value"] = None
        result = export.annual_rows(monthly, definition)[0]
        self.assertIsNone(result["value"])
        self.assertEqual(result["validMonths"], 11)
        for p in monthly:
            p["value"] = 0
        self.assertEqual(export.annual_rows(monthly, definition)[0]["value"], 0)

    def test_power_units_and_duplicate_dates_are_checked(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "power.json"
            path.write_text("{}")
            data = {"units": {"PRECTOTCORR": "mm/hour"}, "rows": []}
            with self.assertRaisesRegex(ValueError, "Unexpected POWER unit"):
                export.power_variable(path, data, {"id": "test", "lat": 39, "lon": -77}, export.POWER_VARIABLES[0])
            data = {"units": {"PRECTOTCORR": "mm/day"}, "rows": [{"year": 2024, "month": 1, "PRECTOTCORR": 0}] * 2}
            with self.assertRaisesRegex(ValueError, "duplicate"):
                export.power_variable(path, data, {"id": "test", "lat": 39, "lon": -77}, export.POWER_VARIABLES[0])

    def test_giovanni_import_validates_location_variable_and_keeps_fill_values(self):
        definition = export.GIOVANNI_VARIABLES[0]
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "g.csv"
            path.write_text("Fill Value:,-9999\ntime,mean_GPM_3IMERGM_07_precipitation\n2024-01-01,0\n2024-02-01,-9999\n2024-03-01,1\n")
            prov = {"site": "test", "variable": definition["parameter"], "collection": "GPM_3IMERGM", "version": "07", "bbox": [-78, 38, -76, 40], "token": "not-public", "signedUrl": "https://example.com/private"}
            path.with_suffix(".provenance.json").write_text(json.dumps(prov))
            item = export.giovanni_variable(path, {"id": "test", "lat": 39, "lon": -77}, definition)
            self.assertEqual([p["value"] for p in item["monthly"]], [0, None, 1])
            self.assertIsNone(item["annual"][0]["value"])
            self.assertNotIn("token", item["provenance"])
            self.assertNotIn("signedUrl", item["provenance"])
            prov["bbox"] = [0, 0, 1, 1]
            path.with_suffix(".provenance.json").write_text(json.dumps(prov))
            with self.assertRaisesRegex(ValueError, "bbox"):
                export.giovanni_variable(path, {"id": "test", "lat": 39, "lon": -77}, definition)
            prov["bbox"] = [-78, 38, -76, 40]
            prov["version"] = "wrong"
            path.with_suffix(".provenance.json").write_text(json.dumps(prov))
            with self.assertRaisesRegex(ValueError, "collection/version"):
                export.giovanni_variable(path, {"id": "test", "lat": 39, "lon": -77}, definition)

    def test_groundwater_requires_native_unit_and_never_assumes_mm_from_percentile(self):
        definition = export.GIOVANNI_VARIABLES[3]
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "g.csv"
            path.write_text(f"time,mean_{definition['parameter']}\n2024-01-01,0\n2024-01-08,20\n")
            prov = {"site": "test", "variable": definition["parameter"], "collection": definition["collection"], "version": definition["version"], "bbox": [-78, 38, -76, 40]}
            provenance_path = path.with_suffix(".provenance.json")
            provenance_path.write_text(json.dumps(prov))
            with self.assertRaisesRegex(ValueError, "Groundwater units"):
                export.giovanni_variable(path, {"id": "test", "lat": 39, "lon": -77}, definition)
            prov["unit"] = "percent"
            provenance_path.write_text(json.dumps(prov))
            item = export.giovanni_variable(path, {"id": "test", "lat": 39, "lon": -77}, definition)
            self.assertEqual(item["unit"], "percent")
            self.assertIn("percentile", item["label"])
            self.assertEqual(item["monthly"][0]["value"], 10)


if __name__ == "__main__":
    unittest.main()
