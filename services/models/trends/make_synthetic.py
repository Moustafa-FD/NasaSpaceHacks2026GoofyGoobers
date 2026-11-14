"""Write deterministic SYNTHETIC monthly fixtures for demos and tests.

These are invented numbers with a known built-in trend, labeled synthetic in
their metadata. They are not NASA observations.

    python -m services.models.trends.make_synthetic data/examples/trends
"""

from __future__ import annotations

import math
import random
import sys
from pathlib import Path


def synthetic_monthly(start_year: int, years: int, trend_per_year: float, seed: int,
                      base: float = 290.0, amplitude: float = 8.0, noise: float = 0.6,
                      missing_every: int = 0) -> list[tuple[str, float | None]]:
    rng = random.Random(seed)
    rows = []
    for index in range(years * 12):
        year, month = start_year + index // 12, index % 12 + 1
        t = index / 12.0
        value = (base + trend_per_year * t
                 + amplitude * math.sin(2 * math.pi * (month - 4) / 12.0)
                 + rng.gauss(0.0, noise))
        missing = missing_every and index % missing_every == missing_every - 1
        rows.append((f"{year:04d}-{month:02d}-01", None if missing else round(value, 4)))
    return rows


def write_csv(path: Path, title: str, rows: list[tuple[str, float | None]], column: str) -> None:
    lines = [
        f"Title:,{title}",
        "Provenance:,SYNTHETIC - invented demonstration values with a known trend; not a NASA observation",
        "Fill Value (mean):,-9999.0",
        "",
        f"time,{column}",
    ]
    lines += [f"{day},{-9999.0 if value is None else value}" for day, value in rows]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main(argv: list[str]) -> int:
    out = Path(argv[0] if argv else "data/examples/trends")
    out.mkdir(parents=True, exist_ok=True)
    write_csv(out / "synthetic-target-monthly.csv",
              "Synthetic target region, +0.04 K/year built-in trend",
              synthetic_monthly(2004, 20, 0.04, seed=11, missing_every=37), "mean_synthetic_temperature")
    write_csv(out / "synthetic-control-monthly.csv",
              "Synthetic control region, +0.01 K/year built-in trend",
              synthetic_monthly(2004, 20, 0.01, seed=23, missing_every=41), "mean_synthetic_temperature")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
