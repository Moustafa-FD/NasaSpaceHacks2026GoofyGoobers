#!/usr/bin/env python3
"""Cache bounded, current OSM urban surfaces; python scripts/fetch-urban-detail.py [--validate].

Reuses ready urban-<site>.json files unless --refresh is explicit. Two concurrent
requests maximum, two endpoints maximum per site, 60 s timeout, 16 MiB response.
No airport is inferred from a city name or invented when it is absent from OSM.
Paved parcels require an explicit mapped paved surface; commercial land alone is
not treated as concrete. Parking paint and missing-width defaults are illustrative.

Incremental infrastructure: --infrastructure-only. Explicit small map fallback:
--map-infrastructure --site ashburn --map-radius 1000. These commands preserve
ready paving/airport geometry, and failed updates never replace ready source data.
"""
from __future__ import annotations
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import gzip
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import re
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location("neighborhood_fetch",ROOT/"scripts/fetch-neighborhoods.py")
base=importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
OUT=ROOT/"data/cloudshadow/neighborhoods"
TAGS={"name","ref","surface","width","lanes","lanes:forward","lanes:backward","oneway","sidewalk","sidewalk:left","sidewalk:right","service","highway","crossing","crossing:markings","parking","parking:lane:both","parking:lane:left","parking:lane:right","location","access","aeroway","amenity","landuse","bridge","layer","junction","power","height","voltage","cables","circuits","wires","material","design","tower:type","traffic_signals","traffic_signals:direction","direction"}
PAVED={"paved","asphalt","concrete","concrete:plates","concrete:lanes","paving_stones"}

def query_for(site,infrastructure_only=False):
    dy=math.degrees(base.RADIUS/base.EARTH);dx=dy/math.cos(math.radians(site["lat"]))
    box=f'{site["lat"]-dy:.7f},{site["lon"]-dx:.7f},{site["lat"]+dy:.7f},{site["lon"]+dx:.7f}'
    infrastructure=f'''way["power"~"^(line|minor_line)$"]({box});
node["power"~"^(tower|pole)$"]({box});node["highway"="traffic_signals"]({box});
way["highway"="service"]["service"~"^(driveway|parking_aisle)$"]({box});'''
    if infrastructure_only:return f'[out:json][timeout:55][maxsize:16777216];({infrastructure});out body geom;'
    return f'''[out:json][timeout:55][maxsize:16777216];(
way["amenity"="parking"]({box});relation["amenity"="parking"]({box});
way["aeroway"~"^(runway|taxiway|apron|aerodrome)$"]({box});relation["aeroway"~"^(apron|aerodrome)$"]({box});
way["landuse"~"^(commercial|retail|industrial)$"]["surface"~"^(paved|asphalt|concrete|concrete:plates|concrete:lanes|paving_stones)$"]({box});
relation["landuse"~"^(commercial|retail|industrial)$"]["surface"~"^(paved|asphalt|concrete|concrete:plates|concrete:lanes|paving_stones)$"]({box});
way["highway"]["lanes"]({box});way["highway"]["width"]({box});way["highway"]["sidewalk"]({box});
node["highway"="crossing"]({box});
{infrastructure}
);out body geom;'''

def width(tags,kind):
    raw=tags.get("width","");m=re.match(r"^\s*([0-9]+(?:\.[0-9]+)?)",raw)
    if m:
        n=float(m[1])*(0.3048 if "ft" in raw or "'" in raw else 1)
        if 0.3<=n<=100:return round(n,2),"osm:width"
    return (30 if kind=="runway" else 15),"illustrative aeroway-class default"

