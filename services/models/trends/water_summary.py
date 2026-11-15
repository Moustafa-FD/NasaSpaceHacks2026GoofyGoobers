"""Build the committed per-site water evidence product from Giovanni downloads.

    python -m services.models.trends.giovanni          # download (needs EARTHDATA_TOKEN)
    python -m services.models.trends.water_summary     # -> data/cloudshadow/water/<site>.json

Each variable becomes annual values (unit-converted, deseasonalized monthly means)
plus a trend tested at ANNUAL cadence with the Hamed-Rao correction and the
autocorrelation-adjusted t-test (storage variables persist from year to year, so
monthly seasonal tests overstate significance). Regional products: they describe
the water setting around a site, never a facility's own withdrawals.
"""

from __future__ import annotations

import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path

from . import analysis, series

ROOT = Path(__file__).resolve().parents[3]
RAW = ROOT / "data" / "raw" / "giovanni"
OUT = ROOT / "data" / "cloudshadow" / "water"

# key, Giovanni ID, label, display unit, scale from source unit, min valid obs per month, plain meaning
VARIABLES = (
    ("groundwater", "GRACEDADM_CLSM0125US_7D_4_0_gws_inst", "Groundwater storage", "mm", 1.0, 2,
     "NASA GRACE satellite gravity assimilated into a land model (0.125°, but effective GRACE detail is ~300 km). Storage in mm of water, not a well level."),
    ("soilMoisture", "GLDAS_NOAH025_M_2_1_SoilMoi0_10cm_inst", "Topsoil moisture (0–10 cm)", "mm", 1.0, 1,
     "NASA GLDAS land model, 0.25°. kg/m² of water in the top 10 cm equals mm of water. Model estimate, not a probe measurement."),
    ("rainfall", "GPM_3IMERGM_07_precipitation", "Rainfall", "mm/day", 24.0, 1,
     "NASA GPM IMERG satellite precipitation, 0.1°, converted from mm/hour to mm/day."),
    ("evapotranspiration", "GLDAS_NOAH025_M_2_1_Evap_tavg", "Evapotranspiration", "mm/day", 86400.0, 1,
     "NASA GLDAS land model, 0.25°: water returning to the air from soil and plants (kg/m²/s × 86,400 = mm/day). Does not isolate cooling-tower evaporation."),
)


def _round(value, digits=4):
    return None if value is None or not math.isfinite(value) else round(value, digits)


def build_variable(path: Path, scale: float, min_count: int) -> dict:
    data = series.read_time_series_csv(path)
    observations = [series.Observation(o.day, None if o.value is None else o.value * scale) for o in data.observations]
    monthly = series.to_monthly(observations, min_count=min_count)
    # Drop a trailing partial year so the last annual value is comparable.
    annual = [a for a in series.to_annual(monthly, min_months=10)]
    report = analysis.analyze_annual(annual, units="")
    trend = {"status": report["status"]}
    if report["status"] == "ok":
        mk, lin, sen = report["mannKendall"], report["linear"], report["sen"]
        both = mk["significant"] and lin["significant"]
        either = mk["significant"] or lin["significant"]
        trend.update(direction=report["direction"], slopePerDecade=_round(sen["slopePerDecade"]),
                     ci=[_round(v) for v in sen["ciPerDecade"]], pMannKendall=_round(mk["pValue"], 6), pTTest=_round(lin["pValue"], 6),
                     verdict="significant" if both else "borderline" if either else "not significant",
                     note="Both tests agree." if both or not either else "Tests disagree; treat as borderline.")
    else:
        trend["reasons"] = report["reasons"]
    return {"monthsUsed": sum(1 for m in monthly if m.value is not None),
            "period": report.get("period"),
            "annual": [{"year": a.year, "value": _round(a.value), "months": a.months} for a in annual],
            "trend": trend}


def main() -> int:
    sites = json.loads((ROOT / "data" / "cloudshadow" / "sites.json").read_text(encoding="utf-8"))["sites"]
    OUT.mkdir(parents=True, exist_ok=True)
    built = 0
    for site in sites:
        variables = {}
        for key, gid, label, unit, scale, min_count, meaning in VARIABLES:
            csv_path = RAW / site["id"] / f"{gid}.csv"
            if not csv_path.exists():
                variables[key] = {"label": label, "unit": unit, "available": False, "reason": "Not downloaded; run the Giovanni downloader."}
                continue
            provenance = json.loads(csv_path.with_suffix(".provenance.json").read_text(encoding="utf-8"))
            variables[key] = {"label": label, "unit": unit, "available": True, "giovanniId": gid, "meaning": meaning,
                              "bbox": provenance.get("bbox"), "retrieved": provenance.get("retrievedUtc"),
                              **build_variable(csv_path, scale, min_count)}
        product = {
            "schemaVersion": "water-evidence/1.0", "site": site["id"], "evidence": "satellite-and-land-model",
            "evidenceNote": ("Regional NASA water context around the site (area average of a ±0.25° box). It describes the water "
                             "setting, not the facility's own water use, and a trend here does not identify its cause."),
            "method": "Annual values from deseasonalized monthly means (≥10 months). Trend: Sen's slope, Mann-Kendall with Hamed-Rao correction and an autocorrelation-adjusted t-test (services/models/trends).",
            "source": "NASA Giovanni via Harmony (area average)", "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
            "variables": variables,
        }
        (OUT / f"{site['id']}.json").write_text(json.dumps(product, indent=1, allow_nan=False), encoding="utf-8")
        built += 1
        print(f"{site['id']}: " + ", ".join(f"{k} {v['trend'].get('verdict', v['trend']['status']) if v.get('available') else 'missing'}" for k, v in variables.items()), file=sys.stderr)
    return 0 if built else 1


if __name__ == "__main__":
    raise SystemExit(main())
