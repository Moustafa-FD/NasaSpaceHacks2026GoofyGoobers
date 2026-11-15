#!/usr/bin/env python3
"""
Footprint Atlas - pick high-resolution before/after photos for each site (Esri World Imagery Wayback).

NASA's 30 m HLS imagery is too coarse to see buildings. Wayback keeps every past release of Esri's
sub-metre World Imagery (2014 -> today). For each site we take one release per year, measure how much the
tiles over the site differ from the latest release, and pick as "before" the latest release from before the
site's start year (falling back to the earliest year) that differs clearly. Writes data/cloudshadow/wayback.json.
Usage: python scripts/wayback_pick.py
"""
import io, json, math, os, urllib.request
from PIL import Image, ImageChops, ImageStat
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data", "cloudshadow")
UA = {"User-Agent": "footprint-atlas-spaceapps/0.1"}
CFG = "https://s3-us-west-2.amazonaws.com/config.maptiles.arcgis.com/waybackconfig.json"
TILE = "https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/default028mm/MapServer/tile/{r}/{z}/{y}/{x}"
Z = 16

def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=40) as r: return r.read()

def tiles(lat, lon):
    n = 2 ** Z; x = (lon + 180) / 360 * n; s = math.sin(math.radians(lat))
    y = (0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * n
    return [(int(y) + dy, int(x) + dx) for dy in (-1, 0, 1) for dx in (-1, 0, 1)]

def mosaic(release, lat, lon):
    out = Image.new("RGB", (768, 768))
    for i, (ty, tx) in enumerate(tiles(lat, lon)):
        out.paste(Image.open(io.BytesIO(get(TILE.format(r=release, z=Z, y=ty, x=tx)))).convert("RGB"), ((i % 3) * 256, (i // 3) * 256))
    return out

def main():
    cfg = json.loads(get(CFG))
    rel = sorted(((v["itemTitle"].split("Wayback ")[1].rstrip(")"), int(k)) for k, v in cfg.items()))
    per_year = {}
    for date, r in rel: per_year.setdefault(int(date[:4]), (date, r))  # first release of each year
    latest_date, latest = rel[-1]
    sites = json.load(open(os.path.join(DATA, "sites.json")))["sites"]
    out = {}
    for s in sites:
        onset = int(str(s["onset"])[:4])
        now = mosaic(latest, s["lat"], s["lon"])
        diffs = {}
        for y, (date, r) in sorted(per_year.items()):
            if y >= 2026: continue
            img = mosaic(r, s["lat"], s["lon"])
            diffs[y] = (date, r, round(sum(ImageStat.Stat(ImageChops.difference(img, now)).mean) / 3, 1))
        cands = [y for y in diffs if y < onset] or [min(diffs)]
        before = max(cands, key=lambda y: (diffs[y][2] >= 12, y))  # latest pre-onset year with clear change
        d, r, score = diffs[before]
        out[s["id"]] = {"before": {"date": d, "release": r}, "after": {"date": latest_date, "release": latest},
                        "changeScore": score, "scores": {y: v[2] for y, v in diffs.items()}}
        print(f"{s['id']:<10} before {d} after {latest_date}  change score {score}  (all: {[(y, v[2]) for y, v in diffs.items()]})", flush=True)
    out["_meta"] = {"source": "Esri World Imagery Wayback", "tile": TILE.replace("{r}", "{release}"),
                    "note": "High-resolution context imagery (Esri, Maxar, Earthstar Geographics); capture dates within a release vary."}
    json.dump(out, open(os.path.join(DATA, "wayback.json"), "w"), indent=1)

if __name__ == "__main__":
    main()
