"""Trend and significance statistics using only the Python standard library.

Methods implemented (all two-sided):

* Ordinary least-squares slope with a t-test and confidence interval, optionally
  using a lag-1 autocorrelation effective sample size (Santer et al., 2000).
* Mann-Kendall test with tie correction and continuity correction
  (Mann, 1945; Kendall, 1975), optionally with the Hamed & Rao (1998)
  variance correction for serially correlated data.
* Sen's slope (Sen, 1968) with the Gilbert (1987) rank-based confidence interval,
  matching scipy.stats.theilslopes for untied times.
* Seasonal Mann-Kendall (Hirsch, Slack & Smith, 1982) and the seasonal Sen slope.
* Benjamini-Hochberg false-discovery-rate adjustment for many-location tests.

Times are numeric (for example decimal years) so unevenly spaced samples are
supported. Inputs must already be finite; missing values are removed by the
caller (see ``series.py``). The O(n^2) pairwise methods are intended for monthly
or annual series (hundreds of points), not raw daily records.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from statistics import NormalDist, median
from typing import Sequence

_NORMAL = NormalDist()


class TrendInputError(ValueError):
    """Inputs cannot support the requested statistic."""


# --------------------------------------------------------------------------- #
# Distribution helpers
# --------------------------------------------------------------------------- #

def _betacf(a: float, b: float, x: float) -> float:
    """Continued fraction for the regularized incomplete beta (modified Lentz)."""
    fpmin = 1e-300
    qab, qap, qam = a + b, a + 1.0, a - 1.0
    c = 1.0
    d = 1.0 - qab * x / qap
    d = 1.0 / (d if abs(d) > fpmin else fpmin)
    h = d
    for m in range(1, 500):
        m2 = 2 * m
        aa = m * (b - m) * x / ((qam + m2) * (a + m2))
        d = 1.0 + aa * d
        d = 1.0 / (d if abs(d) > fpmin else fpmin)
        c = 1.0 + aa / c
        c = c if abs(c) > fpmin else fpmin
        h *= d * c
        aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))
        d = 1.0 + aa * d
        d = 1.0 / (d if abs(d) > fpmin else fpmin)
        c = 1.0 + aa / c
        c = c if abs(c) > fpmin else fpmin
        delta = d * c
        h *= delta
        if abs(delta - 1.0) < 1e-15:
            return h
    raise ArithmeticError("incomplete beta continued fraction did not converge")


def regularized_incomplete_beta(a: float, b: float, x: float) -> float:
    if a <= 0 or b <= 0:
        raise TrendInputError("beta parameters must be positive")
    if x <= 0.0:
        return 0.0
    if x >= 1.0:
        return 1.0
    log_front = (math.lgamma(a + b) - math.lgamma(a) - math.lgamma(b)
                 + a * math.log(x) + b * math.log1p(-x))
    front = math.exp(log_front)
    if x < (a + 1.0) / (a + b + 2.0):
        return front * _betacf(a, b, x) / a
    return 1.0 - front * _betacf(b, a, 1.0 - x) / b


def t_two_sided_p(t: float, df: float) -> float:
    """Two-sided p-value of Student's t with (possibly non-integer) df."""
    if df <= 0:
        raise TrendInputError("degrees of freedom must be positive")
    if math.isinf(t):
        return 0.0
    return regularized_incomplete_beta(df / 2.0, 0.5, df / (df + t * t))


def t_critical(alpha: float, df: float) -> float:
    """Positive t such that the two-sided tail probability equals alpha."""
    if not 0 < alpha < 1:
        raise TrendInputError("alpha must be between 0 and 1")
    low, high = 0.0, 1.0
    while t_two_sided_p(high, df) > alpha:
        high *= 2.0
        if high > 1e12:
            raise ArithmeticError("t critical value search diverged")
    for _ in range(200):
        mid = (low + high) / 2.0
        if t_two_sided_p(mid, df) > alpha:
            low = mid
        else:
            high = mid
    return (low + high) / 2.0


