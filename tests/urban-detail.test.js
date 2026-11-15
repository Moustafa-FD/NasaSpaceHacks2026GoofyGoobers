import test from 'node:test';
import assert from 'node:assert/strict';
import {buildUrbanDetail,groupCampusBuildings,planHouseConnections,planBackyards,infrastructureHeight} from '../apps/web/js/urban-detail.js';
import {buildTerrainSurface} from '../apps/web/js/terrain-mesh.js';

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
  for(const car of result.parkedCars){assert.equal(car.sourceId,lot.id);assert.equal(car.width,1.75*.76);assert.equal(car.depth,4.1*.76);assert.ok(inRing([car.x,car.y],lot.polygon));assert.equal(inRing([car.x,car.y],lot.holes[0]),false);}
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

test('power spans and traffic lights use only mapped locations with labelled physical-height estimates and sag',()=>{
  const urban={powerLines:[{id:'way/power',kind:'line',points:[[-100,100],[100,100]],tags:{voltage:'230000'}}],infrastructureNodes:[{id:'node/t1',kind:'tower',x:-100,y:100,tags:{height:'45'}},{id:'node/t2',kind:'tower',x:100,y:100,tags:{height:'45'}},{id:'node/pole',kind:'pole',x:60,y:0,tags:{}},{id:'node/light',kind:'traffic_signals',x:0,y:-30,tags:{}}]},data=snapshot([],{roads:[{id:'way/road',kind:'residential',width:6,points:[[-100,-30],[100,-30]]}]});
  const result=buildUrbanDetail(data,()=>40,{urban});assert.equal(result.stats.powerTowers,2);assert.equal(result.stats.powerPoles,1);assert.equal(result.stats.trafficSignals,1);assert.equal(result.stats.powerSpans,1);
  assert.deepEqual(result.infrastructure.map((n)=>n.id).sort(),urban.infrastructureNodes.map((n)=>n.id).sort());
  for(const placed of result.infrastructure){const mapped=urban.infrastructureNodes.find((n)=>n.id===placed.id);assert.equal(placed.x,mapped.x);assert.equal(placed.y,mapped.y);assert.ok(placed.height>=5&&placed.height<=45);}
  const span=result.wireSpans[0];assert.equal(span.sourceId,'way/power');assert.deepEqual(span.points[0].slice(0,2),[-100,100]);assert.deepEqual(span.points.at(-1).slice(0,2),[100,100]);assert.ok(span.points[Math.floor(span.points.length/2)][2]<span.points[0][2]-5);
  assert.equal(result.infrastructure.find((n)=>n.id==='node/t1').heightSource,'osm:height');assert.match(result.infrastructure.find((n)=>n.id==='node/pole').heightSource,/estimate/);
  assert.equal(infrastructureHeight({kind:'pole',tags:{height:'30 ft'}}).height,9.144);
  const empty=buildUrbanDetail(data,()=>40);assert.equal(empty.stats.powerSpans,0);assert.equal(empty.stats.trafficSignals,0);assert.deepEqual(empty.infrastructure,[]);
});

test('infrastructure overview reduces wire and tower detail, drops tiny hardware, and keeps bounded batches',()=>{
  const urban={powerLines:[{id:'way/power',kind:'line',points:[[0,0],[250,0]],tags:{}}],infrastructureNodes:[{id:'node/tower',kind:'tower',x:0,y:0,tags:{}},{id:'node/pole',kind:'pole',x:30,y:10,tags:{}},{id:'node/signal',kind:'traffic_signals',x:50,y:10,tags:{}}]},data=snapshot([]),close=buildUrbanDetail(data,()=>0,{urban}),overview=buildUrbanDetail(data,()=>0,{urban,detail:'overview'});
  assert.equal(overview.stats.powerTowers,1);assert.equal(overview.stats.powerPoles,0);assert.equal(overview.stats.trafficSignals,0);assert.ok(overview.stats.triangles<close.stats.triangles/2);
  assert.ok(close.groups.length<=11);assert.ok(close.groups.every((g)=>g.positions.every(Number.isFinite)&&g.normals.every(Number.isFinite)));
  const bytes=close.groups.reduce((n,g)=>n+(g.positions.length+g.normals.length+g.indices.length)*4,0);assert.ok(bytes<100000,'one source span and three supports should remain a small batched mesh');
});

