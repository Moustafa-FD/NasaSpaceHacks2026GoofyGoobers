"""Acquire EIA residential prices/bills and Census place coordinates; no API key.

Run: python scripts/fetch_electricity.py [--download]
Only the compact, attributed extraction is committed; source workbooks stay in tmp/.
XLSX decoding uses Python's standard library, so no spreadsheet dependency is needed.
"""
import argparse
import csv
from datetime import datetime, timezone
import hashlib
import io
import json
import math
from pathlib import Path
import re
import urllib.request
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / "tmp/electricity-sources"
OUT = ROOT / "data/cloudshadow/electricity"
NAMES = dict(x.split(":", 1) for x in (
    "AL:Alabama|AK:Alaska|AZ:Arizona|AR:Arkansas|CA:California|CO:Colorado|CT:Connecticut|DE:Delaware|DC:District of Columbia|FL:Florida|GA:Georgia|HI:Hawaii|ID:Idaho|IL:Illinois|IN:Indiana|IA:Iowa|KS:Kansas|KY:Kentucky|LA:Louisiana|ME:Maine|MD:Maryland|MA:Massachusetts|MI:Michigan|MN:Minnesota|MS:Mississippi|MO:Missouri|MT:Montana|NE:Nebraska|NV:Nevada|NH:New Hampshire|NJ:New Jersey|NM:New Mexico|NY:New York|NC:North Carolina|ND:North Dakota|OH:Ohio|OK:Oklahoma|OR:Oregon|PA:Pennsylvania|RI:Rhode Island|SC:South Carolina|SD:South Dakota|TN:Tennessee|TX:Texas|UT:Utah|VT:Vermont|VA:Virginia|WA:Washington|WV:West Virginia|WI:Wisconsin|WY:Wyoming"
).split("|"))
SOURCES = [
    {"id": "eia-861-2010-2025", "file": "current.xlsx", "title": "EIA-861 historical state data, 2010 onward, Total Electric Industry / Residential", "url": "https://www.eia.gov/electricity/data/state/xls/861/HS861%202010-.xlsx", "landingUrl": "https://www.eia.gov/electricity/data/state/", "releaseDate": "2026-10-07"},
    {"id": "eia-861-1990-2009", "file": "historic.xlsx", "title": "EIA-861 historical state data, 1990–2009, Total Electric Industry / Residential", "url": "https://www.eia.gov/electricity/data/state/xls/861/HS861%201990-2009.xlsx", "landingUrl": "https://www.eia.gov/electricity/data/state/"},
    {"id": "census-gazetteer-2020", "file": "places.zip", "title": "US Census 2020 national places Gazetteer: representative coordinates", "url": "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2020_Gazetteer/2020_Gaz_place_national.zip", "landingUrl": "https://www.census.gov/geographies/reference-files/time-series/geo/gazetteer-files.2020.html", "referenceYear": 2020},
]
PLACE_GROUPS = {
    "colossus1": [("TN", "Memphis city"), ("MS", "Southaven city"), ("AR", "West Memphis city"), ("MS", "Horn Lake city"), ("MS", "Olive Branch city"), ("TN", "Germantown city"), ("TN", "Bartlett city"), ("MS", "Hernando city")],
    "colossus2": [("MS", "Southaven city"), ("TN", "Memphis city"), ("MS", "Horn Lake city"), ("MS", "Olive Branch city"), ("MS", "Hernando city"), ("MS", "Walls town"), ("TN", "Germantown city"), ("AR", "West Memphis city")],
    "ashburn": [("VA", "Ashburn CDP"), ("VA", "Leesburg town"), ("VA", "Sterling CDP"), ("VA", "Herndon town"), ("VA", "Reston CDP"), ("VA", "Chantilly CDP"), ("VA", "Great Falls CDP"), ("MD", "Poolesville town")],
    "abilene": [("TX", "Abilene city"), ("TX", "Impact town"), ("TX", "Tye city"), ("TX", "Hawley city"), ("TX", "Clyde city"), ("TX", "Buffalo Gap town"), ("TX", "Merkel town"), ("TX", "Anson city")],
    "thedalles": [("OR", "The Dalles city"), ("WA", "Dallesport CDP"), ("OR", "Mosier city"), ("WA", "Lyle CDP"), ("WA", "Bingen city"), ("WA", "White Salmon city"), ("OR", "Hood River city"), ("WA", "Goldendale city")],
}


def sheet_rows(raw):
    """First workbook sheet is Total Electric Industry; preserve raw numeric values."""
    ns = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        shared = []
        if "xl/sharedStrings.xml" in z.namelist():
            shared = ["".join(t.text or "" for t in si.iter("{" + ns["m"] + "}t")) for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall("m:si", ns)]
        for row in ET.fromstring(z.read("xl/worksheets/sheet1.xml")).findall("m:sheetData/m:row", ns):
            cells = {}
            for c in row.findall("m:c", ns):
                col = re.match(r"[A-Z]+", c.attrib["r"])[0]
                v = c.find("m:v", ns)
                if c.attrib.get("t") == "inlineStr":
                    value = "".join(t.text or "" for t in c.findall(".//m:t", ns))
                elif v is None:
                    value = None
                elif c.attrib.get("t") == "s":
                    value = shared[int(v.text)]
                else:
                    try:
                        value = float(v.text)
                    except (TypeError, ValueError):
                        value = v.text
                cells[col] = value
            yield cells


