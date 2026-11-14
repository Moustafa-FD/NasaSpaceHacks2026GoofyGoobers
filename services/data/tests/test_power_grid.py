import copy
import importlib.util
import json
import math
import os
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path, PureWindowsPath
from unittest.mock import patch

import numpy as np
from numcodecs import get_codec

MODULE_PATH = Path(__file__).resolve().parents[1] / "power_grid.py"
spec = importlib.util.spec_from_file_location("power_grid", MODULE_PATH)
power = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = power
spec.loader.exec_module(power)


def encode(array, array_spec):
    raw = np.asarray(array, dtype=np.dtype(array_spec["dtype"]))
    for filter_spec in array_spec.get("filters") or []:
        raw = get_codec(filter_spec).encode(raw)
    return bytes(get_codec(array_spec["compressor"]).encode(raw))


def fixture():
    compressor = {"id": "blosc", "cname": "zstd", "clevel": 3, "shuffle": 1, "blocksize": 0}
    metadata = {".zattrs": {"version": "test-only synthetic codec fixture"}}
    payloads = {}
    epoch = datetime(1981, 1, 31)
    coordinate_values = {
        "lat": np.array([-30, 30], dtype="<f8"), "lon": np.array([-90, 90], dtype="<f8"),
        "time": np.array([(datetime(y, m, 28) - epoch).days for y, m in [(2026, 9), (2026, 10), (2029, 12)]], dtype="<i8"),
    }
    for name, values in coordinate_values.items():
        array_spec = {"zarr_format": 2, "shape": [len(values)], "chunks": [len(values)], "dtype": values.dtype.str,
                      "fill_value": None, "order": "C", "filters": None, "compressor": compressor, "dimension_separator": "."}
        metadata[name + "/.zarray"] = array_spec
        metadata[name + "/.zattrs"] = {"_ARRAY_DIMENSIONS": [name]}
        payloads[name + "/0"] = encode(values, array_spec)
    metadata["time/.zattrs"].update({"units": "days since 1981-01-31 00:00:00", "calendar": "proleptic_gregorian"})
    array_spec = {"zarr_format": 2, "shape": [3, 2, 2], "chunks": [3, 1, 1], "dtype": "<f4", "fill_value": "NaN", "order": "C",
                  "filters": [{"id": "fixedscaleoffset", "scale": 100, "offset": 1000, "dtype": "<f4", "astype": "<f4"}],
                  "compressor": compressor, "dimension_separator": "."}
    metadata["T2M/.zarray"] = array_spec
    metadata["T2M/.zattrs"] = {"units": "C", "long_name": "Temperature at 2 Meters", "definition": "SYNTHETIC TEST FIXTURE", "valid_min": -125, "valid_max": 80,
                                "cell_methods": "time: mean", "_ARRAY_DIMENSIONS": ["time", "lat", "lon"]}
    values = np.array([[[10, 20], [30, np.nan]], [[12, 22], [32, 42]], [[5, 5], [5, 5]]], dtype="<f4")
    for key, index in power.chunk_keys("T2M", array_spec):
        _, y, x = index
        payloads[key] = encode(values[:, y:y + 1, x:x + 1], array_spec)
    payloads[".zmetadata"] = json.dumps({"zarr_consolidated_format": 1, "metadata": metadata}).encode()
    return metadata, payloads


class PowerGridTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.metadata, self.payloads = fixture()
        self.calls = []

        def fetch(url, limit=power.MAX_ASSET_BYTES, etag=None):
            key = url.removeprefix(power.SOURCE_URL + "/")
            self.calls.append((key, etag))
            data = self.payloads[key]
            actual_etag = '"' + power.digest(data) + '"'
            if etag == actual_etag: return None, {}
            return data, {"etag": actual_etag, "lastModified": "synthetic-test"}

        self.addCleanup(patch.stopall)
        patch.object(power, "fetch_bytes", side_effect=fetch).start()
        patch.object(power, "emit").start()
        patch.object(power, "current_month", return_value="2026-11").start()

    def cache(self):
        return power.Cache(self.temp.name, 2 * 1024 * 1024)

    def synchronize(self):
        return power.sync({"variables": ["T2M"]}, self.cache())

    def test_source_codec_inverse_and_nan_mask(self):
        array_spec = self.metadata["T2M/.zarray"]
        decoded = power.decode_chunk(self.payloads["T2M/0.1.1"], array_spec)
        self.assertTrue(math.isnan(float(decoded[0, 0, 0])))
        self.assertAlmostEqual(float(decoded[1, 0, 0]), 42, places=4)
        self.assertFalse(bool(power.valid_mask(decoded, array_spec, self.metadata["T2M/.zattrs"])[0, 0, 0]))

    def test_sync_caches_global_chunks_and_excludes_reserved_future_dates(self):
        result = self.synchronize()
        self.assertTrue(result["complete"])
        entry = result["variables"][0]
        self.assertEqual(entry["gridCellCount"], 4)
        self.assertEqual(entry["completeChunks"], 4)
        self.assertEqual(entry["firstValidDate"], "2026-09")
        self.assertEqual(entry["lastValidDate"], "2026-10")
        self.assertEqual(entry["validMonthCount"], 2)
        self.assertTrue(Path(self.temp.name, "inventory.json").is_file())

    def test_refresh_checks_etags_and_reuses_unchanged_bytes(self):
        first = self.synchronize()
        self.calls.clear()
        second = self.synchronize()
        self.assertEqual(second["downloadedBytes"], 0)
        self.assertEqual(first["sourceRevision"], second["sourceRevision"])
        self.assertTrue(self.calls)
        self.assertTrue(all(etag is not None for _, etag in self.calls))

    def test_changed_upstream_chunk_updates_revision_and_values(self):
        first = self.synchronize()
        array_spec = self.metadata["T2M/.zarray"]
        self.payloads["T2M/0.0.0"] = encode(np.array([11, 13, 5], dtype="<f4").reshape(3, 1, 1), array_spec)
        second = self.synchronize()
        self.assertNotEqual(first["sourceRevision"], second["sourceRevision"])
        result = power.query_data({"variables": ["T2M"], "point": {"latitude": -30, "longitude": -90}}, self.cache())
        self.assertAlmostEqual(result["metrics"][0]["series"][0]["value"], 11, places=4)

    def test_series_weighted_mean_missing_coverage_and_point(self):
        self.synchronize()
        result = power.query_data({"variables": ["T2M"]}, self.cache())
        series = result["metrics"][0]["series"]
        self.assertEqual([point["date"] for point in series], ["2026-09", "2026-10"])
        self.assertAlmostEqual(series[0]["value"], 20)
        self.assertEqual(series[0]["coverageFraction"], 0.75)
        point = power.query_data({"variables": ["T2M"], "point": {"latitude": 30, "longitude": 90}}, self.cache())
        self.assertIsNone(point["metrics"][0]["series"][0]["value"])
        self.assertAlmostEqual(point["metrics"][0]["series"][1]["value"], 42)
        self.assertEqual(point["metrics"][0]["units"], "C")

    def test_grid_preserves_native_cell_order_and_nulls(self):
        self.synchronize()
        result = power.query_data({"variables": ["T2M"], "date": "2026-09"}, self.cache(), grid=True)
        self.assertEqual(result["grid"]["shape"], [2, 2])
        self.assertEqual(result["grid"]["values"], [10, 20, 30, None])
        self.assertEqual(result["grid"]["latitudes"], [-30, 30])

    def test_missing_or_corrupted_chunks_cannot_be_interpreted_as_zero(self):
        self.synchronize()
        Path(self.temp.name, "T2M", "0.0.0").write_bytes(b"corrupted-test")
        with self.assertRaisesRegex(power.DataError, "Missing or unverified chunk"):
            power.query_data({"variables": ["T2M"]}, self.cache())
        self.synchronize()
        result = power.query_data({"variables": ["T2M"]}, self.cache())
        self.assertAlmostEqual(result["metrics"][0]["series"][0]["value"], 20)

    def test_budget_prevents_overwrite_and_retains_original_asset(self):
        cache = power.Cache(self.temp.name, 1024 * 1024)
        target = cache.target("T2M/0.0.0")
        cache._atomic(target, b"a" * 600_000)
        with self.assertRaisesRegex(power.DataError, "budget"):
            cache._atomic(target, b"b" * 600_000)
        self.assertEqual(target.read_bytes()[:1], b"a")
        self.assertEqual(cache.used_bytes, 600_000)

    def test_windows_containment_accepts_equivalent_drive_and_unc_prefixes(self):
        pairs = [(r"C:\data\power-grid", r"\\?\C:\data\power-grid\T2M\0.0.0"),
                 (r"\\server\share\power-grid", r"\\?\UNC\server\share\power-grid\T2M\0.0.0")]
        for root, target in pairs:
            with self.subTest(root=root):
                self.assertTrue(power.containment_path(PureWindowsPath(target)).is_relative_to(power.containment_path(PureWindowsPath(root))))
        for target in (r"\\?\D:\data\power-grid\T2M\0.0.0", r"\\?\C:\data\power-grid-sibling\T2M\0.0.0"):
            self.assertFalse(power.containment_path(PureWindowsPath(target)).is_relative_to(PureWindowsPath(r"C:\data\power-grid")))

    @unittest.skipUnless(os.name == "nt", "Windows extended-length path behavior")
    def test_target_accepts_windows_realpath_retaining_extended_prefix(self):
        cache = self.cache()
        target = cache.root / "T2M" / "0.0.0"
        extended = Path("\\\\?\\" + str(target))
        with patch.object(Path, "resolve", return_value=extended):
            self.assertEqual(cache.target("T2M/0.0.0"), extended)

    def test_resolved_directory_escape_and_unsafe_keys_are_still_rejected(self):
        cache = self.cache()
        escaped = cache.root.parent / (cache.root.name + "-outside") / "0.0.0"
        with patch.object(Path, "resolve", return_value=escaped):
            with self.assertRaisesRegex(power.DataError, "escapes"):
                cache.target("T2M/0.0.0")
        for key in ("../outside", "T2M/../../outside", "T2M/0.0.0:alternate"):
            with self.assertRaisesRegex(power.DataError, "Invalid cache key"):
                cache.target(key)

    def test_failed_atomic_replace_restores_verified_manifest_and_resumes(self):
        self.synchronize()
        cache = self.cache()
        key = "T2M/0.0.0"
        original = cache.cached(key)
        record = copy.deepcopy(cache.manifest["files"][key])
        original_disk_inventory = (cache.root / "inventory.json").read_bytes()
        self.payloads[key] = encode(np.array([11, 13, 5], dtype="<f4").reshape(3, 1, 1), self.metadata["T2M/.zarray"])
        with patch.object(power.os, "replace", side_effect=OSError("simulated replace failure")):
            with self.assertRaisesRegex(OSError, "simulated replace failure"):
                cache.ensure(key, self.metadata["T2M/.zarray"], refresh=True)
        self.assertEqual(cache.manifest["files"][key], record)
        self.assertEqual(cache.cached(key), original)
        self.assertEqual((cache.root / "inventory.json").read_bytes(), original_disk_inventory)
        self.assertFalse(list(cache.root.rglob("*.part")))
        cache.ensure(key, self.metadata["T2M/.zarray"], refresh=True)
        self.assertEqual(cache.cached(key), self.payloads[key])

    def test_failed_new_asset_write_leaves_no_manifest_record(self):
        cache = self.cache()
        with patch.object(cache, "_atomic", side_effect=OSError("simulated write failure")):
            with self.assertRaisesRegex(OSError, "simulated write failure"):
                cache.ensure(".zmetadata", refresh=True)
        self.assertNotIn(".zmetadata", cache.manifest["files"])
        self.assertEqual(cache.used_bytes, 0)

    def test_rejects_unknown_variables_and_unavailable_future_grid(self):
        self.synchronize()
        with self.assertRaises(power.DataError): power.variables({"variables": ["PM25"]})
        with self.assertRaises(power.DataError): power.query_data({"variables": ["T2M"], "date": "2029-12"}, self.cache(), grid=True)
        with self.assertRaises(power.DataError): power.query_data({"variables": ["T2M"], "bbox": [0, 0, 1, 1]}, self.cache())


if __name__ == "__main__":
    unittest.main()
