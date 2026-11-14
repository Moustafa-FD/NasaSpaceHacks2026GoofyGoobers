#!/usr/bin/env python3
"""
Cloud Shadow - precompute NASA time series for the demo case studies.

Pulls NASA GIBS tiles (no login needed), decodes pixel colours back into
physical values via the official GIBS colormaps, and writes monthly
"site vs. surroundings" series to data/series/<site>.json.

The browser app does the same thing live for any point you click; this script
just makes the demo examples load instantly.

Usage:
    python3 scripts/precompute.py              # all sites, all variables
    python3 scripts/precompute.py colossus1    # one site
    python3 scripts/precompute.py --hls        # also find cloud-free HLS dates

Needs: Python 3.9+, Pillow (pip install pillow)
"""
import io, json, math, os, re, sys, time, threading, urllib.request
import xml.etree.ElementTree as ET
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data", "cloudshadow")
CACHE = os.environ.get("GIBS_CACHE", os.path.join(ROOT, ".tilecache"))
GIBS = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best"
UA = {"User-Agent": "cloud-shadow-spaceapps/0.1"}

# Must stay in sync with js/layers.js
VARIABLES = {
    "LST_Day": dict(layer="MODIS_Terra_L3_Land_Surface_Temp_8Day_Day", cmap="cm_MODIS_Land_Surface_Temp.xml",
                    start="2003-01-01", every=1, win=1, ring=(6, 20), offset=-273.15),
    "LST_Night": dict(layer="MODIS_Terra_L3_Land_Surface_Temp_8Day_Night", cmap="cm_MODIS_Land_Surface_Temp.xml",
                      start="2003-01-01", every=1, win=1, ring=(6, 20), offset=-273.15),
    "NDVI": dict(layer="MODIS_Terra_L3_NDVI_16Day", cmap="cm_MODIS_L3_NDVI.xml",
                 start="2003-01-01", every=1, win=1, ring=(4, 12)),
    "NO2": dict(layer="TROPOMI_L2_Nitrogen_Dioxide_Tropospheric_Column", cmap="cm_OMI_Nitrogen_Dioxide_Tropo_Column.xml",
                start="2023-09-01", every=1, win=1, ring=(20, 50), scale=1e-15),  # GIBS tiles actually exist from Sep 2023
    "NO2_OMI": dict(layer="OMI_Nitrogen_Dioxide_Tropo_Column", cmap="cm_OMI_Nitrogen_Dioxide_Tropo_Column.xml",
                    start="2005-01-01", every=3, win=1, ring=(30, 70), scale=1e-15),
    "AOD": dict(layer="MODIS_Terra_Aerosol_Optical_Depth_3km", cmap="cm_MODIS_VIIRS_AOD.xml",
                start="2003-01-01", every=3, win=2, min_site=3, ring=(15, 40)),  # 5x5 window: retrievals are patchy near water/bright roofs
    "AirTemp": dict(layer="MERRA2_2m_Air_Temperature_Monthly", cmap="cm_MERRA2_2m_Air_Temperature_Monthly.xml",
                    start="2003-01-01", every=1, win=0, ring=(80, 200), offset=-273.15),
}
EXTRA_LAYERS = ["HLS_L30_Nadir_BRDF_Adjusted_Reflectance", "HLS_S30_Nadir_BRDF_Adjusted_Reflectance",
                "OPERA_L3_DIST-ANN-HLS_Color_Index"]

# ---------------------------------------------------------------- GIBS catalog (tile levels + dates)
CAPS_URL = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/1.0.0/WMTSCapabilities.xml"
def load_catalog(layers):
    path = os.path.join(CACHE, "WMTSCapabilities.xml")
    if not os.path.exists(path) or time.time() - os.path.getmtime(path) > 86400:
        os.makedirs(CACHE, exist_ok=True)
        with urllib.request.urlopen(urllib.request.Request(CAPS_URL, headers=UA), timeout=120) as r, open(path, "wb") as f:
            f.write(r.read())
    W = "{http://www.opengis.net/wmts/1.0}"; O = "{http://www.opengis.net/ows/1.1}"
    cat = {}
    for L in ET.parse(path).getroot().iter(W + "Layer"):
        lid = L.find(O + "Identifier").text
        if lid not in layers: continue
        tms = L.find(f"{W}TileMatrixSetLink/{W}TileMatrixSet").text
        cat[lid] = {"tms": tms, "z": int(tms.split("Level")[1]), "intervals": [v.text for v in L.iter(W + "Value")]}
    return cat

