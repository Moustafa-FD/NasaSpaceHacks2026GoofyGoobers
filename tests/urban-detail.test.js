import test from 'node:test';
import assert from 'node:assert/strict';
import {buildUrbanDetail,groupCampusBuildings} from '../apps/web/js/urban-detail.js';

const rect=(x,y,w,d)=>[[x-w/2,y-d/2],[x+w/2,y-d/2],[x+w/2,y+d/2],[x-w/2,y+d/2]];
const building=(id,kind,x,y,width=30,depth=20)=>({id,kind,x,y,width,depth,angle:0,source:'mapped'});
const snapshot=(buildings,extra={})=>({siteId:'test',radiusM:3300,buildings:buildings.map((b)=>({id:b.id,polygon:rect(b.x,b.y,b.width,b.depth),tags:{building:b.kind==='house'?'house':'industrial'}})),roads:[],areas:[],...extra});
const heightAt=(x,y)=>20+x*.015+y*.01;
function inRing(p,ring){let value=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){const a=ring[i],b=ring[j];if((a[1]>p[1])!==(b[1]>p[1])&&p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0])value=!value;}return value;}

test('nearby data-centre halls share one pad and one perimeter fence, without per-hall fences',()=>{
  const buildings=[building('way/a','data-center',-30,0),building('way/b','data-center',30,0)];
  const result=buildUrbanDetail(snapshot(buildings),heightAt,{buildings});
  assert.equal(result.campuses.length,1);assert.equal(result.campuses[0].buildings.length,2);
  assert.equal(result.stats.campuses,1);assert.equal(result.stats.campusFences,1);assert.equal(result.stats.campusHalls,2);
  assert.equal(result.stats.buildingPads,0);
  const fence=result.groups.find((g)=>g.name==='urban-fence-metal');assert.ok(fence.indices.length);
  assert.ok(fence.positions.every((v,i)=>i%3!==0||Math.abs(v)>35||Math.abs(fence.positions[i+2])>15),'fence should surround campus rather than surround each hall');
});

test('a public road or mapped water separates campus halls while service access does not',()=>{
  const buildings=[building('way/a','data-center',-35,0),building('way/b','data-center',35,0)],road={id:'way/street',kind:'residential',width:6,points:[[0,-100],[0,100]]};
  assert.equal(groupCampusBuildings(snapshot(buildings,{roads:[road]}),buildings).length,2);
  assert.equal(groupCampusBuildings(snapshot(buildings,{roads:[{...road,kind:'service'}]}),buildings).length,1);
  assert.equal(groupCampusBuildings(snapshot(buildings,{areas:[{kind:'water',polygon:rect(0,0,10,100)}]}),buildings).length,2);
});

test('airports require actual mapped runway or apron geometry, not an aerodrome boundary or city name',()=>{
  const empty=snapshot([]),boundary={airports:[{id:'way/airport',polygon:rect(0,0,500,500)}]};
  const none=buildUrbanDetail(empty,heightAt,{urban:boundary});assert.equal(none.airportFocus,null);assert.equal(none.groups.length,0);
  const urban={airways:[{id:'way/runway',kind:'runway',width:23,widthSource:'osm:width',points:[[-300,100],[300,100]],tags:{}}]};
  const result=buildUrbanDetail(empty,heightAt,{urban});assert.equal(result.stats.runways,1);assert.ok(result.airportFocus);assert.equal(result.airportFocus.sourceId,'way/runway');
  assert.equal(result.airportFocus.x,0,'quick view must focus the runway midpoint rather than its endpoint');
  assert.ok(result.groups.some((g)=>g.name==='urban-white-paint'));
  const asphalt=result.groups.find((g)=>g.name==='urban-asphalt');assert.ok(asphalt.positions.every((v,i)=>i%3!==2||Math.abs(v+100)<=11.50001));
});

