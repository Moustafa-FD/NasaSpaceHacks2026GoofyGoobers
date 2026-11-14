"""Illustrative annual accounting, not a calibrated environmental forecast."""

from __future__ import annotations

import calendar
import math
import re
from copy import deepcopy
from typing import Any

MODEL_VERSION = "illustrative-accounting-v0.1"


class ScenarioError(ValueError):
    """The public scenario contract was not satisfied."""


def _object(value: Any, path: str, keys: set[str]) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ScenarioError(f"{path} must be an object")
    missing = keys - value.keys()
    extra = value.keys() - keys
    if missing:
        raise ScenarioError(f"{path} is missing: {', '.join(sorted(missing))}")
    if extra:
        raise ScenarioError(f"{path} has unsupported fields: {', '.join(sorted(extra))}")
    return value


def _text(value: Any, path: str, limit: int = 200) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise ScenarioError(f"{path} must be non-empty text of at most {limit} characters")
    return value


def _number(value: Any, path: str, lower: float, upper: float, *, exclusive: bool = False) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ScenarioError(f"{path} must be a finite number")
    if isinstance(value, float) and not math.isfinite(value):
        raise ScenarioError(f"{path} must be a finite number")
    if value > upper or value < lower or (exclusive and value == lower):
        operator = ">" if exclusive else ">="
        raise ScenarioError(f"{path} must be {operator} {lower} and <= {upper}")
    return value


def validate_request(request: Any) -> tuple[str, dict[str, Any]]:
    root = _object(request, "request", {"runId", "scenario"})
    run_id = _text(root["runId"], "runId", 128)
    scenario = _object(root["scenario"], "scenario", {
        "schemaVersion", "mode", "name", "region", "years", "assumptions",
    })
    if scenario["schemaVersion"] != "1.0":
        raise ScenarioError("schemaVersion must be '1.0'")
    if scenario["mode"] != "illustrative":
        raise ScenarioError("Only mode 'illustrative' is implemented")
    _text(scenario["name"], "name", 120)
    region = _object(scenario["region"], "region", {"id", "name", "bbox"})
    _text(region["id"], "region.id", 80)
    if not re.fullmatch(r"[a-zA-Z0-9_-]+", region["id"]):
        raise ScenarioError("region.id must contain only ASCII letters, digits, underscores or hyphens")
    _text(region["name"], "region.name", 120)
    bbox = region["bbox"]
    if not isinstance(bbox, list) or len(bbox) != 4:
        raise ScenarioError("region.bbox must be [west, south, east, north]")
    for index, (low, high) in enumerate([(-180, 180), (-90, 90), (-180, 180), (-90, 90)]):
        _number(bbox[index], f"region.bbox[{index}]", low, high)
    if bbox[0] >= bbox[2] or bbox[1] >= bbox[3]:
        raise ScenarioError("region.bbox must have west < east and south < north; dateline crossings are unsupported")
    years = _object(scenario["years"], "years", {"start", "end"})
    for key in ("start", "end"):
        if isinstance(years[key], bool) or not isinstance(years[key], int):
            raise ScenarioError(f"years.{key} must be an integer")
        _number(years[key], f"years.{key}", 2000, 2100)
    if years["end"] < years["start"] or years["end"] - years["start"] > 80:
        raise ScenarioError("years.end must be >= years.start and the span must be <= 80 years")
    assumptions = _object(scenario["assumptions"], "assumptions", {
        "itLoadMw", "utilization", "pue", "annualGrowthRate", "gridKgCo2ePerKwh",
        "wueLitresPerItKwh", "electricityPricePerKwh", "currency",
    })
    bounds = {
        "itLoadMw": (0, 100_000, True),
        "utilization": (0, 1, False),
        "pue": (1, 3, False),
        "annualGrowthRate": (-0.2, 0.25, False),
        "gridKgCo2ePerKwh": (0, 5, False),
        "wueLitresPerItKwh": (0, 20, False),
        "electricityPricePerKwh": (0, 5, False),
    }
    for key, (low, high, exclusive) in bounds.items():
        _number(assumptions[key], f"assumptions.{key}", low, high, exclusive=exclusive)
    if not isinstance(assumptions["currency"], str) or not re.fullmatch(r"[A-Z]{3}", assumptions["currency"]):
        raise ScenarioError("assumptions.currency must be a three-letter uppercase currency code")
    return run_id, scenario


