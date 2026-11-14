import json
import math
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from services.models.fields import build, geosfp, opendap
from services.models.fields.product import (FlowField, Frame, WIND_RANGE, bilinear, decode, encode, frame_indices,
                                            read_png_rgb, toward_deg, write_png_rgb)

SAMPLE = """u10m, [2][3][2]
[0][0], -1.5581582, -0.85503316
[0][1], -1.5659707, -1.7456582
[0][2], -1.0112832, -1.4097207

[1][0], -1.9017336, -1.0931399
[1][1], -1.2103274, -1.5579836
[1][2], -0.24938989, -1.2767336


time, [2]
739915.0, 739915.125
lat, [3]
38.5, 39.0, 39.5
lon, [2]
-77.5, -76.875
v10m, [2][3][2]
[0][0], 1, 2
[0][1], 3, 4
[0][2], 5, 6

[1][0], 7, 8
[1][1], 9, 10
[1][2], 11, 12
time, [2]
739915.0, 739915.125
lat, [3]
38.5, 39.0, 39.5
lon, [2]
-77.5, -76.875
"""


class OpendapParserTests(unittest.TestCase):
    def test_parses_multi_variable_response(self):
        arrays = opendap.parse_ascii(SAMPLE)
        self.assertEqual(arrays["u10m"].shape, (2, 3, 2))
        self.assertAlmostEqual(arrays["u10m"].values[0], -1.5581582)
        self.assertAlmostEqual(arrays["u10m"].values[-1], -1.2767336)
        self.assertEqual(arrays["v10m"].values, [float(i) for i in range(1, 13)])
        self.assertEqual(arrays["lat"].values, [38.5, 39.0, 39.5])

    def test_rejects_html_and_truncated_data(self):
        with self.assertRaises(opendap.OpendapError):
            opendap.parse_ascii("<html><body><h1>504 Gateway Time-out</h1></body></html>")
        with self.assertRaises(opendap.OpendapError):
            opendap.parse_ascii("u10m, [1][2][2]\n[0][0], 1, 2\n")

    def test_constraint_format(self):
        self.assertEqual(opendap.constraint("u10m", (5, 1, 5), (0, 8, 720)), "u10m[5:1:5][0:8:720]")


class GeosFpGridTests(unittest.TestCase):
    def test_time_index_round_trip(self):
        moment = datetime(2025, 7, 17, 15, tzinfo=timezone.utc)
        self.assertEqual(geosfp.time_for(geosfp.index_for(moment)), moment)
        self.assertEqual(geosfp.index_for(geosfp.START), 0)

    def test_parses_grads_time(self):
        self.assertEqual(geosfp.parse_grads_time("09z14nov2026"), datetime(2026, 11, 14, 9, tzinfo=timezone.utc))
        self.assertEqual(geosfp.parse_grads_time("00z01dec2017"), geosfp.START)

    def test_box_window_covers_point(self):
        window = geosfp.box_window(39.03, -77.47, 3.0, 4.0)
        lats, lons = window.lats(), window.lons()
        self.assertLessEqual(lats[0], 36.03)
        self.assertGreaterEqual(lats[-1], 42.03)
        self.assertLessEqual(lons[0], -81.47)
        self.assertGreaterEqual(lons[-1], -73.47)
        self.assertAlmostEqual(lats[1] - lats[0], geosfp.DLAT)

    def test_global_window_is_whole_globe(self):
        window = geosfp.global_window(8)
        self.assertEqual((window.ny, window.nx), (91, 144))
        self.assertEqual(window.lats()[0], -90.0)
        self.assertEqual(window.lats()[-1], 90.0)
        self.assertEqual(window.lons()[-1], 177.5)


class ScheduleTests(unittest.TestCase):
    def test_twelve_frames_spread_through_year_with_rotating_hours(self):
        indices = frame_indices(2024, 12, geosfp.index_for, 0, 10**9)
        times = [geosfp.time_for(i) for i in indices]
        self.assertEqual(len(times), 12)
        self.assertEqual([t.month for t in times], list(range(1, 13)))
        self.assertGreater(len({t.hour for t in times}), 4)

    def test_partial_year_drops_future_frames(self):
        latest = geosfp.index_for(datetime(2026, 6, 1, tzinfo=timezone.utc))
        indices = frame_indices(2026, 12, geosfp.index_for, 0, latest)
        self.assertEqual(len(indices), 5)
        self.assertTrue(all(i <= latest for i in indices))


