import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { planNeighborhood, buildingKind, areaAt, contains, orientedBox, segmentDistance } from '../apps/web/js/neighborhood-core.js';

const manifest=JSON.parse(readFileSync(new URL('../apps/web/assets/low-poly/manifest.json',import.meta.url)));
const models=new Map(manifest.models.map((m)=>[m.id,m]));
const rect=(x0,y0,x1,y1)=>[[x0,y0],[x1,y0],[x1,y1],[x0,y1]];
const sites=['colossus1','colossus2','ashburn','abilene','thedalles'];
const snapshots=new Map(sites.map((id)=>[id,JSON.parse(readFileSync(new URL('../data/cloudshadow/neighborhoods/'+id+'.json',import.meta.url)))]));
const expectedCampus={colossus1:'way/1381264361',colossus2:'way/1386926534',ashburn:'way/1188691868',abilene:'way/1472056711',thedalles:'way/1443567519'};
const noPlants={maxTrees:0,maxCrops:0,maxGrass:0};
const residentialTypes=new Set(['house','detached','apartments','residential','terrace','bungalow','semidetached_house','cabin']);

function fixture(areas,extra={}) {
  return {schemaVersion:1,siteId:'campus-vegetation-fixture',center:{lat:35,lon:-90},radiusM:500,buildings:[],trees:[],areas,roads:[],...extra};
}
function footprint(instance,steps=4) {
  const m=models.get(instance.model),c=Math.cos(instance.angle),s=Math.sin(instance.angle),points=[];
  for(let i=0;i<=steps;i++)for(let j=0;j<=steps;j++){
    const x=(i/steps-0.5)*m.width*instance.scale[0],y=(j/steps-0.5)*m.depth*instance.scale[2];
    points.push([instance.x+x*c-y*s,instance.y+x*s+y*c]);
  }
  return points;
}
function assertClearOfWaterAndRoads(plan,instance) {
  for(const point of footprint(instance)) {
    assert.notEqual(areaAt(plan.areaGrid,...point)?.kind,'water',instance.id+' enters mapped water');
    for(const road of plan.roads) assert.ok(segmentDistance(point,road.a,road.b)>=road.width/2-1e-6,instance.id+' enters road '+road.id);
  }
}

for(const id of sites) test(id+': mapped data centers use campus art and preserve surrounding homes',()=>{
  const data=snapshots.get(id),plan=planNeighborhood(data,manifest,{maxBuildings:4200,...noPlants});
  const source=new Map(data.buildings.map((b)=>[b.id,b]));
  const campuses=plan.instances.filter((i)=>i.kind==='data-center');
  assert.ok(campuses.length>0,id+' must include its mapped campus');
  assert.ok(campuses.some((i)=>i.id===expectedCampus[id]),'The known mapped campus footprint must survive the building budget');
  assert.equal(plan.stats.dataCenters,campuses.length);
  assert.ok(plan.campuses.some((c)=>c.id===plan.campusFocus.id),'Campus focus must name a rendered campus');
  for(const campus of campuses){
    assert.equal(campus.source,'mapped');
    assert.equal(models.get(campus.model)?.kind,'data-center');
    assert.notEqual(models.get(campus.model)?.role,'infrastructure','A main hall cannot be replaced by an isolated utility yard');
    assert.ok(source.has(campus.id));
    assert.ok(!residentialTypes.has(source.get(campus.id).tags?.building),'A source-tagged home cannot become a campus');
  }
  let drawnHomes=0;
  for(const instance of plan.instances){
    const original=source.get(instance.id);
    if(original && residentialTypes.has(original.tags?.building)){
      drawnHomes++;
      assert.notEqual(instance.kind,'data-center',instance.id+' was reclassified from a source-tagged home');
      assert.notEqual(models.get(instance.model)?.kind,'data-center');
    }
  }
  assert.ok(drawnHomes>0,'The scene must retain real residential surroundings');
  const focus=plan.campuses.find((c)=>c.id===plan.campusFocus.id);
  assert.ok(Math.hypot(plan.campusFocus.x-focus.x,plan.campusFocus.y-focus.y)<1e-6);
});

for(const id of sites) test(id+': a one-building budget prioritizes the real campus',()=>{
  const data=snapshots.get(id),plan=planNeighborhood(data,manifest,{maxBuildings:1,...noPlants});
  assert.equal(plan.stats.buildings,1);
  assert.equal(plan.stats.dataCenters,1);
  assert.equal(plan.instances.length,1);
  assert.equal(plan.instances[0].kind,'data-center');
  assert.equal(plan.instances[0].source,'mapped');
  assert.equal(plan.campusFocus.id,plan.instances[0].id);
  assert.equal(models.get(plan.instances[0].model)?.kind,'data-center');
});

