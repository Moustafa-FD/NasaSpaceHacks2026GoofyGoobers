#!/usr/bin/env python3
"""
Precipitation maps (mm/year) around each study site, past and projected, on one fixed scale.

Observed years 2003-2025: NASA MERRA-2 bias-corrected monthly precipitation (GIBS layer
MERRA2_Precipitation_Bias_Corrected_Monthly, native 0.5 deg x 0.625 deg grid), decoded from the
official colormap at each grid-cell centre and summed over the calendar year (rate x seconds).

Projected years 2027-2100 (delta-change method): the 2005-2024 observed normal map, scaled by the
NASA POWER NEX-GDDP-CMIP6 ensemble's annual precipitation at the site relative to its 2015-2024
mean (10-year centred running mean, so single model years don't flicker). One factor per scenario
(SSP1-2.6, SSP2-4.5, SSP3-7.0); the spatial pattern is the observed one. Conditional scenario,
not a weather forecast.

    python scripts/water_maps.py            # all sites
Output: data/cloudshadow/watermaps/<site>.json (schema water-map/1.0)
"""
import calendar, json, math, os, statistics, sys
from concurrent.futures import ThreadPoolExecutor
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import precompute as pc  # noqa: E402

LAYER = "MERRA2_Precipitation_Bias_Corrected_Monthly"
CMAP = "cm_MERRA2_Precipitation_Bias_Corrected_Monthly.xml"
DLAT, DLON = 0.5, 0.625           # MERRA-2 native grid
HALF_LAT, HALF_LON = 2.5, 3.125   # box around the site (11 x 11 cells)
FIRST, LAST = 2003, 2025          # complete calendar years
NORMAL = (2005, 2024)
OUT = os.path.join(pc.DATA, "watermaps")


def cell_grid(lat, lon):
    lat0 = math.floor((lat - HALF_LAT + 90) / DLAT) * DLAT - 90
    lon0 = math.floor((lon - HALF_LON + 180) / DLON) * DLON - 180
    ny, nx = int(round(2 * HALF_LAT / DLAT)) + 1, int(round(2 * HALF_LON / DLON)) + 1
    return lat0, lon0, ny, nx


def annual_maps(site, var, lut):
    lat0, lon0, ny, nx = cell_grid(site["lat"], site["lon"])
    centres = [(lat0 + (j + .5) * DLAT, lon0 + (i + .5) * DLON) for j in range(ny) for i in range(nx)]
    pts = [tuple(int(c) for c in pc.world_px(la, lo, var["z"])) for la, lo in centres]
    months = [d for d in pc.expand(var["intervals"]) if FIRST <= d.year <= LAST]

    def month(d):
        vals = []
        for gx, gy in pts:
            got = pc.values_for(var, lut, d, [(gx, gy)])
            vals.append(got[0] if got else None)
        return d, vals
    with ThreadPoolExecutor(16) as ex:
        decoded = list(ex.map(month, months))
    years = {}
    for d, vals in decoded:
        seconds = calendar.monthrange(d.year, d.month)[1] * 86400
        acc = years.setdefault(d.year, [[0.0, 0] for _ in pts])
        for k, v in enumerate(vals):
            if v is not None:
                acc[k][0] += v * seconds   # kg/m2/s x s = mm
                acc[k][1] += 1
    out = {}
    for y, acc in years.items():
        out[y] = [round(total) if n == 12 else None for total, n in acc]
    return {"lat0": lat0, "lon0": lon0, "dlat": DLAT, "dlon": DLON, "ny": ny, "nx": nx}, out


def cmip_factors(site_id):
    path = os.path.join(pc.DATA, "power-projections", f"{site_id}.json")
    doc = json.load(open(path, encoding="utf-8"))
    factors = {}
    for scen, body in doc["scenarios"].items():
        annual = {}
        for m in body["monthly"]:
            y = int(m["date"][:4])
            annual.setdefault(y, []).append(m["precipitationMmPerDay"] * m["days"])
        totals = {y: sum(v) for y, v in annual.items() if len(v) == 12}
        base = statistics.mean(totals[y] for y in range(2015, 2025) if y in totals)
        f = {}
        for y in range(2027, 2101):
            win = [totals[k] for k in range(y - 4, y + 6) if k in totals]
            if len(win) >= 5:  # the last years use a shorter (5-9 year) window
                f[y] = round(statistics.mean(win) / base, 4)
        factors[scen] = {"label": body.get("label", scen), "byYear": f, "baselineMmPerYear": round(base)}
    return factors, doc["source"]


def main(argv):
    sites = json.load(open(os.path.join(pc.DATA, "sites.json"), encoding="utf-8"))["sites"]
    catalog = json.load(open(os.path.join(pc.DATA, "gibs_layers.json"), encoding="utf-8"))
    var = dict(layer=LAYER, **catalog[LAYER])
    lut = pc.load_cmap(CMAP)
    os.makedirs(OUT, exist_ok=True)
    for site in sites:
        if argv and site["id"] not in argv:
            continue
        grid, years = annual_maps(site, var, lut)
        normal = []
        for k in range(grid["ny"] * grid["nx"]):
            vals = [years[y][k] for y in range(NORMAL[0], NORMAL[1] + 1) if y in years and years[y][k] is not None]
            normal.append(round(statistics.mean(vals)) if len(vals) >= 15 else None)
        factors, source = cmip_factors(site["id"])
        doc = {
            "schemaVersion": "water-map/1.0", "site": site["id"], "units": "mm/year", "grid": grid,
            "observed": {str(y): v for y, v in sorted(years.items())}, "normal": normal, "normalPeriod": list(NORMAL),
            "projection": {"method": "delta change: 2005-2024 observed normal x CMIP6 ensemble annual precipitation at the site / its 2015-2024 mean (10-year centred running mean)",
                           "scenarios": factors, "source": source},
            "source": {"name": "NASA MERRA-2 bias-corrected precipitation (GIBS)", "layer": LAYER},
            "evidence": "observed reanalysis for past years; conditional climate scenario for future years, not a forecast",
            "generated": date.today().isoformat(),
        }
        with open(os.path.join(OUT, f"{site['id']}.json"), "w", encoding="utf-8") as f:
            json.dump(doc, f, separators=(",", ":"), allow_nan=False)
        centre = (grid["ny"] // 2) * grid["nx"] + grid["nx"] // 2
        print(f"  {site['id']:<10} {grid['ny']}x{grid['nx']} cells · normal at site {normal[centre]} mm/yr · "
              f"SSP2-4.5 2050 x{factors.get('ssp245', {}).get('byYear', {}).get(2050)}", flush=True)


if __name__ == "__main__":
    main(sys.argv[1:])
