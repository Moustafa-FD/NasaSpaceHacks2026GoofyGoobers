#!/usr/bin/env python3
"""
Per-pixel trend maps: how each NASA map pixel near a study site changed, so the
globe can show "if the trend continues" maps for 2027-2035 instead of a frozen
snapshot.

For every native GIBS pixel in a box around the site:
  1. one value per year = median of the decoded July-season composites
     (Jun 15 - Aug 15, the same season the map shows; colour-class midpoints,
     the same decoding as scripts/precompute.py),
  2. Sen's slope + Mann-Kendall with the Hamed-Rao autocorrelation correction
     (services/models/trends/stats.py, validated against SciPy),
  3. Benjamini-Hochberg false-discovery control across all pixels of the map.
Only pixels with q < 0.10 (Wilks 2016) keep a slope; every other pixel is stored as 0 (no
change) so the projected map never invents change where the record shows none.

The browser adds slope x (year - base year) to the latest real same-season map.
This is a trend extension, not a forecast and not facility attribution.

    python scripts/trend_maps.py                 # all sites, all variables
    python scripts/trend_maps.py colossus1 NDVI  # filter by site and/or variable
Output: data/cloudshadow/trendmaps/<site>/<var>.json  (schema trend-map/1.0)
Needs Pillow; tiles are cached in .tilecache/ (git-ignored).
"""
import base64, json, math, os, statistics, struct, sys, time
from concurrent.futures import ThreadPoolExecutor
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import precompute as pc  # noqa: E402
from services.models.trends import stats  # noqa: E402

# variable -> (box half-size in degrees of latitude, max composites sampled per season)
TARGETS = {"NDVI": (0.25, 4), "LST_Day": (0.5, 8), "LST_Night": (0.5, 8), "AOD": (0.8, 40), "NO2_OMI": (1.2, 40), "SoilMoisture": (1.2, 12)}
SEASON = ((6, 15), (8, 15))  # the map's default view is mid-July
# Soil water is judged on the whole year: two summer months are too noisy for a storage quantity.
SEASONS = {"SoilMoisture": ((1, 1), (12, 31))}
FIRST_YEAR, LAST_YEAR = 2003, 2026
MIN_YEARS, RECENT_YEARS = 12, 3   # at least 12 valid years, 3 of them in the last 6
ALPHA = 0.05      # per-pixel Mann-Kendall / Sen confidence level
# False-discovery level across the map. For spatially correlated fields, Wilks (2016,
# BAMS 97, 2263-2273, "The stippling shows statistically significant grid points")
# recommends alpha_FDR = 0.10, which keeps the global (field) false-positive rate near 0.05.
FDR_Q = 0.10
OUT = os.path.join(pc.DATA, "trendmaps")


def season_dates(all_dates, year, cap, season=SEASON):
    lo, hi = date(year, *season[0]), date(year, *season[1])
    picks = [d for d in all_dates if lo <= d <= hi]
    if len(picks) > cap:  # evenly spaced subsample of daily products
        step = len(picks) / cap
        picks = [picks[int(i * step)] for i in range(cap)]
    return picks


def decode_tile(var, lut, d, row, col):
    img = pc.fetch_tile(var["layer"], d, var["tms"], var["z"], row, col)
    if img is None:
        return None
    px, out = img.load(), {}
    for y in range(256):
        for x in range(256):
            r, g, b, a = px[x, y]
            if a:
                v = lut.get((r, g, b))
                if v is not None:
                    out[(x, y)] = v
    return out


def trend_for(series):
    """series: list of (year, value). Returns (slope/yr, p) or None."""
    if len(series) < MIN_YEARS or sum(1 for y, _ in series if y > LAST_YEAR - 6) < RECENT_YEARS:
        return None
    years = [float(y) for y, _ in series]
    values = [v for _, v in series]
    if max(values) == min(values):
        return 0.0, 1.0
    mk = stats.mann_kendall(years, values, alpha=ALPHA, hamed_rao=True)
    return stats.sens_slope(years, values, alpha=ALPHA).slope, mk.p_value


