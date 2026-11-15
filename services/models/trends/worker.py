"""Trend-analysis worker for the Node environmental API (request kind ``trend-analysis``).

Reads ONE JSON request on stdin and writes ONE JSON result on stdout. Errors go
to stderr as ``{"error": {"code", "message"}}`` with exit status 1 (bad input)
or 2 (unexpected failure). Standard library only.

Request:
    {"target": {"label": str, "unit": str, "points": [{"date": "YYYY[-MM[-DD]]", "value": number|null}]},
     "control": same shape or null,
     "cadence": "monthly" | "annual", "alpha": 0.05, "minYears": 10, "minCountPerMonth": 1}
"""

from __future__ import annotations

import json
import math
import sys
from typing import Any

from . import analysis, series

MAX_POINTS = 20_000


class RequestError(ValueError):
    pass


def _points(block: Any, name: str) -> tuple[list[series.Observation], bool]:
    if not isinstance(block, dict) or not isinstance(block.get("points"), list):
        raise RequestError(f"{name}.points must be a list")
    points = block["points"]
    if not 3 <= len(points) <= MAX_POINTS:
        raise RequestError(f"{name}.points must contain 3-{MAX_POINTS} items")
    observations, seen, year_only = [], set(), True
    for item in points:
        if not isinstance(item, dict) or not isinstance(item.get("date"), str):
            raise RequestError(f"{name}.points items need a date string")
        value = item.get("value")
        if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value)):
            raise RequestError(f"{name}.points values must be finite numbers or null")
        try:
            day = series.parse_date(item["date"])
        except series.SeriesError as error:
            raise RequestError(str(error)) from error
        if day in seen:
            raise RequestError(f"{name}.points has duplicate date {item['date']}")
        seen.add(day)
        year_only = year_only and len(item["date"].strip()) == 4
        observations.append(series.Observation(day, None if value is None else float(value)))
    observations.sort(key=lambda o: o.day)
    return observations, year_only


def _annual_from_years(observations: list[series.Observation]) -> list[series.AnnualValue]:
    by_year = {o.day.year: o.value for o in observations}
    first, last = min(by_year), max(by_year)
    return [series.AnnualValue(y, by_year.get(y), 12 if by_year.get(y) is not None else 0) for y in range(first, last + 1)]


def run(request: dict[str, Any]) -> dict[str, Any]:
    cadence = request.get("cadence", "monthly")
    if cadence not in ("monthly", "annual"):
        raise RequestError("cadence must be monthly or annual")
    alpha = request.get("alpha", 0.05)
    min_years = request.get("minYears", 10)
    min_count = request.get("minCountPerMonth", 1)
    options = {"alpha": float(alpha), "min_years": int(min_years), "units": str(request["target"].get("unit", ""))}

    target, target_years = _points(request.get("target"), "target")
    control_block = request.get("control")
    if target_years and cadence != "annual":
        raise RequestError("yearly points (YYYY) require cadence 'annual'")

    def monthly(observations):
        return series.to_monthly(observations, min_count=int(min_count))

    try:
        if control_block is not None:
            control, control_years = _points(control_block, "control")
            if cadence != "monthly" or target_years or control_years:
                raise RequestError("control comparisons need monthly or finer points and cadence 'monthly'")
            report = analysis.compare_regions(monthly(target), monthly(control), **options)
        elif cadence == "annual":
            annual = _annual_from_years(target) if target_years else series.to_annual(monthly(target))
            report = analysis.analyze_annual(annual, **options)
        else:
            report = analysis.analyze_monthly(monthly(target), **options)
    except series.SeriesError as error:
        raise RequestError(str(error)) from error
    return {"engineVersion": analysis.ENGINE_VERSION, "cadence": cadence, "comparison": control_block is not None,
            "report": report}


def main() -> int:
    try:
        raw = sys.stdin.buffer.read(16_000_001)
        if len(raw) > 16_000_000:
            raise RequestError("request exceeds 16 MB")
        request = json.loads(raw.decode("utf-8"), parse_constant=lambda c: (_ for _ in ()).throw(RequestError(f"invalid number {c}")))
        if not isinstance(request, dict):
            raise RequestError("request must be a JSON object")
        result = run(request)
    except (RequestError, json.JSONDecodeError, UnicodeDecodeError) as error:
        print(json.dumps({"error": {"code": "INVALID_TREND_REQUEST", "message": str(error)}}), file=sys.stderr)
        return 1
    except Exception as error:  # pragma: no cover - unexpected failure path
        print(json.dumps({"error": {"code": "TREND_WORKER_FAILED", "message": f"{type(error).__name__}: {error}"}}), file=sys.stderr)
        return 2
    sys.stdout.write(json.dumps(result, allow_nan=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