test('explicit residential types remain residential even if a large home has a technology-company name',()=>{
  const box=orientedBox(rect(-30,-25,30,25));
  for(const name of ['Equinix House','Digital Realty Apartments','Data Center Caretaker Residence']) {
    assert.notEqual(buildingKind({building:'house',name},box,'residential'),'data-center',name+' must not override an explicit residential building tag');
    assert.notEqual(buildingKind({building:'apartments',name},box,'residential'),'data-center',name+' must not override an explicit apartment tag');
  }
});

test('forest groves provide multiple visible crowns per instance and stay clear of water and streets',()=>{
  const data=fixture([
    {id:'forest',kind:'forest',polygon:rect(-450,-450,450,450)},
    {id:'pond',kind:'water',polygon:rect(90,100,250,280)},
  ],{roads:[{id:'road',kind:'residential',width:12,points:[[-480,0],[480,0]]}]});
  const plan=planNeighborhood(data,manifest,{maxBuildings:0,maxTrees:160,maxCrops:0,maxGrass:0});
  const trees=plan.instances.filter((i)=>i.kind==='tree');
  assert.ok(trees.length>0 && trees.length<=160);
  assert.ok(trees.every((i)=>models.get(i.model)?.style==='grove'));
  assert.ok(plan.stats.canopyCrowns>trees.length,'Instancing budget must count clusters of crowns, not isolated single trees');
  assert.equal(plan.stats.canopyCrowns,trees.reduce((n,i)=>n+models.get(i.model).canopyCount,0));
  for(const tree of trees){
    assert.equal(tree.source,'illustrative-planting');
    assertClearOfWaterAndRoads(plan,tree);
    for(const point of footprint(tree))assert.equal(areaAt(plan.areaGrid,...point)?.kind,'forest');
  }
});

test('wheat field patches contain many stems, obey small budgets and stay on mapped agricultural parcels',()=>{
  const field={id:'farm',kind:'farmland',polygon:rect(-450,-450,450,450),holes:[rect(-220,100,-140,220)]};
  const data=fixture([field,{id:'pond',kind:'water',polygon:rect(90,100,250,280)}],{roads:[{id:'farm-road',kind:'service',width:8,points:[[-480,0],[480,0]]}]});
  for(const maxCrops of [0,1,7,29]){
    const plan=planNeighborhood(data,manifest,{maxBuildings:0,maxTrees:0,maxGrass:0,maxCrops});
    const crops=plan.instances.filter((i)=>i.kind==='crop');
    assert.equal(crops.length,maxCrops,'The broad fixture should fill the bounded crop budget');
    assert.equal(plan.stats.crops,crops.length);
    assert.equal(plan.stats.cropStems,crops.reduce((n,i)=>n+models.get(i.model).stemCount,0));
    if(maxCrops)assert.ok(plan.stats.cropStems>=crops.length*20,'Each patch should visibly contain many stalks');
    for(const crop of crops){
      assert.equal(crop.model,'wheat-field-patch');
      assert.equal(crop.source,'illustrative-crop');
      assertClearOfWaterAndRoads(plan,crop);
      for(const point of footprint(crop))assert.ok(contains(point,field.polygon,field.holes));
    }
  }
});

test('continuous grass does not generate square meadow meshes or consume a patch instance budget',()=>{
  const data=fixture([
    {id:'grass',kind:'grass',polygon:rect(-450,-450,450,450)},
    {id:'forest',kind:'forest',polygon:rect(-450,160,-100,450)},
    {id:'pond',kind:'water',polygon:rect(90,100,250,280)},
  ],{roads:[{id:'road',kind:'residential',width:12,points:[[-480,0],[480,0]]}]});
  const plan=planNeighborhood(data,manifest,{maxBuildings:0,maxTrees:0,maxCrops:0,maxGrass:120});
  const patches=plan.instances.filter((i)=>i.kind==='grass');
  assert.equal(patches.length,0);assert.equal(plan.stats.grass,0);assert.equal(plan.stats.grassSurface,true);
  const noPatchBudget=planNeighborhood(data,manifest,{maxBuildings:0,maxTrees:0,maxCrops:0,maxGrass:0});
  assert.deepEqual(plan.instances,noPatchBudget.instances,'ground coverage must not depend on a finite meadow-instance budget');
  for(const kind of ['water','forest','farmland']){
    const excluded=planNeighborhood(fixture([{id:kind,kind,polygon:rect(-450,-450,450,450)}]),manifest,{maxBuildings:0,maxTrees:0,maxCrops:0,maxGrass:120});
    assert.equal(excluded.stats.grass,0,'No meadow patches should be inserted into '+kind);
  }
});