test('parking paint and scaled cars remain within the mapped lot and outside its island holes',()=>{
  const lot={id:'way/parking',kind:'parking',polygon:rect(0,0,90,75),holes:[rect(10,0,16,20)]},urban={surfaces:[lot]};
  const result=buildUrbanDetail(snapshot([]),heightAt,{urban,maxCars:12});
  assert.equal(result.stats.parkingLots,1);assert.ok(result.stats.parkingStripes>0);assert.ok(result.stats.parkedCars>0&&result.stats.parkedCars<=12);
  for(const car of result.parkedCars){assert.equal(car.sourceId,lot.id);assert.equal(car.width,1.75);assert.equal(car.depth,4.1);assert.ok(inRing([car.x,car.y],lot.polygon));assert.equal(inRing([car.x,car.y],lot.holes[0]),false);}
  const overview=buildUrbanDetail(snapshot([]),heightAt,{urban,detail:'overview'});assert.equal(overview.stats.parkedCars,0);assert.equal(overview.stats.parkingStripes,0);
});

test('nonresidential mapped footprints receive pads while homes keep their lawns and bounded close-only fences',()=>{
  const buildings=[building('way/shop','shop',0,0,20,20),...Array.from({length:12},(_,i)=>building('way/home'+i,'house',100+i*35,0,14,12))],data=snapshot(buildings);
  const result=buildUrbanDetail(data,heightAt,{buildings,maxGardens:3});assert.equal(result.stats.buildingPads,1);assert.equal(result.stats.gardenFences,3);
  assert.ok(result.stats.entranceProps>0);
  const overview=buildUrbanDetail(data,heightAt,{buildings,detail:'overview'});assert.equal(overview.stats.gardenFences,0);assert.equal(overview.stats.entranceProps,0);
});

test('terrain geometry and fence faces have finite unit normals, two-sided fence faces and deterministic budgets',()=>{
  const buildings=[building('way/hall','data-center',0,0),building('way/home','house',100,0,12,10)],data=snapshot(buildings),a=buildUrbanDetail(data,heightAt,{buildings,maxTriangles:6000}),b=buildUrbanDetail(data,heightAt,{buildings,maxTriangles:6000});
  assert.deepEqual(a,b);assert.ok(a.stats.triangles<=6000);assert.ok(a.groups.length<=9);
  for(const mesh of a.groups){assert.equal(mesh.positions.length,mesh.normals.length);assert.ok(mesh.positions.every(Number.isFinite));for(let i=0;i<mesh.normals.length;i+=3)assert.ok(Math.abs(Math.hypot(...mesh.normals.slice(i,i+3))-1)<1e-6);assert.ok(mesh.indices.every((i)=>i<mesh.positions.length/3));}
  const fence=a.groups.find((g)=>g.name==='urban-fence-metal');assert.ok(fence.normals.some((v)=>v<-.5)&&fence.normals.some((v)=>v>.5));
  assert.equal(a.stats.triangles,a.groups.reduce((n,g)=>n+g.indices.length/3,0));
});

test('unknown elevation does not produce a false zero-altitude concrete pad',()=>{
  const buildings=[building('way/office','office',0,0)],result=buildUrbanDetail(snapshot(buildings),()=>null,{buildings});
  assert.equal(result.groups.length,0);assert.equal(result.stats.buildingPads,0);
});

test('small budgets preserve structural pads before optional parking and never count undrawn garden fences',()=>{
  const shop=building('way/shop','shop',0,0,20,20),urban={surfaces:[{id:'way/lot',kind:'parking',polygon:rect(300,0,500,500)}]};
  const detail=buildUrbanDetail(snapshot([shop]),heightAt,{buildings:[shop],urban,maxTriangles:100});assert.equal(detail.stats.buildingPads,1);assert.ok(detail.stats.triangles<=100);
  const home=building('way/home','house',0,0,20,20),small=buildUrbanDetail(snapshot([home]),heightAt,{buildings:[home],maxTriangles:20});assert.equal(small.stats.gardenFences,0);assert.equal(small.groups.length,0);
});
