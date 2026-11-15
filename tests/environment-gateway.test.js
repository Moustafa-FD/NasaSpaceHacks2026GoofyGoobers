import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{environmentGateway}=require('../apps/web/environment-gateway.cjs'),{nearbyWaterStations}=require('../apps/web/water-stations.cjs');
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
test('same-origin gateway forwards bounded job requests and rejects unrelated routes',async t=>{
  const source=createServer((req,res)=>{let body='';req.on('error',()=>{});req.on('data',chunk=>body+=chunk);req.on('end',()=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({path:req.url,method:req.method,body,authorization:req.headers.authorization||null}));});});
  await listen(source);const gateway=environmentGateway({port:source.address().port});
  const web=createServer((req,res)=>{if(!gateway(req,res,new URL(req.url,'http://local'))){res.writeHead(404);res.end();}});await listen(web);
  t.after(async()=>{await Promise.all([new Promise(r=>web.close(r)),new Promise(r=>source.close(r))]);});
  const base='http://127.0.0.1:'+web.address().port;
  const response=await fetch(base+'/api/environment/v1/runs',{method:'POST',headers:{authorization:'do-not-forward','content-type':'application/json'},body:'{"kind":"trend-analysis"}'});
  assert.deepEqual(await response.json(),{path:'/v1/runs',method:'POST',body:'{"kind":"trend-analysis"}',authorization:null});
  assert.equal((await fetch(base+'/api/environment/https://other.example')).status,405);
  assert.equal((await fetch(base+'/api/environment/v1/runs',{method:'POST',body:'x'.repeat(65537)})).status,413);
});
test('station discovery uses source geometry, sorts available stations and preserves limits',async()=>{
  let requested;
  const result=await nearbyWaterStations(new URLSearchParams({lat:'40.123',lon:'-75.123'}),{fetchImpl:async url=>{requested=url;return {ok:true,json:async()=>({features:[{id:'USGS-12345678',properties:{monitoring_location_name:'Far'},geometry:{coordinates:[-75.4,40.4]}},{id:'USGS-87654321',properties:{monitoring_location_name:'Near'},geometry:{coordinates:[-75.13,40.13]}},{id:'INVALID',geometry:{coordinates:[0,0]}}]})};}});
  assert.ok(requested.startsWith('https://api.waterdata.usgs.gov/'));
  assert.equal(result.stations[0].name,'Near');assert.equal(result.stations.length,2);assert.match(result.warnings[0],/may lack/);
  await assert.rejects(()=>nearbyWaterStations(new URLSearchParams({lat:'bad',lon:'-75'})),/Valid/);
});