def distance(a, b):
    lat1, lat2 = math.radians(a[0]), math.radians(b[0])
    h = math.sin((lat2-lat1)/2)**2 + math.cos(lat1)*math.cos(lat2)*math.sin(math.radians(b[1]-a[1])/2)**2
    return 12742 * math.asin(min(1, math.sqrt(h)))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--download", action="store_true", help="refresh source archives")
    opts = parser.parse_args()
    CACHE.mkdir(parents=True, exist_ok=True)
    OUT.mkdir(parents=True, exist_ok=True)
    retrieved = datetime.now(timezone.utc).isoformat(timespec="seconds")
    sources = []
    raw_by_id = {}
    for source in SOURCES:
        path = CACHE / source["file"]
        if opts.download or not path.exists():
            req = urllib.request.Request(source["url"], headers={"User-Agent": "FootprintAtlas/1.0 evidence acquisition"})
            with urllib.request.urlopen(req, timeout=90) as response:
                path.write_bytes(response.read())
        raw = path.read_bytes()
        raw_by_id[source["id"]] = raw
        sources.append({k: v for k, v in source.items() if k != "file"} | {"retrievedAt": retrieved, "sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw)})
    states = {code: {"name": name, "records": []} for code, name in NAMES.items()}
    for source in SOURCES[:2]:
        for row in sheet_rows(raw_by_id[source["id"]]):
            year, state = row.get("A"), row.get("B")
            if not isinstance(year, (int, float)) or state not in states:
                continue
            revenue, sales, customers, price = [row.get(c) for c in "CDEF"]
            if not all(isinstance(v, (int, float)) and v > 0 for v in [revenue, sales, customers, price]):
                continue
            record = {"year": int(year), "priceCentsKwh": price,
                "monthlyBillUsd": round(revenue * 1000 / customers / 12, 4),
                "monthlyKwh": round(sales * 1000 / customers / 12, 4),
                "customers": int(customers), "revenueThousandUsd": revenue, "salesMwh": sales,
                "sourceId": source["id"]}
            # Preserve source figures, rather than silently overwriting historic discrepancies.
            if abs(price - revenue / sales * 100) > .006:
                record["qualityFlags"] = ["published-price-differs-from-revenue-sales-ratio"]
            states[state]["records"].append(record)
    for state in states.values():
        state["records"].sort(key=lambda r: r["year"])
        assert len(state["records"]) >= 30, state["name"]
    with zipfile.ZipFile(io.BytesIO(raw_by_id["census-gazetteer-2020"])) as z:
        rows = csv.DictReader(io.StringIO(z.read(z.namelist()[0]).decode("utf-8-sig")), delimiter="\t")
        places = {(r["USPS"], r["NAME"]): {k.strip(): v.strip() for k, v in r.items()} for r in rows}
    sites_doc = json.loads((ROOT / "data/cloudshadow/sites.json").read_text(encoding="utf-8"))
    sites, cities = {}, {}
    for site in sites_doc["sites"]:
        selected = []
        for key in PLACE_GROUPS[site["id"]]:
            row = places[key]
            city_id = "census-" + row["GEOID"]
            city = {"id": city_id, "name": re.sub(r" (city|town|village|CDP)$", "", row["NAME"]), "officialName": row["NAME"], "state": key[0],
                "lat": float(row["INTPTLAT"]), "lon": float(row["INTPTLONG"]), "sourceId": "census-gazetteer-2020", "coordinateReferenceYear": 2020}
            cities[city_id] = city
            selected.append(city_id)
        sites[site["id"]] = {"onsetYear": int(site["onset"][:4]), "cityIds": selected, "citySelection": "Curated nearby Census places; not a utility service-area boundary."}
    first = min(s["records"][0]["year"] for s in states.values())
    last = min(s["records"][-1]["year"] for s in states.values())
    result = {"schemaVersion": 1, "title": "Residential electricity prices and average monthly bills", "generatedAt": retrieved,
        "evidenceClass": "official-observed-and-conditional-projection", "geography": "US state residential averages, used as city proxies; not city tariffs",
        "units": {"priceCentsKwh": "US cents/kWh, nominal", "monthlyBillUsd": "USD/residential customer/month, nominal", "monthlyKwh": "kWh/residential customer/month"},
        "coverage": {"firstObservedYear": first, "lastObservedYear": last, "projectionThrough": last + 10, "stateCount": len(states)},
        "sources": sources, "states": states, "cities": list(cities.values()), "sites": sites,
        "projection": {"method": "Latest observed price × exp(fitted annual log-price slope × years ahead)", "trainingYears": 10, "horizonYears": 10,
            "uncertainty": "Conditional 95% model range: log-price innovation variance accumulates with years ahead, plus fitted slope uncertainty. Not a calibrated long-horizon forecast interval.",
            "validation": "Rolling one-year-ahead hindcasts for latest five observed years; report mean absolute percentage error and carry-forward comparator. Does not validate ten-year accuracy.",
            "billAssumption": "Hold latest observed state monthly kWh/customer constant in all projected years; no household demand, tariff, policy or data-center load forecast.",
            "attribution": "Before/after differences describe all-cause state price changes. No data-center share or causal effect is estimated."},
        "calculations": {"monthlyBillUsd": "residential revenue (thousand USD) × 1000 / residential customers / 12", "monthlyKwh": "residential sales (MWh) × 1000 / residential customers / 12", "comparison": "Price-only comparison holds latest state monthly kWh constant in both years."}}
    (OUT / "index.json").write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    manifest = {"schemaVersion": 1, "generatedAt": retrieved, "script": "python scripts/fetch_electricity.py --download", "sources": sources, "coverage": result["coverage"], "recordCount": sum(len(v["records"]) for v in states.values())}
    (OUT / "sources.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Stored {manifest['recordCount']} state-year records ({first}–{last}), {len(cities)} nearby Census places; {(OUT / 'index.json').stat().st_size:,} bytes.")


if __name__ == "__main__":
    main()
