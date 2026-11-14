"""Time-series loading, aggregation, anomalies and missing-data reporting.

Missing values are kept as ``None`` (never zero) so gaps stay visible in
reports and charts. Statistics in ``stats.py`` receive only valid points.
"""

from __future__ import annotations

import csv
import math
import re
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Iterable, Sequence


class SeriesError(ValueError):
    """A time series could not be read or prepared."""


@dataclass(frozen=True)
class Observation:
    day: date
    value: float | None


@dataclass(frozen=True)
class MonthlyValue:
    year: int
    month: int
    value: float | None
    count: int = 0

    @property
    def decimal_year(self) -> float:
        return self.year + (self.month - 0.5) / 12.0


@dataclass(frozen=True)
class AnnualValue:
    year: int
    value: float | None
    months: int = 0

    @property
    def decimal_year(self) -> float:
        return self.year + 0.5


@dataclass
class TimeSeries:
    observations: list[Observation]
    value_column: str
    metadata: dict[str, str] = field(default_factory=dict)
    fill_values: tuple[float, ...] = ()


_DATE_PATTERNS = (
    (re.compile(r"^(\d{4})-(\d{2})-(\d{2})(?:[T ][\d:.]+Z?)?$"), 3),
    (re.compile(r"^(\d{4})-(\d{2})$"), 2),
    (re.compile(r"^(\d{4})$"), 1),
)
_MISSING_TEXT = {"", "nan", "na", "n/a", "null", "none", "-"}


def parse_date(text: str) -> date:
    stripped = text.strip()
    for pattern, parts in _DATE_PATTERNS:
        match = pattern.match(stripped)
        if match:
            year = int(match.group(1))
            month = int(match.group(2)) if parts >= 2 else 1
            day = int(match.group(3)) if parts == 3 else 1
            try:
                return date(year, month, day)
            except ValueError as error:
                raise SeriesError(f"invalid date {text!r}") from error
    raise SeriesError(f"unsupported date format {text!r}; use YYYY-MM-DD, YYYY-MM or YYYY")


def _parse_value(text: str, fill_values: Iterable[float]) -> float | None:
    stripped = text.strip()
    if stripped.lower() in _MISSING_TEXT:
        return None
    try:
        value = float(stripped)
    except ValueError as error:
        raise SeriesError(f"non-numeric value {text!r}") from error
    if not math.isfinite(value):
        return None
    for fill in fill_values:
        if math.isclose(value, fill, rel_tol=0.0, abs_tol=1e-9 * max(1.0, abs(fill))):
            return None
    return value


def read_time_series_csv(path: str | Path, *, value_column: str | None = None,
                         fill_values: Sequence[float] = ()) -> TimeSeries:
    """Read a CSV with an optional metadata preamble and a ``time``/``date`` header.

    Designed for area-average exports such as Giovanni's: ``key:,value`` rows
    before the header become metadata, and any metadata key containing
    "fill value" is treated as a missing-value marker. Verify the parser against
    each real export format before relying on it.
    """
    with open(path, newline="", encoding="utf-8-sig") as handle:
        rows = list(csv.reader(handle))
    metadata: dict[str, str] = {}
    header_index = None
    for index, row in enumerate(rows):
        cells = [c.strip() for c in row]
        if cells and cells[0].lower() in {"time", "date"}:
            header_index = index
            break
        if len(cells) >= 2 and cells[0]:
            metadata[cells[0].rstrip(":").strip()] = cells[1]
    if header_index is None:
        raise SeriesError("no header row starting with 'time' or 'date' was found")

    fills = list(fill_values)
    for key, text in metadata.items():
        if "fill value" in key.lower():
            try:
                fills.append(float(text))
            except ValueError:
                pass

    header = [c.strip() for c in rows[header_index]]
    if value_column is None:
        candidates = [h for h in header[1:] if h]
        if len(candidates) != 1:
            raise SeriesError(f"choose a value column from: {', '.join(candidates) or 'none'}")
        value_column = candidates[0]
    if value_column not in header:
        raise SeriesError(f"value column {value_column!r} not found")
    column = header.index(value_column)

    observations = []
    seen: set[date] = set()
    for row in rows[header_index + 1:]:
        if not row or not row[0].strip():
            continue
        day = parse_date(row[0])
        if day in seen:
            raise SeriesError(f"duplicate time {row[0]!r}")
        seen.add(day)
        text = row[column] if column < len(row) else ""
        observations.append(Observation(day, _parse_value(text, fills)))
    if not observations:
        raise SeriesError("the file contains no data rows")
    observations.sort(key=lambda o: o.day)
    return TimeSeries(observations, value_column, metadata, tuple(fills))


