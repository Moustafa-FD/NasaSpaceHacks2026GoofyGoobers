"""One JSON request -> progress events + one screening result, standard library only."""
from __future__ import annotations

import calendar
import json
import math
import re
import sys
from typing import Any
from urllib.parse import urlsplit

from ..projections import plume
from ..fields.opendap import OpendapError

VERSION = "environment-screening/1.0"
RANGES = {"heatMw": (0, 100000), "emissionRateGs": (0, 100000), "withdrawalM3s": (0, 100000), "returnM3s": (0, 100000),
          "riverFlowM3s": (0, 1000000), "upstreamTempC": (-2, 60), "dischargeTempC": (-2, 100),
          "upstreamMgL": (0, 1000000), "dischargeMgL": (0, 1000000), "soundPowerDbA": (0, 200)}
REQUIRED = {"heat": ["heatMw", "dispersion.effectiveHeightM", "dispersion.airDensityKgM3", "dispersion.specificHeatJkgK"],
            "air": ["emissionRateGs", "pollutant", "dispersion.effectiveHeightM"],
            "waterBalance": ["withdrawalM3s", "returnM3s"],
            "waterTemperature": ["riverFlowM3s", "returnM3s", "upstreamTempC", "dischargeTempC"],
            "waterQuality": ["riverFlowM3s", "returnM3s", "upstreamMgL", "dischargeMgL", "pollutant"],
            "noise": ["soundPowerDbA", "receptors[].distanceM or noiseContourLevelsDbA"]}
REFERENCES = [
    {"title": "US EPA CAP88-PC Gaussian plume formulation", "url": "https://www.epa.gov/system/files/documents/2022-05/402-r-00-004.pdf"},
    {"title": "US EPA NPDES Permit Writers' Manual: complete mixing mass balance", "url": "https://www.epa.gov/npdes/npdes-permit-writers-manual"},
    {"title": "OSHA Technical Manual: sound propagation and decibel addition", "url": "https://www.osha.gov/otm/section-3-health-hazards/chapter-5"},
    {"title": "FHWA acoustical fundamentals", "url": "https://www.fhwa.dot.gov/environment/noise/noise_barriers/design_construction/design/design03.cfm"},
]
LIMITATIONS = [
    "Conditional screening from explicitly supplied inputs; not calibrated to this facility and not proof of attribution.",
    "Only supplied years are calculated. Missing years and inputs are not interpolated, extrapolated or replaced by zero.",
    "Heat and air share a fixed sampled NASA GEOS-FP wind footprint. Future emission/heat inputs do not forecast future wind or weather.",
    "Heat is treated as a passive sensible-heat tracer: no buoyancy/plume rise, cooling-tower evaporation, building downwash or urban heat storage.",
    "Air is source-only primary pollutant transport: no background concentration, chemistry, deposition, exposure or health-risk model.",
    "Water rates are annual-average scenario rates; accounting assumes matching facility boundaries. Complete mixing uses receiving flow immediately upstream of discharge, not necessarily intake flow.",
    "Water mixing is steady and conservative: no reactions, heat exchange, stratification, travel time, aquifer balance, water level or river morphology.",
    "Noise uses an omnidirectional far-field point source in a free field. No terrain, ground reflections, barriers, frequency spectrum, meteorology, multiple-source campus geometry or regulatory compliance assessment.",
    "No crop-yield, forest-mortality or pollutant-response model is included. Existing agricultural climate-exposure models remain available separately.",
    "Input and model uncertainty are not quantified; output is not a confidence interval or a validated decades-ahead forecast.",
]


