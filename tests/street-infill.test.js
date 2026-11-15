import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {planStreetInfill,sampleStreetFrontage} from '../apps/web/js/street-infill.js';
import {planNeighborhood,contains} from '../apps/web/js/neighborhood-core.js';
const manifest=JSON.parse(readFileSync(new URL('../apps/web/assets/low-poly/manifest.json',import.meta.url)));
const rect=(x,y,w,d)=>[[x-w/2,y-d/2],[x+w/2,y-d/2],[x+w/2,y+d/2],[x-w/2,y+d/2]];
const data=(extra={})=>({schemaVersion:1,siteId:'infill-test',center:{lat:35,lon:-90},radiusM:500,roads:[{id:'way/main',kind:'residential',width:6,points:[[-400,0],[400,0]]}],buildings:[],areas:[{id:'land/residential',kind:'residential',polygon:rect(0,0,950,600)}],trees:[],...extra});
const noPlants={maxTrees:0,maxCrops:0,maxGrass:0};
function footprint(b){const c=Math.cos(b.angle),s=Math.sin(b.angle);return rect(0,0,b.width,b.depth).map(([x,y])=>[b.x+x*c-y*s,b.y+x*s+y*c]);}

test('short source segments share cumulative frontage stations and fill both sides with stable source-way IDs',()=>{
  const coarse=data(),fine=data({roads:[{...coarse.roads[0],points:Array.from({length:161},(_,i)=>[-400+i*5,0])}]});
  assert.deepEqual(sampleStreetFrontage(coarse.roads[0]),sampleStreetFrontage(fine.roads[0]));
  const a=planStreetInfill(coarse),b=planStreetInfill(fine);assert.deepEqual(a.buildings,b.buildings);
  assert.ok(a.buildings.length>35);assert.ok(a.buildings.some((b)=>b.y>0)&&a.buildings.some((b)=>b.y<0));
  assert.ok(a.buildings.every((b)=>b.id===`infill:${b.roadId}:${b.stationM}:${b.side}`));
});

test('commercial frontages receive shops/offices while residential frontages receive houses/apartments',()=>{
  const residential=planStreetInfill(data()),commercial=planStreetInfill(data({areas:[{id:'retail',kind:'commercial',polygon:rect(0,0,950,600)}],roads:[{...data().roads[0],kind:'tertiary'}]}));
  assert.ok(residential.stats.byKind.house>0&&residential.stats.byKind.apartment>0);
  assert.ok(commercial.stats.byKind.shop>0&&commercial.stats.byKind.office>0);
  assert.ok(commercial.buildings.every((b)=>['shop','office'].includes(b.kind)));
  assert.ok([...residential.buildings,...commercial.buildings].every((b)=>b.kind!=='data-center'&&!b.tags.name&&!b.tags.height));
});

test('unclassified land needs nearby existing urban context, with no settlement inferred from an empty rural road',()=>{
  const empty=data({areas:[]});assert.equal(planStreetInfill(empty).buildings.length,0);
  const sourceBuildings=[{id:'house/a',kind:'house',x:-55,y:70,width:12,depth:14,angle:0},{id:'house/b',kind:'house',x:55,y:70,width:12,depth:14,angle:0}],populated={...empty,buildings:sourceBuildings.map((b)=>({id:b.id,polygon:rect(b.x,b.y,b.width,b.depth),tags:{building:'house'}}))};
  const result=planStreetInfill(populated,{sourceBuildings});assert.ok(result.buildings.length>0);assert.equal(result.stats.inferredUrban,result.buildings.length);
  assert.ok(result.buildings.every((b)=>Math.abs(b.x)<160));
});

test('protected natural/industrial areas, airport operations, parking and narrow water strips receive no infill',()=>{
  for(const kind of ['forest','water','farmland','orchard','park','industrial'])assert.equal(planStreetInfill(data({areas:[...data().areas,{kind,polygon:rect(0,0,950,600)}]})).buildings.length,0,kind);
  for(const urban of [{surfaces:[{kind:'parking',polygon:rect(0,0,950,600)}]},{airports:[{kind:'aerodrome',polygon:rect(0,0,950,600)}]},{airways:[{kind:'runway',width:40,points:[[-450,0],[450,0]]}]}])assert.equal(planStreetInfill(data(),{urban}).buildings.length,0);
  for(const tags of [{bridge:'yes'},{tunnel:'yes'},{layer:'1'},{service:'driveway'}])assert.equal(planStreetInfill(data({roads:[{...data().roads[0],tags}]})).buildings.length,0,'no frontage on grade-separated or private driveway ways');
  const strip={kind:'water',polygon:rect(0,16,950,1)},result=planStreetInfill(data({areas:[...data().areas,strip]}));
  assert.ok(result.buildings.length>0);assert.ok(result.buildings.every((b)=>b.y<0),'a thin water strip must block intersecting roofs even between perimeter probes');
});

