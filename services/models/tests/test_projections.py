import math
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

from services.models.projections import build, nexgddp, plume

CATALOG = """<catalog>
<catalogRef xlink:href="r1i1p1f2/catalog.xml" xlink:title="r1i1p1f2" />
<dataset name="tas_day_UKESM1-0-LL_ssp585_r1i1p1f2_gn_2050.nc" />
<dataset name="tas_day_UKESM1-0-LL_ssp585_r1i1p1f2_gn_2050_v1.1.nc" />
<dataset name="tas_day_UKESM1-0-LL_ssp585_r1i1p1f2_gn_2050_v2.0.nc" />
<dataset name="tas_day_UKESM1-0-LL_ssp585_r1i1p1f2_gn_2051_v2.0.nc" />
</catalog>"""


def csv_days(n, value, var="tas"):
    rows = [f'time,station,latitude[unit="degrees_north"],longitude[unit="degrees_east"],{var}[unit="K"]']
    rows += [f"2050-01-{(d % 28) + 1:02d}T12:00:00Z,GP,39.125,-77.375,{value}" for d in range(n)]
    return "\n".join(rows) + "\n"


class NexGddpTests(unittest.TestCase):
    def test_sampled_years_are_inside_windows(self):
        self.assertEqual(nexgddp.sampled_years((1995, 2014), 4), [1997, 2002, 2007, 2012])
        self.assertEqual(nexgddp.sampled_years((2081, 2100), 1), [2091])

    def test_catalog_parsing_picks_newest_version(self):
        with mock.patch.object(nexgddp, "_get", side_effect=[CATALOG, CATALOG]):
            files = nexgddp.list_files("UKESM1-0-LL", "ssp585", "tas")
        self.assertEqual(files[2050].name, "tas_day_UKESM1-0-LL_ssp585_r1i1p1f2_gn_2050_v2.0.nc")
        self.assertEqual(files[2050].variant, "r1i1p1f2")
        self.assertIn("temporal=all", nexgddp.point_url(files[2050], 39.03, -77.47))
        self.assertIn("longitude=282.5300", nexgddp.point_url(files[2050], 39.03, -77.47))

    def test_single_time_step_responses_are_rejected(self):
        # Regression: without temporal=all NCSS returns one day, which silently produced winter-only "annual" means.
        with self.assertRaises(nexgddp.ProjectionError):
            nexgddp.parse_point_csv(csv_days(1, 280.0), "tas")
        values, point = nexgddp.parse_point_csv(csv_days(360, 290.0), "tas")
        self.assertEqual(len(values), 360)
        self.assertEqual(point, (39.125, -77.375))

    def test_annual_metrics_normalise_calendars(self):
        tas = nexgddp.annual_metric("tas", [293.15] * 365)
        self.assertAlmostEqual(tas["meanTempC"], 20.0)
        hot360 = nexgddp.annual_metric("tasmax", [310.0] * 36 + [300.0] * 324)       # 10% of a 360-day year
        hot365 = nexgddp.annual_metric("tasmax", [310.0] * 36 + [300.0] * 329)
        self.assertAlmostEqual(hot360["hotDays35C"], 36.525)
        self.assertAlmostEqual(hot365["hotDays35C"], 36 * 365.25 / 365)
        pr = nexgddp.annual_metric("pr", [1.0 / 86400] * 360)                      # 1 mm/day
        self.assertAlmostEqual(pr["precipMmPerYear"], 365.25)
        self.assertIsNone(nexgddp.annual_metric("tas", [None] * 40 + [290.0] * 320))

    def test_summary_uses_per_model_deltas_and_spread(self):
        models, scenarios = ("A", "B"), ("ssp245",)
        results = {}
        for model, base, warm in (("A", 10.0, 12.0), ("B", 14.0, 15.0)):
            results[(model, "historical", "tas", "historical")] = [base]
            for window in ("mid", "late"):
                results[(model, "ssp245", "tas", window)] = [warm]
        out = build.summarise({"id": "x", "lat": 1, "lon": 2}, results, models, scenarios, 1, {(1.0, 2.0)})
        late = out["metrics"]["meanTempC"]["ssp245_2081_2100"]["changeFromHistorical"]
        self.assertEqual((late["min"], late["max"], late["models"]), (1.0, 2.0, 2))
        self.assertEqual(out["evidence"], "climate-scenario")


