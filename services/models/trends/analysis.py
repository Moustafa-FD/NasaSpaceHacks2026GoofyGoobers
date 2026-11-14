"""Trend reports for monthly or annual regional time series.

A report combines a non-parametric test (Mann-Kendall + Sen's slope) with a
parametric one (least-squares t-test), states whether the record is long and
complete enough, and never turns missing data into numbers.
"""

from __future__ import annotations

import math
from typing import Any, Sequence

from . import stats
from .series import AnnualValue, MonthlyValue, difference, missing_report, monthly_anomalies

ENGINE_VERSION = "trend-engine-v0.1"

ATTRIBUTION_NOTE = (
    "A trend shows that a variable changed in this region; it does not show what caused the change. "
    "Compare with a similar control region and facility records before attributing it to any source."
)
METHOD_NOTE = (
    "Detects monotonic/linear change only. Non-linear changes, step changes and correlation "
    "between seasons are not modeled."
)


def _per_decade(value: float | None) -> float | None:
    return None if value is None else value * 10.0


def _finite(value: float | None) -> float | None:
    return value if value is not None and math.isfinite(value) else None


def _fmt(value: float | None) -> str:
    return "n/a" if value is None else f"{value:.3g}"


def _sen_block(sen: stats.SenSlope) -> dict[str, Any]:
    return {
        "slopePerDecade": _per_decade(sen.slope),
        "ciPerDecade": [_per_decade(sen.ci_low), _per_decade(sen.ci_high)],
        "pairs": sen.n_slopes,
    }


def _mk_block(mk: stats.MannKendall, alpha: float) -> dict[str, Any]:
    return {
        "variant": mk.variant,
        "s": mk.s,
        "varianceS": mk.var_s,
        "varianceCorrectionFactor": mk.variance_correction_factor,
        "z": mk.z,
        "pValue": mk.p_value,
        "tau": mk.tau,
        "n": mk.n,
        "significant": mk.p_value < alpha,
    }


def _linear_block(lin: stats.LinearTrend, alpha: float) -> dict[str, Any]:
    return {
        "slopePerDecade": _per_decade(lin.slope),
        "standardErrorPerDecade": _per_decade(lin.standard_error),
        "ciPerDecade": [_per_decade(lin.ci_low), _per_decade(lin.ci_high)],
        "tStatistic": _finite(lin.t_statistic),
        "degreesOfFreedom": lin.degrees_of_freedom,
        "pValue": lin.p_value,
        "rSquared": lin.r_squared,
        "n": lin.n,
        "lag1Autocorrelation": lin.lag1_autocorrelation,
        "effectiveN": lin.effective_n,
        "autocorrelationAdjusted": lin.autocorrelation_adjusted,
        "significant": lin.p_value is not None and lin.p_value < alpha,
        "note": lin.note,
    }


def _verdict(mk: stats.MannKendall, sen: stats.SenSlope, lin: stats.LinearTrend,
             alpha: float, units: str) -> tuple[str, str]:
    confidence = f"{(1 - alpha) * 100:g}%"
    unit_text = f" {units}" if units else ""
    if mk.p_value < alpha and sen.slope != 0:
        direction = "increasing" if sen.slope > 0 else "decreasing"
        summary = (f"{direction.capitalize()} by about {_fmt(_per_decade(sen.slope))}{unit_text} per decade "
                   f"(Sen's slope; {confidence} CI {_fmt(_per_decade(sen.ci_low))} to "
                   f"{_fmt(_per_decade(sen.ci_high))}). Mann-Kendall p = {_fmt(mk.p_value)}, "
                   f"significant at the {confidence} level.")
    else:
        direction = "no significant trend"
        leaning = "upward" if sen.slope > 0 else "downward" if sen.slope < 0 else "flat"
        summary = (f"No statistically significant trend at the {confidence} level "
                   f"(Mann-Kendall p = {_fmt(mk.p_value)}). The estimate leans {leaning} at "
                   f"{_fmt(_per_decade(sen.slope))}{unit_text} per decade; a longer record may change this.")
    if lin.p_value is not None:
        agree = (lin.p_value < alpha) == (mk.p_value < alpha)
        summary += (f" The least-squares t-test (p = {_fmt(lin.p_value)}) "
                    f"{'agrees' if agree else 'disagrees; treat the result cautiously'}.")
    return direction, summary


def _insufficient(cadence: str, units: str, alpha: float, report: dict, reasons: list[str],
                  period: dict | None) -> dict[str, Any]:
    return {
        "engineVersion": ENGINE_VERSION,
        "status": "insufficient_data",
        "cadence": cadence,
        "units": units,
        "alpha": alpha,
        "period": period,
        "missing": report,
        "reasons": reasons,
        "limitations": [ATTRIBUTION_NOTE],
    }


def _period(values: Sequence[MonthlyValue] | Sequence[AnnualValue]) -> dict | None:
    valid = [v for v in values if v.value is not None]
    if not valid:
        return None
    first, last = valid[0], valid[-1]
    if isinstance(first, MonthlyValue):
        return {"start": f"{first.year:04d}-{first.month:02d}", "end": f"{last.year:04d}-{last.month:02d}"}
    return {"start": str(first.year), "end": str(last.year)}