def to_monthly(observations: Sequence[Observation], *, min_count: int = 1) -> list[MonthlyValue]:
    """Mean of valid observations per calendar month, on a gap-free monthly grid.

    Months with fewer than ``min_count`` valid observations become ``None``.
    For daily input choose ``min_count`` deliberately (for example 15).
    """
    if min_count < 1:
        raise SeriesError("min_count must be at least 1")
    if not observations:
        return []
    buckets: dict[tuple[int, int], list[float]] = {}
    for obs in observations:
        bucket = buckets.setdefault((obs.day.year, obs.day.month), [])
        if obs.value is not None:
            bucket.append(obs.value)
    first = min(buckets)
    last = max(buckets)
    result = []
    year, month = first
    while (year, month) <= last:
        values = buckets.get((year, month), [])
        mean = sum(values) / len(values) if len(values) >= min_count else None
        result.append(MonthlyValue(year, month, mean, len(values)))
        month += 1
        if month == 13:
            year, month = year + 1, 1
    return result


def to_annual(monthly: Sequence[MonthlyValue], *, min_months: int = 10,
              deseasonalize: bool = True) -> list[AnnualValue]:
    """Annual values from monthly values (``None`` below ``min_months`` valid months).

    With ``deseasonalize`` (default) each year is the mean monthly climatology plus
    the mean anomaly of its valid months. A plain average would be biased whenever
    a month is missing from a series with a seasonal cycle (a missing winter month
    makes the year look warmer). Requires all 12 calendar months in the record.
    """
    if not 1 <= min_months <= 12:
        raise SeriesError("min_months must be between 1 and 12")
    climatology = monthly_climatology(monthly) if deseasonalize else {}
    if deseasonalize and len(climatology) < 12:
        raise SeriesError("deseasonalized annual values need every calendar month in the record")
    level = sum(climatology.values()) / 12.0 if deseasonalize else 0.0
    by_year: dict[int, list[float]] = {}
    for item in monthly:
        values = by_year.setdefault(item.year, [])
        if item.value is not None:
            values.append(item.value - climatology[item.month] if deseasonalize else item.value)
    return [AnnualValue(year, level + sum(v) / len(v) if len(v) >= min_months else None, len(v))
            for year, v in sorted(by_year.items())]


def monthly_climatology(monthly: Sequence[MonthlyValue],
                        baseline: tuple[int, int] | None = None) -> dict[int, float]:
    sums: dict[int, list[float]] = {}
    for item in monthly:
        if item.value is None:
            continue
        if baseline and not baseline[0] <= item.year <= baseline[1]:
            continue
        sums.setdefault(item.month, []).append(item.value)
    return {month: sum(v) / len(v) for month, v in sums.items()}


def monthly_anomalies(monthly: Sequence[MonthlyValue],
                      baseline: tuple[int, int] | None = None) -> list[MonthlyValue]:
    """Subtract each calendar month's mean (over ``baseline`` years, default all)."""
    climatology = monthly_climatology(monthly, baseline)
    return [MonthlyValue(m.year, m.month,
                         m.value - climatology[m.month]
                         if m.value is not None and m.month in climatology else None,
                         m.count)
            for m in monthly]


def difference(target: Sequence[MonthlyValue], control: Sequence[MonthlyValue]) -> list[MonthlyValue]:
    """Target minus control on the months both cover; missing if either is missing."""
    control_map = {(c.year, c.month): c.value for c in control}
    result = []
    for t in target:
        key = (t.year, t.month)
        if key not in control_map:
            continue
        c = control_map[key]
        result.append(MonthlyValue(t.year, t.month,
                                   t.value - c if t.value is not None and c is not None else None))
    return result


def missing_report(values: Sequence[MonthlyValue] | Sequence[AnnualValue]) -> dict:
    total = len(values)
    valid = sum(1 for v in values if v.value is not None)
    longest = current = 0
    for v in values:
        current = current + 1 if v.value is None else 0
        longest = max(longest, current)
    return {
        "steps": total,
        "valid": valid,
        "missing": total - valid,
        "missingFraction": (total - valid) / total if total else 1.0,
        "longestGapSteps": longest,
    }