def finite(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def bounded(value: Any, low: float, high: float) -> bool:
    return finite(value) and low <= value <= high


def source(value: Any) -> bool:
    if not isinstance(value, dict) or set(value) - {"evidence", "citation", "url"} or value.get("evidence") not in ("reported", "assumed"):
        return False
    if not isinstance(value.get("citation"), str) or not value["citation"].strip() or len(value["citation"]) > 1000:
        return False
    if "url" in value:
        if not isinstance(value["url"], str) or len(value["url"]) > 2000:
            return False
        parsed = urlsplit(value["url"])
        if parsed.scheme not in ("http", "https") or not parsed.netloc or parsed.username or parsed.password:
            return False
    return True


def validate(request: Any) -> None:
    if not isinstance(request, dict) or set(request) - {"schemaVersion", "kind", "siteId", "point", "years", "dispersion", "receptors", "noiseContourLevelsDbA", "backgroundNoise", "site"}:
        raise ValueError("Invalid screening request object or unknown field")
    if request.get("schemaVersion") != "1.0" or request.get("kind") != "environment-screening":
        raise ValueError("Expected environment-screening schemaVersion 1.0")
    if ("siteId" in request) == ("point" in request):
        raise ValueError("Choose exactly one siteId or point")
    if "siteId" in request and request["siteId"] not in ("ashburn", "colossus1", "colossus2", "abilene", "thedalles"):
        raise ValueError("Unknown study siteId")
    if "point" in request:
        p = request["point"]
        if not isinstance(p, dict) or set(p) - {"latitude", "longitude"} or not bounded(p.get("latitude"), -90, 90) or not bounded(p.get("longitude"), -180, 180):
            raise ValueError("Invalid requested WGS84 point")
    if "site" in request:
        s = request["site"]
        if not isinstance(s, dict) or not isinstance(s.get("id"), str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,80}", s["id"]) or not bounded(s.get("lat"), -90, 90) or not bounded(s.get("lon"), -180, 180):
            raise ValueError("Invalid resolved source site")
        if request.get("siteId") and s["id"] != request["siteId"]:
            raise ValueError("Resolved site does not match the requested study site")
        if request.get("point") and (abs(s["lat"] - request["point"]["latitude"]) > 1e-6 or abs(s["lon"] - request["point"]["longitude"]) > 1e-6):
            raise ValueError("Resolved source does not match the requested point")
    rows = request.get("years")
    if not isinstance(rows, list) or not 1 <= len(rows) <= 81:
        raise ValueError("Provide 1-81 explicit annual records")
    seen = set()
    for row in rows:
        if not isinstance(row, dict) or set(row) - {"year", "source", "pollutant", *RANGES}:
            raise ValueError("Unknown screening year field")
        year = row.get("year")
        if not isinstance(year, int) or isinstance(year, bool) or not 2020 <= year <= 2100 or year in seen:
            raise ValueError("Provide unique integer years 2020-2100")
        seen.add(year)
        values = [key for key in RANGES if key in row]
        if values or "source" in row:
            if not source(row.get("source")):
                raise ValueError("Every numeric annual input needs a reported/assumed source citation")
        if any(not bounded(row[key], *RANGES[key]) for key in values):
            raise ValueError("Annual inputs must be finite, in supported ranges and not booleans")
        if "pollutant" in row and (not isinstance(row["pollutant"], str) or not row["pollutant"].strip() or len(row["pollutant"]) > 80):
            raise ValueError("A pollutant/constituent identity must be a nonempty string up to 80 characters")
        if "withdrawalM3s" in row and "returnM3s" in row and row["returnM3s"] > row["withdrawalM3s"]:
            raise ValueError("Returned flow exceeds withdrawal in the stated accounting boundary")
    if "dispersion" in request:
        d = request["dispersion"]
        if not isinstance(d, dict) or set(d) - {"effectiveHeightM", "landUse", "airDensityKgM3", "specificHeatJkgK", "source"} or not bounded(d.get("effectiveHeightM"), 1, 300) or d.get("landUse") not in ("urban", "rural") or not source(d.get("source")):
            raise ValueError("Dispersion needs height, land use and an explicit source citation")
        for key, limits in [("airDensityKgM3", (.5, 2)), ("specificHeatJkgK", (800, 1200))]:
            if key in d and not bounded(d[key], *limits):
                raise ValueError(f"Invalid {key}")
    if "receptors" in request:
        receptors = request["receptors"]
        if not isinstance(receptors, list) or not 1 <= len(receptors) <= 20 or any(not isinstance(r, dict) or set(r) - {"name", "distanceM"} or not isinstance(r.get("name"), str) or not r["name"].strip() or len(r["name"]) > 80 or not bounded(r.get("distanceM"), 1, 10000) for r in receptors):
            raise ValueError("Noise receptors need names and far-field distances 1-10000 m")
    if "backgroundNoise" in request:
        b = request["backgroundNoise"]
        if not isinstance(b, dict) or set(b) - {"dbA", "source"} or not bounded(b.get("dbA"), 0, 160) or not source(b.get("source")):
            raise ValueError("Background noise needs dbA and a source citation")
    if "noiseContourLevelsDbA" in request:
        levels = request["noiseContourLevelsDbA"]
        if not isinstance(levels, list) or not 1 <= len(levels) <= 5 or any(not bounded(level, 10, 140) for level in levels) or len(set(levels)) != len(levels):
            raise ValueError("Choose 1-5 unique display contour levels 10-140 dB(A), not regulatory limits")


def metric(identifier: str, label: str, value: float, unit: str, domain: str, **extra: Any) -> dict:
    if not finite(value):
        raise ValueError("Screening calculation produced a nonfinite value")
    return {"id": identifier, "label": label, "value": value, "unit": unit, "domain": domain, "status": "conditional-screening", **extra}


def mixing(flow: float, upstream: float, discharge_flow: float, discharge: float) -> float | None:
    total = flow + discharge_flow
    return (flow * upstream + discharge_flow * discharge) / total if total > 0 else None


def run(request: dict, dispersion_result: dict | None = None, progress=lambda *_: None) -> dict:
    validate(request)
    d = request.get("dispersion", {})
    need_transport = bool(d) and any("heatMw" in row or "emissionRateGs" in row for row in request["years"])
    transport_error = None
    if need_transport and dispersion_result is None:
        selected = request.get("site")
        if not isinstance(selected, dict):
            raise ValueError("Node must resolve the selected source site before transport screening")
        try:
            progress(.15, "screening:reading-nasa-wind")
            frames = None if selected.get("prepared") else plume.point_frames(selected["lat"], selected["lon"], progress=lambda done, total: progress(.1 + .6 * done / total, "screening:reading-nasa-wind"))
            dispersion_result = plume.scenario(selected, height_m=d["effectiveHeightM"], land_use=d["landUse"], frames=frames)
        except (plume.PlumeError, OpendapError, OSError, ValueError) as error:
            transport_error = str(error)
    chi = dispersion_result.get("peak", {}).get("chiOverQ") if dispersion_result else None
    has_transport = finite(chi) and chi >= 0
    rows, missing, scales = [], [], []
    for row in sorted(request["years"], key=lambda item: item["year"]):
        year, metrics, absent = row["year"], [], {}
        for domain, fields in REQUIRED.items():
            fields_missing = []
            for field in fields:
                available = bool(request.get("receptors") or request.get("noiseContourLevelsDbA")) if field.startswith("receptors[]") else field.split(".")[-1] in d if field.startswith("dispersion.") else field in row
                if not available:
                    fields_missing.append(field)
            if domain in ("heat", "air") and not has_transport:
                fields_missing.append("NASA wind dispersion footprint")
            if fields_missing:
                absent[domain] = fields_missing
                missing.append({"year": year, "domain": domain, "fields": fields_missing, "reason": transport_error if domain in ("heat", "air") and transport_error else "Supply the listed inputs and their reported or assumed sources."})
        scale = {"year": year, "heatMultiplier": None, "airMultiplier": None}
        if "heat" not in absent:
            multiplier = row["heatMw"] * 1e6 / (d["airDensityKgM3"] * d["specificHeatJkgK"])
            scale["heatMultiplier"] = multiplier
            metrics.append(metric("heat_peak_temperature_rise", "Passive-tracer peak temperature rise", chi * multiplier, "°C", "heat", note="Fixed sampled-wind screening; buoyancy and building physics are omitted."))
        if "air" not in absent:
            scale["airMultiplier"] = row["emissionRateGs"] * 1e6
            metrics.append(metric("air_peak_source_contribution", f"Peak source-only {row['pollutant']}", chi * scale["airMultiplier"], "µg/m³", "air", pollutant=row["pollutant"]))
        seconds = (366 if calendar.isleap(year) else 365) * 86400
        if "waterBalance" not in absent:
            for identifier, label, rate in [("water_withdrawal", "Scenario withdrawal", row["withdrawalM3s"]), ("water_return", "Scenario returned water", row["returnM3s"]), ("water_balance", "Withdrawal minus return (accounting)", row["withdrawalM3s"] - row["returnM3s"])]:
                metrics.append(metric(identifier, label, rate * seconds, "m³/year", "water", note="Annual-average rate × calendar-year seconds; matching accounting boundaries required. Not a prediction of lake or groundwater depletion."))
        for domain, before, after, identifier, label, unit in [("waterTemperature", "upstreamTempC", "dischargeTempC", "water_mixed_temperature", "Completely mixed receiving-water temperature", "°C"), ("waterQuality", "upstreamMgL", "dischargeMgL", "water_mixed_concentration", "Completely mixed conservative constituent", "mg/L")]:
            if domain in absent:
                continue
            value = mixing(row["riverFlowM3s"], row[before], row["returnM3s"], row[after])
            if value is None:
                missing.append({"year": year, "domain": domain, "fields": ["positive combined receiving/discharge flow"], "reason": "Both flows are zero; a mixed concentration or temperature is undefined."})
                continue
            extra = {"pollutant": row["pollutant"]} if domain == "waterQuality" else {}
            metrics.append(metric(identifier, label, value, unit, "water", **extra))
            metrics.append(metric(identifier + "_change", "Change from supplied upstream value", value - row[before], unit, "water", **extra))
        contours = []
        if "noise" not in absent:
            for index, receptor in enumerate(request.get("receptors", [])):
                level = row["soundPowerDbA"] - 10 * math.log10(4 * math.pi * receptor["distanceM"] ** 2)
                extra = {"receptor": receptor, "key": f"noise_source_db_a:{index}"}
                metrics.append(metric("noise_source_db_a", "Free-field source sound pressure", level, "dB(A)", "noise", **extra))
                if "backgroundNoise" in request:
                    background = request["backgroundNoise"]["dbA"]
                    # Work relative to the larger level to avoid overflow and add energies, not dB.
                    high = max(level, background)
                    total = high + 10 * math.log10(10 ** ((level-high)/10) + 10 ** ((background-high)/10))
                    metrics.append(metric("noise_total_db_a", "Source plus supplied background", total, "dB(A)", "noise", receptor=receptor, key=f"noise_total_db_a:{index}"))
            for level in request.get("noiseContourLevelsDbA", []):
                radius = math.sqrt(10 ** ((row["soundPowerDbA"] - level) / 10) / (4 * math.pi))
                supported = 1 <= radius <= 10000
                contours.append({"levelDbA": level, "radiusM": radius if supported else None, "status": "conditional-screening" if supported else "outside-supported-distance", "note": "Source-only free-field chosen display contour, not a health/legal threshold; supported radius 1-10000 m."})
        rows.append({"year": year, "metrics": metrics, "noiseContours": contours, "source": row.get("source"), "input": row})
        scales.append(scale)
    sources = [item for item in [*(row.get("source") for row in request["years"]), d.get("source"), request.get("backgroundNoise", {}).get("source")] if item]
    unique = {json.dumps(item, sort_keys=True): item for item in sources}
    progress(.95, "screening:complete")
    return {"schemaVersion": VERSION, "kind": "environment-screening", "modelVersion": VERSION, "evidence": "screening-scenario",
            "site": request.get("site"), "years": rows, "requiredInputs": missing, "sources": list(unique.values()), "references": REFERENCES,
            "inputEvidence": "contains-assumptions" if any(s["evidence"] == "assumed" for s in sources) else "reported-inputs" if sources else "missing-inputs",
            "uncertainty": {"status": "not_quantified", "note": "No calibration, held-out accuracy or probabilistic uncertainty is claimed."},
            "spatial": {"dispersion": dispersion_result, "scales": scales} if has_transport else None,
            "unavailable": [{"id": "crop_yield", "reason": "No calibrated crop or forest response model is supplied. Use the existing agriculture climate-exposure job."}, {"id": "hydrological_depletion", "reason": "Accounting and mixing are not a watershed/aquifer storage or river-flow model."}],
            "limitations": LIMITATIONS}


def duplicate_safe(pairs: list[tuple[str, Any]]) -> dict:
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON field")
        result[key] = value
    return result


def main() -> int:
    def emit(progress: float, stage: str) -> None:
        print(json.dumps({"type": "progress", "progress": progress, "stage": stage}), flush=True)
    try:
        raw = sys.stdin.buffer.read(1_000_001)
        if len(raw) > 1_000_000:
            raise ValueError("Request exceeds 1 MB")
        request = json.loads(raw.decode("utf-8"), object_pairs_hook=duplicate_safe, parse_constant=lambda value: (_ for _ in ()).throw(ValueError("Nonfinite JSON number")))
        result = run(request, progress=emit)
        print(json.dumps({"type": "result", "result": result}, allow_nan=False), flush=True)
        return 0
    except (ValueError, KeyError, TypeError) as error:
        print(json.dumps({"error": {"code": "INVALID_SCREENING_REQUEST", "message": str(error)}}), file=sys.stderr)
        return 1
    except Exception as error:
        print(json.dumps({"error": {"code": "SCREENING_WORKER_FAILED", "message": f"{type(error).__name__}: {error}"}}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
