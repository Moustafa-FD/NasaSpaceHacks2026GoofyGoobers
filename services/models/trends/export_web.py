"""Build small, source-preserving regional histories for the web dashboard.

Offline only: existing POWER snapshots are exported immediately. Giovanni CSVs
are optional local inputs, never recreated from prose findings or authenticated
with this command. Native CSVs and credentials remain outside public products.
"""
from __future__ import annotations

import argparse
import calendar
import hashlib
import json
import math
from datetime import datetime, timezone
from pathlib import Path

from . import analysis, series

ROOT = Path(__file__).resolve().parents[3]
POWER_DOC = "https://power.larc.nasa.gov/docs/services/api/temporal/monthly/"
GIOVANNI_DOC = "https://giovanni.gsfc.nasa.gov/"
GLDAS_DOC = "https://hydro1.gesdisc.eosdis.nasa.gov/data/GLDAS/GLDAS_NOAH025_3H.2.1/doc/README_GLDAS2.pdf"

POWER_VARIABLES = (
    {"id": "power-precipitation", "parameter": "PRECTOTCORR", "label": "Regional precipitation", "group": "water", "unit": "mm/day", "annualUnit": "mm/year", "aggregation": "complete-year-total", "scale": 1},
    {"id": "power-temperature", "parameter": "T2M", "label": "Regional air temperature", "group": "heat", "unit": "°C", "sourceUnit": "C", "scale": 1},
    {"id": "power-humidity", "parameter": "RH2M", "label": "Regional relative humidity", "group": "water", "unit": "%", "scale": 1},
    {"id": "power-wind", "parameter": "WS10M", "label": "Regional wind speed", "group": "air", "unit": "m/s", "scale": 1},
)

GIOVANNI_VARIABLES = (
    {"id": "giovanni-precipitation", "parameter": "GPM_3IMERGM_07_precipitation", "label": "Precipitation · GPM IMERG", "group": "water", "unit": "mm/hour", "sourceUnit": "mm/hr", "annualUnit": "mm/year", "aggregation": "complete-year-total", "dailyFactor": 24, "minCount": 1, "resolution": "0.1° native grid · regional area average", "collection": "GPM_3IMERGM", "version": "07", "evidence": "satellite-derived"},
    {"id": "giovanni-soil", "parameter": "GLDAS_NOAH025_M_2_1_SoilMoi0_10cm_inst", "label": "Topsoil water · 0–10 cm", "group": "water", "unit": "kg/m²", "sourceUnit": "kg/m^2", "minCount": 1, "resolution": "0.25° native grid · regional area average", "collection": "GLDAS_NOAH025_M", "version": "2.1", "evidence": "model-derived", "documentationUrl": GLDAS_DOC},
    {"id": "giovanni-et", "parameter": "GLDAS_NOAH025_M_2_1_Evap_tavg", "label": "Regional evapotranspiration", "group": "water", "unit": "mm/day", "sourceUnit": "kg/m^2/s", "scale": 86400, "annualUnit": "mm/year", "aggregation": "complete-year-total", "minCount": 1, "resolution": "0.25° native grid · regional area average", "collection": "GLDAS_NOAH025_M", "version": "2.1", "evidence": "model-derived", "documentationUrl": GLDAS_DOC},
    {"id": "giovanni-groundwater", "parameter": "GRACEDADM_CLSM0125US_7D_4_0_gws_inst", "label": "Groundwater condition · GRACE-DA", "group": "water", "unit": "source units", "requireSourceUnit": True, "minCount": 2, "resolution": "0.125° model grid; GRACE information has a much coarser regional footprint", "collection": "GRACEDADM_CLSM0125US_7D", "version": "4.0", "evidence": "model-derived"},
    {"id": "giovanni-no2", "parameter": "OMNO2d_003_ColumnAmountNO2TropCloudScreened", "label": "Regional NO₂ column · OMI", "group": "air", "unit": "×10¹⁵ molecules/cm²", "sourceUnit": "molecules/cm^2", "scale": 1e-15, "minCount": 15, "resolution": "0.25° native grid · regional area average", "collection": "OMNO2d", "version": "003", "evidence": "satellite-derived"},
)


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def source_url(site, weather):
    years = [row["year"] for row in weather.get("rows", []) if isinstance(row.get("year"), int)]
    dates = f"&start={min(years)}&end={max(years)}" if years else ""
    return ("https://power.larc.nasa.gov/api/temporal/monthly/point?"
            f"parameters=T2M,PRECTOTCORR,RH2M,WS10M&community=AG&latitude={site['lat']}&longitude={site['lon']}&format=JSON{dates}")