def build(site, vid, catalog):
    half, cap = TARGETS[vid]
    var = dict(pc.VARIABLES[vid], **catalog[pc.VARIABLES[vid]["layer"]])
    lut, z = pc.load_cmap(var["cmap"]), var["z"]
    half_lon = half / max(0.2, math.cos(math.radians(site["lat"])))
    x0, y0 = pc.world_px(site["lat"] + half, site["lon"] - half_lon, z)
    x1, y1 = pc.world_px(site["lat"] - half, site["lon"] + half_lon, z)
    gx0, gy0, gx1, gy1 = int(x0), int(y0), int(math.ceil(x1)), int(math.ceil(y1))
    width, height = gx1 - gx0, gy1 - gy0
    tiles = [(row, col) for row in range(gy0 // 256, (gy1 - 1) // 256 + 1) for col in range(gx0 // 256, (gx1 - 1) // 256 + 1)]
    all_dates = pc.expand(var["intervals"], var["start"])
    first = max(FIRST_YEAR, int(var["start"][:4]))
    jobs = [(year, d, row, col) for year in range(first, LAST_YEAR + 1) for d in season_dates(all_dates, year, cap, SEASONS.get(vid, SEASON)) for row, col in tiles]
    t0 = time.time()
    with ThreadPoolExecutor(16) as ex:
        decoded = list(ex.map(lambda j: (j, decode_tile(var, lut, j[1], j[2], j[3])), jobs))
    per_year = {}  # (year) -> {pixel index: [values]}
    for (year, _d, row, col), values in decoded:
        if not values:
            continue
        bucket = per_year.setdefault(year, {})
        for (x, y), v in values.items():
            gx, gy = col * 256 + x, row * 256 + y
            if gx0 <= gx < gx1 and gy0 <= gy < gy1:
                bucket.setdefault((gy - gy0) * width + (gx - gx0), []).append(v)
    series = {}
    for year in sorted(per_year):
        for i, vals in per_year[year].items():
            series.setdefault(i, []).append((year, statistics.median(vals)))
    results = {i: trend_for(s) for i, s in series.items()}
    tested = [(i, r) for i, r in results.items() if r is not None]
    q = stats.benjamini_hochberg([min(1.0, max(0.0, p)) for _, (_, p) in tested]) if tested else []
    slope = [0.0] * (width * height)
    sig = []
    for (i, (s, _p)), qi in zip(tested, q):
        if qi < FDR_Q and s != 0:
            slope[i] = s
            sig.append(s)
    peak = max((abs(s) for s in slope), default=0.0) or 1.0
    scale = peak / 32767
    packed = struct.pack(f"<{len(slope)}h", *(int(round(s / scale)) for s in slope))
    unit_factor = var.get("scale", 1)
    out = {
        "schemaVersion": "trend-map/1.0", "site": site["id"], "variable": vid, "layer": var["layer"], "z": z,
        "gx0": gx0, "gy0": gy0, "width": width, "height": height,
        "slopeEncoding": "int16-le base64; raw colormap units per year = value * slopeScale; 0 = no significant trend",
        "slopeScale": scale, "slope": base64.b64encode(packed).decode("ascii"),
        "season": "all months, median per year" if vid in SEASONS else "Jun 15 - Aug 15 composites, median per year", "years": [first, LAST_YEAR],
        "method": {"test": "Mann-Kendall with Hamed-Rao autocorrelation correction", "slope": "Sen's slope",
                   "multipleTesting": "Benjamini-Hochberg across pixels", "alpha": ALPHA, "fdrQ": FDR_Q,
                   "fdrReference": "Wilks 2016, BAMS 97:2263 (alpha_FDR = 0.10 for correlated fields)",
                   "minYears": MIN_YEARS, "recentYearsRequired": f"{RECENT_YEARS} of the last 6"},
        "stats": {"pixels": width * height, "tested": len(tested), "significant": len(sig),
                  "significantShare": round(len(sig) / len(tested), 4) if tested else 0,
                  "medianSignificantSlopePerDecade": round(statistics.median(sig) * 10 * unit_factor, 5) if sig else None,
                  "negativeShare": round(sum(1 for s in sig if s < 0) / len(sig), 4) if sig else None},
        "source": f"NASA GIBS {var['layer']} (colour-class midpoints)",
        "evidence": "trend extension of observed satellite pixels; not a forecast or facility attribution",
        "generated": date.today().isoformat(),
    }
    os.makedirs(os.path.join(OUT, site["id"]), exist_ok=True)
    with open(os.path.join(OUT, site["id"], f"{vid}.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"), allow_nan=False)
    st = out["stats"]
    print(f"  {site['id']:<10} {vid:<9} {width}x{height} px, {len(jobs)} tiles, tested {st['tested']}, "
          f"significant {st['significant']} ({st['significantShare']:.0%}), median {st['medianSignificantSlopePerDecade']}/decade  {time.time()-t0:.0f}s", flush=True)
    return out


def main(argv):
    sites = json.load(open(os.path.join(pc.DATA, "sites.json"), encoding="utf-8"))["sites"]
    catalog = json.load(open(os.path.join(pc.DATA, "gibs_layers.json"), encoding="utf-8"))
    catalog = catalog.get("layers", catalog)
    want_sites = [a for a in argv if any(s["id"] == a for s in sites)]
    want_vars = [a for a in argv if a in TARGETS]
    index = {}
    path = os.path.join(OUT, "index.json")
    if os.path.exists(path):
        index = json.load(open(path, encoding="utf-8")).get("sites", {})
    for site in sites:
        if want_sites and site["id"] not in want_sites:
            continue
        for vid in TARGETS:
            if want_vars and vid not in want_vars:
                continue
            build(site, vid, catalog)
            index.setdefault(site["id"], [])
            if vid not in index[site["id"]]:
                index[site["id"]].append(vid)
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"schemaVersion": "trend-map-index/1.0", "sites": index, "projectionThrough": 2035}, f, indent=1)


if __name__ == "__main__":
    main(sys.argv[1:])