def normal_two_sided_p(z: float) -> float:
    return 2.0 * (1.0 - _NORMAL.cdf(abs(z)))


def z_critical(alpha: float) -> float:
    if not 0 < alpha < 1:
        raise TrendInputError("alpha must be between 0 and 1")
    return _NORMAL.inv_cdf(1.0 - alpha / 2.0)


# --------------------------------------------------------------------------- #
# Small utilities
# --------------------------------------------------------------------------- #

def _check_pairs(times: Sequence[float], values: Sequence[float], minimum: int) -> None:
    if len(times) != len(values):
        raise TrendInputError("times and values must have equal length")
    if len(values) < minimum:
        raise TrendInputError(f"at least {minimum} points are required")
    for item in (*times, *values):
        if isinstance(item, bool) or not isinstance(item, (int, float)) or not math.isfinite(item):
            raise TrendInputError("times and values must be finite numbers")


def _sorted_by_time(times: Sequence[float], values: Sequence[float]) -> tuple[list[float], list[float]]:
    pairs = sorted(zip(times, values), key=lambda p: p[0])
    return [float(p[0]) for p in pairs], [float(p[1]) for p in pairs]


def rankdata(values: Sequence[float]) -> list[float]:
    """1-based ranks with ties given their average rank."""
    order = sorted(range(len(values)), key=lambda i: values[i])
    ranks = [0.0] * len(values)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and values[order[j + 1]] == values[order[i]]:
            j += 1
        average = (i + j) / 2.0 + 1.0
        for k in range(i, j + 1):
            ranks[order[k]] = average
        i = j + 1
    return ranks


def autocorrelation(values: Sequence[float], lag: int) -> float:
    """Sample autocorrelation (biased estimator, as in statsmodels.acf)."""
    n = len(values)
    if lag < 0 or lag >= n:
        raise TrendInputError("lag must be within the series length")
    mean = sum(values) / n
    denominator = sum((v - mean) ** 2 for v in values)
    if denominator == 0:
        return 0.0
    numerator = sum((values[i] - mean) * (values[i + lag] - mean) for i in range(n - lag))
    return numerator / denominator


def _tie_term(values: Sequence[float]) -> float:
    counts: dict[float, int] = {}
    for v in values:
        counts[v] = counts.get(v, 0) + 1
    return sum(t * (t - 1) * (2 * t + 5) for t in counts.values() if t > 1)


def _mk_s(values: Sequence[float]) -> int:
    n = len(values)
    s = 0
    for i in range(n - 1):
        vi = values[i]
        for j in range(i + 1, n):
            diff = values[j] - vi
            if diff > 0:
                s += 1
            elif diff < 0:
                s -= 1
    return s


def _mk_var(values: Sequence[float]) -> float:
    n = len(values)
    return (n * (n - 1) * (2 * n + 5) - _tie_term(values)) / 18.0


def _mk_z(s: float, var_s: float) -> float:
    if var_s <= 0:
        return 0.0
    if s > 0:
        return (s - 1) / math.sqrt(var_s)
    if s < 0:
        return (s + 1) / math.sqrt(var_s)
    return 0.0


def _pairwise_slopes(times: Sequence[float], values: Sequence[float]) -> list[float]:
    slopes = []
    n = len(values)
    for i in range(n - 1):
        for j in range(i + 1, n):
            dt = times[j] - times[i]
            if dt != 0:
                slopes.append((values[j] - values[i]) / dt)
    return slopes


# --------------------------------------------------------------------------- #
# Results
# --------------------------------------------------------------------------- #

@dataclass(frozen=True)
class LinearTrend:
    slope: float
    intercept: float
    standard_error: float | None
    t_statistic: float | None
    degrees_of_freedom: float | None
    p_value: float | None
    ci_low: float | None
    ci_high: float | None
    r_squared: float
    n: int
    lag1_autocorrelation: float
    effective_n: float
    autocorrelation_adjusted: bool
    note: str | None = None