def normalize(site,raw,endpoint,blob):
    lat,lon=site["lat"],site["lon"]
    sx=base.EARTH*math.cos(math.radians(lat))*math.pi/180;sy=base.EARTH*math.pi/180
    def project(geom):return [[(p["lon"]-lon)*sx,(p["lat"]-lat)*sy] for p in geom if p and "lat" in p and "lon" in p]
    doc={"schemaVersion":1,"siteId":site["id"],"center":{"lat":lat,"lon":lon},"radiusM":base.RADIUS,"extentM":[-3300,-3300,3300,3300],"status":"ready",
         "source":{"name":"OpenStreetMap","url":"https://www.openstreetmap.org/copyright","license":"ODbL-1.0","downloadedAt":base.now(),"endpoint":endpoint,"osmTimestamp":raw.get("osm3s",{}).get("timestamp_osm_base"),"responseSha256":hashlib.sha256(blob).hexdigest(),"coverage":"Current, incomplete contributed OSM features in the existing 6.6 km square; not historical reconstruction.","styling":"Mapped locations, surfaces and paths. Missing widths/heights, wire sag, signal hardware, parking paint, gardens and short inferred house connections are illustrative, not surveyed."},"surfaces":[],"airways":[],"airports":[],"roadTags":[],"crossings":[],"powerLines":[],"infrastructureNodes":[]}
    elements=raw["elements"]
    members={m["ref"] for e in elements if e["type"]=="relation" for m in e.get("members",[]) if m.get("type")=="way"}
    for e in elements:
        tags=e.get("tags",{});ident=f'{e["type"]}/{e["id"]}';keep={k:v for k,v in tags.items() if k in TAGS}
        if e["type"]=="node":
            if tags.get("highway")=="crossing":
                p=project([e])[0]
                if max(abs(v) for v in p)<=base.RADIUS:doc["crossings"].append({"id":ident,"x":round(p[0],2),"y":round(p[1],2),"tags":keep})
            kind=tags.get("power") if tags.get("power") in {"tower","pole"} else "traffic_signals" if tags.get("highway")=="traffic_signals" else None
            if kind:
                p=project([e])[0]
                if max(abs(v) for v in p)<=base.RADIUS:doc["infrastructureNodes"].append({"id":ident,"kind":kind,"x":round(p[0],2),"y":round(p[1],2),"tags":keep})
            continue
        if e["type"]=="way":
            points=project(e.get("geometry",[]));outers=[points] if len(points)>=4 and points[0]==points[-1] else [];inners=[]
            if "highway" in tags:doc["roadTags"].append({"id":ident,"tags":keep})
            if tags.get("power") in {"line","minor_line"}:
                for i,chunk in enumerate(base.clip_lines(points)):doc["powerLines"].append({"id":ident+(f'/{i}' if i else ''),"kind":tags["power"],"points":chunk,"tags":keep})
            if tags.get("aeroway") in {"runway","taxiway"} and not outers:
                w,why=width(tags,tags["aeroway"])
                for i,chunk in enumerate(base.clip_lines(points)):doc["airways"].append({"id":ident+(f'/{i}' if i else ''),"kind":tags["aeroway"],"points":chunk,"width":w,"widthSource":why,"tags":keep})
        else:
            outers=base.stitch([project(m.get("geometry",[])) for m in e.get("members",[]) if m.get("type")=="way" and m.get("role","outer") in {"outer",""}])
            inners=base.stitch([project(m.get("geometry",[])) for m in e.get("members",[]) if m.get("type")=="way" and m.get("role")=="inner"])
        if e["type"]=="way" and e["id"] in members:continue
        kind=(tags.get("aeroway") if tags.get("aeroway") in {"apron","runway","taxiway","aerodrome"} else "parking" if tags.get("amenity")=="parking" else "paved" if tags.get("landuse") in {"commercial","retail","industrial"} and tags.get("surface") in PAVED else None)
        if not kind:continue
        if kind=="parking" and (tags.get("parking") in {"underground","multi-storey","rooftop"} or tags.get("location") in {"underground","roof","rooftop"}):continue
        for i,outer in enumerate(outers):
            polygon=base.clip_polygon(outer)
            if len(polygon)<3 or base.area(polygon)<2:continue
            item={"id":ident+(f'/{i}' if i else ''),"kind":kind,"polygon":polygon,"tags":keep}
            holes=[base.clip_polygon(h) for h in inners if h and base.contains(outer,h[0])]
            holes=[h for h in holes if len(h)>=3 and base.area(h)>2]
            if holes:item["holes"]=holes
            doc["airports" if kind=="aerodrome" else "surfaces"].append(item)
    for category in ("surfaces","airways","airports","roadTags","crossings","powerLines","infrastructureNodes"):doc[category].sort(key=lambda x:x["id"])
    return doc

