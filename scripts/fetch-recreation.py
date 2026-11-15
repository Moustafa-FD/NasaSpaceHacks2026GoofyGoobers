#!/usr/bin/env python3
"""Cache contributed OSM recreation features for the five existing study areas.

Standard library only. Two parallel sites, two endpoints/attempts maximum, 50s
timeouts, bounded8MiB decoded responses. Ready source files survive failed refresh.
Equipment/facade geometry is illustrative; source sport/name tags are retained.
"""
from __future__ import annotations
import argparse
from concurrent.futures import ThreadPoolExecutor,as_completed
import gzip,hashlib,importlib.util,json,math,urllib.error,urllib.parse,urllib.request
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('recreation_map_adapter',ROOT/'scripts/fetch-neighborhoods.py')
base=importlib.util.module_from_spec(spec);spec.loader.exec_module(base)
OUT=ROOT/'data/cloudshadow/neighborhoods'
TAGS={'name','leisure','sport','amenity','tourism','building','height','building:levels','shelter_type','surface','access','indoor','covered','operator','playground','bench','backrest','seats'}

def query_for(site):
    dy=math.degrees(base.RADIUS/base.EARTH);dx=dy/math.cos(math.radians(site['lat']))
    box=f"{site['lat']-dy:.7f},{site['lon']-dx:.7f},{site['lat']+dy:.7f},{site['lon']+dx:.7f}"
    return f'''[out:json][timeout:40][maxsize:8388608];(
nwr["leisure"~"^(park|garden|recreation_ground|pitch|playground|sports_centre|fitness_station)$"]({box});
nwr["sport"~"^(tennis|basketball|soccer|football|baseball|softball|volleyball)$"]({box});
nwr["amenity"~"^(bench|picnic_table|shelter|community_centre)$"]({box});
nwr["tourism"="picnic_site"]({box});nwr["leisure"="picnic_table"]({box});
nwr["building"~"^(pavilion|sports_hall)$"]({box});
);out body geom;'''

def kind_for(tags):
    leisure,amenity=tags.get('leisure'),tags.get('amenity')
    if leisure in {'park','garden','recreation_ground'}:return 'park'
    if leisure=='playground':return 'playground'
    if amenity=='community_centre' or leisure=='sports_centre' or tags.get('building')=='sports_hall':return 'community'
    if leisure=='pitch' or tags.get('sport') in {'tennis','basketball','soccer','football','baseball','softball','volleyball'}:return 'pitch'
    if amenity=='bench':return 'bench'
    if amenity=='picnic_table' or leisure=='picnic_table':return 'picnic_table'
    if tags.get('tourism')=='picnic_site':return 'picnic_site'
    if amenity=='shelter' or tags.get('building')=='pavilion':return 'pavilion'
    if leisure=='fitness_station':return 'fitness'
    return None

def normalize(site,raw,endpoint,blob):
    lat,lon=site['lat'],site['lon'];sx=base.EARTH*math.cos(math.radians(lat))*math.pi/180;sy=base.EARTH*math.pi/180
    def project(points):return [[(p['lon']-lon)*sx,(p['lat']-lat)*sy] for p in points if p and 'lat'in p and 'lon'in p]
    doc={'schemaVersion':1,'siteId':site['id'],'center':{'lat':lat,'lon':lon},'radiusM':3300,'extentM':[-3300,-3300,3300,3300],'status':'ready',
         'source':{'name':'OpenStreetMap','url':'https://www.openstreetmap.org/copyright','license':'ODbL-1.0','endpoint':endpoint,'downloadedAt':base.now(),
                   'osmTimestamp':raw.get('osm3s',{}).get('timestamp_osm_base'),'responseSha256':hashlib.sha256(blob).hexdigest(),
                   'queryScope':'Mapped leisure parks/playgrounds/pitches, explicitly sport-tagged facilities, benches, picnic sites/tables, shelters and community centres in6.6km square.',
                   'coverage':'Current, incomplete contributed map; missing recreation features remain unknown. Not historical reconstruction.',
                   'styling':'Actual source feature geometry/tags; play equipment, pavilion forms, field markings and generic park furniture are illustrative, not surveyed equipment positions.'},'features':[]}
    elements=raw['elements'];members={m['ref'] for e in elements if e['type']=='relation' and kind_for(e.get('tags',{})) for m in e.get('members',[]) if m.get('type')=='way'}
    for e in elements:
        tags=e.get('tags',{});kind=kind_for(tags)
        if not kind:continue
        keep={k:v for k,v in tags.items() if k in TAGS};ident=f"{e['type']}/{e['id']}"
        if e['type']=='node':
            p=project([e])[0]
            if max(abs(v) for v in p)<=3300:doc['features'].append({'id':ident,'kind':kind,'x':round(p[0],2),'y':round(p[1],2),'tags':keep})
            continue
        if e['type']=='way':
            if e['id'] in members:continue
            points=project(e.get('geometry',[]));outers=[points] if len(points)>=4 and points[0]==points[-1] else [];inners=[]
        else:
            outers=base.stitch([project(m.get('geometry',[])) for m in e.get('members',[]) if m.get('type')=='way' and m.get('role','outer') in {'outer',''}])
            inners=base.stitch([project(m.get('geometry',[])) for m in e.get('members',[]) if m.get('type')=='way' and m.get('role')=='inner'])
        for i,outer in enumerate(outers):
            polygon=base.clip_polygon(outer)
            if len(polygon)<3 or base.area(polygon)<2:continue
            f={'id':ident+(f'/{i}'if i else''),'kind':kind,'polygon':polygon,'tags':keep}
            holes=[base.clip_polygon(h) for h in inners if h and base.contains(outer,h[0])]
            holes=[h for h in holes if len(h)>=3 and base.area(h)>=2]
            if holes:f['holes']=holes
            doc['features'].append(f)
    doc['features'].sort(key=lambda f:f['id']);return doc