def build_manifest(request: Any) -> dict[str, Any]:
    """Return four accounting series and explicit unsupported-domain records."""
    run_id, scenario = validate_request(request)
    assumptions = scenario["assumptions"]
    series: dict[str, list[dict[str, int | float]]] = {
        "facility_electricity": [], "grid_emissions": [],
        "cooling_water_use": [], "facility_electricity_bill": [],
    }
    first_year = scenario["years"]["start"]
    for year in range(first_year, scenario["years"]["end"] + 1):
        hours = (366 if calendar.isleap(year) else 365) * 24
        it_kwh = (assumptions["itLoadMw"] * 1000 * assumptions["utilization"]
                  * hours * (1 + assumptions["annualGrowthRate"]) ** (year - first_year))
        facility_kwh = it_kwh * assumptions["pue"]
        values = {
            "facility_electricity": facility_kwh,
            "grid_emissions": facility_kwh * assumptions["gridKgCo2ePerKwh"] / 1000,
            "cooling_water_use": it_kwh * assumptions["wueLitresPerItKwh"],
            "facility_electricity_bill": facility_kwh * assumptions["electricityPricePerKwh"],
        }
        for metric, value in values.items():
            if not math.isfinite(value):
                raise ScenarioError("Scenario produced a non-finite accounting result")
            series[metric].append({"year": year, "value": value})

    metric_specs = [
        ("facility_electricity", "Facility electricity use", "energy", "kWh/year"),
        ("grid_emissions", "Estimated grid-electricity emissions", "emissions", "tonnes CO2e/year"),
        ("cooling_water_use", "Assumed onsite cooling water use", "water-use", "litres/year"),
        ("facility_electricity_bill", "Illustrative facility electricity bill", "facility-bills", f"{assumptions['currency']}/year"),
    ]
    metrics = [{
        "id": metric_id,
        "label": label,
        "domain": domain,
        "unit": unit,
        "status": "illustrative",
        "spatialResolution": "region-accounting-total",
        "temporalResolution": "annual",
        "uncertainty": {
            "status": "not_quantified",
            "reason": "Fixed assumed inputs only; no input distributions, calibration, or confidence interval is implemented.",
        },
        "series": series[metric_id],
    } for metric_id, label, domain, unit in metric_specs]
    unavailable = {
        "air-quality": "No emissions inventory, dispersion/chemistry model, or ground calibration is connected; CO2e accounting is not an air-quality prediction.",
        "water-quality": "Requires source/discharge flow, temperature and chemistry observations plus a receiving-water transport model.",
        "water-stress": "Requires withdrawals, net consumption, return flows, competing demand and calibrated watershed/groundwater supply models.",
        "household-bills": "Requires regional tariffs, household demand, infrastructure cost allocation and an electricity-market model; facility billing is not a household-rate forecast.",
        "employment": "Requires construction/operating jobs, local hiring, commuting and labor-force evidence; no employment or unemployment model is implemented.",
        "population": "Requires a demographic baseline, births, deaths and migration assumptions; no population model is implemented.",
        "land-ecosystems": "Requires observed land-cover/vegetation/temperature trends and a validated land/ecosystem model.",
        "noise": "Requires equipment sound-power/spectral data, operating schedules, background measurements, receptors and a calibrated acoustic propagation model.",
    }
    return {
        "schemaVersion": "1.0",
        "runId": run_id,
        "mode": "illustrative",
        "modelVersion": MODEL_VERSION,
        "scenarioName": scenario["name"],
        "region": deepcopy(scenario["region"]),
        "years": deepcopy(scenario["years"]),
        "provenance": {
            "kind": "synthetic",
            "sourceIds": ["synthetic-demo-inputs"],
            "assumptions": deepcopy(assumptions),
            "warnings": [
                "Illustrative accounting only: these inputs do not describe a verified real facility and these results are not validated forecasts.",
                "Annual growth compounds assumed IT load; it is not a trained model or evidence of future data-center development.",
                "Grid factors, PUE, WUE and electricity price remain fixed across the scenario; climate, grid decarbonization and efficiency changes are not modeled.",
                "Cooling water use is not net water consumption, water scarcity, groundwater decline, or water quality.",
                "Electricity bills include only the assumed energy price; demand charges, fixed fees, taxes and household tariffs are excluded.",
                "Grid CO2e estimates exclude onsite generators, construction and supply-chain emissions and do not identify the location of pollution.",
                "No statistical uncertainty or causal attribution is established. A far-future output is assumption-dependent arithmetic, not predictive skill.",
            ],
        },
        "metrics": metrics,
        "unavailable": [{"domain": domain, "reason": reason} for domain, reason in unavailable.items()],
        "layers": [],
    }