test('short illustrative driveways stop at local roads and reject neighbors, water, far roads and highways',()=>{
  const home=building('way/home','house',0,0,12,10),street={id:'way/street',kind:'residential',width:6,points:[[-100,-30],[100,-30]]},data=snapshot([home],{roads:[street]});
  const paths=planHouseConnections(data,[home]);assert.equal(paths.length,1);assert.equal(paths[0].source,'illustrative');assert.equal(paths[0].width,2.7);assert.ok(paths[0].walk);assert.ok(Math.hypot(paths[0].points[1][0]-paths[0].points[0][0],paths[0].points[1][1]-paths[0].points[0][1])<=35);assert.ok(Math.abs(paths[0].gate[1]+7.2)<1e-8);
  const neighbor=building('way/neighbor','house',0,-16,14,10);assert.equal(planHouseConnections(snapshot([home,neighbor],{roads:[street]}),[home]).length,0);
  assert.equal(planHouseConnections(snapshot([home],{roads:[street],areas:[{kind:'water',polygon:rect(0,-16,30,4)}]}),[home]).length,0);
  assert.equal(planHouseConnections(snapshot([home],{roads:[{...street,kind:'motorway',width:14}]}),[home]).length,0);
  assert.equal(planHouseConnections(snapshot([home],{roads:[{...street,points:[[-100,-70],[100,-70]]}]}),[home]).length,0);
});

test('mapped driveways retain their original source path and garden/driveway priority follows the Homes focus',()=>{
  const homes=[building('way/near-origin','house',0,0,12,10),building('way/near-focus','house',1500,0,12,10)],street={id:'way/street',kind:'residential',width:6,points:[[-100,-25],[1600,-25]]},data=snapshot(homes,{roads:[street]}),options={buildings:homes,residentialFocus:{x:1500,y:0},maxDriveways:1,maxGardens:1};
  const result=buildUrbanDetail(data,()=>30,options);assert.equal(result.driveways[0].houseId,'way/near-focus');assert.equal(result.gardens[0].houseId,'way/near-focus');assert.deepEqual(result.gardens[0].drivewayGate,result.driveways[0].gate);assert.deepEqual(result.gardens[0].accessPath.at(-1),result.gardens[0].gate);assert.equal(result.stats.gardenBeds,1);assert.equal(result.stats.patios,1);assert.equal(result.stats.hedges,1);
  const mapped={id:'way/drive',kind:'service',width:3,widthSource:'osm:width',points:[[0,-7],[0,-23]],tags:{service:'driveway'}},paths=planHouseConnections(snapshot([homes[0]],{roads:[street,mapped]}),[homes[0]]);
  assert.equal(paths[0].source,'mapped');assert.equal(paths[0].sourceId,'way/drive');assert.deepEqual(paths[0].points,mapped.points);
  const overview=buildUrbanDetail(data,()=>30,{...options,detail:'overview'});assert.equal(overview.driveways.length,0);assert.equal(overview.gardens.length,0);
});