def annual_rows(monthly, definition):
    """Totals require all twelve months; mean variables use >=10 months.

    Mean histories use the existing Python seasonal-anomaly adjustment. A
    rainfall/ET total is never summed from a partial year or extrapolated.
    """
    monthly_grid = [series.MonthlyValue(int(p["date"][:4]), int(p["date"][5:7]), p["value"], p.get("count", 1)) for p in monthly]
    if definition.get("aggregation") == "complete-year-total":
        years = sorted({p.year for p in monthly_grid})
        output = []
        for year in years:
            rows = {p.month: p for p in monthly_grid if p.year == year}
            valid = [p for p in rows.values() if finite(p.value)]
            complete = len(rows) == 12 and len(valid) == 12
            value = sum(p.value * calendar.monthrange(year, p.month)[1] * definition.get("dailyFactor", 1) for p in valid) if complete else None
            output.append({"year": year, "value": value, "validMonths": len(valid), "complete": complete})
        return output
    try:
        annual = series.to_annual(monthly_grid, min_months=10)
    except series.SeriesError:
        # A seasonal correction requires every calendar month somewhere in the
        # record. Do not silently change to a seasonally biased partial mean.
        partial = series.to_annual(monthly_grid, min_months=10, deseasonalize=False)
        annual = [series.AnnualValue(p.year, None, p.months) for p in partial]
    return [{"year": p.year, "value": p.value, "validMonths": p.months, "complete": p.months == 12} for p in annual]


def finish_variable(definition, monthly, source, provenance, **extra):
    rows = annual_rows(monthly, definition)
    unit = definition.get("annualUnit", definition["unit"])
    report = analysis.analyze_annual([series.AnnualValue(p["year"], p["value"], p["validMonths"]) for p in rows], units=unit)
    valid = [p for p in monthly if finite(p["value"])]
    return {"id": definition["id"], "parameter": definition["parameter"], "label": definition["label"], "group": definition["group"], "status": "available" if valid else "no-numeric-data", "evidence": definition.get("evidence", "model-derived"), "unit": definition["unit"], "annualUnit": unit,
            "resolution": definition.get("resolution", "0.5° × 0.625° meteorological grid · regional model context"),
            "source": source, "provenance": provenance, "monthly": monthly, "annual": rows, "trend": report,
            "coverage": {"first": valid[0]["date"] if valid else None, "last": valid[-1]["date"] if valid else None, "validMonths": len(valid), "expectedMonths": len(monthly), "annualValues": sum(finite(p["value"]) for p in rows)},
            "aggregation": "Sum of source monthly mean rates × actual days in each month; all 12 months required." if definition.get("aggregation") == "complete-year-total" else "Seasonally adjusted annual mean with at least 10 valid months; gaps remain unknown.",
            "caveats": ["Regional context; not a measurement of this facility's effect.", "No annual forecast is generated from this observed record.", "A regional trend does not prove a facility caused the change."], **extra}


def power_variable(path, weather, site, definition):
    source_unit = weather.get("units", {}).get(definition["parameter"])
    expected_unit = definition.get("sourceUnit", definition["unit"])
    if source_unit != expected_unit:
        raise ValueError(f"Unexpected POWER unit for {definition['parameter']}: {source_unit!r}; expected {expected_unit!r}")
    rows = weather.get("rows", [])
    observations = []
    for row in rows:
        year, month = row.get("year"), row.get("month")
        if not isinstance(year, int) or not isinstance(month, int) or not 1 <= month <= 12:
            raise ValueError("POWER monthly row has an invalid calendar date")
        value = row.get(definition["parameter"])
        observations.append(series.Observation(series.parse_date(f"{year}-{month:02d}"), value if finite(value) and value != -999 else None))
    if len({p.day for p in observations}) != len(observations):
        raise ValueError("POWER monthly record has duplicate dates")
    monthly = [{"date": f"{p.year}-{p.month:02d}", "value": p.value, "count": p.count, "quality": "numeric" if p.value is not None else "missing"} for p in series.to_monthly(observations)]
    return finish_variable(definition, monthly, {"name": weather.get("source", "NASA POWER / MERRA-2"), "url": source_url(site, weather), "documentationUrl": POWER_DOC, "version": weather.get("api_version"), "nativeUnit": source_unit}, {"artifact": f"weather/{site['id']}.json", "sha256": sha256(path), "retrievedUtc": weather.get("retrievedUtc"), "retrievalNote": "Bundled source snapshot; original retrieval timestamp was not supplied."}, quality={"nativeQualityFlagsAvailable": False, "note": "Bundled monthly snapshot; numeric/fill status retained, retrieval-level scientific quality flags not supplied."})


