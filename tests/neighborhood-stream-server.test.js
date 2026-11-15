import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setTimeout as delay, setImmediate as turn } from 'node:timers/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const require=createRequire(import.meta.url);
const { createWebServer, createNeighborhoodService, neighborhoodQuery, validNeighborhoodResult }=require('../apps/web/server.cjs');

const query=(lat=35.09,lon=-90.16)=>new URLSearchParams({lat:String(lat),lon:String(lon)});
function result(center={lat:35.09,lon:-90.16}) {
  return {status:'ready',snapshot:{schemaVersion:1,status:'ready',center,radiusM:3300,extentM:[-3300,-3300,3300,3300],
    source:{name:'OpenStreetMap',license:'ODbL-1.0'},buildings:[],roads:[],areas:[],trees:[],waterways:[]},
  elevation:{schemaVersion:1,status:'unknown',center,width:2,height:2,heights:[null,null,null,null],validSamples:0},
  urban:{schemaVersion:1,status:'unknown',source:{reason:'explicitly unavailable in this fixture'},surfaces:[]}};
}
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
const settle=async()=>{await turn();await turn();};

async function launch(t,service){
  const server=createWebServer({neighborhoodService:service});
  await new Promise((resolve)=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{service.close();await new Promise((resolve)=>server.close(resolve));});
  return (path,options)=>fetch(`http://127.0.0.1:${server.address().port}${path}`,options);
}

test('coordinate validation rejects malformed/duplicate/nonfinite values and quantizes safe stable IDs',()=>{
  for(const value of ['','lat=35','lat=NaN&lon=0','lat=Infinity&lon=0','lat=76&lon=0','lat=-76&lon=0',
    'lat=0&lon=181','lat=0&lon=-181','lat=1&lat=2&lon=0','lat=0&lon=0&lon=2','lat=0x10&lon=0',
    'lat=35%3Bwhoami&lon=0','lat=%24%28whoami%29&lon=0']) assert.throws(()=>neighborhoodQuery(new URLSearchParams(value)));
  const a=neighborhoodQuery(query(35.091,-90.161)),b=neighborhoodQuery(query(35.094,-90.164));
  assert.equal(a.id,b.id);assert.equal(a.id,'stream-n3509-w9016');
  assert.deepEqual(a.center,{lat:35.09,lon:-90.16});
  assert.match(neighborhoodQuery(query(-75,180)).id,/^stream-s7500-e18000$/);
  assert.equal(neighborhoodQuery(query(-0.001,0)).id,'stream-n0-e0');
});

test('same-origin endpoint deduplicates a quantized request, polls to ready, and retains legacy APIs',async(t)=>{
  const work=deferred();let calls=0;
  const service=createNeighborhoodService({lookupCached:async()=>null,runner:()=>{calls++;return work.promise;}}),get=await launch(t,service);
  const health=await(await get('/api/health')).json();
  assert.equal(health.ok,true);assert.equal(health.capabilities.neighborhoodStreaming,true);
  assert.ok(health.sites>=5);
  assert.equal((await get('/api/sites/colossus1')).status,200);
  assert.equal((await get('/api/layers')).status,200);
  assert.equal((await get('/js/site-marker.js')).status,200);
  assert.equal((await get('/api/neighborhood?lat=NaN&lon=0')).status,400);
  assert.equal((await get('/api/neighborhood?lat=35.09&lon=-90.16',{method:'POST'})).status,405);
  const initial=await get('/api/neighborhood?lat=35.091&lon=-90.161');
  assert.equal(initial.status,202);assert.equal(initial.headers.get('retry-after'),'2');
  const initialBody=await initial.json();assert.equal(initialBody.status,'loading');assert.equal(initialBody.retryAfterMs,2000);
  assert.equal((await get('/api/neighborhood?lat=35.094&lon=-90.164')).status,202);
  assert.equal(calls,1);
  work.resolve(result());await settle();
  const completed=await get('/api/neighborhood?lat=35.091&lon=-90.161'),body=await completed.json();
  assert.equal(completed.status,200);assert.equal(body.status,'ready');assert.equal(body.id,initialBody.id);
  assert.deepEqual(body.snapshot.center,{lat:35.09,lon:-90.16});
  assert.deepEqual(body.elevation.heights,[null,null,null,null],'missing terrain is not replaced with zero');
  assert.equal(calls,1);
});