test('illustrative street infill receives driveways, gardens and shop pads without crossing other infill or hidden mapped buildings',()=>{
  const home={...building('infill:home','house',0,0,12,10),source:'illustrative-infill'},shop={...building('infill:shop','shop',60,0,18,12),source:'illustrative-infill'},street={id:'way/street',kind:'residential',width:6,points:[[-100,-25],[100,-25]]},data=snapshot([],{roads:[street]});
  const result=buildUrbanDetail(data,()=>30,{buildings:[home,shop]});
  assert.equal(result.driveways.length,1);assert.equal(result.driveways[0].houseId,home.id);assert.equal(result.driveways[0].source,'illustrative');
  assert.equal(result.gardens.length,1);assert.equal(result.gardens[0].houseId,home.id);assert.equal(result.stats.buildingPads,1);assert.ok(result.stats.entranceProps>0);
  const neighbor={...building('infill:neighbor','house',0,-15,14,10),source:'illustrative-infill'};
  assert.equal(planHouseConnections(data,[home,neighbor]).some((path)=>path.houseId===home.id),false);
  const hidden=building('mapped:hidden','house',0,12,20,10),blocked=buildUrbanDetail(snapshot([hidden],{roads:[street]}),()=>30,{buildings:[home]});
  assert.equal(blocked.gardens.length,0,'a mapped footprint beyond the render budget must still block the garden');
});

test('parked vehicle body geometry uses the same compact scale as moving traffic',()=>{
  const lot={id:'way/lot',kind:'parking',polygon:rect(0,0,30,30)},result=buildUrbanDetail(snapshot([]),()=>20,{urban:{surfaces:[lot]},maxCars:1}),car=result.parkedCars[0];
  const paint=result.groups.find((g)=>g.name.startsWith('urban-car-'));assert.ok(paint&&car);
  const xs=paint.positions.filter((v,i)=>i%3===0),zs=paint.positions.filter((v,i)=>i%3===2),ys=paint.positions.filter((v,i)=>i%3===1);
  assert.ok(Math.abs(Math.max(...xs)-Math.min(...xs)-1.75*.76)<1e-6);assert.ok(Math.abs(Math.max(...zs)-Math.min(...zs)-4.1*.76)<1e-6);
  assert.ok(Math.max(...ys)<21,'body height scales along with the footprint');
});

test('backyards extend away from street frontage with three fence sides and a driveway-connected side gate',()=>{
  const home=building('way/home','house',0,0,12,10),data=snapshot([home],{roads:[{id:'street',kind:'residential',width:6,points:[[-100,-25],[100,-25]]}]}),result=buildUrbanDetail(data,()=>30,{buildings:[home]}),yard=result.gardens[0];
  assert.ok(yard.depthM>=12&&yard.depthM<=20);assert.ok(yard.polygon.every((p)=>p[1]>5));assert.equal(yard.fenceEdges.length,3);assert.ok(yard.front[1]<-.99);assert.ok(yard.accessPath);
  assert.deepEqual(yard.accessPath.at(-1),yard.gate);assert.ok(yard.gate[1]>5);assert.ok(result.stats.backyardAreaM2>120);
  const wood=result.groups.find((g)=>g.name==='urban-garden-fence');assert.ok(Math.max(...wood.positions.filter((v,i)=>i%3===1))>31.2,'backyard fence panels should be readable above grass');
});

test('backyards shrink around hidden buildings and water instead of discarding every constrained yard',()=>{
  const home=building('way/home','house',0,0,12,10),hidden=building('mapped/hidden','house',0,23,30,10),road={id:'street',kind:'residential',width:6,points:[[-100,-25],[100,-25]]},data=snapshot([home,hidden],{roads:[road]}),a=planBackyards(data,[home]),b=planBackyards(data,[home]);
  assert.deepEqual(a,b);assert.equal(a.yards.length,1);assert.ok(a.yards[0].shrunk);assert.ok(a.yards[0].depthM>=4.5&&a.yards[0].depthM<a.yards[0].desiredDepthM);assert.ok(a.yards[0].polygon.every((p)=>p[1]<18));
  const wet=snapshot([home],{roads:[road],areas:[{kind:'water',polygon:rect(0,16,60,3)}]}),waterYard=planBackyards(wet,[home]).yards[0];assert.ok(waterYard);assert.ok(waterYard.polygon.every((p)=>p[1]<14.5));
});

