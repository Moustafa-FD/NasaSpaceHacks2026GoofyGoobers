import json
import subprocess
import sys
import unittest
from pathlib import Path

from services.models.trends import worker

ROOT = Path(__file__).resolve().parents[3]


class TrendWorkerTests(unittest.TestCase):
    def test_year_only_points_use_annual_cadence(self):
        points = [{"date": str(2000 + i), "value": 10 + 0.1 * i + (0.3 if i % 3 == 0 else -0.2)} for i in range(15)]
        result = worker.run({"target": {"label": "x", "unit": "K", "points": points}, "cadence": "annual"})
        self.assertEqual(result["report"]["status"], "ok")
        self.assertEqual(result["report"]["direction"], "increasing")
        with self.assertRaises(worker.RequestError):
            worker.run({"target": {"label": "x", "unit": "K", "points": points}, "cadence": "monthly"})

    def test_rejects_bad_points(self):
        for points in ([{"date": "2020-01", "value": 1}] * 3, [{"date": "2020-01", "value": True}] * 3, [{"date": "x", "value": 1}] * 3):
            with self.assertRaises(worker.RequestError):
                worker.run({"target": {"label": "x", "unit": "", "points": points}})

    def test_process_protocol(self):
        bad = subprocess.run([sys.executable, "-m", "services.models.trends.worker"], cwd=ROOT, input="[]",
                             capture_output=True, text=True, timeout=60)
        self.assertEqual(bad.returncode, 1)
        self.assertEqual(bad.stdout, "")
        self.assertEqual(json.loads(bad.stderr)["error"]["code"], "INVALID_TREND_REQUEST")


if __name__ == "__main__":
    unittest.main()