def validate(doc):
    assert doc["schemaVersion"]==1 and doc["source"]["license"]=="ODbL-1.0"
    for category in ("surfaces","airways","airports","powerLines"):
        seen=set()
        for f in doc.get(category,[]):
            assert f["id"] not in seen;seen.add(f["id"])
            points=f.get("polygon",f.get("points"));assert len(points)>=(3 if "polygon" in f else 2)
            assert all(len(p)==2 and all(math.isfinite(v) and abs(v)<=3300.02 for v in p) for p in points)
    for c in doc.get("crossings",[]):assert abs(c["x"])<=3300.02 and abs(c["y"])<=3300.02
    for c in doc.get("infrastructureNodes",[]):assert c["kind"] in {"tower","pole","traffic_signals"} and abs(c["x"])<=3300.02 and abs(c["y"])<=3300.02

def fetch_one(site,refresh=False,attempts=2,surfaces_only=False,infrastructure_only=False):
    dest=OUT/f'urban-{site["id"]}.json'
    old=json.loads(dest.read_text(encoding="utf-8")) if dest.exists() else None
    if old and not refresh and old.get("status")=="ready":
        validate(old)
        if not infrastructure_only or old.get("source",{}).get("infrastructure",{}).get("status")=="ready":return old
    errors=[]
    for endpoint in base.ENDPOINTS[:attempts]:
        try:
            query=query_for(site,infrastructure_only)
            if surfaces_only:query=re.sub(r'way\["highway"\][^;]+;|node\["highway"="crossing"\][^;]+;','',query)
            request=urllib.request.Request(endpoint,data=urllib.parse.urlencode({"data":query}).encode(),headers={"User-Agent":"FootprintAtlas/0.1 bounded urban surface cache","Accept":"application/json","Accept-Encoding":"gzip"})
            with urllib.request.urlopen(request,timeout=60) as response:
                blob=response.read(16*1024*1024+1)
                if len(blob)>16*1024*1024:raise ValueError("response exceeds 16 MiB")
                if response.headers.get("Content-Encoding")=="gzip":blob=gzip.decompress(blob)
                if len(blob)>16*1024*1024:raise ValueError("decoded response exceeds 16 MiB")
            raw=json.loads(blob)
            if raw.get("remark") or not isinstance(raw.get("elements"),list):raise ValueError(raw.get("remark","missing elements"))
            doc=normalize(site,raw,endpoint,blob);doc["source"]["queryScope"]="mapped infrastructure and driveway/parking-aisle metadata only" if infrastructure_only else "mapped surfaces and aeroways only; road metadata and crossing nodes omitted" if surfaces_only else "mapped surfaces, aeroways, road metadata, crossing nodes and power/signal infrastructure";validate(doc)
            if infrastructure_only and old and old.get("status")=="ready":
                extra_source={**doc["source"],"status":"ready"};merged={**old,"powerLines":doc["powerLines"],"infrastructureNodes":doc["infrastructureNodes"],"source":{**old["source"],"infrastructure":extra_source}}
                road_tags={r["id"]:r for r in old.get("roadTags",[])}
                for r in doc["roadTags"]:road_tags[r["id"]]={"id":r["id"],"tags":{**road_tags.get(r["id"],{}).get("tags",{}),**r["tags"]}}
                merged["roadTags"]=sorted(road_tags.values(),key=lambda r:r["id"]);doc=merged
                doc["source"].pop("infrastructureRefresh",None)
            elif not surfaces_only:doc["source"]["infrastructure"]={"status":"ready","downloadedAt":doc["source"]["downloadedAt"],"endpoint":endpoint,"responseSha256":doc["source"]["responseSha256"]}
            dest.write_text(json.dumps(doc,separators=(",",":"),ensure_ascii=False),encoding="utf-8")
            print(json.dumps({"site":site["id"],"status":"ready",**{k:len(doc.get(k,[])) for k in ("surfaces","airways","airports","roadTags","crossings","powerLines","infrastructureNodes")}}),flush=True)
            return doc
        except Exception as exc:
            errors.append({"endpoint":endpoint,"error":f'{type(exc).__name__}: {exc}'})
            print(json.dumps({"site":site["id"],"status":"attempt_failed",**errors[-1]}),flush=True)
            if isinstance(exc,urllib.error.HTTPError) and exc.code==429:break
    failed={"schemaVersion":1,"siteId":site["id"],"status":"failed","source":{"name":"OpenStreetMap","url":"https://www.openstreetmap.org/copyright","license":"ODbL-1.0","attemptedAt":base.now(),"errors":errors},"surfaces":[],"airways":[],"airports":[],"roadTags":[],"crossings":[]}
    if infrastructure_only and old and old.get("status")=="ready":
        latest=json.loads(dest.read_text(encoding="utf-8")) if dest.exists() else old
        if latest.get("status")=="ready":old=latest
        old["source"]["infrastructureRefresh"]={"status":"failed","attemptedAt":base.now(),"errors":errors}
        dest.write_text(json.dumps(old,separators=(",",":"),ensure_ascii=False),encoding="utf-8");return old
    if not dest.exists():dest.write_text(json.dumps(failed,separators=(",",":")),encoding="utf-8")
    return failed

