#!/usr/bin/env python3
"""Bounded OSM neighborhood snapshots for the local low-poly scene generator.

Python standard library only. Geometries are current contributed OSM features;
road-width defaults and subsequent 3D architecture are illustrative.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import gzip
import hashlib
import json
import math
from pathlib import Path
import re
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "cloudshadow" / "neighborhoods"
RADIUS = 3300
EARTH = 6378137.0
ENDPOINTS = ("https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter")
KEEP_TAGS = {"building", "building:levels", "building:material", "building:colour", "height", "min_height", "roof:shape", "roof:height", "roof:colour", "roof:material", "name", "start_date", "construction", "amenity", "shop", "industrial", "historic"}
ROAD_WIDTHS = {"motorway": 14, "motorway_link": 7, "trunk": 12, "trunk_link": 7, "primary": 10, "primary_link": 7, "secondary": 9, "secondary_link": 7, "tertiary": 8, "tertiary_link": 6, "residential": 6, "living_street": 5, "unclassified": 6, "service": 4, "track": 3, "footway": 1.5, "path": 1.3, "cycleway": 2, "pedestrian": 4, "steps": 1.2}


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def area(poly):
    return abs(sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(poly, poly[1:] + poly[:1]))) / 2 if len(poly) >= 3 else 0


def clean(poly):
    out = []
    for p in poly:
        p = [round(p[0], 2), round(p[1], 2)]
        if not out or p != out[-1]:
            out.append(p)
    if len(out) > 1 and out[0] == out[-1]:
        out.pop()
    return out


def clip_polygon(poly, bound=RADIUS):
    """Clip an OSM ring to the finite local square (Sutherland-Hodgman)."""
    out = poly
    for axis, limit, direction in ((0, -bound, 1), (0, bound, -1), (1, -bound, 1), (1, bound, -1)):
        src, out = out, []
        if not src:
            break
        prev = src[-1]
        prev_in = direction * (prev[axis] - limit) >= 0
        for p in src:
            inside = direction * (p[axis] - limit) >= 0
            if inside != prev_in:
                t = (limit - prev[axis]) / (p[axis] - prev[axis])
                out.append([prev[0] + t * (p[0] - prev[0]), prev[1] + t * (p[1] - prev[1])])
            if inside:
                out.append(p)
            prev, prev_in = p, inside
    return clean(out)


def clip_segment(a, b, bound=RADIUS):
    lo, hi = 0.0, 1.0
    dx, dy = b[0] - a[0], b[1] - a[1]
    for p, q in ((-dx, a[0] + bound), (dx, bound - a[0]), (-dy, a[1] + bound), (dy, bound - a[1])):
        if p == 0:
            if q < 0:
                return None
            continue
        t = q / p
        if p < 0:
            lo = max(lo, t)
        else:
            hi = min(hi, t)
        if lo > hi:
            return None
    return clean([[a[0] + lo * dx, a[1] + lo * dy], [a[0] + hi * dx, a[1] + hi * dy]])


def clip_lines(points):
    chunks, current = [], []
    for a, b in zip(points, points[1:]):
        seg = clip_segment(a, b)
        if not seg or len(seg) < 2:
            if len(current) >= 2:
                chunks.append(current)
            current = []
        elif current and current[-1] == seg[0]:
            current.append(seg[-1])
        else:
            if len(current) >= 2:
                chunks.append(current)
            current = seg
    if len(current) >= 2:
        chunks.append(current)
    return chunks


def contains(poly, p):
    result = False
    for a, b in zip(poly, poly[1:] + poly[:1]):
        if (a[1] > p[1]) != (b[1] > p[1]) and p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]:
            result = not result
    return result


def stitch(parts):
    """Join relation member ways into closed outer/inner rings."""
    parts = [list(p) for p in parts if len(p) >= 2]
    rings = []
    while parts:
        ring = parts.pop()
        changed = True
        while ring[0] != ring[-1] and changed:
            changed = False
            for i, p in enumerate(parts):
                if ring[-1] == p[0]:
                    ring.extend(p[1:])
                elif ring[-1] == p[-1]:
                    ring.extend(p[-2::-1])
                elif ring[0] == p[-1]:
                    ring = p[:-1] + ring
                elif ring[0] == p[0]:
                    ring = p[:0:-1] + ring
                else:
                    continue
                parts.pop(i)
                changed = True
                break
        if ring[0] == ring[-1] and len(ring) >= 4:
            rings.append(ring)
    return rings


def area_kind(tags):
    land, natural, leisure = tags.get("landuse"), tags.get("natural"), tags.get("leisure")
    if natural == "water" or tags.get("waterway") == "riverbank" or land in {"reservoir", "basin"}:
        return "water"
    if land == "forest" or natural == "wood":
        return "forest"
    if land in {"farmland", "farmyard"}:
        return "farmland"
    if land in {"orchard", "vineyard"}:
        return "orchard"
    if land in {"residential", "industrial", "commercial"}:
        return land
    if leisure in {"park", "garden", "recreation_ground", "golf_course"}:
        return "park"
    if land in {"grass", "meadow", "recreation_ground", "cemetery", "village_green"} or natural == "grassland":
        return "grass"
    if natural in {"scrub", "heath", "wetland"}:
        return "scrub"
    return None


def width_for(tags):
    raw = tags.get("width", "")
    match = re.match(r"^\s*([0-9]+(?:\.[0-9]+)?)", raw)
    if match:
        val = float(match[1]) * (0.3048 if "ft" in raw or "'" in raw else 1)
        if 0.3 <= val <= 80:
            return round(val, 2), "osm:width"
    return ROAD_WIDTHS.get(tags.get("highway"), 4), "illustrative road-class default"


def query_for(site):
    lat, lon = site["lat"], site["lon"]
    dy = math.degrees(RADIUS / EARTH)
    dx = dy / math.cos(math.radians(lat))
    bbox = f"{lat-dy:.7f},{lon-dx:.7f},{lat+dy:.7f},{lon+dx:.7f}"
    return f'''[out:json][timeout:55][maxsize:33554432];
(
  way["building"]({bbox}); relation["building"]({bbox});
  way["highway"]({bbox}); way["waterway"]({bbox});
  way["landuse"]({bbox}); relation["landuse"]({bbox});
  way["natural"]({bbox}); relation["natural"]({bbox});
  way["leisure"~"^(park|garden|recreation_ground|golf_course)$"]({bbox});
  relation["leisure"~"^(park|garden|recreation_ground|golf_course)$"]({bbox});
  node["natural"="tree"]({bbox});
); out body geom;'''


def normalize(site, raw, endpoint, downloaded, digest):
    lat, lon = site["lat"], site["lon"]
    sx = EARTH * math.cos(math.radians(lat)) * math.pi / 180
    sy = EARTH * math.pi / 180

    def project(geom):
        return [[(p["lon"] - lon) * sx, (p["lat"] - lat) * sy] for p in geom if p and "lat" in p and "lon" in p]

    result = {"schemaVersion": 1, "siteId": site["id"], "center": {"lat": lat, "lon": lon}, "radiusM": RADIUS,
              "extentM": [-RADIUS, -RADIUS, RADIUS, RADIUS], "status": "ready",
              "source": {"name": "OpenStreetMap", "url": "https://www.openstreetmap.org/copyright", "license": "ODbL-1.0", "downloadedAt": downloaded, "endpoint": endpoint,
                         "osmTimestamp": raw.get("osm3s", {}).get("timestamp_osm_base"), "responseSha256": digest,
                         "coverage": "Current, incomplete contributed OSM mapping; not historical reconstruction.", "roadWidths": "OSM width tags when present; otherwise illustrative road-class defaults in meters."},
              "buildings": [], "roads": [], "areas": [], "trees": [], "waterways": []}
    elements = raw.get("elements", [])
    relation_members = {m["ref"] for e in elements if e["type"] == "relation" and e.get("tags", {}).get("building") for m in e.get("members", []) if m.get("type") == "way" and m.get("role", "outer") in {"outer", ""}}
    for element in elements:
        tags = element.get("tags", {})
        ident = f'{element["type"]}/{element["id"]}'
        if element["type"] == "node":
            if tags.get("natural") == "tree":
                p = project([element])[0]
                if max(abs(p[0]), abs(p[1])) <= RADIUS:
                    result["trees"].append({"id": ident, "x": round(p[0], 2), "y": round(p[1], 2)})
            continue
        if element["type"] == "relation":
            outers = stitch([project(m.get("geometry", [])) for m in element.get("members", []) if m.get("type") == "way" and m.get("role", "outer") in {"outer", ""}])
            inners = stitch([project(m.get("geometry", [])) for m in element.get("members", []) if m.get("type") == "way" and m.get("role") == "inner"])
        else:
            points = project(element.get("geometry", []))
            outers = [points] if len(points) >= 4 and points[0] == points[-1] else []
            inners = []
            if "highway" in tags:
                width, width_source = width_for(tags)
                for i, chunk in enumerate(clip_lines(points)):
                    result["roads"].append({"id": ident + (f"/{i}" if i else ""), "kind": tags["highway"], "width": width, "widthSource": width_source, "points": chunk})
            if tags.get("waterway") in {"river", "stream", "canal", "drain", "ditch"}:
                for i, chunk in enumerate(clip_lines(points)):
                    result["waterways"].append({"id": ident + (f"/{i}" if i else ""), "kind": tags["waterway"], "points": chunk})
        kind = area_kind(tags)
        for i, outer in enumerate(outers):
            polygon = clip_polygon(outer)
            if len(polygon) < 3 or area(polygon) < 2:
                continue
            feature = {"id": ident + (f"/{i}" if i else ""), "polygon": polygon}
            holes = [clip_polygon(h) for h in inners if h and contains(outer, h[0])]
            holes = [h for h in holes if len(h) >= 3 and area(h) > 2]
            if holes:
                feature["holes"] = holes
            if tags.get("building") and tags["building"] not in {"no", "construction"} and not (element["type"] == "way" and element["id"] in relation_members):
                result["buildings"].append({**feature, "tags": {k: v for k, v in tags.items() if k in KEEP_TAGS}})
            if kind:
                result["areas"].append({**feature, "kind": kind})
    for key in ("buildings", "roads", "areas", "trees", "waterways"):
        result[key].sort(key=lambda item: item["id"])
    return result


def fetch_one(site, refresh=False, attempts=2, ways_only=False):
    dest = OUT / f'{site["id"]}.json'
    if dest.exists() and not refresh:
        old = json.loads(dest.read_text(encoding="utf-8"))
        if old.get("status") == "ready":
            return site["id"], old
    query = query_for(site)
    if ways_only:
        query = re.sub(r"\s*relation[^;]+;", "", query)
    errors = []
    for endpoint in ENDPOINTS[:attempts]:  # Bounded attempts per invocation; no background retries.
        try:
            payload = urllib.parse.urlencode({"data": query}).encode()
            request = urllib.request.Request(endpoint, data=payload, headers={"User-Agent": "FootprintAtlas/0.1 local-neighborhood-precompute (https://github.com/Moustafa-FD/NasaSpaceHacks2026GoofyGoobers)", "Accept": "application/json", "Accept-Encoding": "gzip"})
            with urllib.request.urlopen(request, timeout=60) as response:
                blob = response.read(32 * 1024 * 1024 + 1)
                if len(blob) > 32 * 1024 * 1024:
                    raise ValueError("response exceeds bounded 32 MiB download")
                if response.headers.get("Content-Encoding") == "gzip":
                    blob = gzip.decompress(blob)
                    if len(blob) > 32 * 1024 * 1024:
                        raise ValueError("decoded response exceeds 32 MiB")
            raw = json.loads(blob)
            if raw.get("remark") or not isinstance(raw.get("elements"), list):
                raise ValueError(raw.get("remark", "missing elements list"))
            result = normalize(site, raw, endpoint, now(), hashlib.sha256(blob).hexdigest())
            result["source"]["queryScope"] = "ways and mapped tree nodes; multipolygon relations omitted" if ways_only else "ways, multipolygon relations, and mapped tree nodes"
            validate(result)
            dest.write_text(json.dumps(result, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
            print(json.dumps({"site": site["id"], "status": "ready", **{k: len(result[k]) for k in ("buildings", "roads", "areas", "trees")}}), flush=True)
            return site["id"], result
        except Exception as exc:
            errors.append({"endpoint": endpoint, "error": f"{type(exc).__name__}: {exc}"})
            print(json.dumps({"site": site["id"], "status": "attempt_failed", **errors[-1]}), flush=True)
    failure = {"schemaVersion": 1, "siteId": site["id"], "center": {"lat": site["lat"], "lon": site["lon"]}, "radiusM": RADIUS, "status": "failed", "source": {"name": "OpenStreetMap", "url": "https://www.openstreetmap.org/copyright", "license": "ODbL-1.0", "attemptedAt": now(), "errors": errors}, "buildings": [], "roads": [], "areas": [], "trees": [], "waterways": []}
    # A failed refresh never destroys an existing valid snapshot.
    if not dest.exists():
        dest.write_text(json.dumps(failure, separators=(",", ":")), encoding="utf-8")
    return site["id"], failure


def validate(doc):
    assert doc["schemaVersion"] == 1 and doc["source"]["license"] == "ODbL-1.0"
    ids = set()
    for category in ("buildings", "areas", "roads", "waterways"):
        for feature in doc.get(category, []):
            key = category + ":" + feature["id"]
            assert key not in ids, f"duplicate {key}"
            ids.add(key)
            points = feature.get("polygon", feature.get("points"))
            assert len(points) >= (3 if "polygon" in feature else 2), key
            for p in points:
                assert len(p) == 2 and all(math.isfinite(v) and abs(v) <= RADIUS + 0.02 for v in p), (key, p)
            if "polygon" in feature:
                assert area(points) >= 1.99, key
            for hole in feature.get("holes", []):
                assert len(hole) >= 3 and area(hole) > 1.99
                assert all(all(math.isfinite(v) and abs(v) <= RADIUS + 0.02 for v in p) for p in hole)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--site", action="append", help="One known site ID; repeatable. Defaults to all five.")
    parser.add_argument("--refresh", action="store_true")
    parser.add_argument("--attempts", type=int, choices=(1, 2), default=2, help="Bounded attempts per site in this invocation.")
    parser.add_argument("--ways-only", action="store_true", help="Lighter query omitting multipolygon relations; recorded in provenance.")
    parser.add_argument("--validate", action="store_true", help="Validate cached files without network access.")
    args = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    sites = json.loads((ROOT / "data/cloudshadow/sites.json").read_text(encoding="utf-8"))["sites"]
    if args.site:
        requested = set(args.site)
        if requested - {s["id"] for s in sites}:
            parser.error("unknown site ID")
        sites = [s for s in sites if s["id"] in requested]
    if args.validate:
        for site in sites:
            doc = json.loads((OUT / f'{site["id"]}.json').read_text(encoding="utf-8"))
            validate(doc)
            print(json.dumps({"site": site["id"], "status": doc["status"], **{k: len(doc[k]) for k in ("buildings", "roads", "areas", "trees")}}))
        return
    results = {}
    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [executor.submit(fetch_one, site, args.refresh, args.attempts, args.ways_only) for site in sites]
        for future in as_completed(futures):
            ident, doc = future.result()
            results[ident] = {"status": doc["status"], "counts": {k: len(doc[k]) for k in ("buildings", "roads", "areas", "trees", "waterways")}, "source": doc["source"], "bytes": (OUT / f"{ident}.json").stat().st_size}
    # Include existing valid snapshots in the inventory after a single-site retry.
    for site in json.loads((ROOT / "data/cloudshadow/sites.json").read_text(encoding="utf-8"))["sites"]:
        if site["id"] not in results:
            dest = OUT / f'{site["id"]}.json'
            if dest.exists():
                doc = json.loads(dest.read_text(encoding="utf-8"))
                results[site["id"]] = {"status": doc["status"], "counts": {k: len(doc[k]) for k in ("buildings", "roads", "areas", "trees", "waterways")}, "source": doc["source"], "bytes": dest.stat().st_size}
    report = {"generatedAt": now(), "radiusM": RADIUS, "boundedConcurrentRequests": 2, "sites": results, "allReady": all(x["status"] == "ready" for x in results.values())}
    (OUT / "report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({"allReady": report["allReady"], "sites": {k: v["counts"] for k, v in results.items()}}))


if __name__ == "__main__":
    main()
