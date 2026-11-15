import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {planNeighborhood,contains,areaAt,segmentDistance} from '../apps/web/js/neighborhood-core.js';

const original=JSON.parse(readFileSync(new URL('../apps/web/assets/low-poly/manifest.json',import.meta.url))),grove=original.models.find((m)=>m.style==='grove');
// Planner-only variants reuse one mesh reference; authored-kit geometry has its
// own checks. This catches row-correlated selection even with older asset kits.
const manifest={...original,models:[...original.models,...['b','c','d'].map((suffix)=>({...grove,id:'grove-fixture-'+suffix}))]},models=new Map(manifest.models.map((m)=>[m.id,m]));
const rect=(x,y,w,d)=>[[x-w/2,y-d/2],[x+w/2,y-d/2],[x+w/2,y+d/2],[x-w/2,y+d/2]];
const fixture=(extra={})=>({schemaVersion:1,siteId:'tree-placement',center:{lat:35,lon:-90},radiusM:1200,buildings:[],roads:[],trees:[],areas:[{id:'forest',kind:'forest',polygon:rect(0,0,2200,2200)}],...extra});
const options={maxBuildings:0,maxCrops:0,maxGrass:0,maxTrees:350};
const trees=(plan)=>plan.instances.filter((i)=>i.kind==='tree');

test('forest positions break planting rows, mix neighboring variants and retain useful centre spacing',()=>{
  const a=planNeighborhood(fixture(),manifest,options),b=planNeighborhood(fixture(),manifest,options),plants=trees(a);assert.deepEqual(a.instances,b.instances);assert.equal(plants.length,350);
  assert.ok(new Set(plants.map((p)=>p.model)).size>=4);
  let wideJitter=0,adjacent=0,repeated=0;const cells=new Map();
  for(const p of plants){const parts=p.id.split(':'),cx=Number(parts.at(-2)),cy=Number(parts.at(-1));cells.set(cx+','+cy,p);if(Math.abs(p.x-cx)>10||Math.abs(p.y-cy)>10)wideJitter++;}
  for(const [key,p] of cells){const [x,y]=key.split(',').map(Number);for(const q of [cells.get(x+24+','+y),cells.get(x+','+(y+24))])if(q){adjacent++;if(q.model===p.model)repeated++;}}
  assert.ok(wideJitter>plants.length*.25,'offsets must spread beyond the old six-metre half-cell jitter');assert.ok(adjacent>100);assert.ok(repeated/adjacent<.55,'neighbors must not repeat one species across rows');
  for(let i=0;i<plants.length;i++)for(let j=0;j<i;j++)assert.ok(Math.hypot(plants[i].x-plants[j].x,plants[i].y-plants[j].y)>=12-1e-8,'procedural grove centers must not collapse into pairs');
  const scales=plants.map((p)=>p.scale[0]);assert.ok(Math.max(...scales)-Math.min(...scales)>.5);assert.equal(new Set(plants.map((p)=>Math.floor(p.angle/(Math.PI/2)))).size,4);
});

test('broad dense forests still fill the3200-group budget with many crowns and preserve mapped tree coordinates',()=>{
  const mapped=[{id:'node/1',x:12.123,y:18.456},{id:'node/2',x:12.323,y:18.556}],data=fixture({trees:mapped}),plan=planNeighborhood(data,manifest,{...options,maxTrees:3200});
  assert.equal(plan.stats.trees,3200);assert.ok(plan.stats.canopyCrowns>28000);
  for(const source of mapped){const placed=plan.instances.find((p)=>p.id===source.id);assert.ok(placed);assert.equal(placed.x,source.x);assert.equal(placed.y,source.y);assert.equal(placed.mappedPosition,true);}
});

test('narrow forest edges can receive individual trees while crowns avoid water, fields, roads, buildings and courts',()=>{
  const forest={id:'strip',kind:'forest',polygon:rect(0,0,18,1000),holes:[rect(0,-260,18,70)]},pond={id:'water',kind:'water',polygon:rect(0,120,18,45)},field={id:'field',kind:'farmland',polygon:rect(0,-260,18,70)},court={id:'court',kind:'pitch',polygon:rect(0,250,18,70)},road={id:'road',kind:'residential',width:6,points:[[-100,0],[100,0]]},building={id:'house',polygon:rect(0,-100,12,16),tags:{building:'house'}},data=fixture({radiusM:600,areas:[forest,pond,field],roads:[road],buildings:[building]});
  const plan=planNeighborhood(data,manifest,{...options,maxTrees:100,recreation:{features:[court]}}),plants=trees(plan).filter((p)=>p.id.startsWith(data.siteId+':plant:'));assert.ok(plants.length>0);assert.ok(plants.every((p)=>models.get(p.model).style!=='grove'),'the full nine-crown mesh cannot fit this strip');
  for(const p of plants){const m=models.get(p.model),c=Math.cos(p.angle),s=Math.sin(p.angle);for(const u of [-.5,0,.5])for(const v of [-.5,0,.5]){
    const dx=u*m.width*p.scale[0],dy=v*m.depth*p.scale[2],point=[p.x+dx*c-dy*s,p.y+dx*s+dy*c];assert.equal(areaAt(plan.areaGrid,...point)?.kind,'forest');assert.equal(contains(point,court.polygon),false);assert.equal(contains(point,building.polygon),false);assert.ok(segmentDistance(point,...road.points)>road.width/2);
  }}
});