test('source buildings outside the draw cap still block infill, and the separate allowance never removes mapped buildings',()=>{
  const dc={id:'way/dc',polygon:rect(-250,180,50,60),tags:{building:'data_center'}},unrendered={id:'way/not-drawn',polygon:rect(0,55,850,94),tags:{building:'apartments'}},snapshot=data({buildings:[dc,unrendered]});
  const baseline=planNeighborhood(snapshot,manifest,{...noPlants,maxBuildings:1,maxInfillBuildings:0}),filled=planNeighborhood(snapshot,manifest,{...noPlants,maxBuildings:1,maxInfillBuildings:60});
  assert.deepEqual(filled.instances.filter((i)=>i.source==='mapped'),baseline.instances);
  assert.equal(filled.stats.mappedBuildings,1);assert.ok(filled.stats.infillBuildings>0);
  for(const b of filled.instances.filter((i)=>i.source==='illustrative-infill'))assert.ok(footprint(b).every((p)=>!contains(p,unrendered.polygon)));
  assert.ok(filled.instances.filter((i)=>i.source==='illustrative-infill').every((i)=>i.illustrative&&i.name===''&&i.frontage.roadId==='way/main'));
});

test('the separate infill count/triangle caps and deterministic overview preserve the same architecture choices',()=>{
  const snapshot=data(),options={...noPlants,maxBuildings:0,maxInfillBuildings:15,maxInfillTriangles:4000},a=planNeighborhood(snapshot,manifest,options),b=planNeighborhood(snapshot,manifest,{...options,detail:'overview'});
  assert.ok(a.stats.infillBuildings>0&&a.stats.infillBuildings<=15);assert.ok(a.stats.infillTriangles<=4000);
  assert.equal(Object.values(a.stats.infillByKind).reduce((a,b)=>a+b,0),a.stats.infillBuildings);assert.deepEqual(a.instances,b.instances);
  assert.equal(planNeighborhood(snapshot,manifest,{...noPlants,maxBuildings:0}).stats.buildings,0,'legacy explicit hard budgets must remain usable');
});

test('expanded compact coverage exceeds the old650 cap and shares frontage between distance/angle sectors',()=>{
  const roads=[-300,-100,100,300].map((y,i)=>({id:'street/'+i,kind:'residential',width:6,points:[[-1800,y],[1800,y]]})),snapshot=data({radiusM:2000,roads,areas:[{kind:'residential',polygon:rect(0,0,3900,3900)}]}),plan=planNeighborhood(snapshot,manifest,{...noPlants,maxInfillBuildings:1600});
  assert.ok(plan.stats.infillBuildings>900);assert.ok(plan.stats.infillTriangles<=320000);assert.ok(plan.stats.infillBuildings<=1600);
  const small=planStreetInfill(snapshot,{maxInfillBuildings:80});assert.ok(small.stats.sectors.every((n)=>n>0));assert.ok(Math.max(...small.stats.sectors)<25);
});

test('grass beside existing urban homes can fill while campus service roads and recreation footprints remain clear',()=>{
  const homes=[{id:'h1',kind:'house',x:-55,y:70,width:12,depth:14,angle:0,tags:{building:'house'}},{id:'h2',kind:'house',x:55,y:70,width:12,depth:14,angle:0,tags:{building:'house'}}],snapshot=data({areas:[{kind:'grass',polygon:rect(0,0,950,600)}],buildings:homes.map((b)=>({id:b.id,polygon:rect(b.x,b.y,b.width,b.depth),tags:b.tags}))});
  assert.ok(planStreetInfill(snapshot,{sourceBuildings:homes}).buildings.length>0);
  const campus={id:'dc',kind:'data-center',x:0,y:0,width:850,depth:300,angle:0,tags:{building:'data_center'}},reserved=planStreetInfill({...snapshot,roads:[{...snapshot.roads[0],kind:'service'}]},{sourceBuildings:[...homes,campus]});assert.equal(reserved.buildings.length,0);
  const recreation={features:[{kind:'pitch',polygon:rect(0,0,950,600)}]};assert.equal(planStreetInfill(snapshot,{sourceBuildings:homes,recreation}).buildings.length,0);
  const planted=planNeighborhood(data({roads:[],areas:[{kind:'grass',polygon:rect(0,0,950,600)}]}),manifest,{maxBuildings:0,maxTrees:100,maxGrass:100,maxCrops:0,recreation:{features:[{kind:'playground',polygon:rect(0,0,950,600)}]}});
  assert.equal(planted.stats.trees,0);assert.equal(planted.stats.grass,0);
});
