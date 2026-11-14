"""Command-line trend report for a regional time-series CSV.

Examples (from the repository root):

    python -m services.models.trends.cli data/examples/trends/synthetic-target-monthly.csv --units K
    python -m services.models.trends.cli target.csv --control control.csv --json
    python -m services.models.trends.cli --list-variables

Reports go to stdout; errors go to stderr with exit status 1.
"""

from __future__ import annotations

import argparse
import json
import sys

from . import analysis, catalog, series


def _print_report(title: str, report: dict) -> None:
    print(f"== {title} ==")
    if report["status"] != "ok":
        print("Not enough data for a trend test:")
        for reason in report["reasons"]:
            print(f"  - {reason}")
        return
    period = report["period"]
    missing = report["missing"]
    print(f"Period: {period['start']} to {period['end']} ({report['cadence']}), "
          f"{missing['valid']} valid of {missing['steps']} steps, longest gap {missing['longestGapSteps']}")
    print(report["summary"])
    mk = report["mannKendall"]
    lin = report["linear"]
    print(f"  Mann-Kendall ({mk['variant']}): S={mk['s']:.0f}, Z={mk['z']:.3f}, p={mk['pValue']:.4g}, tau={mk['tau']:.3f}")
    if lin["pValue"] is not None:
        print(f"  Least squares: slope={lin['slopePerDecade']:.4g}/decade, p={lin['pValue']:.4g}, "
              f"lag-1 autocorrelation={lin['lag1Autocorrelation']:.2f}, effective n={lin['effectiveN']:.1f}")
    for note in report["limitations"]:
        print(f"  Note: {note}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Trend magnitude and significance for a regional time series.")
    parser.add_argument("csv", nargs="?", help="time-series CSV (Giovanni-style preamble allowed)")
    parser.add_argument("--control", help="control-region CSV for a difference-in-trends comparison")
    parser.add_argument("--value-column", help="value column name when the CSV has several")
    parser.add_argument("--cadence", choices=["monthly", "annual"], default="monthly")
    parser.add_argument("--alpha", type=float, default=0.05)
    parser.add_argument("--min-years", type=int, default=10)
    parser.add_argument("--min-count", type=int, default=1, help="valid observations needed per month")
    parser.add_argument("--units", default="")
    parser.add_argument("--json", action="store_true", help="print the machine-readable report")
    parser.add_argument("--list-variables", action="store_true", help="print the candidate variable catalog")
    args = parser.parse_args(argv)

    try:
        if args.list_variables:
            for entry in catalog.load_catalog():
                marker = "" if entry["status"] == "candidate" else " [unavailable]"
                print(f"{entry['id']}{marker}: {entry['label']} - {entry['plainDefinition']}")
            return 0
        if not args.csv:
            parser.error("a CSV path is required unless --list-variables is given")
        if not 0 < args.alpha < 1:
            raise ValueError("--alpha must be between 0 and 1")

        def monthly(path: str) -> list[series.MonthlyValue]:
            data = series.read_time_series_csv(path, value_column=args.value_column)
            return series.to_monthly(data.observations, min_count=args.min_count)

        target = monthly(args.csv)
        options = {"alpha": args.alpha, "min_years": args.min_years, "units": args.units}
        if args.control:
            if args.cadence != "monthly":
                raise ValueError("--control comparisons currently use monthly cadence")
            result = analysis.compare_regions(target, monthly(args.control), **options)
        elif args.cadence == "annual":
            result = analysis.analyze_annual(series.to_annual(target), **options)
        else:
            result = analysis.analyze_monthly(target, **options)
    except (ValueError, OSError) as error:
        print(json.dumps({"error": {"code": "TREND_INPUT", "message": str(error)}}), file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps(result, indent=2, allow_nan=False))
    elif args.control:
        _print_report("Target region", result["target"])
        _print_report("Control region", result["control"])
        _print_report("Target minus control", result["difference"])
    else:
        _print_report("Trend report", result)
    return 0


if __name__ == "__main__":
    sys.exit(main())