def expand(intervals, start=None):
    """'2000-02-26/2000-12-26/P8D' style intervals -> sorted list of dates."""
    out = []
    for iv in intervals:
        a, b, per = iv.split("/")
        d, end = date.fromisoformat(a[:10]), date.fromisoformat(b[:10])
        n = int(re.sub(r"\D", "", per)); unit = per[-1]
        while d <= end:
            out.append(d)
            if unit == "D": d += timedelta(days=n)
            elif unit == "M": d = date(d.year + (d.month - 1 + n) // 12, (d.month - 1 + n) % 12 + 1, 1)
            elif unit == "Y": d = date(d.year + n, d.month, d.day)
    out = sorted(set(out))
    return [d for d in out if not start or d >= date.fromisoformat(start)]

# ---------------------------------------------------------------- colormaps
def load_cmap(fname):
    """rgb -> numeric value (midpoint of the class interval). Transparent/no-data -> absent."""
    tree = ET.parse(os.path.join(DATA, fname))
    lut = {}
    for e in tree.iter("ColorMapEntry"):
        if e.get("transparent") == "true" or e.get("nodata") == "true" or not e.get("value"):
            continue
        parts = [s.strip() for s in e.get("value").strip("[]()").split(",")]
        lo, hi = (parts[0], parts[0]) if len(parts) == 1 else parts[:2]
        lo = float(lo.replace("INF", "inf")); hi = float(hi.replace("INF", "inf"))
        if math.isinf(lo): v = hi
        elif math.isinf(hi): v = lo
        else: v = (lo + hi) / 2
        lut[tuple(int(c) for c in e.get("rgb").split(","))] = v
    return lut

# ---------------------------------------------------------------- geometry
def world_px(lat, lon, z):
    n = 256 * 2 ** z
    x = (lon + 180) / 360 * n
    s = math.sin(math.radians(lat))
    y = (0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * n
    return x, y

def m_per_px(lat, z):
    return 156543.03392 * math.cos(math.radians(lat)) / 2 ** z

def sample_plan(lat, lon, z, win, ring):
    """Return {'site': [(gx,gy)], 'ref': [(gx,gy)]} in global pixel coords."""
    cx, cy = world_px(lat, lon, z)
    cx, cy = int(cx), int(cy)
    mpp = m_per_px(lat, z)
    site = [(cx + dx, cy + dy) for dx in range(-win, win + 1) for dy in range(-win, win + 1)]
    r0, r1 = ring[0] * 1000 / mpp, ring[1] * 1000 / mpp
    R = int(math.ceil(r1))
    step = max(1, R // 30)  # cap ring to ~3000 px
    ref = [(cx + dx, cy + dy) for dx in range(-R, R + 1, step) for dy in range(-R, R + 1, step)
           if r0 <= math.hypot(dx, dy) <= r1]
    return {"site": site, "ref": ref}

# ---------------------------------------------------------------- tiles
_lock = threading.Lock()
def fetch_tile(layer, d, tms, z, row, col):
    path = os.path.join(CACHE, layer, d.isoformat(), f"{z}_{row}_{col}.png")
    if os.path.exists(path):
        b = open(path, "rb").read()
        return Image.open(io.BytesIO(b)).convert("RGBA") if b else None
    url = f"{GIBS}/{layer}/default/{d.isoformat()}/{tms}/{z}/{row}/{col}.png"
    b = b""
    for attempt in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r:
                b = r.read(); break
        except urllib.error.HTTPError as e:
            if e.code == 400: return None  # bad request: don't cache
            if e.code == 404: break
            time.sleep(1 + attempt * 2)
        except Exception:
            time.sleep(1 + attempt * 2)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f: f.write(b)
    return Image.open(io.BytesIO(b)).convert("RGBA") if b else None

def values_for(var, lut, d, pts):
    """Decode a list of global pixel coords for one date -> list of floats (no-data dropped)."""
    by_tile = defaultdict(list)
    for gx, gy in pts: by_tile[(gy // 256, gx // 256)].append((gx % 256, gy % 256))
    out = []
    for (row, col), pix in by_tile.items():
        img = fetch_tile(var["layer"], d, var["tms"], var["z"], row, col)
        if img is None: continue
        px = img.load()
        for x, y in pix:
            r, g, b, a = px[x, y]
            if a == 0: continue
            v = lut.get((r, g, b))
            if v is not None: out.append(v)
    return out

def mean(a): return sum(a) / len(a) if a else None

def convert(var, v):
    if v is None: return None
    v = v + var.get("offset", 0)
    v = v * var.get("scale", 1)
    return round(v, 4)

# ---------------------------------------------------------------- main
def run_site(site, var_ids):
    path_out = os.path.join(DATA, "series", f"{site['id']}.json")
    out = json.load(open(path_out)) if os.path.exists(path_out) else {"id": site["id"], "vars": {}}
    out["generated"] = date.today().isoformat()
    for vid in var_ids:
        var = dict(VARIABLES[vid], **CATALOG[VARIABLES[vid]["layer"]]); lut = load_cmap(var["cmap"])
        plan = sample_plan(site["lat"], site["lon"], var["z"], var["win"], var["ring"])
        dates = expand(var["intervals"], var["start"])[::var["every"]]
        t0 = time.time()
        def one(d):
            s = values_for(var, lut, d, plan["site"]); r = values_for(var, lut, d, plan["ref"])
            # need most of the site window and a decent chunk of the ring to be valid
            ok_s = len(s) >= var.get("min_site", max(1, len(plan["site"]) // 2))
            ok_r = len(r) >= max(5, len(plan["ref"]) // 4)
            return d, (mean(s) if ok_s else None), (mean(r) if ok_r else None)
        with ThreadPoolExecutor(16) as ex:
            rows = list(ex.map(one, dates))
        # aggregate to calendar months
        agg = defaultdict(lambda: [[], []])
        for d, s, r in rows:
            k = f"{d.year:04d}-{d.month:02d}"
            if s is not None: agg[k][0].append(s)
            if r is not None: agg[k][1].append(r)
        months = sorted(agg)
        out["vars"][vid] = {
            "t": months,
            "site": [convert(var, mean(agg[k][0])) for k in months],
            "ref": [convert(var, mean(agg[k][1])) for k in months],
            "n": [len(agg[k][0]) for k in months],
        }
        valid = sum(1 for v in out["vars"][vid]["site"] if v is not None)
        print(f"  {site['id']:<10} {vid:<9} {len(dates):>5} dates -> {len(months)} months ({valid} valid)  {time.time()-t0:.0f}s", flush=True)
    os.makedirs(os.path.join(DATA, "series"), exist_ok=True)
    with open(os.path.join(DATA, "series", f"{site['id']}.json"), "w") as f:
        json.dump(out, f, separators=(",", ":"))

# ---------------------------------------------------------------- HLS clear-sky finder
def hls_best(site, target, span=80):
    z = 12; tms = "GoogleMapsCompatible_Level12"
    avail = {L: set(expand(CATALOG[L]["intervals"])) for L in EXTRA_LAYERS[:2]}
    gx, gy = world_px(site["lat"], site["lon"], z)
    row, col = int(gy) // 256, int(gx) // 256
    t = date.fromisoformat(target)
    cands = [t + timedelta(days=k) for k in range(-span, span + 1)]
    cands = [d for d in cands if d < date.today()]
    def score(args):
        layer, d = args
        img = fetch_tile(layer, d, tms, z, row, col)
        if img is None: return None
        px = list(img.getdata()) if not hasattr(img, "get_flattened_data") else list(img.get_flattened_data()); n = len(px)
        cover = sum(1 for p in px if p[3] > 0) / n
        if cover < 0.98: return None
        white = sum(1 for p in px if p[0] > 190 and p[1] > 190 and p[2] > 190) / n
        return (white + abs((d - t).days) / 4000, layer, d.isoformat(), round(white, 3))
    jobs = [(L, d) for L in EXTRA_LAYERS[:2] for d in cands if d in avail[L]]
    with ThreadPoolExecutor(16) as ex:
        res = [r for r in ex.map(score, jobs) if r]
    if not res: return None
    best = min(res)
    return {"layer": best[1], "date": best[2], "cloud": best[3]}

def run_hls(sites):
    out = {}
    for s in sites:
        out[s["id"]] = {k: hls_best(s, v) for k, v in s["compare"].items()}
        print("  HLS", s["id"], out[s["id"]], flush=True)
    with open(os.path.join(DATA, "hls_dates.json"), "w") as f:
        json.dump(out, f, indent=1)

if __name__ == "__main__":
    sites = json.load(open(os.path.join(DATA, "sites.json")))["sites"]
    CATALOG = load_catalog({v["layer"] for v in VARIABLES.values()} | set(EXTRA_LAYERS))
    # compact layer catalog for the browser (live mode + map date snapping)
    with open(os.path.join(DATA, "gibs_layers.json"), "w") as f:
        json.dump({k: {"tms": v["tms"], "z": v["z"], "intervals": v["intervals"]} for k, v in CATALOG.items()}, f, indent=1)
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if args: sites = [s for s in sites if s["id"] in args]
    if "--hls" in sys.argv:
        run_hls(sites)
    if "--hls-only" not in sys.argv and "--no-series" not in sys.argv:
        for s in sites:
            print(s["name"], flush=True)
            vsel = next((a.split("=", 1)[1].split(",") for a in sys.argv if a.startswith("--vars=")), list(VARIABLES))
            run_site(s, vsel)
    print("done")
