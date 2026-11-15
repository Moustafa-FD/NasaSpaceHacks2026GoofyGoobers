"""NASA NEX-GDDP-CMIP6 point projections to 2100 via the NCCS THREDDS NetCDF Subset Service.

NEX-GDDP-CMIP6 is bias-corrected, statistically downscaled CMIP6 daily climate at
0.25 deg (CC0). This module fetches one point-year-variable at a time as CSV
(standard library only), caches raw responses under data/raw/nexgddp/, and
summarises climate windows per model and across a small model ensemble.

These are CONDITIONAL climate scenarios (SSP pathways), not forecasts of any
facility's effect, and a 0.25 deg cell is regional, not site scale.
"""

from __future__ import annotations

import csv
import io
import math
import re
import statistics
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path

THREDDS = "https://ds.nccs.nasa.gov/thredds"
ROOT_PATH = "AMES/NEX/GDDP-CMIP6"
USER_AGENT = "climate-projection-builder/0.1"
HEAT_THRESHOLD_K = 308.15  # 35 C
MIN_DAYS = 300             # a model year has 360 (some UK models), 365 or 366 days
DAYS_PER_YEAR = 365.25     # counts and totals are normalised so 360-day calendars compare fairly

# Ensemble chosen to span warm and cool sensitivities across modelling centres.
MODELS = ("ACCESS-CM2", "GFDL-ESM4", "MPI-ESM1-2-HR", "MRI-ESM2-0", "UKESM1-0-LL")
SCENARIOS = ("ssp245", "ssp585")
VARIABLES = ("tas", "tasmax", "pr")
WINDOWS = {
    "historical": (1995, 2014),
    "mid": (2041, 2060),
    "late": (2081, 2100),
}


class ProjectionError(RuntimeError):
    pass


def sampled_years(window: tuple[int, int], per_window: int) -> list[int]:
    """Evenly spaced years inside an inclusive window (mid-interval sampling)."""
    start, end = window
    n = end - start + 1
    return sorted({start + int((k + 0.5) * n / per_window) for k in range(per_window)})


def _get(url: str, timeout: float = 180, retries: int = 3) -> str:
    last: Exception | None = None
    for attempt in range(retries):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.read().decode("utf-8", errors="replace")
        except (urllib.error.URLError, TimeoutError) as error:
            last = error
            time.sleep(3 * (attempt + 1))
    raise ProjectionError(f"request failed after {retries} attempts: {last}")


@dataclass(frozen=True)
class FileRef:
    model: str
    experiment: str
    variant: str
    variable: str
    year: int
    name: str

    @property
    def path(self) -> str:
        return f"{ROOT_PATH}/{self.model}/{self.experiment}/{self.variant}/{self.variable}/{self.name}"


_FILE = re.compile(r'name="(([a-z]+)_day_([^_]+)_([a-z0-9]+)_(r\d+i\d+p\d+f\d+)_(g[a-z0-9]+)_(\d{4})(?:_v(\d+\.\d+))?\.nc)"')


def list_files(model: str, experiment: str, variable: str) -> dict[int, FileRef]:
    """Year -> newest file version for one model/experiment/variable (first run variant listed)."""
    catalog = _get(f"{THREDDS}/catalog/{ROOT_PATH}/{model}/{experiment}/catalog.xml")
    variants = re.findall(r'xlink:title="(r\d+i\d+p\d+f\d+)"', catalog)
    if not variants:
        raise ProjectionError(f"{model} {experiment}: no run variant in catalog")
    variant = sorted(variants)[0]
    listing = _get(f"{THREDDS}/catalog/{ROOT_PATH}/{model}/{experiment}/{variant}/{variable}/catalog.xml")
    best: dict[int, tuple[float, FileRef]] = {}
    for name, var, mdl, exp, run, grid, year, version in _FILE.findall(listing):
        if var != variable:
            continue
        v = float(version) if version else 0.0
        ref = FileRef(model, experiment, variant, variable, int(year), name)
        if int(year) not in best or v > best[int(year)][0]:
            best[int(year)] = (v, ref)
    if not best:
        raise ProjectionError(f"{model} {experiment} {variable}: no files listed")
    return {year: ref for year, (_, ref) in best.items()}


def point_url(ref: FileRef, lat: float, lon: float) -> str:
    # temporal=all is required: without a time parameter NCSS returns a single time step.
    query = urllib.parse.urlencode({"var": ref.variable, "latitude": f"{lat:.4f}", "longitude": f"{lon % 360:.4f}",
                                    "temporal": "all", "accept": "csv"})
    return f"{THREDDS}/ncss/grid/{ref.path}?{query}"


def parse_point_csv(text: str, variable: str) -> tuple[list[float | None], tuple[float, float]]:
    """Daily values (None for missing) and the grid point actually used."""
    rows = list(csv.reader(io.StringIO(text)))
    if not rows or not rows[0] or not rows[0][0].startswith("time"):
        raise ProjectionError("unexpected NCSS response: " + text[:200].replace("\n", " "))
    header = rows[0]
    column = next((i for i, h in enumerate(header) if h.startswith(variable + "[") or h == variable), None)
    lat_col = next((i for i, h in enumerate(header) if h.startswith("latitude")), None)
    lon_col = next((i for i, h in enumerate(header) if h.startswith("longitude")), None)
    if column is None:
        raise ProjectionError(f"column {variable} not in NCSS response")
    values: list[float | None] = []
    point = (math.nan, math.nan)
    for row in rows[1:]:
        if len(row) <= column:
            continue
        try:
            x = float(row[column])
            values.append(x if math.isfinite(x) and abs(x) < 1e19 else None)
        except ValueError:
            values.append(None)
        if lat_col is not None and lon_col is not None and math.isnan(point[0]):
            point = (float(row[lat_col]), float(row[lon_col]))
    if len(values) < MIN_DAYS:
        raise ProjectionError(f"NCSS returned {len(values)} days; a full model year (>= {MIN_DAYS}) is required")
    return values, point


def annual_metric(variable: str, daily: list[float | None]) -> dict[str, float] | None:
    """Annual summary for one year of daily values; None if more than 10% are missing."""
    valid = [x for x in daily if x is not None]
    if len(valid) < 0.9 * len(daily):
        return None
    if variable == "tas":
        return {"meanTempC": statistics.fmean(valid) - 273.15}
    if variable == "tasmax":
        return {"hotDays35C": sum(1 for x in valid if x >= HEAT_THRESHOLD_K) * DAYS_PER_YEAR / len(valid)}
    if variable == "pr":
        return {"precipMmPerYear": statistics.fmean(valid) * 86400.0 * DAYS_PER_YEAR}
    raise ProjectionError(f"unsupported variable {variable}")


def fetch_point_year(ref: FileRef, lat: float, lon: float, cache_dir: Path) -> tuple[list[float | None], tuple[float, float]]:
    cache = cache_dir / ref.model / ref.experiment / f"{ref.variable}_{ref.year}_{lat:.3f}_{lon:.3f}.csv"
    if cache.exists():
        text = cache.read_text(encoding="utf-8")
    else:
        text = _get(point_url(ref, lat, lon))
        parse_point_csv(text, ref.variable)  # validate before caching
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(text, encoding="utf-8")
    return parse_point_csv(text, ref.variable)


def ensemble_summary(per_model: dict[str, float | None]) -> dict[str, float | int | None]:
    values = sorted(v for v in per_model.values() if v is not None)
    if not values:
        return {"median": None, "min": None, "max": None, "models": 0}
    return {"median": round(statistics.median(values), 3), "min": round(values[0], 3), "max": round(values[-1], 3),
            "models": len(values)}