@dataclass(frozen=True)
class MannKendall:
    variant: str
    s: float
    var_s: float
    z: float
    p_value: float
    tau: float
    n: int
    variance_correction_factor: float = 1.0


@dataclass(frozen=True)
class SenSlope:
    slope: float
    intercept: float
    ci_low: float | None
    ci_high: float | None
    n_slopes: int


# --------------------------------------------------------------------------- #
# Tests
# --------------------------------------------------------------------------- #

def linear_trend(times: Sequence[float], values: Sequence[float], *, alpha: float = 0.05,
                 adjust_autocorrelation: bool = True) -> LinearTrend:
    """OLS slope with t-test. With ``adjust_autocorrelation`` the residual lag-1
    autocorrelation r1 > 0 shrinks the sample to n_eff = n(1 - r1)/(1 + r1)
    (Santer et al., 2000) for the standard error and degrees of freedom."""
    _check_pairs(times, values, 3)
    t, y = _sorted_by_time(times, values)
    n = len(y)
    mean_t = sum(t) / n
    mean_y = sum(y) / n
    sxx = sum((ti - mean_t) ** 2 for ti in t)
    if sxx == 0:
        raise TrendInputError("times must not all be equal")
    sxy = sum((ti - mean_t) * (yi - mean_y) for ti, yi in zip(t, y))
    slope = sxy / sxx
    intercept = mean_y - slope * mean_t
    residuals = [yi - (intercept + slope * ti) for ti, yi in zip(t, y)]
    sse = sum(r * r for r in residuals)
    syy = sum((yi - mean_y) ** 2 for yi in y)
    r_squared = 1.0 - sse / syy if syy > 0 else 0.0
    r1 = autocorrelation(residuals, 1) if n > 2 else 0.0

    effective_n = float(n)
    adjusted = False
    if adjust_autocorrelation and r1 > 0:
        effective_n = n * (1.0 - r1) / (1.0 + r1)
        adjusted = True
    df = effective_n - 2.0
    if df <= 0:
        return LinearTrend(slope, intercept, None, None, None, None, None, None, r_squared, n, r1,
                           effective_n, adjusted,
                           "Serial correlation leaves too few effective samples for a t-test.")
    standard_error = math.sqrt(sse / df / sxx)
    if standard_error == 0:
        p_value = 0.0 if slope != 0 else 1.0
        t_stat = math.copysign(math.inf, slope) if slope != 0 else 0.0
        return LinearTrend(slope, intercept, 0.0, t_stat, df, p_value, slope, slope, r_squared, n,
                           r1, effective_n, adjusted, "Residuals are exactly zero (perfect fit).")
    t_stat = slope / standard_error
    p_value = t_two_sided_p(t_stat, df)
    half_width = t_critical(alpha, df) * standard_error
    return LinearTrend(slope, intercept, standard_error, t_stat, df, p_value,
                       slope - half_width, slope + half_width, r_squared, n, r1, effective_n, adjusted)


def sens_slope(times: Sequence[float], values: Sequence[float], *, alpha: float = 0.05) -> SenSlope:
    _check_pairs(times, values, 2)
    t, y = _sorted_by_time(times, values)
    slopes = sorted(_pairwise_slopes(t, y))
    if not slopes:
        raise TrendInputError("times must not all be equal")
    slope = median(slopes)
    intercept = median(y) - slope * median(t)
    count = len(slopes)
    c = z_critical(alpha) * math.sqrt(_mk_var(y))
    lower_index = round((count - c) / 2.0) - 1
    upper_index = round((count + c) / 2.0)
    ci_low = slopes[lower_index] if 0 <= lower_index < count else None
    ci_high = slopes[upper_index] if 0 <= upper_index < count else None
    return SenSlope(slope, intercept, ci_low, ci_high, count)


