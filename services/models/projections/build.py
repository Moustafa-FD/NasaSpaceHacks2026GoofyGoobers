"""Build per-site climate projections to 2100 from NASA NEX-GDDP-CMIP6.

    python -m services.models.projections.build                    # all sites, default ensemble
    python -m services.models.projections.build --sites ashburn --per-window 4

Output: data/cloudshadow/projections/<site>.json (small, committed) and an index.
Raw point CSVs are cached in data/raw/nexgddp/ (ignored by Git), so re-runs only
fetch what is missing and then stop. Progress goes to stderr.
"""

from __future__ import annotations

import argparse
import json
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

from . import nexgddp

ROOT = Path(__file__).resolve().parents[3]
SITES_FILE = ROOT / "data" / "cloudshadow" / "sites.json"
OUT_DIR = ROOT / "data" / "cloudshadow" / "projections"
CACHE_DIR = ROOT / "data" / "raw" / "nexgddp"
METRICS = {"tas": "meanTempC", "tasmax": "hotDays35C", "pr": "precipMmPerYear"}
UNITS = {"meanTempC": "degC (annual mean)", "hotDays35C": "days/year with daily max >= 35 degC", "precipMmPerYear": "mm/year"}


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def plan(per_window: int, models, scenarios) -> list[tuple[str, str, str, str, int]]:
    """(model, experiment, variable, window, year) tasks."""
    tasks = []
    for model in models:
        for variable in nexgddp.VARIABLES:
            for year in nexgddp.sampled_years(nexgddp.WINDOWS["historical"], per_window):
                tasks.append((model, "historical", variable, "historical", year))
            for scenario in scenarios:
                for window in ("mid", "late"):
                    for year in nexgddp.sampled_years(nexgddp.WINDOWS[window], per_window):
                        tasks.append((model, scenario, variable, window, year))
    return tasks