class EncodingTests(unittest.TestCase):
    def test_encode_decode_within_half_step(self):
        lo, hi = WIND_RANGE
        step = (hi - lo) / 255
        for value in (-40, -12.34, 0, 3.3, 39.9):
            self.assertLessEqual(abs(decode(encode(value, lo, hi), lo, hi) - value), step / 2 + 1e-9)
        self.assertEqual(encode(99, lo, hi), 255)
        self.assertEqual(encode(None, lo, hi), 128)

    def test_png_round_trip(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "t.png"
            pixels = bytes(range(2 * 3 * 3))
            write_png_rgb(path, 3, 2, pixels)
            self.assertEqual(read_png_rgb(path), (3, 2, pixels))

    def test_bilinear_and_bearing(self):
        lats, lons = [0.0, 1.0], [10.0, 11.0]
        grid = [[1.0, 3.0], [5.0, 7.0]]          # value = 1 + 2*dx + 4*dy
        self.assertAlmostEqual(bilinear(grid, lats, lons, 0.25, 10.5), 3.0)
        self.assertIsNone(bilinear(grid, lats, lons, 2.0, 10.5))
        self.assertIsNone(bilinear([[None, 3.0], [5.0, 7.0]], lats, lons, 0.5, 10.5))
        self.assertAlmostEqual(toward_deg(0, 1), 0.0)
        self.assertAlmostEqual(toward_deg(1, 0), 90.0)
        self.assertAlmostEqual(toward_deg(0, -1), 180.0)
        self.assertAlmostEqual(toward_deg(-1, 0), 270.0)


class ProductTests(unittest.TestCase):
    def make_field(self):
        lats, lons = [38.0, 39.0, 40.0], [-78.0, -77.0]
        frames = []
        for k in range(5):
            u = [[float(k), float(k)], [float(k), float(k)], [10.0, 10.0]]   # north row distinct
            v = [[-2.0, -2.0], [-2.0, -2.0], [-2.0, -2.0]]
            t2m = [[290.0] * 2 for _ in range(3)]
            slp = [[1013.0] * 2 for _ in range(3)]
            frames.append(Frame(datetime(2025, 1 + k, 15, tzinfo=timezone.utc), k, u, v, t2m, slp))
        site = {"id": "test", "name": "Test", "lat": 38.5, "lon": -77.5}
        return FlowField("test-2025", "site", 2025, lats, lons, {"name": "unit test"}, frames, site, 12)

    def test_write_produces_atlas_manifest_and_site_series(self):
        with tempfile.TemporaryDirectory() as folder:
            manifest = self.make_field().write(Path(folder), "2025")
            json.dumps(manifest, allow_nan=False)
            self.assertEqual(manifest["schemaVersion"], "flow-field/1.0")
            self.assertFalse(manifest["complete"])
            self.assertEqual(manifest["atlas"], {"cols": 4, "rows": 2, "tileWidth": 2, "tileHeight": 3,
                                                 "order": "row-major, frame 0 top-left"})
            width, height, pixels = read_png_rgb(Path(folder) / manifest["files"]["wind"])
            self.assertEqual((width, height), (8, 6))
            lo, hi = WIND_RANGE
            top_left_u = decode(pixels[0], lo, hi)       # frame 0, northernmost row
            self.assertAlmostEqual(top_left_u, 10.0, delta=0.2)
            bottom_left_u = decode(pixels[(2 * width) * 3], lo, hi)
            self.assertAlmostEqual(bottom_left_u, 0.0, delta=0.2)
            self.assertEqual(pixels[2], 255)            # valid flag
            series = manifest["siteSeries"]
            self.assertEqual(len(series), 5)
            self.assertAlmostEqual(series[3]["u"], 3.0)
            self.assertAlmostEqual(series[3]["towardDeg"], toward_deg(3.0, -2.0), places=1)
            self.assertAlmostEqual(series[0]["slpHpa"], 1013.0)
            self.assertTrue((Path(folder) / manifest["files"]["scalars"]).exists())

    def test_index_lists_products_with_validation(self):
        with tempfile.TemporaryDirectory() as folder:
            out = Path(folder)
            self.make_field().write(out / "test", "2025")
            build.write_index(out)
            index = json.loads((out / "index.json").read_text(encoding="utf-8"))
            self.assertEqual(index["products"][0]["files"]["wind"], "test/2025.wind.png")
            self.assertIn("direction", index["validation"])


@unittest.skipUnless(Path(build.OUT_DIR / "index.json").exists(), "flow fields not built")
class BuiltDataTests(unittest.TestCase):
    def test_committed_products_are_consistent(self):
        index = json.loads((build.OUT_DIR / "index.json").read_text(encoding="utf-8"))
        for product in index["products"]:
            manifest = json.loads((build.OUT_DIR / product["manifest"]).read_text(encoding="utf-8"))
            width, height, _ = read_png_rgb(build.OUT_DIR / product["files"]["wind"])
            atlas = manifest["atlas"]
            self.assertEqual((width, height), (atlas["cols"] * atlas["tileWidth"], atlas["rows"] * atlas["tileHeight"]))
            self.assertEqual(len(manifest["frames"]), product["frames"])
            for row in manifest.get("siteSeries", []):
                if "speed" in row:
                    self.assertTrue(0 <= row["speed"] < 60 and math.isfinite(row["towardDeg"]))


if __name__ == "__main__":
    unittest.main()
