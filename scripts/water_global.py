#!/usr/bin/env python3
"""
Global yearly rainfall grids (mm/year) for the Water map, 2003-2025, plus the 2005-2024 normal.

Source: NASA MERRA-2 bias-corrected monthly precipitation (GIBS MERRA2_Precipitation_Bias_Corrected_Monthly),
decoded from the official colormap at the centre of every 0.5 deg x 0.625 deg MERRA-2 cell and summed
over the calendar year (rate x seconds). A cell with any missing month is no-data for that year.

Output: data/cloudshadow/watermaps/global/<year>.png and normal.png (8-bit grayscale, equirectangular,
row 0 = north; value = mm/year / 20, 255 = no data) and index.json.

    python scripts/water_global.py
"""
import calendar, json, os, statistics, sys
from concurrent.futures import ThreadPoolExecutor
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import precompute as pc  # noqa: E402

LAYER, CMAP = "MERRA2_Precipitation_Bias_Corrected_Monthly", "cm_MERRA2_Precipitation_Bias_Corrected_Monthly.xml"
Z = 2                              # 1024 px around the world: ~0.35 deg per pixel, finer than the 0.5 deg grid
NX, NY = 576, 361                  # MERRA-2 grid: lon -180..179.375 step 0.625, lat -90..90 step 0.5
STEP, NODATA = 20, 255             # 20 mm/year per level, up to 5,080 mm/year
FIRST, LAST, NORMAL = 2003, 2025, (2005, 2024)
OUT = os.path.join(pc.DATA, "watermaps", "global")


def main():
    catalog = json.load(open(os.path.join(pc.DATA, "gibs_layers.json"), encoding="utf-8"))
    var = dict(layer=LAYER, **catalog[LAYER])  # tile matrix set stays Level6; we request its zoom-2 tiles
    lut = pc.load_cmap(CMAP)
    # cell centres -> global pixel at Z (web mercator only reaches ~85 deg; polar rows stay no-data)
    cells = []
    for j in range(NY):
        lat = 90 - j * 0.5
        for i in range(NX):
            lon = -180 + i * 0.625
            cells.append(tuple(int(c) for c in pc.world_px(lat, lon, Z)) if abs(lat) < 85 else None)
    months = [d for d in pc.expand(catalog[LAYER]["intervals"]) if FIRST <= d.year <= LAST]

    def month(d):
        tiles = {}
        out = []
        for c in cells:
            if c is None:
                out.append(None); continue
            gx, gy = c; key = (gy // 256, gx // 256)
            if key not in tiles:
                img = pc.fetch_tile(LAYER, d, var["tms"], Z, *key)
                tiles[key] = img.load() if img is not None else None
            px = tiles[key]
            if px is None:
                out.append(None); continue
            r, g, b, a = px[gx % 256, gy % 256]
            out.append(lut.get((r, g, b)) if a else None)
        return d, out

    with ThreadPoolExecutor(16) as ex:
        decoded = list(ex.map(month, months))
    totals = {}
    for d, vals in decoded:
        sec = calendar.monthrange(d.year, d.month)[1] * 86400
        acc = totals.setdefault(d.year, [[0.0, 0] for _ in cells])
        for k, v in enumerate(vals):
            if v is not None:
                acc[k][0] += v * sec; acc[k][1] += 1
    os.makedirs(OUT, exist_ok=True)
    annual = {}
    for y, acc in sorted(totals.items()):
        annual[y] = [t if n == 12 else None for t, n in acc]
        save(annual[y], os.path.join(OUT, f"{y}.png"))
    normal = []
    for k in range(len(cells)):
        vals = [annual[y][k] for y in range(NORMAL[0], NORMAL[1] + 1) if y in annual and annual[y][k] is not None]
        normal.append(statistics.mean(vals) if len(vals) >= 15 else None)
    save(normal, os.path.join(OUT, "normal.png"))
    json.dump({"schemaVersion": "water-global/1.0", "units": "mm/year", "encoding": f"8-bit gray, value x {STEP} mm/year, {NODATA} = no data",
               "grid": {"nx": NX, "ny": NY, "lon0": -180 - 0.3125, "lat0": 90 + 0.25, "dlon": 0.625, "dlat": 0.5, "rows": "north to south"},
               "step": STEP, "nodata": NODATA, "years": sorted(annual), "normalPeriod": list(NORMAL),
               "source": {"name": "NASA MERRA-2 bias-corrected precipitation (GIBS)", "layer": LAYER}},
              open(os.path.join(OUT, "index.json"), "w", encoding="utf-8"), indent=1)
    print("years", min(annual), "-", max(annual), "normal cells", sum(v is not None for v in normal))


def save(values, path):
    img = Image.new("L", (NX, NY))
    img.putdata([NODATA if v is None else min(NODATA - 1, int(round(v / STEP))) for v in values])
    img.save(path, optimize=True)


if __name__ == "__main__":
    main()
