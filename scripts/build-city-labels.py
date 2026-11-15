"""Build a compact attributed place-label catalog. Raw archives stay in ignored tmp/.

Natural Earth POP_MAX is a metro estimate, not a current city census.
Five case-study municipalities use verified 2020 Census QuickFacts counts instead.
Run with --download to refresh source archives; population overrides are fixed 2020.
"""
import argparse
import csv
import io
import json
from pathlib import Path
import struct
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / 'tmp/city-label-sources'
SOURCES = {
    'natural-earth-places.zip': 'https://naciscdn.org/naturalearth/10m/cultural/ne_10m_populated_places_simple.zip',
    'census-2020-gazetteer.zip': 'https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2020_Gazetteer/2020_Gaz_place_national.zip',
}
# Values independently checked against Population, Census, April 1, 2020.
OVERRIDES = [
    ('VA', 'Ashburn CDP', 'Ashburn', 46349, 'ashburncdpvirginia'),
    ('TN', 'Memphis city', 'Memphis', 633104, 'memphiscitytennessee'),
    ('MS', 'Southaven city', 'Southaven', 54648, 'southavencitymississippi'),
    ('TX', 'Abilene city', 'Abilene', 125182, 'abilenecitytexas'),
    ('OR', 'The Dalles city', 'The Dalles', 16010, 'thedallescityoregon'),
]

def dbf_rows(data):
    count, header, width = struct.unpack_from('<IHH', data, 4)
    fields = []
    for start in range(32, header - 1, 32):
        if data[start] == 13:
            break
        fields.append((data[start:start + 11].split(b'\0')[0].decode(), data[start + 16]))
    for i in range(count):
        record = data[header + i * width:header + (i + 1) * width]
        if record[0] == 42:
            continue
        cursor, row = 1, {}
        for name, length in fields:
            row[name] = record[cursor:cursor + length].decode('utf-8', 'replace').strip()
            cursor += length
        yield row

def main():
    args = argparse.ArgumentParser()
    args.add_argument('--download', action='store_true')
    opts = args.parse_args()
    CACHE.mkdir(parents=True, exist_ok=True)
    for filename, url in SOURCES.items():
        if opts.download or not (CACHE / filename).exists():
            with urllib.request.urlopen(url, timeout=60) as response:
                (CACHE / filename).write_bytes(response.read())
    cities = []
    with zipfile.ZipFile(CACHE / 'natural-earth-places.zip') as archive:
        rows = dbf_rows(archive.read(next(n for n in archive.namelist() if n.endswith('.dbf'))))
        for row in rows:
            population = int(row['pop_max'] or 0)
            cities.append([row['ne_id'], row['name'], round(float(row['latitude']), 5),
                           round(float(row['longitude']), 5), population if population > 0 else None,
                           None, 'metro-estimate', row['adm1name'], row['adm0name'],
                           float(row['min_zoom'] or 6), 'natural-earth'])
    with zipfile.ZipFile(CACHE / 'census-2020-gazetteer.zip') as archive:
        rows = csv.DictReader(io.StringIO(archive.read(archive.namelist()[0]).decode('utf-8-sig')), delimiter='\t')
        gazetteer = {(r['USPS'], r['NAME']): {k.strip(): v.strip() for k, v in r.items()} for r in rows}
    for state, official_name, name, population, slug in OVERRIDES:
        row = gazetteer[(state, official_name)]
        lat, lon = float(row['INTPTLAT']), float(row['INTPTLONG'])
        # Only replace the same nearby US place, never a namesake elsewhere.
        cities = [c for c in cities if not (c[1] == name and abs(c[2]-lat) < .5 and abs(c[3]-lon) < .5)]
        cities.append(['census-' + row['GEOID'], name, lat, lon, population, 2020,
                       'cdp-census' if official_name.endswith('CDP') else 'city-census',
                       state, 'United States of America', 4 if population > 100000 else 6, slug])
    cities.sort(key=lambda c: (c[9], -(c[4] or 0), c[0]))
    output = {'schemaVersion': 1, 'columns': ['id','name','lat','lon','population','year','scope','region','country','minZoom','source'],
              'sources': {'natural-earth': {'url': 'https://www.naturalearthdata.com/downloads/10m-cultural-vectors/10m-populated-places/',
                 'version': '5.1.2', 'populationField': 'POP_MAX', 'note': 'Metro/micropolitan estimate; reference year not supplied. Not a current administrative city count.'},
                 'census': {'url': 'https://www.census.gov/quickfacts/', 'referenceDate': '2020-04-01',
                    'coordinates': SOURCES['census-2020-gazetteer.zip'], 'note': '2020 city/CDP population; Gazetteer internal point, not a facility location.'}},
              'cities': cities}
    path = ROOT / 'data/cloudshadow/cities.json'
    path.write_text(json.dumps(output, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8')
    print(f'{len(cities)} places, {path.stat().st_size:,} bytes')

if __name__ == '__main__':
    main()