def analyze_monthly(monthly: Sequence[MonthlyValue], *, alpha: float = 0.05, min_years: int = 10,
                    max_missing_fraction: float = 0.2, min_per_month: int = 5, units: str = "",
                    baseline: tuple[int, int] | None = None) -> dict[str, Any]:
    """Seasonal Mann-Kendall + seasonal Sen slope on monthly values, and an
    autocorrelation-adjusted least-squares t-test on monthly anomalies."""
    report = missing_report(monthly)
    period = _period(monthly)
    valid = [m for m in monthly if m.value is not None]
    reasons = []
    if not valid:
        return _insufficient("monthly", units, alpha, report, ["No valid values."], None)
    span_years = valid[-1].year - valid[0].year + 1
    if span_years < min_years:
        reasons.append(f"Record spans {span_years} years; at least {min_years} are required.")
    if report["missingFraction"] > max_missing_fraction:
        reasons.append(f"{report['missingFraction']:.0%} of months are missing; "
                       f"at most {max_missing_fraction:.0%} is allowed.")
    seasons: dict[int, list[tuple[float, float]]] = {}
    for m in valid:
        seasons.setdefault(m.month, []).append((m.decimal_year, m.value))
    usable = [s for s in seasons.values() if len(s) >= min_per_month]
    if not usable:
        reasons.append(f"No calendar month has {min_per_month} or more valid years.")
    if reasons:
        return _insufficient("monthly", units, alpha, report, reasons, period)

    mk, sen = stats.seasonal_mann_kendall(usable, alpha=alpha)
    anomalies = [a for a in monthly_anomalies(monthly, baseline) if a.value is not None]
    lin = stats.linear_trend([a.decimal_year for a in anomalies], [a.value for a in anomalies],
                             alpha=alpha, adjust_autocorrelation=True)
    direction, summary = _verdict(mk, sen, lin, alpha, units)
    limitations = [ATTRIBUTION_NOTE, METHOD_NOTE]
    skipped = sorted(set(range(1, 13)) - {month for month, s in seasons.items() if len(s) >= min_per_month})
    if skipped:
        limitations.append(f"Calendar months excluded from the seasonal test for too few years: {skipped}.")
    return {
        "engineVersion": ENGINE_VERSION,
        "status": "ok",
        "cadence": "monthly",
        "units": units,
        "alpha": alpha,
        "period": period,
        "missing": report,
        "direction": direction,
        "summary": summary,
        "sen": _sen_block(sen),
        "mannKendall": _mk_block(mk, alpha),
        "linear": _linear_block(lin, alpha),
        "deseasonalized": True,
        "anomalyBaseline": list(baseline) if baseline else "full record",
        "limitations": limitations,
    }


def analyze_annual(annual: Sequence[AnnualValue], *, alpha: float = 0.05, min_years: int = 10,
                   max_missing_fraction: float = 0.2, units: str = "") -> dict[str, Any]:
    """Hamed-Rao corrected Mann-Kendall, Sen slope and adjusted t-test on annual values."""
    report = missing_report(annual)
    period = _period(annual)
    valid = [a for a in annual if a.value is not None]
    reasons = []
    if len(valid) < min_years:
        reasons.append(f"{len(valid)} valid years; at least {min_years} are required.")
    if report["missingFraction"] > max_missing_fraction:
        reasons.append(f"{report['missingFraction']:.0%} of years are missing; "
                       f"at most {max_missing_fraction:.0%} is allowed.")
    if reasons:
        return _insufficient("annual", units, alpha, report, reasons, period)
    times = [a.decimal_year for a in valid]
    values = [a.value for a in valid]
    mk = stats.mann_kendall(times, values, alpha=alpha, hamed_rao=True)
    sen = stats.sens_slope(times, values, alpha=alpha)
    lin = stats.linear_trend(times, values, alpha=alpha, adjust_autocorrelation=True)
    direction, summary = _verdict(mk, sen, lin, alpha, units)
    return {
        "engineVersion": ENGINE_VERSION,
        "status": "ok",
        "cadence": "annual",
        "units": units,
        "alpha": alpha,
        "period": period,
        "missing": report,
        "direction": direction,
        "summary": summary,
        "sen": _sen_block(sen),
        "mannKendall": _mk_block(mk, alpha),
        "linear": _linear_block(lin, alpha),
        "deseasonalized": False,
        "limitations": [ATTRIBUTION_NOTE, METHOD_NOTE],
    }


def compare_regions(target: Sequence[MonthlyValue], control: Sequence[MonthlyValue],
                    **options: Any) -> dict[str, Any]:
    """Trend of (target - control): change in the target beyond the control's change.

    A significant difference trend means the regions diverged; it still is not
    proof that a particular facility caused the divergence.
    """
    diff = difference(target, control)
    result = {
        "target": analyze_monthly(target, **options),
        "control": analyze_monthly(control, **options),
        "difference": analyze_monthly(diff, **options),
    }
    result["difference"]["limitations"] = [
        "The difference trend is the change in the target region beyond the control region's change. "
        "Regions can diverge for many reasons (land use, traffic, weather patterns), so this is "
        "evidence to investigate, not proof of a facility effect.",
        METHOD_NOTE,
    ]
    return result
