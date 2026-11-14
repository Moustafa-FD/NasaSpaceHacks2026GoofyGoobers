"""Build flow-field products from NASA GEOS-FP for the web app and Unreal.

    python -m services.models.fields.build                      # all sites + global, 2018..latest
    python -m services.models.fields.build --years 2024-2026 --sites ashburn
    python -m services.models.fields.build --no-global --frames 12

Resumable and bounded: a product whose manifest is already complete is skipped;
an incomplete current-year product is rebuilt only when newer analyses exist.
The run ends when every requested product is complete or has no new frames.
Progress goes to stderr.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

from . import geosfp
from .product import FlowField, Frame, frame_indices

ROOT = Path(__file__).resolve().parents[3]
SITES_FILE = ROOT / "data" / "cloudshadow" / "sites.json"
OUT_DIR = ROOT / "data" / "cloudshadow" / "fields"
GLOBAL_STRIDE = 8          # 2.0 deg lat x 2.5 deg lon
SITE_HALF_LAT, SITE_HALF_LON = 3.0, 4.0


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def source_block(window: geosfp.Window) -> dict:
    return {
        "name": "NASA GMAO GEOS-FP",
        "collection": geosfp.COLLECTION,
        "dataset": geosfp.DATASET,
        "variables": ["u10m", "v10m", "t2m", "slp"],
        "nativeResolution": "0.25 deg lat x 0.3125 deg lon, 3-hourly instantaneous",
        "productResolution": f"{geosfp.DLAT * window.stride:g} deg lat x {geosfp.DLON * window.stride:g} deg lon",
        "retrieved": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
        "access": "public OPeNDAP, no login",
    }


def existing_frames(path: Path) -> tuple[int, bool]:
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
        return len(manifest["frames"]), bool(manifest.get("complete"))
    except (OSError, ValueError, KeyError):
        return 0, False


def build_product(kind: str, name: str, year: int, window: geosfp.Window, indices: list[int], expected: int,
                  variables: list[str], site: dict | None, out_dir: Path, workers: int) -> dict:
    def one(index: int) -> Frame:
        data = geosfp.fetch_frame(index, window, variables)
        slp = data.get("slp")
        return Frame(geosfp.time_for(index), index, data["u10m"], data["v10m"], data.get("t2m"),
                     [[None if x is None else x / 100.0 for x in row] for row in slp] if slp else None)

    with ThreadPoolExecutor(max_workers=workers) as pool:
        frames = list(pool.map(one, indices))
    product = FlowField(f"{name}-{year}", kind, year, window.lats(), window.lons(), source_block(window),
                        frames, site, expected)
    return product.write(out_dir / name, str(year))


VALIDATION = {
    "method": ("GEOS-FP site series compared at the same instants with NASA POWER hourly (MERRA-2) and with NOAA "
               "ISD observations at Washington Dulles airport (KIAD, ~10 km from the Ashburn site), 2025."),
    "direction": "Median difference ~9 deg from the Dulles observations (7 instants with a reported direction, all within 37 deg).",
    "speed": ("GEOS-FP 10 m speed averaged 1.98 m/s vs 3.15 m/s observed at Dulles (8 instants, ~37% lower); NASA POWER "
              "averaged ~18% higher than observed. Grid-cell winds over suburbs/forest are weaker than an exposed "
              "airport anemometer, so treat speed as relative; it is not corrected."),
    "temperature": "2 m temperature within 1.3 K mean absolute difference of NASA POWER hourly (12 instants).",
    "details": "docs/flow-fields.md",
}


def write_index(out_dir: Path) -> None:
    products = []
    for path in sorted(out_dir.glob("*/*.json")):
        try:
            m = json.loads(path.read_text(encoding="utf-8"))
        except ValueError:
            continue
        if m.get("schemaVersion") != "flow-field/1.0":
            continue
        rel = path.parent.name
        products.append({"id": m["id"], "kind": m["kind"], "site": (m.get("site") or {}).get("id"), "year": m["year"],
                         "frames": len(m["frames"]), "complete": m["complete"],
                         "manifest": f"{rel}/{path.name}", "files": {k: f"{rel}/{v}" for k, v in m["files"].items()}})
    index = {"schemaVersion": "flow-field-index/1.0", "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
             "source": "NASA GMAO GEOS-FP via NCCS OPeNDAP", "validation": VALIDATION, "products": products}
    (out_dir / "index.json").write_text(json.dumps(index, indent=1), encoding="utf-8")


def parse_years(text: str, latest_year: int) -> list[int]:
    if "-" in text:
        a, b = text.split("-", 1)
        return list(range(int(a), int(b) + 1))
    return [int(text)] if text else list(range(2018, latest_year + 1))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build GEOS-FP flow-field products.")
    parser.add_argument("--years", default="", help="e.g. 2018-2026 (default: 2018..latest analysis year)")
    parser.add_argument("--frames", type=int, default=12, help="analysis frames per year (default 12)")
    parser.add_argument("--sites", default="all", help="comma-separated site ids from sites.json, or 'all' / 'none'")
    parser.add_argument("--no-global", action="store_true")
    parser.add_argument("--out", default=str(OUT_DIR))
    parser.add_argument("--workers", type=int, default=3)
    parser.add_argument("--force", action="store_true", help="rebuild complete products")
    parser.add_argument("--index-only", action="store_true", help="only rewrite index.json from existing manifests")
    args = parser.parse_args(argv)
    if args.index_only:
        write_index(Path(args.out))
        return 0
    if not 1 <= args.frames <= 96:
        parser.error("--frames must be 1..96")
    out_dir = Path(args.out)

    latest = geosfp.latest_index()
    latest_time = geosfp.time_for(latest)
    log(f"GEOS-FP latest analysis {latest_time:%Y-%m-%d %HZ} (index {latest})")
    years = [y for y in parse_years(args.years, latest_time.year) if 2018 <= y <= latest_time.year]

    sites = json.loads(SITES_FILE.read_text(encoding="utf-8"))["sites"]
    if args.sites == "none":
        sites = []
    elif args.sites != "all":
        wanted = set(args.sites.split(","))
        sites = [s for s in sites if s["id"] in wanted]

    jobs = []
    if not args.no_global:
        jobs.append(("global", "global", geosfp.global_window(GLOBAL_STRIDE), ["u10m", "v10m"], None))
    for s in sites:
        window = geosfp.box_window(s["lat"], s["lon"], SITE_HALF_LAT, SITE_HALF_LON)
        jobs.append(("site", s["id"], window, ["u10m", "v10m", "t2m", "slp"],
                     {"id": s["id"], "name": s.get("name", s["id"]), "lat": s["lat"], "lon": s["lon"]}))

    built = skipped = 0
    for kind, name, window, variables, site in jobs:
        for year in years:
            indices = frame_indices(year, args.frames, geosfp.index_for, 0, latest)
            expected = len(frame_indices(year, args.frames, geosfp.index_for, 0, 10**9))
            have, complete = existing_frames(out_dir / name / f"{year}.json")
            if not args.force and (complete or have >= len(indices)):
                skipped += 1
                continue
            started = time.time()
            build_product(kind, name, year, window, indices, expected, variables, site, out_dir, args.workers)
            built += 1
            log(f"{name} {year}: {len(indices)}/{expected} frames, {window.nx}x{window.ny} cells, {time.time() - started:.0f}s")
    write_index(out_dir)
    log(f"done: {built} built, {skipped} already up to date")
    return 0


if __name__ == "__main__":
    sys.exit(main())
