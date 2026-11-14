import os
import tempfile
import unittest
import urllib.parse
from pathlib import Path
from unittest import mock

from services.models.trends import giovanni, series

REAL_LAYOUT = """User Start Date:,2001-01-01T00:00:00.000Z
User End Date:,2025-12-31T23:59:59.000Z
User Bounding Box:,"-77.75, 38.85, -77.25, 39.2"
Fill Value:,-9999.900390625
,
time,mean_GPM_3IMERGM_07_precipitation
2001-01-01T00:00:00,0.10395639
2001-02-01T00:00:00,-9999.900390625
2001-03-01T00:00:00,0.17179278
"""


class GiovanniClientTests(unittest.TestCase):
    def test_bbox_and_url(self):
        bbox = giovanni.site_bbox(39.0298, -77.4744, 0.25)
        self.assertEqual(bbox, (-77.7244, 38.7798, -77.2244, 39.2798))
        url = giovanni.rangeset_url("C123-GES_DISC", "GPM_3IMERGM_07_precipitation", bbox, "2001-01-01T00:00:00Z", "2025-12-31T23:59:59Z")
        parts = urllib.parse.urlsplit(url)
        self.assertEqual(parts.hostname, "harmony.earthdata.nasa.gov")
        self.assertIn("/C123-GES_DISC/ogc-api-coverages/1.0.0/collections/GPM_3IMERGM_07_precipitation/coverage/rangeset", parts.path)
        query = urllib.parse.parse_qs(parts.query)
        self.assertEqual(query["average"], ["area"])
        self.assertEqual(query["format"], ["text/csv"])
        self.assertIn("lon(-77.7244:-77.2244)", query["subset"])

    def test_token_from_env_file_and_environment(self):
        with tempfile.TemporaryDirectory() as folder:
            env = Path(folder) / ".env"
            env.write_text('OTHER=1\nEARTHDATA_TOKEN="abc.def"\n', encoding="utf-8")
            with mock.patch.dict(os.environ, {}, clear=True):
                self.assertEqual(giovanni.load_token(env), "abc.def")
            with mock.patch.dict(os.environ, {"EARTHDATA_TOKEN": "from-env"}):
                self.assertEqual(giovanni.load_token(env), "from-env")
            with mock.patch.dict(os.environ, {}, clear=True), self.assertRaises(giovanni.GiovanniError):
                giovanni.load_token(Path(folder) / "missing.env")

    def test_token_only_sent_to_nasa_hosts(self):
        sent = []

        class Response:
            def __init__(self, request): sent.append((request.full_url, request.get_header("Authorization")))
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def read(self): return b"{}"

        client = giovanni.Client("secret")
        with mock.patch("urllib.request.urlopen", lambda request, timeout: Response(request)):
            client.get("https://harmony.earthdata.nasa.gov/jobs/1")
            client.get("https://example-bucket.s3.amazonaws.com/file.csv")
            client.get("https://cmr.earthdata.nasa.gov/search", auth=False)
        self.assertEqual(sent[0][1], "Bearer secret")
        self.assertIsNone(sent[1][1])
        self.assertIsNone(sent[2][1])


class GiovanniCsvTests(unittest.TestCase):
    def test_trend_engine_reads_real_giovanni_layout(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "g.csv"
            path.write_text(REAL_LAYOUT, encoding="utf-8")
            data = series.read_time_series_csv(path)
        self.assertEqual(data.value_column, "mean_GPM_3IMERGM_07_precipitation")
        self.assertEqual([o.value for o in data.observations], [0.10395639, None, 0.17179278])
        self.assertEqual(data.metadata["User Start Date"], "2001-01-01T00:00:00.000Z")


if __name__ == "__main__":
    unittest.main()
