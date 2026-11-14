import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildingKind,planNeighborhood,contains} from '../apps/web/js/neighborhood-core.js';
const manifest=JSON.parse(readFileSync(new URL('../apps/web/assets/low-poly/manifest.json',import.meta.url)));
const rect=(x,y,w,d)=>[[x-w/2,y-d/2],[x+w/2,y-d/2],[x+w/2,y+d/2],[x-w/2,y+d/2]];
const source=(buildings=[],areas=[])=>({schemaVersion:1,siteId:'commercial-fixture',center:{lon:0,lat:40},radiusM:500,buildings,areas,roads:[],trees:[]});

test('small mapped commercial buildings and restaurants do not become houses or civic schools',()=>{
  assert.equal(buildingKind({building:'yes'},{area:220},'commercial'),'shop');
  assert.equal(buildingKind({building:'yes',amenity:'restaurant'},{area:180},'residential'),'shop');
  assert.equal(buildingKind({building:'house'},{area:160},'commercial'),'house');
  assert.equal(buildingKind({building:'yes',amenity:'school'},{area:800},'commercial'),'civic');
});

test('mapped use selects cafe and hangar silhouettes while ordinary warehouses remain warehouses',()=>{
  const data=source([
    {id:'cafe',polygon:rect(0,0,16,14),tags:{building:'yes',amenity:'cafe'}},
    {id:'hangar',polygon:rect(100,0,50,40),tags:{building:'hangar'}},
    {id:'warehouse',polygon:rect(-100,0,50,40),tags:{building:'warehouse'}},
  ]);
  const plan=planNeighborhood(data,manifest,{maxTrees:0,maxCrops:0,maxGrass:0});
  assert.equal(plan.instances.find(i=>i.id==='cafe').model,'shop-cafe-terrace');
  assert.equal(plan.instances.find(i=>i.id==='hangar').model,'airport-aircraft-hangar');
  assert.notEqual(plan.instances.find(i=>i.id==='warehouse').model,'airport-aircraft-hangar');
  assert.equal(plan.stats.buildings,3,'more architecture does not invent commercial footprints');
});

test('mapped paving and runway corridors stay free of generated planting',()=>{
  const park=rect(0,0,950,950),paved=rect(0,0,400,400);
  const data=source([],[{id:'park',kind:'park',polygon:park}]);
  const urban={surfaces:[{id:'lot',kind:'parking',polygon:paved}],airways:[{id:'runway',kind:'runway',width:35,points:[[-400,300],[400,300]]}]};
  const plan=planNeighborhood(data,manifest,{urban,maxTrees:500,maxGrass:500});
  assert.ok(plan.stats.trees>0);
  for(const i of plan.instances){assert.equal(contains([i.x,i.y],paved),false);assert.ok(Math.abs(i.y-300)>21.5||Math.abs(i.x)>400);}
});