class PlumeTests(unittest.TestCase):
    def test_centerline_matches_analytic_ground_source(self):
        sy, sz = plume._RURAL["D"][0](1000), plume._RURAL["D"][1](1000)
        self.assertAlmostEqual(plume.chi_over_q(1000, 0, 5, 0, "D", "rural"), 1 / (math.pi * 5 * sy * sz))
        self.assertLess(plume.chi_over_q(1000, 0, 5, 50, "D", "rural"), plume.chi_over_q(1000, 0, 5, 0, "D", "rural"))
        self.assertEqual(plume.chi_over_q(50, 0, 5, 0, "D", "rural"), 0.0)          # inside the 100 m validity limit

    def test_crosswind_integral_conserves_mass(self):
        x, u, h = 2000.0, 4.0, 30.0
        sy, sz = plume._URBAN["C"][0](x), plume._URBAN["C"][1](x)
        integral = sum(plume.chi_over_q(x, y, u, h, "C", "urban") for y in range(-5000, 5001)) * 1.0
        expected = 2 * math.exp(-h * h / (2 * sz * sz)) / (math.sqrt(2 * math.pi) * u * sz)
        self.assertAlmostEqual(integral / expected, 1.0, places=4)

    def test_footprint_points_downwind_and_counts_calms(self):
        t = datetime(2025, 6, 1, 18, tzinfo=timezone.utc)
        frames = [plume.Frame(t, 4.0, 0.0)] * 9 + [plume.Frame(t, 0.1, 0.0)]       # toward east, plus one calm
        receptors = [{"name": "east", "lat": 35.0, "lon": 35.0 / 35 * 0 + 0.0275}, {"name": "west", "lat": 35.0, "lon": -0.0275}]
        out = plume.footprint(35.0, 0.0, frames, height_m=10, land_use="rural", half_width_m=4000, cell_m=200, receptors=receptors)
        self.assertEqual((out["frames"]["used"], out["frames"]["calm"]), (9, 1))
        self.assertEqual(out["peak"]["bearingDeg"], 90)
        east, west = out["receptors"]
        self.assertGreater(east["chiOverQ"], 0)
        self.assertEqual(west["chiOverQ"], 0)

    def test_stability_and_sun(self):
        self.assertGreater(plume.solar_elevation_deg(datetime(2025, 6, 21, 18, tzinfo=timezone.utc), 35, -90), 50)
        self.assertLess(plume.solar_elevation_deg(datetime(2025, 6, 21, 6, tzinfo=timezone.utc), 35, -90), 0)
        self.assertEqual(plume.stability_class(1.0, True), "B")
        self.assertEqual(plume.stability_class(1.0, False), "E")
        self.assertEqual(plume.stability_class(8.0, False), "D")

    def test_concentration_requires_sourced_emission(self):
        site = {"id": "colossus1", "lat": 35.0601, "lon": -90.1564}
        frames = [plume.Frame(datetime(2025, 1, 1, tzinfo=timezone.utc), 3.0, 1.0)] * 3
        with self.assertRaises(plume.PlumeError):
            plume.scenario(site, height_m=20, emission_rate_gs=1.0, frames=frames)
        out = plume.scenario(site, height_m=20, emission_rate_gs=2.0, emission_source="stated test assumption", frames=frames)
        self.assertAlmostEqual(out["peak"]["concentrationUgM3"], out["peak"]["chiOverQ"] * 2e6)
        self.assertEqual(out["evidence"], "scenario")


@unittest.skipUnless((plume.FIELDS_DIR / "colossus1").is_dir(), "flow fields not built")
class CommittedPlumeTests(unittest.TestCase):
    def test_colossus1_uses_real_wind_frames(self):
        frames = plume.load_site_frames("colossus1")
        self.assertGreaterEqual(len(frames), 100)
        self.assertTrue(all(math.isfinite(f.u) and math.isfinite(f.v) for f in frames))


if __name__ == "__main__":
    unittest.main()


@unittest.skipUnless((plume.FIELDS_DIR / "abilene").is_dir(), "flow fields not built")
class PreparedBoxTests(unittest.TestCase):
    def test_points_inside_a_prepared_box_reuse_stored_winds(self):
        import json
        boxed = plume.prepared_box_frames(32.5029, -99.7834)
        self.assertIsNotNone(boxed)
        frames, box = boxed
        self.assertEqual(box, "abilene")
        self.assertGreaterEqual(len(frames), 100)
        exact = {r["time"]: (r["u"], r["v"]) for r in json.loads((plume.FIELDS_DIR / "abilene" / "2025.json").read_text())["siteSeries"]}
        compared = [(f, exact[f.time.strftime("%Y-%m-%dT%H:%MZ")]) for f in frames if f.time.strftime("%Y-%m-%dT%H:%MZ") in exact]
        self.assertEqual(len(compared), 12)
        for frame, (u, v) in compared:                      # 8-bit atlas: within one quantization step
            self.assertLess(abs(frame.u - u), 0.32)
            self.assertLess(abs(frame.v - v), 0.32)

    def test_points_outside_every_box_need_a_download(self):
        self.assertIsNone(plume.prepared_box_frames(10.0, 10.0))