def missing_giovanni(definition, reason="The source CSV is not present in this checkout; the research summary is not the underlying series."):
    return {"id": definition["id"], "parameter": definition["parameter"], "label": definition["label"], "group": definition["group"], "status": "not-imported", "evidence": definition["evidence"], "unit": definition["unit"], "annualUnit": definition.get("annualUnit", definition["unit"]), "resolution": definition["resolution"], "monthly": [], "annual": [], "trend": None, "coverage": {"first": None, "last": None, "validMonths": 0, "expectedMonths": 0, "annualValues": 0}, "source": {"name": "NASA Giovanni / GES DISC", "url": GIOVANNI_DOC, "collection": definition["collection"], "version": definition["version"], "documentationUrl": definition.get("documentationUrl", GIOVANNI_DOC)}, "reason": reason, "importCommand": "python -m services.models.trends.export_web --giovanni-dir PATH_TO_GIOVANNI_EXPORTS", "caveats": ["Not imported here does not mean NASA has no data.", "Storage percentiles, storage amounts and groundwater levels are distinct quantities; source units must be checked."] if definition.get("requireSourceUnit") else ["Not imported here does not mean NASA has no data."]}


def giovanni_variable(path, site, definition):
    if path.stat().st_size > 32 * 1024 * 1024:
        raise ValueError("Giovanni export exceeds the bounded 32 MiB input size")
    provenance_path = path.with_suffix(".provenance.json")
    if not provenance_path.exists():
        raise ValueError("Giovanni CSV requires its source .provenance.json with site, variable, collection and bbox")
    prov = json.loads(provenance_path.read_text(encoding="utf-8"))
    if prov.get("site") != site["id"] or prov.get("variable") != definition["parameter"]:
        raise ValueError("Giovanni provenance site/variable does not match this export")
    if prov.get("collection") != definition["collection"] or str(prov.get("version")) != definition["version"]:
        raise ValueError("Giovanni source collection/version does not match the configured variable")
    bbox = prov.get("bbox")
    if not isinstance(bbox, list) or len(bbox) != 4 or not all(finite(v) for v in bbox) or not bbox[0] <= site["lon"] <= bbox[2] or not bbox[1] <= site["lat"] <= bbox[3]:
        raise ValueError("Giovanni area-average bbox does not contain the selected study site")
    data = series.read_time_series_csv(path)
    if definition["parameter"] not in data.value_column:
        raise ValueError("CSV value column does not match the requested Giovanni variable")
    definition = dict(definition)
    if definition.get("requireSourceUnit"):
        native_unit = prov.get("unit") or prov.get("units") or next((v for k, v in data.metadata.items() if k.lower() in {"units", "unit", "data units"}), None)
        if not native_unit:
            raise ValueError("Groundwater units must be supplied from source metadata in CSV or provenance; never assume storage amount from a percentile product")
        definition["unit"] = str(native_unit)
        if "percent" in str(native_unit).lower() or str(native_unit).strip() == "%":
            definition["label"] = "Groundwater condition percentile · GRACE-DA"
    monthly_grid = series.to_monthly(data.observations, min_count=definition.get("minCount", 1))
    scale = definition.get("scale", 1)
    monthly = [{"date": f"{p.year}-{p.month:02d}", "value": p.value * scale if p.value is not None else None, "count": p.count, "quality": "numeric" if p.value is not None else "missing-or-insufficient-samples"} for p in monthly_grid]
    source = {"name": "NASA Giovanni / GES DISC", "url": GIOVANNI_DOC, "collection": prov.get("collection"), "version": prov.get("version"), "nativeUnit": definition.get("sourceUnit", definition["unit"]), "documentationUrl": definition.get("documentationUrl", GIOVANNI_DOC), "bbox": bbox, "conceptId": prov.get("conceptId")}
    # Allowlist source metadata. Never copy signed result URLs, auth headers or tokens.
    public_provenance = {k: prov.get(k) for k in ["retrievedUtc", "harmonyJobId", "start", "stop", "service"]}
    public_provenance.update({"sha256": sha256(path), "valueColumn": data.value_column, "conversionFactor": scale})
    return finish_variable(definition, monthly, source, public_provenance, quality={"fillValues": list(data.fill_values), "minimumSourceSamplesPerMonth": definition.get("minCount", 1), "nativeQualityFlagsAvailable": False, "note": "Giovanni area-average numeric/fill values; original pixel-level QA flags are not supplied by this CSV."})