def mann_kendall(times: Sequence[float], values: Sequence[float], *, alpha: float = 0.05,
                 hamed_rao: bool = False) -> MannKendall:
    """Mann-Kendall test on values ordered by time.

    With ``hamed_rao`` the variance is inflated using significant
    autocorrelations of the ranks of the Sen-detrended series (Hamed & Rao, 1998).
    """
    _check_pairs(times, values, 3)
    t, y = _sorted_by_time(times, values)
    n = len(y)
    s = _mk_s(y)
    var_s = _mk_var(y)
    factor = 1.0
    variant = "original"
    if hamed_rao:
        variant = "hamed_rao"
        slope = median(_pairwise_slopes(t, y) or [0.0])
        ranks = rankdata([yi - slope * ti for ti, yi in zip(t, y)])
        bound = z_critical(alpha) / math.sqrt(n)
        total = 0.0
        for lag in range(1, n - 2):
            r = autocorrelation(ranks, lag)
            if abs(r) > bound:
                total += (n - lag) * (n - lag - 1) * (n - lag - 2) * r
        factor = 1.0 + 2.0 / (n * (n - 1) * (n - 2)) * total
        # Conservative: significant negative autocorrelation can push the factor below 1, which would
        # shrink the variance and overstate significance. Only allow the correction to widen uncertainty.
        factor = max(1.0, factor)
        var_s *= factor
    z = _mk_z(s, var_s)
    tau = s / (n * (n - 1) / 2.0)
    return MannKendall(variant, float(s), var_s, z, normal_two_sided_p(z), tau, n, factor)


def seasonal_mann_kendall(seasons: Sequence[Sequence[tuple[float, float]]], *,
                          alpha: float = 0.05) -> tuple[MannKendall, SenSlope]:
    """Seasonal Mann-Kendall and seasonal Sen slope.

    ``seasons`` holds one list of (time, value) pairs per season (for example 12
    calendar months). Seasons with fewer than 2 points are skipped. The
    covariance between seasons is not modeled (Hirsch & Slack, 1984 extension).
    """
    s_total = 0.0
    var_total = 0.0
    pairs = 0
    n_total = 0
    all_slopes: list[float] = []
    for season in seasons:
        if len(season) < 2:
            continue
        times = [p[0] for p in season]
        values = [p[1] for p in season]
        _check_pairs(times, values, 2)
        t, y = _sorted_by_time(times, values)
        n = len(y)
        s_total += _mk_s(y)
        var_total += _mk_var(y)
        pairs += n * (n - 1) // 2
        n_total += n
        all_slopes.extend(_pairwise_slopes(t, y))
    if pairs == 0 or not all_slopes:
        raise TrendInputError("seasonal test needs at least one season with two points")
    z = _mk_z(s_total, var_total)
    mk = MannKendall("seasonal", s_total, var_total, z, normal_two_sided_p(z), s_total / pairs, n_total)
    all_slopes.sort()
    count = len(all_slopes)
    c = z_critical(alpha) * math.sqrt(var_total)
    lower_index = round((count - c) / 2.0) - 1
    upper_index = round((count + c) / 2.0)
    sen = SenSlope(
        median(all_slopes), math.nan,
        all_slopes[lower_index] if 0 <= lower_index < count else None,
        all_slopes[upper_index] if 0 <= upper_index < count else None,
        count,
    )
    return mk, sen


def benjamini_hochberg(p_values: Sequence[float]) -> list[float]:
    """Benjamini-Hochberg adjusted p-values (q-values), in input order."""
    m = len(p_values)
    for p in p_values:
        if not isinstance(p, (int, float)) or not 0 <= p <= 1:
            raise TrendInputError("p-values must be within [0, 1]")
    order = sorted(range(m), key=lambda i: p_values[i])
    adjusted = [0.0] * m
    running = 1.0
    for rank in range(m, 0, -1):
        index = order[rank - 1]
        running = min(running, p_values[index] * m / rank)
        adjusted[index] = running
    return adjusted