test('two-worker maximum and finite queue reject excess work without spawning it',async(t)=>{
  const tasks=[],service=createNeighborhoodService({lookupCached:async()=>null,maxConcurrent:99,maxQueued:1,runner:(request)=>{const task=deferred();tasks.push({request,...task});return task.promise;}});
  t.after(()=>{for(const task of tasks)task.resolve(result(task.request.center));service.close();});
  assert.equal((await service.get(query(35.1))).body.status,'loading');
  assert.equal((await service.get(query(35.2))).body.status,'loading');
  assert.equal((await service.get(query(35.3))).body.status,'pending');
  const excess=await service.get(query(35.4));assert.equal(excess.code,503);assert.match(excess.body.error,/queue is full/);
  assert.deepEqual(service.stats,{running:2,queued:1,records:3});assert.equal(tasks.length,2);
  assert.equal((await service.get(query(35.3))).code,202,'polling a queued job consumes no extra slot');
  tasks[0].resolve(result(tasks[0].request.center));await settle();
  assert.equal(tasks.length,3);assert.equal(service.stats.running,2);assert.equal(service.stats.queued,0);
});

test('failed acquisition stays explicit and cannot retry before the 60-second cooldown',async(t)=>{
  let time=1000,calls=0;
  const service=createNeighborhoodService({lookupCached:async()=>null,now:()=>time,runner:async(request)=>{if(++calls===1)throw new Error('provider unavailable');return result(request.center);}});
  t.after(()=>service.close());
  assert.equal((await service.get(query())).code,202);await settle();
  const failed=await service.get(query());assert.equal(failed.code,503);assert.equal(failed.body.status,'failed');
  assert.match(failed.body.error,/provider unavailable/);assert.equal(failed.body.retryAfterMs,60000);
  time+=59999;assert.equal((await service.get(query())).code,503);assert.equal(calls,1);
  time++;assert.equal((await service.get(query())).code,202);await settle();
  assert.equal((await service.get(query())).code,200);assert.equal(calls,2);
});

test('cache pressure preserves failure cooldown records rather than silently dropping failures',async(t)=>{
  let time=0,calls=0;
  const service=createNeighborhoodService({lookupCached:async()=>null,maxRecords:2,now:()=>time,runner:async()=>{calls++;throw new Error('offline');}});
  t.after(()=>service.close());
  for(const lat of [35.1,35.2]){assert.equal((await service.get(query(lat))).code,202);await settle();}
  assert.equal((await service.get(query(35.3))).code,503);assert.equal(service.stats.records,2);assert.equal(calls,2);
  assert.equal((await service.get(query(35.1))).code,503);assert.equal(calls,2);
  time=60000;assert.equal((await service.get(query(35.3))).code,202);await settle();assert.equal(calls,3);
});

test('ready cache returns its original coordinate frame, and bounded memory evicts old ready records',async(t)=>{
  const original={lat:35.0601,lon:-90.1564};let calls=0;
  const cached=createNeighborhoodService({lookupCached:async()=>result(original),runner:async()=>{calls++;throw new Error('should not run');}});
  t.after(()=>cached.close());
  const response=await cached.get(query(original.lat,original.lon));
  assert.equal(response.code,200);assert.deepEqual(response.body.snapshot.center,original);assert.equal(calls,0);
  const service=createNeighborhoodService({lookupCached:async()=>null,maxReady:2,maxRecords:4,runner:async(request)=>result(request.center)});
  t.after(()=>service.close());
  for(let i=0;i<12;i++){assert.equal((await service.get(query(36+i*.01))).code,202);await settle();assert.ok(service.stats.records<=2);}
});

test('invalid results cannot become ready and worker timeouts abort without background retries',async(t)=>{
  assert.throws(()=>validNeighborhoodResult({snapshot:{status:'failed'}}));
  const invalid=result();invalid.elevation.heights=[0];assert.throws(()=>validNeighborhoodResult(invalid));
  const valid=result();assert.deepEqual(validNeighborhoodResult(valid).elevation.heights,[null,null,null,null]);
  let calls=0,aborted=false;
  const service=createNeighborhoodService({lookupCached:async()=>null,timeoutMs:15,runner:(_,{signal})=>{calls++;return new Promise((_,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(new Error('aborted provider'));},{once:true}));}});
  t.after(()=>service.close());
  assert.equal((await service.get(query())).code,202);await delay(40);
  const failed=await service.get(query());assert.equal(failed.code,503);assert.equal(aborted,true);assert.equal(calls,1);
  await delay(25);assert.equal(calls,1,'failure alone schedules no recurring retry');
  assert.equal(service.stats.running,0);
});

