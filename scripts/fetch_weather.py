#!/usr/bin/env python3
"""
Cloud Shadow - NASA POWER weather for each case-study site (drives Unreal plumes/clouds).

NASA POWER (https://power.larc.nasa.gov) serves MERRA-2-based point data, no login.
Monthly 2003-2025: wind speed/direction at 10 m, air temperature, precipitation, humidity.

Writes:
  data/cloudshadow/weather/<site>.json               raw monthly values + units + source
  data/cloudshadow/unreal/weather/<site>_monthly.csv Year,Month,T2M,WS10M,WD10M,PrecipMMDay,RH2M
  data/cloudshadow/weather/summary.json              long-term wind per site (vector mean), used by export

Usage:  npm run data:weather   (python scripts/fetch_weather.py)
"""
import json
import math
import os
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data", "cloudshadow")
API = ("https://power.larc.nasa.gov/api/temporal/monthly/point?parameters=WS10M,WD10M,T2M,PRECTOTCORR,RH2M"
       "&community=RE&longitude={lon}&latitude={lat}&start=2003&end=2025&format=JSON")
UA = {"User-Agent": "cloud-shadow-spaceapps/0.1"}
FILL = -999.0


def fetch(site):
    url = API.format(lat=site["lat"], lon=site["lon"])
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
        return json.load(r)


def main():
    sites = json.load(open(os.path.join(DATA, "sites.json"), encoding="utf-8"))["sites"]
    os.makedirs(os.path.join(DATA, "weather"), exist_ok=True)
    os.makedirs(os.path.join(DATA, "unreal", "weather"), exist_ok=True)
    summary = {}
    for s in sites:
        d = fetch(s)
        p = d["properties"]["parameter"]
        keys = sorted(k for k in p["T2M"] if not k.endswith("13"))  # "YYYY13" = annual mean, skip
        rows = []
        for k in keys:
            vals = {name: p[name].get(k, FILL) for name in ("T2M", "WS10M", "WD10M", "PRECTOTCORR", "RH2M")}
            if any(v == FILL for v in vals.values()):
                continue
            rows.append({"year": int(k[:4]), "month": int(k[4:]), **vals})
        out = {"id": s["id"], "source": "NASA POWER (MERRA-2), monthly, point", "api_version": d["header"]["api"]["version"],
               "units": {k: v["units"] for k, v in d["parameters"].items()}, "rows": rows}
        json.dump(out, open(os.path.join(DATA, "weather", f"{s['id']}.json"), "w"), indent=1)
        with open(os.path.join(DATA, "unreal", "weather", f"{s['id']}_monthly.csv"), "w") as f:
            f.write("Year,Month,T2M,WS10M,WD10M,PrecipMMDay,RH2M\n")
            for r in rows:
                f.write(f"{r['year']},{r['month']},{r['T2M']},{r['WS10M']},{r['WD10M']},{r['PRECTOTCORR']},{r['RH2M']}\n")
        # Long-term vector-mean wind. WD10M is meteorological (direction the wind comes FROM).
        # Average the "toward" vectors (u east, v north), then convert back.
        u = sum(-r["WS10M"] * math.sin(math.radians(r["WD10M"])) for r in rows) / len(rows)
        v = sum(-r["WS10M"] * math.cos(math.radians(r["WD10M"])) for r in rows) / len(rows)
        toward = (math.degrees(math.atan2(u, v)) + 360) % 360
        summary[s["id"]] = {
            "windFromDeg": round((toward + 180) % 360, 1),   # compass bearing the wind comes from
            "plumeTowardDeg": round(toward, 1),              # bearing a plume drifts toward
            "meanWindSpeedMS": round(sum(r["WS10M"] for r in rows) / len(rows), 2),
            "vectorMeanSpeedMS": round(math.hypot(u, v), 2),  # small = wind direction varies a lot
            "months": len(rows),
            "note": "Vector mean of monthly means: indicates the prevailing drift, not any single day.",
        }
        print(f"  {s['id']:<10} {len(rows)} months  wind from {summary[s['id']]['windFromDeg']:6.1f}°  "
              f"plume toward {summary[s['id']]['plumeTowardDeg']:6.1f}°  mean {summary[s['id']]['meanWindSpeedMS']} m/s")
    json.dump(summary, open(os.path.join(DATA, "weather", "summary.json"), "w"), indent=1)


if __name__ == "__main__":
    main()