test('adjacent generated yards never overlap and mapped recreation reserves remain untouched',()=>{
  const homes=[building('h1','house',0,0,12,10),building('h2','house',0,30,12,10)],data=snapshot(homes,{roads:[{id:'south',kind:'residential',width:6,points:[[-100,-25],[100,-25]]},{id:'north',kind:'residential',width:6,points:[[-100,55],[100,55]]}]}),result=planBackyards(data,homes);
  assert.equal(result.yards.length,2);const [a,b]=result.yards;assert.ok(Math.max(...a.polygon.map((p)=>p[1]))<Math.min(...b.polygon.map((p)=>p[1])));
  assert.equal(planBackyards(data,[homes[0]],{recreation:{features:[{kind:'playground',polygon:rect(0,16,80,24)}]}}).yards.length,0);
});

test('side access chooses the clear gate when a road blocks one side and yard geometry obeys its own budget',()=>{
  const home=building('way/home','house',0,0,12,10),street={id:'street',kind:'residential',width:6,points:[[-100,-25],[100,-25]]},plain=snapshot([home],{roads:[street]}),connections=planHouseConnections(plain,[home]),sideRoad={id:'side-road',kind:'service',width:1.5,points:[[8.8,-6],[8.8,8]]},yard=planBackyards({...plain,roads:[street,sideRoad]},[home],{connections}).yards[0];
  assert.ok(yard);assert.ok(yard.accessPath);assert.ok(yard.gate[0]<0,'blocked right-side access should use the clear left-side gate');assert.ok(yard.accessPath.every((p)=>p[0]<=0));
  const homes=[home,building('h2','house',35,0,12,10),building('h3','house',70,0,12,10)],limited=buildUrbanDetail(snapshot(homes,{roads:[street]}),()=>30,{buildings:homes,maxGardenTriangles:140});
  assert.ok(limited.gardens.length>0);assert.ok(limited.stats.gardenTriangles<=140);assert.ok(limited.stats.triangles<=160000);
});

test('fenced backyards inherit continuous terrain instead of emitting flat vegetation-category lawn slabs',()=>{
  const home=building('way/home','house',0,0,12,10),data=snapshot([home],{roads:[{id:'street',kind:'residential',width:6,points:[[-100,-25],[100,-25]]}]}),detail=buildUrbanDetail(data,()=>30,{buildings:[home]}),yard=detail.gardens[0];
  assert.ok(yard&&yard.accessPath);assert.equal(yard.fenceEdges.length,3);assert.ok(detail.stats.patios&&detail.stats.gardenBeds&&detail.stats.hedges);
  assert.equal(detail.groups.some((g)=>/lawn/.test(g.name)),false);
  for(const mesh of detail.groups.filter((g)=>g.category===1)){
    assert.equal(mesh.name,'urban-garden-green','only small modeled garden plants receive tree-growth treatment');
    for(let i=0;i<mesh.indices.length;i+=3){const [a,b,c]=mesh.indices.slice(i,i+3).map((n)=>[mesh.positions[n*3],mesh.positions[n*3+2]]),area=Math.abs((b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]))/2;assert.ok(area<1,'a vegetation-category triangle must not blanket the yard');}
  }
  const terrain=buildTerrainSurface(data,{groundKindAt:()=> 'grass'},()=>30,{radius:100,spacingM:50}).groups.find((g)=>g.category===3),p=yard.polygon.reduce((sum,q)=>[sum[0]+q[0]/4,sum[1]+q[1]/4],[0,0]),cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);let covered=false;
  for(let i=0;i<terrain.indices.length;i+=3){const [a,b,c]=terrain.indices.slice(i,i+3).map((n)=>[terrain.positions[n*3],-terrain.positions[n*3+2]]);if([cross(a,b,p),cross(b,c,p),cross(c,a,p)].every((v)=>v>=-1e-8))covered=true;}
  assert.ok(covered,'the existing natural-ground mesh must cover the open fenced yard');
});