test('service close cancels active work and never starts queued acquisitions',async()=>{
  let aborted=false,calls=0;
  const service=createNeighborhoodService({lookupCached:async()=>null,runner:(_,{signal})=>{calls++;return new Promise((_,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(new Error('stopped'));},{once:true}));}});
  await service.get(query(35.1));await service.get(query(35.2));assert.equal(calls,1);
  service.close();await settle();assert.equal(aborted,true);assert.equal(calls,1);assert.equal(service.stats.running,0);
  assert.equal((await service.get(query(35.3))).code,503);
});

test('optional urban adapter import/fetch/validation failures retain the ready streamed map and DEM without network calls',()=>{
  const code=String.raw`
import importlib.util,json,tempfile,types,urllib.request
from pathlib import Path
spec=importlib.util.spec_from_file_location('stream_test',Path('scripts/stream-neighborhood.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
def forbidden(*args,**kwargs):raise AssertionError('test must never contact a provider')
urllib.request.urlopen=forbidden
cases=[]
for mode in ['import','fetch','validate']:
  with tempfile.TemporaryDirectory() as directory:
    m.CACHE=Path(directory)
    def snapshot(site):return {'schemaVersion':1,'siteId':site['id'],'status':'ready','center':{'lat':site['lat'],'lon':site['lon']},'source':{'name':'fixture'},'buildings':[],'roads':[],'areas':[]}
    def heights(site):return {'status':'ready','center':{'lat':site['lat'],'lon':site['lon']},'width':1,'height':1,'heights':[123.5],'validSamples':1}
    def load(name,filename):
      if filename=='fetch-neighborhoods.py':return types.SimpleNamespace(fetch_one=lambda site,**kw:(site['id'],snapshot(site)),validate=lambda d:None)
      if filename=='fetch-terrain.py':return types.SimpleNamespace(acquire=heights,validate=lambda d:None)
      if mode=='import':raise RuntimeError('optional import failed')
      def fetch(site,**kw):
        if mode=='fetch':raise RuntimeError('optional provider failed')
        return {'status':'ready','center':{'lat':site['lat'],'lon':site['lon']}}
      def validate(doc):raise ValueError('optional urban geometry invalid')
      return types.SimpleNamespace(fetch_one=fetch,validate=validate)
    m.load_adapter=load
    path,document=m.acquire(35.09,-90.16)
    assert path.exists() and document['status']=='ready'
    assert document['snapshot']['status']=='ready' and document['elevation']['heights']==[123.5]
    assert document['urban']['status'] in ['unknown','failed']
    assert document['urban']['surfaces']==[] and document['urban']['source']['reason']
    assert document['recreation']['status'] in ['unknown','failed']
    assert document['recreation']['features']==[] and document['recreation']['source']['reason']
    cases.append(mode)
print(json.dumps(cases))
`;
  const execution=spawnSync(process.env.DATA_PYTHON_EXECUTABLE||process.env.PYTHON||'python',['-c',code],{
    cwd:fileURLToPath(new URL('..',import.meta.url)),encoding:'utf8',windowsHide:true,timeout:10000});
  assert.equal(execution.status,0,execution.stderr);
  assert.deepEqual(JSON.parse(execution.stdout.trim()),['import','fetch','validate']);
});

test('stream responses retain matching recreation provenance and discard mismatched optional coverage',()=>{
  const document=result(),recreation={status:'ready',center:document.snapshot.center,source:{license:'ODbL-1.0',osmTimestamp:'fixture'},features:[{id:'way/pitch',kind:'pitch',tags:{sport:'tennis'},polygon:[[0,0],[20,0],[20,30],[0,30]]}]};
  document.recreation=recreation;
  assert.deepEqual(validNeighborhoodResult(document).recreation,recreation);
  document.recreation={...recreation,center:{lat:0,lon:0}};
  assert.equal(validNeighborhoodResult(document).recreation,null);
  assert.equal(validNeighborhoodResult(document).snapshot.status,'ready','optional coverage cannot take away a valid map');
});