def validate(doc):
    assert doc['schemaVersion']==1 and doc['source']['license']=='ODbL-1.0'
    assert doc['status']in {'ready','failed'} and len(doc.get('features',[]))<=20000
    seen=set()
    for f in doc.get('features',[]):
        assert f['id']not in seen;seen.add(f['id']);assert f['kind']in {'park','pitch','playground','bench','picnic_table','picnic_site','pavilion','community','fitness'}
        points=f.get('polygon',[[f.get('x'),f.get('y')]])
        assert all(len(p)==2 and all(isinstance(v,(int,float)) and math.isfinite(v) and abs(v)<=3300.02 for v in p) for p in points)
        for hole in f.get('holes',[]):assert len(hole)>=3 and all(all(math.isfinite(v) and abs(v)<=3300.02 for v in p)for p in hole)

def fetch_one(site,refresh=False,attempts=2):
    dest=OUT/f"recreation-{site['id']}.json"
    old=json.loads(dest.read_text(encoding='utf-8'))if dest.exists()else None
    if old and old.get('status')=='ready' and not refresh:validate(old);return old
    errors=[]
    for endpoint in base.ENDPOINTS[:attempts]:
        try:
            request=urllib.request.Request(endpoint,data=urllib.parse.urlencode({'data':query_for(site)}).encode(),headers={'User-Agent':'FootprintAtlas/0.1 bounded-recreation-cache','Accept':'application/json','Accept-Encoding':'gzip'})
            with urllib.request.urlopen(request,timeout=50)as response:
                blob=response.read(8388609)
                if len(blob)>8388608:raise ValueError('response exceeds8MiB')
                if response.headers.get('Content-Encoding')=='gzip':blob=gzip.decompress(blob)
                if len(blob)>8388608:raise ValueError('decoded response exceeds8MiB')
            raw=json.loads(blob)
            if raw.get('remark')or not isinstance(raw.get('elements'),list):raise ValueError(raw.get('remark','missing OSM elements'))
            doc=normalize(site,raw,endpoint,blob);validate(doc)
            raw_dir=ROOT/'tmp/recreation-sources';raw_dir.mkdir(parents=True,exist_ok=True);(raw_dir/f"{site['id']}.json.gz").write_bytes(gzip.compress(blob))
            dest.write_text(json.dumps(doc,ensure_ascii=False,separators=(',',':'))+'\n',encoding='utf-8')
            print(json.dumps({'site':site['id'],'status':'ready','features':len(doc['features'])}),flush=True);return doc
        except Exception as error:
            errors.append({'endpoint':endpoint,'error':f'{type(error).__name__}: {error}'});print(json.dumps({'site':site['id'],'status':'attempt_failed',**errors[-1]}),flush=True)
            if isinstance(error,urllib.error.HTTPError)and error.code==429:break
    if old and old.get('status')=='ready':return old
    failed={'schemaVersion':1,'siteId':site['id'],'center':{'lat':site['lat'],'lon':site['lon']},'radiusM':3300,'status':'failed','source':{'name':'OpenStreetMap','url':'https://www.openstreetmap.org/copyright','license':'ODbL-1.0','attemptedAt':base.now(),'errors':errors},'features':[]}
    dest.write_text(json.dumps(failed,separators=(',',':'))+'\n',encoding='utf-8');return failed

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--site',action='append');parser.add_argument('--refresh',action='store_true');parser.add_argument('--attempts',type=int,choices=(1,2),default=2);parser.add_argument('--validate',action='store_true');args=parser.parse_args()
    sites=json.loads((ROOT/'data/cloudshadow/sites.json').read_text(encoding='utf-8'))['sites'];sites=[s for s in sites if not args.site or s['id']in args.site]
    if args.validate:
        for site in sites:validate(json.loads((OUT/f"recreation-{site['id']}.json").read_text(encoding='utf-8')))
        print(json.dumps({'validated':len(sites)}));return
    with ThreadPoolExecutor(max_workers=2)as pool:
        futures=[pool.submit(fetch_one,s,args.refresh,args.attempts)for s in sites]
        for future in as_completed(futures):future.result()
if __name__=='__main__':main()
