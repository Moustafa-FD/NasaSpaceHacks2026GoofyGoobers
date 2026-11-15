"""Gaussian-plume dispersion screening driven by real NASA GEOS-FP winds.

Computes the long-term average ground-level dilution factor chi/Q (s/m^3) around
a point source, using every analysed wind frame available for the site
(data/cloudshadow/fields/<site>/<year>.json -> siteSeries). Multiply chi/Q by an
emission rate Q (g/s) to get a concentration (g/m^3); this module does so ONLY when
the caller supplies Q and its source. Without Q, results are relative footprints.

Method (standard screening formulation, e.g. Turner's Workbook; Seinfeld & Pandis ch. 18):
    C/Q = 1 / (2 pi u_H sigma_y sigma_z) * exp(-y^2 / 2 sigma_y^2) * 2 exp(-H^2 / 2 sigma_z^2)   (ground level, z = 0,
    with ground reflection), Briggs (1973) rural or urban sigma curves, Pasquill stability from 10 m wind speed and
    day/night (moderate insolation by day, >= 4/8 cloud at night: an explicit assumption), power-law wind at
    stack height. Valid ~100 m to 10 km downwind; calm frames (< 0.5 m/s) are counted and excluded; no
    chemistry, deposition, building downwash, terrain or mixing-height cap. Effective stack height must be given
    (plume rise needs exhaust temperature/velocity we do not have). This is a SCREENING scenario, not a
    regulatory model (AERMOD) and not a measurement.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

ROOT = Path(__file__).resolve().parents[3]
FIELDS_DIR = ROOT / "data" / "cloudshadow" / "fields"
CALM_MS = 0.5
MIN_X, MAX_X = 100.0, 10_000.0

# Briggs (1973) sigma_y, sigma_z (m) as functions of downwind distance x (m).
_RURAL = {
    "A": (lambda x: 0.22 * x / math.sqrt(1 + 0.0001 * x), lambda x: 0.20 * x),
    "B": (lambda x: 0.16 * x / math.sqrt(1 + 0.0001 * x), lambda x: 0.12 * x),
    "C": (lambda x: 0.11 * x / math.sqrt(1 + 0.0001 * x), lambda x: 0.08 * x / math.sqrt(1 + 0.0002 * x)),
    "D": (lambda x: 0.08 * x / math.sqrt(1 + 0.0001 * x), lambda x: 0.06 * x / math.sqrt(1 + 0.0015 * x)),
    "E": (lambda x: 0.06 * x / math.sqrt(1 + 0.0001 * x), lambda x: 0.03 * x / (1 + 0.0003 * x)),
    "F": (lambda x: 0.04 * x / math.sqrt(1 + 0.0001 * x), lambda x: 0.016 * x / (1 + 0.0003 * x)),
}
_URBAN_AB = (lambda x: 0.32 * x / math.sqrt(1 + 0.0004 * x), lambda x: 0.24 * x * math.sqrt(1 + 0.001 * x))
_URBAN_EF = (lambda x: 0.11 * x / math.sqrt(1 + 0.0004 * x), lambda x: 0.08 * x / math.sqrt(1 + 0.0015 * x))
_URBAN = {
    "A": _URBAN_AB, "B": _URBAN_AB,
    "C": (lambda x: 0.22 * x / math.sqrt(1 + 0.0004 * x), lambda x: 0.20 * x),
    "D": (lambda x: 0.16 * x / math.sqrt(1 + 0.0004 * x), lambda x: 0.14 * x / math.sqrt(1 + 0.0003 * x)),
    "E": _URBAN_EF, "F": _URBAN_EF,
}
# Wind-profile exponents (urban / rural), e.g. EPA ISC3 user guide.
_PROFILE = {"urban": {"A": .15, "B": .15, "C": .20, "D": .25, "E": .30, "F": .30},
            "rural": {"A": .07, "B": .07, "C": .10, "D": .15, "E": .35, "F": .55}}


class PlumeError(ValueError):
    pass


def solar_elevation_deg(when: datetime, lat: float, lon: float) -> float:
    """Approximate solar elevation (NOAA low-precision formulas), adequate for a day/night split."""
    day = when.timetuple().tm_yday
    hour = when.hour + when.minute / 60
    gamma = 2 * math.pi / 365 * (day - 1 + (hour - 12) / 24)
    decl = (0.006918 - 0.399912 * math.cos(gamma) + 0.070257 * math.sin(gamma) - 0.006758 * math.cos(2 * gamma)
            + 0.000907 * math.sin(2 * gamma) - 0.002697 * math.cos(3 * gamma) + 0.00148 * math.sin(3 * gamma))
    eqtime = 229.18 * (0.000075 + 0.001868 * math.cos(gamma) - 0.032077 * math.sin(gamma)
                       - 0.014615 * math.cos(2 * gamma) - 0.040849 * math.sin(2 * gamma))
    true_solar_min = hour * 60 + eqtime + 4 * lon
    hour_angle = math.radians(true_solar_min / 4 - 180)
    phi = math.radians(lat)
    cos_zenith = math.sin(phi) * math.sin(decl) + math.cos(phi) * math.cos(decl) * math.cos(hour_angle)
    return 90 - math.degrees(math.acos(max(-1.0, min(1.0, cos_zenith))))


def stability_class(wind10: float, daytime: bool) -> str:
    """Pasquill class from 10 m wind; day = moderate insolation, night = >= 4/8 cloud (stated assumptions)."""
    if daytime:
        if wind10 < 2: return "B"   # A-B -> B (moderate insolation)
        if wind10 < 3: return "B"
        if wind10 < 5: return "C"   # B-C -> C
        if wind10 < 6: return "D"   # C-D -> D
        return "D"
    if wind10 < 3: return "E"
    return "D"


def chi_over_q(x: float, y: float, u_stack: float, height: float, stability: str, land_use: str) -> float:
    """Ground-level chi/Q (s/m^3) at downwind x, crosswind y (m); 0 outside the valid range."""
    if not MIN_X <= x <= MAX_X:
        return 0.0
    sy_f, sz_f = (_URBAN if land_use == "urban" else _RURAL)[stability]
    sy, sz = sy_f(x), sz_f(x)
    return (1.0 / (2 * math.pi * u_stack * sy * sz)) * math.exp(-y * y / (2 * sy * sy)) * 2 * math.exp(-height * height / (2 * sz * sz))


@dataclass(frozen=True)
class Frame:
    time: datetime
    u: float
    v: float

    @property
    def speed(self) -> float:
        return math.hypot(self.u, self.v)


def load_site_frames(site_id: str, fields_dir: Path = FIELDS_DIR) -> list[Frame]:
    frames = []
    for path in sorted((fields_dir / site_id).glob("*.json")):
        manifest = json.loads(path.read_text(encoding="utf-8"))
        for row in manifest.get("siteSeries", []):
            if row.get("u") is None or row.get("v") is None:
                continue
            when = datetime.strptime(row["time"], "%Y-%m-%dT%H:%MZ").replace(tzinfo=timezone.utc)
            frames.append(Frame(when, float(row["u"]), float(row["v"])))
    if not frames:
        raise PlumeError(f"no GEOS-FP wind frames for site {site_id}; run npm run data:fields")
    return frames


def prepared_box_frames(lat: float, lon: float, fields_dir: Path = FIELDS_DIR) -> tuple[list[Frame], str] | None:
    """Wind at any point inside a prepared site box, read from the stored GEOS-FP atlases (no download).

    Uses the box whose centre is nearest. Values are bilinear from the 8-bit atlas (0.31 m/s steps), so
    speeds are coarser than the exact siteSeries but directions match. Returns None if no box covers the point.
    """
    from ..fields.product import decode, read_png_rgb
    best = None
    for site_dir in sorted(fields_dir.iterdir()) if fields_dir.is_dir() else []:
        if not site_dir.is_dir() or site_dir.name == "global":
            continue
        manifests = sorted(site_dir.glob("*.json"))
        if not manifests:
            continue
        grid = json.loads(manifests[0].read_text(encoding="utf-8"))["grid"]
        if not (grid["latMin"] + grid["dLat"] <= lat <= grid["latMax"] - grid["dLat"] and grid["lonMin"] + grid["dLon"] <= lon <= grid["lonMax"] - grid["dLon"]):
            continue
        centre = math.hypot((grid["latMin"] + grid["latMax"]) / 2 - lat, (grid["lonMin"] + grid["lonMax"]) / 2 - lon)
        if best is None or centre < best[0]:
            best = (centre, site_dir.name, manifests)
    if best is None:
        return None
    frames: list[Frame] = []
    for path in best[2]:
        m = json.loads(path.read_text(encoding="utf-8"))
        g, a, enc = m["grid"], m["atlas"], m["encoding"]["wind"]
        width, _, pixels = read_png_rgb(path.parent / m["files"]["wind"])
        fx = (lon - g["lonMin"]) / g["dLon"]
        fy = (g["latMax"] - lat) / g["dLat"]            # atlas rows run north -> south
        i0, j0 = int(fx), int(fy)
        tx, ty = fx - i0, fy - j0
        for k, frame in enumerate(m["frames"]):
            ox, oy = (k % a["cols"]) * a["tileWidth"], (k // a["cols"]) * a["tileHeight"]

            def px(i, j, ch):
                return pixels[((oy + j) * width + ox + i) * 3 + ch]
            if any(px(i, j, 2) != 255 for i in (i0, i0 + 1) for j in (j0, j0 + 1)):
                continue

            def bl(ch, lo, hi):
                val = lambda i, j: decode(px(i, j, ch), lo, hi)
                return (val(i0, j0) * (1 - tx) + val(i0 + 1, j0) * tx) * (1 - ty) + (val(i0, j0 + 1) * (1 - tx) + val(i0 + 1, j0 + 1) * tx) * ty
            u, v = bl(0, enc["R"]["min"], enc["R"]["max"]), bl(1, enc["G"]["min"], enc["G"]["max"])
            when = datetime.strptime(frame["time"], "%Y-%m-%dT%H:%MZ").replace(tzinfo=timezone.utc)
            frames.append(Frame(when, u, v))
    return (frames, best[1]) if frames else None


def point_frames(lat: float, lon: float, *, first_year: int = 2018, frames_per_year: int = 12, workers: int = 12,
                 progress=None) -> list[Frame]:
    """GEOS-FP analysed 10 m wind at any point (bilinear from the 4 surrounding cells), same sampling as the fields."""
    from concurrent.futures import ThreadPoolExecutor
    from ..fields import geosfp
    from ..fields.product import bilinear, frame_indices
    latest = geosfp.latest_index()
    years = range(first_year, geosfp.time_for(latest).year + 1)
    indices = [i for y in years for i in frame_indices(y, frames_per_year, geosfp.index_for, 0, latest)]
    j = int((lat - geosfp.LAT0) // geosfp.DLAT)
    i = int((lon - geosfp.LON0) // geosfp.DLON)
    window = geosfp.Window(j, j + 1, i, i + 1)
    lats, lons = window.lats(), window.lons()
    done = [0]

    def one(index: int) -> Frame | None:
        data = geosfp.fetch_frame(index, window, ["u10m", "v10m"])
        u, v = bilinear(data["u10m"], lats, lons, lat, lon), bilinear(data["v10m"], lats, lons, lat, lon)
        done[0] += 1
        if progress:
            progress(done[0], len(indices))
        return None if u is None or v is None else Frame(geosfp.time_for(index), u, v)

    with ThreadPoolExecutor(max_workers=workers) as pool:
        frames = [f for f in pool.map(one, indices) if f is not None]
    if not frames:
        raise PlumeError("no GEOS-FP wind frames could be read for this point")
    return frames


def footprint(lat: float, lon: float, frames: Iterable[Frame], *, height_m: float, land_use: str = "urban",
              half_width_m: float = 8000.0, cell_m: float = 200.0, receptors: list[dict] | None = None) -> dict[str, Any]:
    """Average chi/Q over frames on a square grid (rows north->south) plus named receptors."""
    frames = list(frames)
    if not frames:
        raise PlumeError("no wind frames")
    if not 1 <= height_m <= 300:
        raise PlumeError("effective stack height must be 1-300 m")
    if land_use not in ("urban", "rural"):
        raise PlumeError("land use must be urban or rural")
    n = int(round(2 * half_width_m / cell_m)) + 1
    offsets = [-half_width_m + i * cell_m for i in range(n)]
    grid = [[0.0] * n for _ in range(n)]
    receptors = receptors or []
    m_per_deg_lat = 111_320.0
    m_per_deg_lon = 111_320.0 * math.cos(math.radians(lat))
    rec_xy = [((r["lon"] - lon) * m_per_deg_lon, (r["lat"] - lat) * m_per_deg_lat) for r in receptors]
    rec_sum = [0.0] * len(receptors)
    used = calm = 0
    classes: dict[str, int] = {}
    for frame in frames:
        if frame.speed < CALM_MS:
            calm += 1
            continue
        day = solar_elevation_deg(frame.time, lat, lon) > 0
        cls = stability_class(frame.speed, day)
        classes[cls] = classes.get(cls, 0) + 1
        u_stack = max(1.0, frame.speed * (height_m / 10.0) ** _PROFILE[land_use][cls])
        ux, uy = frame.u / frame.speed, frame.v / frame.speed          # unit vector the air moves toward
        used += 1
        for r, north in enumerate(reversed(offsets)):                    # row 0 = north
            for c, east in enumerate(offsets):
                x = east * ux + north * uy
                if x < MIN_X:
                    continue
                grid[r][c] += chi_over_q(x, -east * uy + north * ux, u_stack, height_m, cls, land_use)
        for k, (east, north) in enumerate(rec_xy):
            x = east * ux + north * uy
            rec_sum[k] += chi_over_q(x, -east * uy + north * ux, u_stack, height_m, cls, land_use)
    total = used + calm
    if used == 0:
        raise PlumeError("all wind frames were calm; no plume direction")
    # Calm frames contribute zero here (undefined direction): the average is over all frames, so footprints are
    # not inflated by dropping calms, and the calm share is reported.
    mean = [[v / total for v in row] for row in grid]
    peak = max((v, r, c) for r, row in enumerate(mean) for c, v in enumerate(row))
    peak_east, peak_north = offsets[peak[2]], list(reversed(offsets))[peak[1]]
    return {
        "grid": {"n": n, "cellM": cell_m, "halfWidthM": half_width_m, "rowOrder": "north-to-south", "units": "s/m^3",
                 "values": [[float(f"{v:.4g}") for v in row] for row in mean]},
        "peak": {"chiOverQ": peak[0], "eastM": peak_east, "northM": peak_north,
                 "distanceM": round(math.hypot(peak_east, peak_north)), "bearingDeg": round((math.degrees(math.atan2(peak_east, peak_north)) + 360) % 360)},
        "receptors": [{**r, "distanceM": round(math.hypot(*xy)), "chiOverQ": rec_sum[k] / total} for k, (r, xy) in enumerate(zip(receptors, rec_xy))],
        "frames": {"total": total, "used": used, "calm": calm, "stabilityClasses": dict(sorted(classes.items())),
                   "first": min(f.time for f in frames).strftime("%Y-%m-%dT%H:%MZ"),
                   "last": max(f.time for f in frames).strftime("%Y-%m-%dT%H:%MZ")},
    }


def scenario(site: dict, *, height_m: float, land_use: str = "urban", emission_rate_gs: float | None = None,
             emission_source: str | None = None, pollutant: str | None = None, fields_dir: Path = FIELDS_DIR,
             half_width_m: float = 8000.0, cell_m: float = 200.0, frames: list[Frame] | None = None) -> dict[str, Any]:
    if emission_rate_gs is not None and (not emission_source or not str(emission_source).strip()):
        raise PlumeError("an emission rate needs its source (permit, inventory or stated assumption)")
    if emission_rate_gs is not None and not 0 < emission_rate_gs <= 1e5:
        raise PlumeError("emission rate must be in (0, 100000] g/s")
    if frames is None:
        frames = load_site_frames(site["id"], fields_dir)
    result = footprint(site["lat"], site["lon"], frames, height_m=height_m, land_use=land_use, half_width_m=half_width_m,
                       cell_m=cell_m, receptors=site.get("neighbors") or [])
    out: dict[str, Any] = {
        "schemaVersion": "plume-scenario/1.0",
        "evidence": "scenario",
        "evidenceNote": ("Screening Gaussian-plume footprint driven by real NASA GEOS-FP analysed winds at the site. "
                         "chi/Q is dilution per unit emission; it is not a measured or predicted concentration unless an "
                         "emission rate with a stated source is supplied. No chemistry, deposition, downwash or terrain."),
        "site": {"id": site["id"], "name": site.get("name", site["id"]), "lat": site["lat"], "lon": site["lon"]},
        "assumptions": {"effectiveStackHeightM": height_m, "landUse": land_use,
                        "stability": "Pasquill class from 10 m wind; day = moderate insolation, night = >= 4/8 cloud",
                        "dispersion": f"Briggs (1973) {land_use} sigma curves, valid {int(MIN_X)} m to {int(MAX_X)} m",
                        "calmThresholdMs": CALM_MS, "windSource": "NASA GEOS-FP siteSeries (data/cloudshadow/fields)"},
        **result,
    }
    if emission_rate_gs is not None:
        to_ugm3 = emission_rate_gs * 1e6
        out["emission"] = {"rateGs": emission_rate_gs, "source": emission_source, "pollutant": pollutant}
        out["peak"]["concentrationUgM3"] = out["peak"]["chiOverQ"] * to_ugm3
        for r in out["receptors"]:
            r["concentrationUgM3"] = r["chiOverQ"] * to_ugm3
        out["concentrationNote"] = ("Long-term average primary concentration from this source alone under the stated "
                                    "assumptions; excludes background, chemistry (e.g. NO -> NO2) and other sources.")
    return out


def main(argv: list[str] | None = None) -> int:
    """Write static plume footprints for sites with on-site combustion (sites.json effects.plume)."""
    import argparse
    import sys
    parser = argparse.ArgumentParser(description="Gaussian-plume chi/Q footprints from GEOS-FP winds.")
    parser.add_argument("--sites", default="", help="comma-separated site ids (default: sites with effects.plume)")
    parser.add_argument("--height", type=float, default=20.0, help="ASSUMED effective stack height in m (default 20)")
    parser.add_argument("--land-use", default="urban", choices=["urban", "rural"])
    parser.add_argument("--out", default=str(ROOT / "data" / "cloudshadow" / "plumes"))
    args = parser.parse_args(argv)
    sites = json.loads((ROOT / "data" / "cloudshadow" / "sites.json").read_text(encoding="utf-8"))["sites"]
    chosen = [s for s in sites if (s["id"] in args.sites.split(",") if args.sites else (s.get("effects") or {}).get("plume"))]
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    for site in chosen:
        result = scenario(site, height_m=args.height, land_use=args.land_use)
        result["assumptions"]["effectiveStackHeightNote"] = "Assumed for screening; no published stack/exhaust data were available."
        (out / f"{site['id']}.json").write_text(json.dumps(result, allow_nan=False), encoding="utf-8")
        print(f"{site['id']}: peak chi/Q {result['peak']['chiOverQ']:.3g} s/m3 at {result['peak']['distanceM']} m, "
              f"{result['frames']['used']} wind frames", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