def fetch_map_infrastructure(site,refresh=False,radius=1600):
    """Explicit small, one-request fallback when public Overpass is unavailable.

    The OSM editing API is not used as an unbounded bulk-data service: this makes
    one cached map request per known site, <=3.2 km square, <=16 MiB, with no retry.
    Reference: https://wiki.openstreetmap.org/wiki/API_v0.6#Retrieving_map_data_by_bounding_box:_GET_/api/0.6/map
    """
    dest=OUT/f'urban-{site["id"]}.json'
    old=json.loads(dest.read_text(encoding="utf-8")) if dest.exists() else None
    if not old or old.get("status")!="ready":raise ValueError("map infrastructure fallback requires an existing ready urban snapshot")
    if not refresh and old.get("source",{}).get("infrastructure",{}).get("status")=="ready":return old
    dy=math.degrees(radius/base.EARTH);dx=dy/math.cos(math.radians(site["lat"]))
    bbox=f'{site["lon"]-dx:.7f},{site["lat"]-dy:.7f},{site["lon"]+dx:.7f},{site["lat"]+dy:.7f}'
    endpoint='https://api.openstreetmap.org/api/0.6/map?'+urllib.parse.urlencode({"bbox":bbox})
    try:
        request=urllib.request.Request(endpoint,headers={"User-Agent":"FootprintAtlas/0.1 small cached infrastructure fallback","Accept":"application/xml","Accept-Encoding":"gzip"})
        with urllib.request.urlopen(request,timeout=45) as response:
            blob=response.read(16*1024*1024+1)
            if len(blob)>16*1024*1024:raise ValueError("map response exceeds 16 MiB")
            if response.headers.get("Content-Encoding")=="gzip":blob=gzip.decompress(blob)
            if len(blob)>16*1024*1024:raise ValueError("decoded map response exceeds 16 MiB")
        root=ET.fromstring(blob);node_map={e.attrib["id"]:{"lat":float(e.attrib["lat"]),"lon":float(e.attrib["lon"])} for e in root.findall("node")};elements=[]
        for e in root:
            tags={t.attrib["k"]:t.attrib["v"] for t in e.findall("tag")}
            if e.tag=="node" and (tags.get("power") in {"tower","pole"} or tags.get("highway")=="traffic_signals"):
                elements.append({"type":"node","id":int(e.attrib["id"]),**node_map[e.attrib["id"]],"tags":tags})
            elif e.tag=="way" and (tags.get("power") in {"line","minor_line"} or "highway" in tags):
                refs=[n.attrib["ref"] for n in e.findall("nd")]
                if all(ref in node_map for ref in refs):elements.append({"type":"way","id":int(e.attrib["id"]),"geometry":[node_map[ref] for ref in refs],"tags":tags})
        doc=normalize(site,{"elements":elements},endpoint,blob);validate(doc)
        provenance={**doc["source"],"status":"ready","method":"OSM API v0.6 map bounding-box fallback","coverageExtentM":[-radius,-radius,radius,radius],"coverage":"Only ways touching the smaller bounded local square and their referenced nodes; infrastructure outside this partial coverage is unknown."}
        merged={**old,"powerLines":doc["powerLines"],"infrastructureNodes":doc["infrastructureNodes"],"source":{**old["source"],"infrastructure":provenance}}
        merged["source"].pop("infrastructureRefresh",None)
        road_tags={r["id"]:r for r in old.get("roadTags",[])}
        for r in doc["roadTags"]:road_tags[r["id"]]={"id":r["id"],"tags":{**road_tags.get(r["id"],{}).get("tags",{}),**r["tags"]}}
        merged["roadTags"]=sorted(road_tags.values(),key=lambda r:r["id"])
        dest.write_text(json.dumps(merged,separators=(",",":"),ensure_ascii=False),encoding="utf-8")
        print(json.dumps({"site":site["id"],"status":"ready","method":"small OSM map fallback","bytes":len(blob),"powerLines":len(doc["powerLines"]),"infrastructureNodes":len(doc["infrastructureNodes"])}),flush=True)
        return merged
    except Exception as exc:
        old["source"]["infrastructureRefresh"]={"status":"failed","attemptedAt":base.now(),"endpoint":endpoint,"error":f'{type(exc).__name__}: {exc}'}
        dest.write_text(json.dumps(old,separators=(",",":"),ensure_ascii=False),encoding="utf-8")
        print(json.dumps({"site":site["id"],"status":"infrastructure_unavailable","error":str(exc)}),flush=True);return old

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument("--site",action="append");parser.add_argument("--refresh",action="store_true");parser.add_argument("--attempts",type=int,choices=(1,2),default=2);parser.add_argument("--validate",action="store_true");parser.add_argument("--surfaces-only",action="store_true",help="Smaller bounded retry; omits supplemental road metadata and crossing nodes");parser.add_argument("--infrastructure-only",action="store_true",help="Incrementally merge power lines/supports, traffic signals and driveway tags without replacing ready surfaces");parser.add_argument("--map-infrastructure",action="store_true",help="Explicit one-request-per-site cached OSM map fallback with smaller 1.6 km half-extent");parser.add_argument("--map-radius",type=int,choices=(800,1000,1600),default=1600,help="Bounded half-extent for the explicit map fallback only");args=parser.parse_args()
    sites=json.loads((ROOT/"data/cloudshadow/sites.json").read_text(encoding="utf-8"))["sites"]
    if args.site:
        if set(args.site)-{s["id"] for s in sites}:parser.error("unknown site ID")
        sites=[s for s in sites if s["id"] in args.site]
    if args.validate:
        for site in sites:
            doc=json.loads((OUT/f'urban-{site["id"]}.json').read_text(encoding="utf-8"));validate(doc);print(site["id"],doc["status"])
        return
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures=[pool.submit(fetch_map_infrastructure,s,args.refresh,args.map_radius) if args.map_infrastructure else pool.submit(fetch_one,s,args.refresh,args.attempts,args.surfaces_only,args.infrastructure_only) for s in sites]
        docs=[future.result() for future in as_completed(futures)]
    print(json.dumps({"allReady":all(d["status"]=="ready" for d in docs),"infrastructureReady":all(d.get("source",{}).get("infrastructure",{}).get("status")=="ready" for d in docs),"sites":[d["siteId"] for d in docs]}))

if __name__=="__main__":main()