def summarise(site: dict, results: dict, models, scenarios, per_window: int, grid_points: set) -> dict:
    """results[(model, experiment, variable, window)] -> list of annual metric values."""
    def window_mean(model, experiment, variable, window):
        values = results.get((model, experiment, variable, window), [])
        return sum(values) / len(values) if values else None

    metrics = {}
    for variable, metric in METRICS.items():
        baseline = {m: window_mean(m, "historical", variable, "historical") for m in models}
        block = {"unit": UNITS[metric], "historical_1995_2014": {"perModel": {m: None if v is None else round(v, 3) for m, v in baseline.items()},
                                                                  **nexgddp.ensemble_summary(baseline)}}
        for scenario in scenarios:
            for window in ("mid", "late"):
                values = {m: window_mean(m, scenario, variable, window) for m in models}
                deltas = {m: None if values[m] is None or baseline[m] is None else values[m] - baseline[m] for m in models}
                start, end = nexgddp.WINDOWS[window]
                block[f"{scenario}_{start}_{end}"] = {
                    "value": nexgddp.ensemble_summary(values),
                    "changeFromHistorical": nexgddp.ensemble_summary(deltas),
                    "perModelChange": {m: None if d is None else round(d, 3) for m, d in deltas.items()},
                }
        metrics[metric] = block
    return {
        "schemaVersion": "climate-projection/1.0",
        "site": {"id": site["id"], "name": site.get("name", site["id"]), "lat": site["lat"], "lon": site["lon"]},
        "evidence": "climate-scenario",
        "evidenceNote": ("Conditional climate under SSP emission pathways from bias-corrected, downscaled CMIP6 models. "
                         "Regional 0.25-degree cell climate, not a forecast of weather or of any facility's effect. "
                         "Uncertainty shown is model spread (min-max across the ensemble), not a confidence interval."),
        "source": {"name": "NASA NEX-GDDP-CMIP6", "access": f"{nexgddp.THREDDS}/ncss/grid/{nexgddp.ROOT_PATH}",
                   "license": "CC0", "citation": "Thrasher et al. (2022), Scientific Data 9:262",
                   "retrieved": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ")},
        "gridPoints": sorted([list(p) for p in grid_points]),
        "ensemble": list(models),
        "scenarios": {"ssp245": "SSP2-4.5 (intermediate emissions)", "ssp585": "SSP5-8.5 (very high emissions)"},
        "windows": {k: list(v) for k, v in nexgddp.WINDOWS.items()},
        "sampling": {"yearsPerWindow": per_window,
                     "years": {k: nexgddp.sampled_years(v, per_window) for k, v in nexgddp.WINDOWS.items()},
                     "note": "Each 20-year window is represented by evenly spaced sample years to bound download cost."},
        "metrics": metrics,
    }


def project_point(site: dict, *, per_window: int = 4, models=nexgddp.MODELS, scenarios=nexgddp.SCENARIOS,
                  workers: int = 6, catalogs: dict | None = None, progress=None) -> dict:
    """Climate-projection summary for one point (``site`` needs id, lat, lon)."""
    if catalogs is None:
        catalogs = {(m, e, v): nexgddp.list_files(m, e, v) for m in models for e in ("historical", *scenarios)
                    for v in nexgddp.VARIABLES}
    tasks = plan(per_window, models, scenarios)
    results: dict = {}
    grid_points: set = set()
    failures = 0

    def run(task):
        model, experiment, variable, window, year = task
        ref = catalogs[(model, experiment, variable)].get(year)
        if ref is None:
            raise nexgddp.ProjectionError(f"{model} {experiment} {variable} {year}: file not listed")
        daily, point = nexgddp.fetch_point_year(ref, site["lat"], site["lon"], CACHE_DIR)
        return task, nexgddp.annual_metric(variable, daily), point

    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(run, t) for t in tasks]
        for done, future in enumerate(as_completed(futures), 1):
            try:
                (model, experiment, variable, window, _), metric, point = future.result()
            except nexgddp.ProjectionError as error:
                failures += 1
                log(f"  {site['id']}: {error}")
                continue
            grid_points.add((round(point[0], 3), round(point[1], 3)))
            if metric is not None:
                results.setdefault((model, experiment, variable, window), []).append(metric[METRICS[variable]])
            if progress:
                progress(done, len(tasks))
    if failures > len(tasks) // 4:
        raise nexgddp.ProjectionError(f"{failures} of {len(tasks)} requests failed; projection not reliable")
    summary = summarise(site, results, models, scenarios, per_window, grid_points)
    summary["coverage"] = {"requested": len(tasks), "failed": failures}
    return summary


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build NEX-GDDP-CMIP6 climate projections per site.")
    parser.add_argument("--sites", default="all")
    parser.add_argument("--per-window", type=int, default=4)
    parser.add_argument("--workers", type=int, default=6)
    parser.add_argument("--out", default=str(OUT_DIR))
    args = parser.parse_args(argv)
    if not 1 <= args.per_window <= 20:
        parser.error("--per-window must be 1..20")
    sites = json.loads(SITES_FILE.read_text(encoding="utf-8"))["sites"]
    if args.sites != "all":
        sites = [s for s in sites if s["id"] in args.sites.split(",")]
    models, scenarios = nexgddp.MODELS, nexgddp.SCENARIOS

    log("listing NEX-GDDP-CMIP6 files...")
    catalogs = {}
    for model in models:
        for experiment in ("historical", *scenarios):
            for variable in nexgddp.VARIABLES:
                catalogs[(model, experiment, variable)] = nexgddp.list_files(model, experiment, variable)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    index = []
    for site in sites:
        summary = project_point(site, per_window=args.per_window, models=models, scenarios=scenarios, workers=args.workers,
                                catalogs=catalogs, progress=lambda d, n, s=site: d % 50 == 0 and log(f"  {s['id']}: {d}/{n}"))
        failures = summary["coverage"]["failed"]
        (out_dir / f"{site['id']}.json").write_text(json.dumps(summary, indent=1, allow_nan=False), encoding="utf-8")
        index.append({"site": site["id"], "file": f"{site['id']}.json", "failed": failures})
        t = summary["metrics"]["meanTempC"]
        log(f"{site['id']}: historical {t['historical_1995_2014']['median']} C; ssp585 late change "
            f"{t['ssp585_2081_2100']['changeFromHistorical']['median']} C ({failures} failed)")
    (out_dir / "index.json").write_text(json.dumps({"schemaVersion": "climate-projection-index/1.0", "products": index}, indent=1),
                                        encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