def build_site(root, site, giovanni_dir):
    variables = []
    weather_path = root / "data" / "cloudshadow" / "weather" / f"{site['id']}.json"
    if weather_path.exists():
        weather = json.loads(weather_path.read_text(encoding="utf-8"))
        variables.extend(power_variable(weather_path, weather, site, d) for d in POWER_VARIABLES)
    for definition in GIOVANNI_VARIABLES:
        path = giovanni_dir / site["id"] / f"{definition['parameter']}.csv"
        try:
            item = giovanni_variable(path, site, definition) if path.exists() else missing_giovanni(definition)
        except (ValueError, series.SeriesError) as error:
            item = missing_giovanni(definition, f"Local export could not be imported: {error}")
        variables.append(item)
    inventory = [{"id": v["id"], "label": v["label"], "group": v["group"], "status": v["status"], "evidence": v["evidence"], "source": v["source"], "unit": v["annualUnit"], "resolution": v["resolution"], "coverage": v["coverage"], **({"reason": v["reason"]} if v.get("reason") else {})} for v in variables]
    for kind, folder, schema, label in [("satellite", "series", None, "Satellite site/nearby histories"), ("climate", "projections", "climate-projection/1.0", "CMIP6 regional scenarios"), ("power-climate", "power-projections", "power-projection/1.0", "NASA POWER annual climate simulations"), ("plume", "plumes", "plume-scenario/1.0", "Conditional dispersion screening")]:
        path = root / "data" / "cloudshadow" / folder / f"{site['id']}.json"
        if not path.exists():
            continue
        product = json.loads(path.read_text(encoding="utf-8"))
        if schema and product.get("schemaVersion") != schema:
            continue
        entry = {"id": kind, "label": label, "status": "available", "product": f"{folder}/{site['id']}.json", "evidence": product.get("evidence", "satellite-colour-class-estimate"), "sha256": sha256(path)}
        if kind == "climate":
            entry.update({"periods": product.get("windows"), "pathways": list(product.get("scenarios", {})), "resolution": "0.25° regional cell", "source": product.get("source")})
        if kind == "power-climate":
            entry.update({"period": product.get("period"), "pathways": list(product.get("scenarios", {})), "resolution": product.get("resolution"), "source": product.get("source"), "uncertainty": "No ensemble-spread interval supplied by this API response."})
        if kind == "plume":
            entry.update({"coverage": product.get("frames"), "resolution": "Source screening grid; historical wind sample", "source": {"name": "Gaussian plume / NASA GEOS-FP", "url": "https://gmao.gsfc.nasa.gov/weather_prediction/GEOS_FP/"}})
        if kind == "satellite":
            entry["variables"] = [{"id": key, "first": values.get("t", [None])[0], "last": values.get("t", [None])[-1], "samples": len(values.get("t", []))} for key, values in product.get("vars", {}).items() if values.get("t")]
        inventory.append(entry)
    fields_index = root / "data" / "cloudshadow" / "fields" / "index.json"
    if fields_index.exists():
        fields = json.loads(fields_index.read_text(encoding="utf-8"))
        available = [p for p in fields.get("products", []) if p.get("site") == site["id"] and (root / "data" / "cloudshadow" / "fields" / str(p.get("manifest", ""))).is_file()]
        if available:
            inventory.append({"id": "wind", "label": "NASA GEOS-FP analyzed wind", "status": "available", "evidence": "model_analysis", "source": {"name": fields.get("source"), "url": "https://gmao.gsfc.nasa.gov/weather_prediction/GEOS_FP/"}, "years": sorted({p["year"] for p in available}), "frames": sum(p.get("frames", 0) for p in available), "resolution": "0.25° × 0.3125° model analysis; sampled instants, not continuous observed wind"})
    return {"schemaVersion": "regional-evidence/1.0", "site": {k: site[k] for k in ["id", "name", "lat", "lon"]}, "variables": variables, "inventory": inventory, "limitations": ["Regional histories are context, not facility attribution or future predictions.", "Missing local Giovanni exports are not reconstructed from research prose.", "Native source grids cannot resolve individual buildings or streams."]}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--giovanni-dir", type=Path, default=ROOT / "data" / "raw" / "giovanni")
    parser.add_argument("--out", type=Path, default=ROOT / "data" / "cloudshadow" / "regional-evidence")
    args = parser.parse_args(argv)
    sites = json.loads((ROOT / "data" / "cloudshadow" / "sites.json").read_text(encoding="utf-8"))["sites"]
    args.out.mkdir(parents=True, exist_ok=True)
    index = []
    for site in sites:
        product = build_site(ROOT, site, args.giovanni_dir)
        (args.out / f"{site['id']}.json").write_text(json.dumps(product, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n", encoding="utf-8")
        item = {"site": site["id"], "file": f"{site['id']}.json", "availableVariables": sum(v["status"] == "available" for v in product["variables"]), "missingImports": sum(v["status"] == "not-imported" for v in product["variables"])}
        index.append(item)
        print(f"{site['id']}: {item['availableVariables']} available variables, {item['missingImports']} pending imports")
    (args.out / "index.json").write_text(json.dumps({"schemaVersion": "regional-evidence-index/1.0", "products": index}, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
